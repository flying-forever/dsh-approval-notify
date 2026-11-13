# dsh-approval-notify

DeepSeek Harness（DSH）插件：DSH 需要你批准工具调用时，在屏幕右上角弹一张置顶小卡片和/或响一声。

**审批结论仍然在 DSH 窗口里点**——这个插件只提醒，不参与作答。

## 特性

- **卡片 / 响铃分开开关**：在「设置 → 插件 → 审批提醒」里各管各的，改完立即生效，不用重启 DSH。只想要"有动静但不打扰"就关卡片、留响铃。
- 卡片显示工具名和请求原因，点右上角 `×` 可收起，审批答完自动消失。
- 不抢焦点、不进 Alt+Tab；除 `×` 以外区域鼠标点击穿透，不会挡住审批按钮。
- 设置页带「按当前设置试一次」按钮，不用等真实审批就能验证。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（Web profile，需要 `webServer` 服务） |
| 系统 | **仅 Windows**（依赖 WinForms） |
| PowerShell | Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`） |

非 Windows 平台插件会静默不提醒。

## 安装

**方式 A：插件面板**

1. 打开 DSH 的「插件」面板 → 「添加插件」
2. 填本目录的**绝对路径**，例如 `D:\apps\dsh-approval-notify`
3. 插件列表里会出现「审批提醒」，设置页里多出同名一页

**方式 B：手动写 profile**

`~/.dsh/profiles/<profile>/package.json`：

```jsonc
"dependencies": {
  "@local/dsh-approval-notify": "link:<本目录绝对路径>"
},
"dsh": { "profile": { "bundles": [ /* ... */, "@local/dsh-approval-notify" ] } }
```

然后在 profile 目录跑一次 `pnpm install`，重启 DSH。

> 本地目录是 `link:` 安装的，**别删、别移动**这个目录，否则插件失效。
> 包名保持 `@local/dsh-approval-notify` 是为了和 `cordis.patch.yml` 里的行名一致；改包名要同时改那一行。

## 使用

「设置 → 插件 → 审批提醒」：

| 开关 | 默认 | 作用 |
|---|---|---|
| 弹卡片 | 开 | 右上角置顶卡片 |
| 响铃 | 开 | 一声系统提示音，不开窗口 |

设置持久化在 `~/.dsh/approval-notify.json`：

```json
{ "card": true, "sound": true }
```

文件不存在或损坏时回落到「都开」，不会因为读配置失败而静默丢提醒。删掉该文件即恢复默认。

## 工作原理

```
DSH 需要审批
   ↓  Host 触发 approval/request 瀑布事件
插件（prepend 插在链首）
   ↓  立刻 next() 交给真正的应答者（GUI 审批面板）
   ↓  同时按设置 spawn notify.ps1
WinForms 自绘卡片（右上角，WS_EX_NOACTIVATE 不抢焦点）
   ↓  审批有结果 / 点 × / 超时 → 进程结束
```

- **监听必须 `prepend`**：瀑布链由外向内执行，`next()` 逐层向内，最内层兜底是 `'unavailable'`。原生面板先注册且位于链首，插件若追加在链尾，`next()` 会立即拿到兜底值、卡片刚生成就被关掉。
- **命中测试按区域**：只有右上角 `×` 的 22×22 区域返回 `HTCLIENT`，其余像素一律 `HTTRANSPARENT`（点击穿透）。卡片是单窗口自绘、没有子控件，否则子控件会截走本该穿透的点击。
- 卡片位置在**右上角**并向下错开：右下角会压住 composer 里的「允许/拒绝」。

### 设置页路由（同源校验）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/approval-notify/api/settings` | `{ ok, card, sound, settingsFile }` |
| POST | `/approval-notify/api/settings` | 写入 `{ card, sound }`（两个都必须是布尔） |
| POST | `/approval-notify/api/test` | 按当前设置试一次；两个都关时返回 `error: "both-disabled"` |

跨站请求（`sec-fetch-site: cross-site` 或 `Origin` 与 `Host` 不符）返回 403。

## 排障

**设置页「试一次」有声音但拉不出卡片（1.1.1 已修）**

测试路径没有卡片槽位，旧版 Host 会传 `-Offset NaN`；脚本参数若是 `[int]$Offset`，PowerShell 参数绑定直接失败（`Cannot convert value "NaN" to type "System.Int32"`），进程在画窗之前就退出。纯响铃模式不传 `-Offset`，所以只有卡片坏。

现在 `$Offset` 收成字符串并用 `[int]::TryParse` 兜底为 0；Host 侧 `slot ?? 0`，测试卡 15 秒自动关闭。

**进程活着但屏幕上看不到卡片**

可能是被前台/全屏窗口盖住（Win32 层看是 `visible=True`、`topmost=True`、`cloaked=0`，但被遮挡）。插件显示后会补一次 `SetWindowPos(HWND_TOPMOST)`；如果仍不出现，先确认没有别的 always-on-top 窗口压在上面。

## 限制

- 仅 Windows；依赖 PowerShell 5.1 + .NET WinForms，被组策略/杀软拦住时没有任何提示。
- 纯响铃模式要加载 WinForms 程序集才能调 `SystemSounds`，从请求到出声约 1 秒延迟。
- 卡片只能点右上角 `×` 关闭，或等审批结果 / 600 秒超时；其余区域不接收鼠标（刻意如此）。
- 最多同时 3 张卡片，多出来的只留在 DSH 面板里（审批通常是串行的，基本遇不到）。
- DSH 进程被强杀时，残留卡片会在 600 秒后自行消失。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：监听 `approval/request`、卡片生命周期、设置读写、注册设置页路由 |
| `client.js` | 设置页：两个开关 + 「试一次」按钮 |
| `notify.ps1` | 画卡片 / 纯响铃（`-NoCard` / `-NoSound`） |
| `cordis.patch.yml` | 插入 `approval-notify` 插件行 |
| `package.json` | 包清单：`dsh.bundle.patch` + `dsh.client` |
| `locale/{zh,en}.json` | 插件面板里的标题与描述 |
| `test/smoke.mjs` | 脱离 DSH 的冒烟测试（`node test/smoke.mjs`） |

## License

MIT，见 [LICENSE](LICENSE)。
