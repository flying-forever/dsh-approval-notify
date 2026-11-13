/**
 * DSH 审批提醒插件（Host 侧，纯提醒、不参与作答）
 *
 * 监听 approval/request 瀑布事件：按当前设置弹置顶卡片和/或响一声，随后立刻 next()
 * 交给真正的应答者（浏览器审批面板），不改变任何审批结论。
 *
 * 两个功能可以在「设置 → 插件 → 审批提醒」里分开开关：
 *   card  —— 屏幕右上角置顶卡片（默认开）
 *   sound —— 提示音（默认开）
 * 关掉卡片只留声音，就是「只响铃、不弹窗」的模式。
 *
 * 同源路由（Host 半边，给上面的设置页用）：
 *   GET  /approval-notify/api/settings   读设置
 *   POST /approval-notify/api/settings   写设置 { card, sound }
 *   POST /approval-notify/api/test       按当前设置试一次提醒
 *
 * 设置持久化在 <DSH_HOME>/approval-notify.json。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'approval-notify'
/** 设置页的路由要挂在 webServer 上，和 provider-guard 一样等它挂载。 */
export const inject = ['webServer']

const PLUGIN_ID = 'approval-notify'
const SETTINGS_PATH = '/approval-notify/api/settings'
const TEST_PATH = '/approval-notify/api/test'

const DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(DIR, 'notify.ps1')
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/** 同时最多几张卡片，再多的请求只留在应用内审批面板。 */
const MAX_CARDS = 3
/** 卡片高度 104，加 8 像素间距。 */
const SLOT_HEIGHT = 112
/** 决策一到就关会赶在窗口渲染之前；至少让它亮这么久。 */
const MIN_VISIBLE_MS = 3000

const SETTINGS_DEFAULTS = { card: true, sound: true }

function settingsFile() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
  return join(home, 'approval-notify.json')
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读设置。文件不存在或损坏时回落到默认值（都开），不让提醒功能因为读配置失败而消失。
 * @returns {{ card: boolean, sound: boolean }} 当前设置。
 */
export function readSettings() {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return { ...SETTINGS_DEFAULTS }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      card: asBool(parsed?.card, SETTINGS_DEFAULTS.card),
      sound: asBool(parsed?.sound, SETTINGS_DEFAULTS.sound),
    }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

/**
 * 写设置。只接受布尔字段，其余忽略。
 * @param next - 新的设置对象。
 * @returns {{ card: boolean, sound: boolean }} 落盘后的设置。
 */
export function writeSettings(next) {
  const value = {
    card: asBool(next?.card, SETTINGS_DEFAULTS.card),
    sound: asBool(next?.sound, SETTINGS_DEFAULTS.sound),
  }
  writeFileSync(settingsFile(), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
  return value
}

/** 审批请求里优先用本地化文案，其次用审计原因。 */
function describe(request) {
  const display = request?.displayReason
  const localized = display && (display.zh ?? display.en)
  return localized ?? request?.reason ?? ''
}

/**
 * 拉起 notify.ps1：卡片和声音由命令行开关分别控制。
 * @param options - `{ request, slot, card, sound, seconds, onExit }`；没有 slot 时按 0 处理。
 */
function spawnNotifier({ request, slot, card, sound, onExit, seconds = 600 }) {
  if (process.platform !== 'win32') return undefined
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT]
  if (card) {
    const text = describe(request)
    const tool = request?.toolName ?? '未知操作'
    const body = text.length > 0 ? `工具：${tool}\n${text}` : `工具：${tool}`
    args.push(
      '-TitleText', 'DSH 有审批请求',
      '-BodyText', body,
      '-HintText', '打开 DeepSeek Harness 处理',
      '-Offset', String((slot ?? 0) * SLOT_HEIGHT),
      '-Seconds', String(seconds),
    )
  } else {
    args.push('-NoCard')
  }
  if (!sound) args.push('-NoSound')

  const child = spawn(POWERSHELL, args, { windowsHide: true, stdio: 'ignore', detached: false })
  // 卡片自己结束（用户点 ×、600 秒超时、进程异常）时也要释放槽位，
  // 否则后面的审批会白白占用第 2、3 个位置。
  child.on('error', () => { onExit?.() })
  child.on('exit', () => { onExit?.() })
  if (typeof child.unref === 'function') child.unref()
  return {
    close() {
      try { child.kill() } catch {}
    },
  }
}

