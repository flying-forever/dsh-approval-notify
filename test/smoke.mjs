// 冒烟测试：不装进 DSH，直接用假 ctx 驱动插件，验证弹卡片、响铃与自动关闭。
// 用法：node test/smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, readSettings, writeSettings } from '../index.js'

// 用临时 DSH_HOME，避免读到（或写坏）真实设置。
const home = mkdtempSync(join(tmpdir(), 'approval-notify-smoke-'))
process.env.DSH_HOME = home

console.log('plugin name:', name)
console.log('settings default:', JSON.stringify(readSettings()))
console.log('settings card=false:', JSON.stringify(writeSettings({ card: false, sound: true })))
console.log('settings back to both:', JSON.stringify(writeSettings({ card: true, sound: true })))

let listener
const disposer = apply({
  on(event, fn) {
    console.log('ctx.on ->', event)
    listener = fn
    return () => console.log('disposed')
  },
  effect(fn) {
    // 假 ctx 没有 webServer：路由注册应当被安静跳过。
    return fn()
  },
})
if (typeof disposer !== 'function') console.log('warn: apply did not return a disposer')

function ask(tool, reason, holdMs) {
  let resolve
  const answer = new Promise((r) => { resolve = r })
  const returned = listener(
    { toolName: tool, reason, displayReason: { zh: reason } },
    () => answer,
  )
  console.log(`ask ${tool}: delegated to next() = ${returned === answer}`)
  setTimeout(() => {
    console.log(`resolved ${tool}`)
    resolve('allowed-once')
  }, holdMs)
}

ask('pwsh', '写入工作区以外的目录', 9000)
setTimeout(() => ask('read', '读取工作区以外的文件', 4000), 600)
setTimeout(() => {
  rmSync(home, { recursive: true, force: true })
  console.log('done')
  process.exit(0)
}, 11000)
