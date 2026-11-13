// approval-notify Client half.
//
// 在「设置 → 插件」里注册一页：把「弹卡片」和「响铃」拆成两个开关，分别保存。
// Host 半边（index.js）提供 /approval-notify/api/{settings,test} 三个同源路由。
window.__ModuleLoader__.load({
  id: '@local/dsh-approval-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SETTINGS_ENDPOINT = '/approval-notify/api/settings'
    const TEST_ENDPOINT = '/approval-notify/api/test'

    const wrapStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      maxWidth: '680px',
      padding: '2px 0 12px',
    }

    const titleStyle = {
      margin: 0,
      fontSize: '15px',
      fontWeight: 600,
      lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary)',
    }

    const textStyle = {
      margin: 0,
      fontSize: '12.5px',
      lineHeight: '19px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '14px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '12px',
      background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      fontSize: '12.5px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
    }

    const hintStyle = {
      display: 'block',
      fontSize: '11.5px',
      lineHeight: '17px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const monoStyle = {
      fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: '11.5px',
      wordBreak: 'break-all',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const buttonStyle = {
      alignSelf: 'flex-start',
      padding: '6px 14px',
      border: '1px solid transparent',
      borderRadius: '8px',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#ffffff',
      font: 'inherit',
      fontSize: '12.5px',
      lineHeight: '16px',
      cursor: 'pointer',
    }

    const buttonDisabledStyle = {
      ...buttonStyle,
      opacity: 0.55,
      cursor: 'default',
    }

    const messageStyle = (kind) => ({
      fontSize: '12px',
      lineHeight: '17px',
      color: kind === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-success-primary)',
    })

    async function readSettings() {
      const response = await fetch(SETTINGS_ENDPOINT, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`http-${response.status}`)
      return response.json()
    }

    async function saveSettings(next) {
      const response = await fetch(SETTINGS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(next),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(`http-${response.status}`)
      if (data === null || data.ok !== true) {
        throw new Error(data !== null && typeof data.error === 'string' ? data.error : 'save-failed')
      }
      return data
    }

    async function runTest() {
      const response = await fetch(TEST_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(`http-${response.status}`)
      if (data === null || data.ok !== true) {
        throw new Error(data !== null && typeof data.error === 'string' ? data.error : 'test-failed')
      }
      return data
    }

    function Toggle({ label, hint, checked, disabled, onChange }) {
      return h(
        'label',
        { style: rowStyle },
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          style: { marginTop: '2px', cursor: disabled ? 'default' : 'pointer' },
          onChange: (event) => onChange(event.target.checked),
        }),
        h(
          'span',
          null,
          label,
          hint ? h('span', { style: hintStyle }, hint) : null,
        ),
      )
    }

    function ApprovalNotifySection() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testing, setTesting] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          setState(await readSettings())
        } catch (error) {
          setState({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const loading = state === null
      const ready = state !== null && state.ok === true
      const card = ready && state.card === true
      const sound = ready && state.sound === true
      const bothOff = ready && !state.card && !state.sound

      async function toggle(field, value) {
        if (!ready || busy) return
        setBusy(true)
        setMessage(null)
        try {
          const saved = await saveSettings({ card: field === 'card' ? value : card, sound: field === 'sound' ? value : sound })
          setState({ ok: true, ...saved })
          setMessage({
            kind: 'ok',
            text: saved.card || saved.sound ? '已保存。' : '已保存：两个提醒都关掉了，审批只会在应用内面板等你。',
          })
        } catch (error) {
          setMessage({ kind: 'error', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
          await load()
        } finally {
          setBusy(false)
        }
      }

      async function onTest() {
        setTesting(true)
        setMessage(null)
        try {
          await runTest()
          setMessage({ kind: 'ok', text: '已按当前设置触发一次提醒。' })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          setMessage({
            kind: 'error',
            text: reason === 'both-disabled' ? '两个提醒都关着，没有可测试的提醒。' : `测试失败：${reason}`,
          })
        } finally {
          setTesting(false)
        }
      }

      return h(
        'div',
        { style: wrapStyle },
        h('h3', { style: titleStyle }, '审批提醒'),
        h(
          'p',
          { style: textStyle },
          'DSH 需要你批准工具调用时，这个插件会用桌面提醒告诉你。两个提醒可以分开开关：不要弹窗、只想听到声音，就只勾「响铃」。',
        ),
        h(
          'div',
          { style: cardStyle },
          h(Toggle, {
            label: '弹卡片',
            hint: '屏幕右上角置顶小卡片，显示工具和她请求原因；点卡片上的 × 关闭，审批本身仍在 DSH 窗口里作答。',
            checked: card,
            disabled: !ready || busy,
            onChange: (value) => toggle('card', value),
          }),
          h(Toggle, {
            label: '响铃',
            hint: '收到审批请求时播放一声系统提示音，不开窗口。',
            checked: sound,
            disabled: !ready || busy,
            onChange: (value) => toggle('sound', value),
          }),
          bothOff
            ? h('p', { style: textStyle }, '两个都关着：审批只会在 DSH 应用内面板等你，不会有任何桌面提醒。')
            : null,
          h(
            'button',
            {
              type: 'button',
              style: testing || loading ? buttonDisabledStyle : buttonStyle,
              disabled: testing || loading,
              onClick: onTest,
            },
            testing ? '正在触发…' : '按当前设置试一次',
          ),
          message !== null ? h('div', { style: messageStyle(message.kind) }, message.text) : null,
          ready && state.settingsFile ? h('div', { style: monoStyle }, `设置文件：${state.settingsFile}`) : null,
        ),
        h('p', { style: textStyle }, '修改立即生效，不需要重启 DSH；审批结论始终不受这个插件影响。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'approval-notify',
          order: 62,
          label: () => '审批提醒',
        }, ApprovalNotifySection))
      },
    }
  },
})