function showCard(request, slot, settings, onExit) {
  try {
    return spawnNotifier({ request, slot, card: true, sound: settings.sound, onExit })
  } catch {
    return undefined
  }
}

/**
 * 注册瀑布监听：只提醒，不作答。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  /** 占用的纵向槽位，避免同时到来的多个请求叠成一张。 */
  const slots = new Map()

  // 设置页的路由（GET/POST settings、POST test）和审批监听一起注册。
  registerRoutes(ctx)

  // 瀑布链由外向内执行：原生审批面板启动时先注册、位于链首；后装插件排在链尾时
  // next() 会立刻拿到兜底的 'unavailable'，卡片在人作答前就被关闭。
  // prepend 把本监听器插到链首，next() 才真正包住“面板等人作答”的整段等待。
  return ctx.on('approval/request', (request, next) => {
    const settings = readSettings()
    const shownAt = Date.now()
    let slot
    let card

    if (settings.card) {
      for (let i = 0; i < MAX_CARDS; i += 1) {
        if (!slots.has(i)) { slot = i; break }
      }
      if (slot !== undefined) {
        card = showCard(request, slot, settings, () => {
          if (slots.get(slot) === card) slots.delete(slot)
        })
        if (card !== undefined) slots.set(slot, card)
        else slots.delete(slot)
      }
    } else if (settings.sound) {
      // 只响铃：不占槽位，进程自己播完就退出。
      try {
        spawnNotifier({ request, card: false, sound: true })
      } catch {}
    }

    let answer
    try {
      answer = next()
    } catch (error) {
      card?.close()
      if (slot !== undefined) slots.delete(slot)
      throw error
    }

    if (card !== undefined) {
      Promise.resolve(answer)
        .catch(() => {})
        .then(() => {
          const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt))
          setTimeout(() => {
            slots.delete(slot)
            card.close()
          }, wait)
        })
    }
    return answer
  }, { prepend: true })
}

/* ── 设置页用的同源路由 ───────────────────────────────────────────────────── */

function isTrustedRequest(request) {
  const headers = request.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const url = new URL(origin)
    const host = typeof headers.host === 'string' ? headers.host : ''
    return url.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length === 0 ? null : JSON.parse(raw)
}

function statePayload() {
  return { ok: true, ...readSettings(), settingsFile: settingsFile() }
}

export function registerRoutes(ctx) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer) {
    ctx.logger?.warn?.('[%s] no webServer service in this profile; settings routes were not registered', PLUGIN_ID)
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden' })
      if (request.method === 'GET') {
        try {
          writeJson(response, 200, statePayload())
        } catch (error) {
          ctx.logger?.warn?.('[%s] settings read failed: %s', PLUGIN_ID, error instanceof Error ? error.message : String(error))
          writeJson(response, 200, { ok: false, error: 'settings-read-failed' })
        }
        return
      }
      if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return writeJson(response, 400, { ok: false, error: 'bad-json' })
      }
      if (body === null || typeof body !== 'object') return writeJson(response, 400, { ok: false, error: 'bad-body' })
      if (typeof body.card !== 'boolean' || typeof body.sound !== 'boolean') {
        return writeJson(response, 400, { ok: false, error: 'bad-body' })
      }
      try {
        const saved = writeSettings({ card: body.card, sound: body.sound })
        ctx.logger?.info?.('[%s] settings saved card=%s sound=%s', PLUGIN_ID, saved.card, saved.sound)
        writeJson(response, 200, { ok: true, ...saved, settingsFile: settingsFile() })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.('[%s] settings write failed: %s', PLUGIN_ID, reason)
        writeJson(response, 200, { ok: false, error: 'settings-write-failed' })
      }
    },
  }), `${PLUGIN_ID}:settings-route`)

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: TEST_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) return writeJson(response, 403, { ok: false, error: 'forbidden' })
      if (request.method !== 'POST') return writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
      const settings = readSettings()
      if (!settings.card && !settings.sound) {
        return writeJson(response, 200, { ok: false, error: 'both-disabled' })
      }
      try {
        const child = spawnNotifier({ card: settings.card, sound: settings.sound, seconds: 15 })
        if (child === undefined) return writeJson(response, 200, { ok: false, error: 'unsupported-platform' })
        writeJson(response, 200, { ok: true, ...settings })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.('[%s] test notify failed: %s', PLUGIN_ID, reason)
        writeJson(response, 200, { ok: false, error: 'notify-failed' })
      }
    },
  }), `${PLUGIN_ID}:test-route`)
}
