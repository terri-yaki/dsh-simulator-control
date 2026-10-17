/**
 * Simulator Control — Web client half.
 *
 * Registers a right-sidebar tab type that shows the live iOS Simulator screen
 * and posts taps, typing and boot/shutdown commands to the Host routes in
 * `lib/web.js`. Visible copy goes through the Client locale service.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-simulator-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'simulatorControl'
    const TYPE_ID = '@local/dsh-simulator-control/panel'
    const KIND = 'simulator'
    const TYPE_LABEL = 'Simulator'

    const DICT_EN = {
      'type.label': TYPE_LABEL,
      'guide.title': TYPE_LABEL,
      'guide.description': 'Live iOS Simulator screen with tap, typing and boot controls.',
      'device': 'Device',
      'boot': 'Boot',
      'shutdown': 'Shut down',
      'home': 'Home',
      'refresh': 'Refresh',
      'typePlaceholder': 'Type into the focused field…',
      'send': 'Send',
      'tapHint': 'Tap the screen to tap the simulator',
      'notBooted': 'not booted',
      'noDevices': 'No simulators are installed.',
      'loading': 'Connecting…',
      'autoBootHint': 'boots automatically when needed',
      'frameError': 'Screen unavailable',
      'actionError': 'Action failed',
    }

    const DICT_ZH = {
      'type.label': '模拟器',
      'guide.title': '模拟器',
      'guide.description': '实时 iOS 模拟器画面，支持点按、输入与启动/关闭。',
      'device': '设备',
      'boot': '启动',
      'shutdown': '关闭',
      'home': '主屏幕',
      'refresh': '刷新',
      'typePlaceholder': '向当前输入框输入文本…',
      'send': '发送',
      'tapHint': '点按画面即点按模拟器',
      'notBooted': '未启动',
      'noDevices': '未安装模拟器。',
      'loading': '连接中…',
      'autoBootHint': '需要时自动启动',
      'frameError': '画面不可用',
      'actionError': '操作失败',
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        gap: '8px',
        padding: '10px 12px',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
      },
      toolbar: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      select: {
        flex: '1 1 120px',
        minWidth: 0,
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
      },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '4px 9px',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        borderRadius: '7px',
        padding: '4px 9px',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      viewport: {
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        overflow: 'hidden',
      },
      image: {
        display: 'block',
        maxWidth: '100%',
        maxHeight: '100%',
        width: 'auto',
        height: 'auto',
        cursor: 'crosshair',
        userSelect: 'none',
      },
      placeholder: {
        padding: '20px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      typing: { display: 'flex', gap: '6px', alignItems: 'center' },
      input: {
        flex: 1,
        minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '5px 8px',
        font: 'inherit',
        fontSize: '12px',
        outline: 'none',
      },
      footer: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        minHeight: '14px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' },
    }

    function api(path) {
      return `${window.location.origin}/simulator-control/${path}`
    }

    async function readJson(response) {
      try {
        return await response.json()
      } catch {
        return undefined
      }
    }

    function Panel(props) {
      const t = props.t
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const visible = tabInfo?.tab?.visible !== false

      const [devices, setDevices] = React.useState([])
      const [selected, setSelected] = React.useState(null)
      const [frameUrl, setFrameUrl] = React.useState(null)
      const [frameAt, setFrameAt] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [typed, setTyped] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const selectedRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const mountedRef = React.useRef(true)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])
      React.useEffect(() => {
        selectedRef.current = selected
      }, [selected])
      React.useEffect(() => {
        frameRef.current = frameUrl
      }, [frameUrl])
      React.useEffect(
        () => () => {
          if (frameRef.current !== null) URL.revokeObjectURL(frameRef.current)
        },
        [],
      )

      const booted = devices.find((device) => device.udid === selected)?.booted === true

      const loadState = React.useCallback(async () => {
        try {
          const query = selectedRef.current === null ? '' : `?udid=${encodeURIComponent(selectedRef.current)}`
          const response = await fetch(api(`state${query}`), { cache: 'no-store' })
          const data = await readJson(response)
          if (!response.ok || data?.ok !== true) throw new Error(data?.error ?? `state ${response.status}`)
          if (!mountedRef.current) return
          setDevices(Array.isArray(data.devices) ? data.devices : [])
          setSelected((current) => {
            const exists = data.devices?.some((device) => device.udid === current)
            return exists ? current : data.selected ?? null
          })
        } catch (cause) {
          if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        loadState()
      }, [loadState, tick])

      React.useEffect(() => {
        if (!visible || selected === null) return undefined
        let cancelled = false
        let timer
        const loop = async () => {
          if (cancelled) return
          if (document.visibilityState === 'hidden') {
            timer = setTimeout(loop, 1500)
            return
          }
          try {
            const response = await fetch(api(`frame?udid=${encodeURIComponent(selected)}&t=${Date.now()}`), {
              cache: 'no-store',
            })
            if (response.ok) {
              const blob = await response.blob()
              const url = URL.createObjectURL(blob)
              if (cancelled) {
                URL.revokeObjectURL(url)
                return
              }
              setFrameUrl((previous) => {
                if (previous !== null) URL.revokeObjectURL(previous)
                return url
              })
              setFrameAt(Date.now())
              setError('')
            } else {
              const data = await readJson(response)
              if (!cancelled) {
                setFrameUrl((previous) => {
                  if (previous !== null) URL.revokeObjectURL(previous)
                  return null
                })
                setError(data?.error ?? `${t('frameError')} (${response.status})`)
              }
            }
          } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          }
          if (!cancelled) timer = setTimeout(loop, 1000)
        }
        loop()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [visible, selected, tick, t])

      const act = React.useCallback(
        async (action, payload = {}) => {
          if (selected === null) return undefined
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const response = await fetch(api('action'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ udid: selected, action, ...payload }),
            })
            const data = await readJson(response)
            if (!response.ok || data?.ok !== true) throw new Error(data?.error ?? `${t('actionError')} (${response.status})`)
            if (!mountedRef.current) return undefined
            setNotice(typeof data.message === 'string' ? data.message : '')
            setTick((value) => value + 1)
            return data
          } catch (cause) {
            if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
            return undefined
          } finally {
            if (mountedRef.current) setBusy(false)
          }
        },
        [selected, t],
      )

      const sendText = React.useCallback(async () => {
        if (typed === '') return
        const text = typed
        setTyped('')
        await act('type', { text })
      }, [act, typed])

      const tapScreen = async (event) => {
        const image = event.currentTarget
        const rect = image.getBoundingClientRect()
        const naturalWidth = image.naturalWidth || 0
        const naturalHeight = image.naturalHeight || 0
        if (naturalWidth === 0 || naturalHeight === 0) return
        const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
        const displayWidth = naturalWidth * scale
        const displayHeight = naturalHeight * scale
        const offsetX = (rect.width - displayWidth) / 2
        const offsetY = (rect.height - displayHeight) / 2
        const x = (event.clientX - rect.left - offsetX) / displayWidth
        const y = (event.clientY - rect.top - offsetY) / displayHeight
        if (x < 0 || x > 1 || y < 0 || y > 1) return
        await act('tap', { x, y })
      }

      const selectedDevice = devices.find((device) => device.udid === selected)
      const footerLeft = error !== '' ? h('span', { style: styles.error, title: error }, error) : h('span', null, notice !== '' ? notice : t('tapHint'))
      const footerRight = frameAt === null ? null : h('span', null, new Date(frameAt).toLocaleTimeString())

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.toolbar },
          h(
            'select',
            {
              style: styles.select,
              value: selected ?? '',
              disabled: devices.length === 0 || busy,
              title: t('device'),
              onChange: (event) => {
                setFrameUrl((previous) => {
                  if (previous !== null) URL.revokeObjectURL(previous)
                  return null
                })
                setError('')
                setSelected(event.target.value === '' ? null : event.target.value)
              },
            },
            devices.length === 0
              ? h('option', { value: '' }, t('noDevices'))
              : devices.map((device) =>
                  h(
                    'option',
                    { key: device.udid, value: device.udid },
                    `${device.name} · ${device.runtime}${device.booted ? '' : ` (${t('notBooted')})`}`,
                  ),
                ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: booted ? styles.button : styles.buttonPrimary,
              disabled: selected === null || busy,
              onClick: () => act(booted ? 'shutdown' : 'boot'),
            },
            booted ? t('shutdown') : t('boot'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, disabled: selected === null || busy || !booted, onClick: () => act('home') },
            t('home'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, disabled: busy, onClick: () => setTick((value) => value + 1) },
            t('refresh'),
          ),
        ),
        h(
          'div',
          { style: styles.viewport },
          frameUrl === null
            ? h(
                'div',
                { style: styles.placeholder },
                error !== '' ? error : selectedDevice === undefined ? t('noDevices') : t('loading'),
              )
            : h('img', {
                src: frameUrl,
                alt: t('type.label'),
                style: styles.image,
                draggable: false,
                onClick: tapScreen,
              }),
        ),
        h(
          'div',
          { style: styles.typing },
          h('input', {
            style: styles.input,
            value: typed,
            placeholder: t('typePlaceholder'),
            disabled: !booted || busy,
            onChange: (event) => setTyped(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                sendText()
              }
            },
          }),
          h(
            'button',
            { type: 'button', style: styles.button, disabled: typed === '' || !booted || busy, onClick: sendText },
            t('send'),
          ),
        ),
        h('div', { style: styles.footer }, footerLeft, footerRight),
      )
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH }), 'simulator-control: dictionaries')
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => t('type.label'),
            guide: [
              {
                id: 'open',
                order: 40,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
              },
            ],
          }),
        'simulator-control: tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TYPE_ID,
                locale: NS,
              },
              Panel,
            ),
          ),
        'simulator-control: tab body',
      )
    }

    return { inject, apply }
  },
})
