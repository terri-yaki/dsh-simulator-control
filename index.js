/**
 * Simulator Control — DeepSeek Harness Host plugin.
 *
 * Gives agents first-class control of the macOS iOS Simulator:
 * - device discovery and automatic boot (`sim_devices`, `sim_boot`, auto-boot on demand);
 * - app lifecycle through `xcrun simctl`, including DerivedData build lookup (`sim_app`);
 * - UI inspection and input through the AXe CLI — taps by label/id, typing, swipes,
 *   hardware buttons — with no macOS Accessibility permission required;
 * - screenshots (`sim_screenshot`), video clips (`sim_video`), logs (`sim_logs`);
 * - multi-step testing with assertions in one call (`sim_test`).
 *
 * Everything is registered as model-facing tools; see README.md.
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import { readBoolean, readEnum, readNumber, readString, readText } from './lib/args.js'
import {
  buttonAction,
  captureScreenshot,
  describeMatcher,
  ensureDevice,
  findBuiltApps,
  getAppContainer,
  installApp,
  launchApp,
  listUserApps,
  matcherFromArgs,
  openDeviceHub,
  openUrlAction,
  parseAxJson,
  pollElement,
  resolveUserPath,
  runApp,
  shutdownDevice,
  sleep,
  swipeAction,
  tapAction,
  terminateApp,
  typeAction,
  uninstallApp,
} from './lib/actions.js'
import { chooseDefaultDevice, deviceLabel, listAllDevices, resolveDevice } from './lib/devices.js'
import { createBackend, run } from './lib/exec.js'
import { flattenAxTree, formatDeviceList } from './lib/format.js'
import { registerWebRoutes } from './lib/web.js'

export const name = 'simulator-control'
export const inject = ['tools', 'systemPrompt']

const DEVICE_HUB_PATH = '/Applications/Xcode.app/Contents/Applications/DeviceHub.app'

const PROMPT_SECTION = `## iOS Simulator

The \`sim_*\` tools operate the macOS iOS Simulator. They use the only booted simulator and, when none is booted, boot a suitable iPhone automatically (set \`DSH_SIM_DEFAULT_DEVICE\` to prefer one); pass \`device\` (name or UDID) to choose another. \`sim_devices\` lists devices and the auto-boot target.
- Inspect before acting: \`sim_describe_ui\` returns accessibility elements with labels, ids and frames in points; \`sim_screenshot\` captures pixels. Prefer label/id taps over coordinates.
- Input commands return once the event is dispatched, not when the app settles. After navigation-triggering actions re-run \`sim_describe_ui\`, and retry once if a freshly booted simulator ignored the first events.
- Put multi-step checks in ONE \`sim_test\` call: a \`steps\` array of tap/type/swipe/button/sleep/screenshot/launch steps plus \`assert\` steps that wait for an element; it reports per-step pass/fail and attaches a final screenshot. Use \`sim_video\` for clips, and \`sim_app\` \`find\`/\`run\` to locate a DerivedData build and install+launch it.`

/* ------------------------------------------------------------------ */
/* Settings (environment tuned; no extra package imports)              */
/* ------------------------------------------------------------------ */

function loadSettings() {
  const env = process.env
  const parsedTimeout = Number.parseInt(env.DSH_SIM_BOOT_TIMEOUT ?? '', 10)
  return {
    autoBoot: env.DSH_SIM_AUTOBOOT !== '0',
    defaultDevice: (env.DSH_SIM_DEFAULT_DEVICE ?? '').trim(),
    axePath: (env.DSH_SIM_AXE ?? '').trim(),
    bootTimeout:
      Number.isFinite(parsedTimeout) && parsedTimeout >= 30 ? Math.min(parsedTimeout, 600) : 180,
  }
}

/* ------------------------------------------------------------------ */
/* Output and parameter schemas                                        */
/* ------------------------------------------------------------------ */

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

function textOutput(extraProperties = {}, render) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Human-readable result.' },
        ...extraProperties,
      },
    },
    render: render ?? ((_args, value) => [{ type: 'text', text: value.text }]),
  }
}

function screenshotOutput() {
  return textOutput({ path: { type: 'string' }, image: IMAGE_VALUE_SCHEMA }, (_args, value) => {
    const content = [{ type: 'text', text: value.text }]
    if (value.image !== undefined) content.push({ type: 'image', attachment: value.image })
    return content
  })
}

function simTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output ?? textOutput(),
    ...(definition.concurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
    execute: definition.execute,
  }
}

const DEVICE_PARAMETER = {
  type: 'string',
  description:
    'Simulator name or UDID. Omit to use the only booted simulator; when none is booted a suitable iPhone is booted automatically.',
}

function bootNote(bootedNow, device) {
  return bootedNow ? `Auto-booted ${deviceLabel(device)}. ` : ''
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ------------------------------------------------------------------ */
/* Video recording manager                                             */
/* ------------------------------------------------------------------ */

function createVideoManager() {
  const recordings = new Map()

  async function start(device, filePath, signal) {
    const existing = recordings.get(device.udid)
    if (existing !== undefined) {
      throw new Error(`Already recording ${deviceLabel(device)} (${existing.path}); stop it first.`)
    }
    const path = filePath ?? resolve(tmpdir(), 'dsh-simulator', `recording-${Date.now()}.mp4`)
    await mkdir(dirname(path), { recursive: true })
    const child = spawn(
      '/usr/bin/xcrun',
      ['simctl', 'io', device.udid, 'recordVideo', '--codec=h264', '--force', path],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const record = { child, path, startedAt: Date.now(), stderr: '' }
    recordings.set(device.udid, record)
    const outcome = await new Promise((resolvePromise) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolvePromise({ ok: true, note: 'started' })
      }, 3000)
      child.stderr?.on('data', (chunk) => {
        record.stderr += chunk.toString()
        if (!settled && record.stderr.includes('Recording started')) {
          settled = true
          clearTimeout(timer)
          resolvePromise({ ok: true, note: 'started' })
        }
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        recordings.delete(device.udid)
        resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
      child.once('exit', (code) => {
        record.exitCode = code
        record.exited = true
        if (recordings.get(device.udid) === record && !settled) {
          recordings.delete(device.udid)
          settled = true
          clearTimeout(timer)
          resolvePromise({ ok: false, error: `recorder exited (code ${code ?? 'unknown'}): ${record.stderr.slice(-400)}` })
        }
      })
    })
    if (!outcome.ok) {
      recordings.delete(device.udid)
      throw new Error(`could not start video recording: ${outcome.error}`)
    }
    return { path }
  }

  async function stop(device) {
    const record = recordings.get(device.udid)
    if (record === undefined) throw new Error(`No active recording on ${deviceLabel(device)}.`)
    const closed = new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          record.child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolvePromise({ timedOut: true })
      }, 15_000)
      record.child.once('close', (code, signalName) => {
        clearTimeout(timer)
        resolvePromise({ code, signal: signalName, timedOut: false })
      })
    })
    try {
      record.child.kill('SIGINT')
    } catch {
      // Already gone.
    }
    const closedInfo = await closed
    recordings.delete(device.udid)
    let size = 0
    try {
      size = (await stat(record.path)).size
    } catch {
      size = 0
    }
    if (size === 0) {
      throw new Error(
        `Recording stopped but no video frames were written (${record.path}). Start a recording while the simulator display is active.`,
      )
    }
    return {
      path: record.path,
      bytes: size,
      durationMs: Date.now() - record.startedAt,
      timedOut: closedInfo.timedOut === true,
    }
  }

  function dispose() {
    for (const record of recordings.values()) {
      try {
        record.child.kill('SIGINT')
      } catch {
        // Already gone.
      }
    }
    recordings.clear()
  }

  return { start, stop, dispose }
}

/* ------------------------------------------------------------------ */
/* Flow runner (sim_test)                                              */
/* ------------------------------------------------------------------ */

const FLOW_ACTIONS = [
  'tap',
  'type',
  'swipe',
  'button',
  'open_url',
  'sleep',
  'screenshot',
  'assert',
  'launch',
  'terminate',
  'install',
]

function describeStep(step) {
  const action = typeof step?.action === 'string' ? step.action : '(missing action)'
  const parts = [action]
  for (const key of ['label', 'id', 'url', 'bundle_id', 'button', 'direction']) {
    if (typeof step?.[key] === 'string') parts.push(`${key}=${JSON.stringify(step[key].slice(0, 60))}`)
  }
  if (typeof step?.text === 'string') parts.push(`text=${JSON.stringify(step.text.slice(0, 40))}`)
  if (typeof step?.seconds === 'number') parts.push(`seconds=${step.seconds}`)
  if (typeof step?.exists === 'boolean') parts.push(`exists=${step.exists}`)
  return parts.join(' ')
}

async function runFlowStep(backend, ctx, exec, device, step, options) {
  const action = readString(step, 'action', { required: true, label: 'step.action' })
  const settleMs = options.settleMs
  switch (action) {
    case 'tap': {
      const result = await tapAction(backend, device, step, exec.signal)
      await sleep(settleMs)
      return `tap ${result.target}`
    }
    case 'type': {
      const result = await typeAction(backend, device, step, exec.signal)
      await sleep(Math.min(settleMs, 400))
      return `typed ${result.length} character${result.length === 1 ? '' : 's'}${result.submit ? ' + Return' : ''}`
    }
    case 'swipe': {
      const result = await swipeAction(backend, device, step, exec.signal)
      await sleep(settleMs)
      return result.direction === undefined ? 'swiped by points' : `swiped ${result.direction}`
    }
    case 'button': {
      const result = await buttonAction(backend, device, step, exec.signal)
      await sleep(settleMs)
      return `pressed ${result.button}`
    }
    case 'open_url': {
      const result = await openUrlAction(backend, device, step, exec.signal)
      await sleep(settleMs)
      return `opened ${result.url}`
    }
    case 'sleep': {
      const seconds = readNumber(step, 'seconds', { min: 0, max: 60, label: 'step.seconds' }) ?? 1
      await sleep(seconds * 1000)
      return `waited ${seconds}s`
    }
    case 'screenshot': {
      const requestedPath = readString(step, 'path', { label: 'step.path' })
      const shot = await captureScreenshot(backend, ctx, exec, device, requestedPath)
      options.screenshots.push(shot.path)
      return `saved ${shot.path}`
    }
    case 'assert': {
      const matcher = matcherFromArgs(step)
      const present = step.exists !== false
      const timeoutSeconds = readNumber(step, 'timeout', { min: 0.1, max: 300, label: 'step.timeout' }) ?? options.defaultTimeoutSeconds
      const result = await pollElement(backend, device, matcher, {
        present,
        timeoutMs: timeoutSeconds * 1000,
        signal: exec.signal,
      })
      if (!result.satisfied) {
        throw new Error(
          present
            ? `${describeMatcher(matcher)} not found within ${timeoutSeconds}s`
            : `${describeMatcher(matcher)} still present after ${timeoutSeconds}s`,
        )
      }
      return present ? `found ${describeMatcher(matcher)}` : `gone ${describeMatcher(matcher)}`
    }
    case 'launch': {
      const bundleId = readString(step, 'bundle_id', { required: true, label: 'step.bundle_id' })
      const result = await launchApp(backend, device, bundleId, exec.signal)
      await sleep(settleMs)
      return `launched ${result.bundleId} (${result.detail})`
    }
    case 'terminate': {
      const bundleId = readString(step, 'bundle_id', { required: true, label: 'step.bundle_id' })
      const result = await terminateApp(backend, device, bundleId, exec.signal)
      return result.wasRunning ? `terminated ${bundleId}` : `${bundleId} was not running`
    }
    case 'install': {
      const appPath = readString(step, 'app_path', { label: 'step.app_path' })
      const bundleId = readString(step, 'bundle_id', { label: 'step.bundle_id' })
      if (appPath === undefined && bundleId === undefined) {
        throw new Error('install steps need app_path or bundle_id')
      }
      const targetPath = appPath === undefined ? undefined : resolveUserPath(ctx, exec, appPath)
      const result = await installApp(backend, device, { appPath: targetPath, bundleId }, exec.signal)
      return `installed ${result.bundleId ?? result.path}`
    }
    default:
      throw new Error(`unknown step action "${action}" (supported: ${FLOW_ACTIONS.join(', ')})`)
  }
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

function buildToolDefinitions(ctx, backend, settings, video) {
  const tools = []

  async function readyDevice(args, exec) {
    return await ensureDevice(backend, readString(args, 'device', { label: 'device' }), {
      autoBoot: settings.autoBoot,
      defaultDevice: settings.defaultDevice,
      waitSeconds: settings.bootTimeout,
      signal: exec.signal,
    })
  }

  tools.push(
    simTool({
      name: 'sim_devices',
      description:
        'List installed iOS simulators with runtime, UDID and boot state. Also reports which simulator the automatic boot would pick. Use it to choose a device, or after a tool reports that several simulators are booted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          booted_only: { type: 'boolean', description: 'Only list booted simulators.' },
          include_unavailable: {
            type: 'boolean',
            description: 'Also list simulators whose runtime is unavailable.',
          },
        },
      },
      concurrencySafe: true,
      async execute(args) {
        const devices = await listAllDevices(backend)
        const booted = devices.filter((device) => device.isAvailable && device.state === 'Booted')
        let text = formatDeviceList(devices, {
          bootedOnly: args?.booted_only === true,
          includeUnavailable: args?.include_unavailable === true,
        })
        if (booted.length === 0) {
          const pick = chooseDefaultDevice(devices, settings.defaultDevice)
          if (pick !== undefined) {
            text += settings.autoBoot
              ? `\nAuto-boot target: ${pick.name} (${pick.runtime}).`
              : `\nAutomatic boot is disabled (DSH_SIM_AUTOBOOT=0). Boot ${pick.name} with sim_boot.`
          }
        }
        return { text }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_boot',
      description:
        'Boot a simulator and wait until it is ready, reusing an already booted device. Omit device to boot the automatic choice: the most recently used iPhone on the newest runtime (or DSH_SIM_DEFAULT_DEVICE). A first-ever boot can ignore the first input events for a few seconds; verify with sim_describe_ui and retry.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          wait_timeout: {
            type: 'number',
            description: 'Maximum seconds to wait for the boot to finish. Default 180.',
          },
          show_ui: {
            type: 'boolean',
            description: 'Open the Xcode Device Hub window after booting so the simulator screen is visible.',
          },
        },
      },
      async execute(args, exec) {
        const waitSeconds = readNumber(args, 'wait_timeout', { min: 1, max: 600, label: 'wait_timeout' })
        const { device, bootedNow } = await ensureDevice(
          backend,
          readString(args, 'device', { label: 'device' }),
          {
            autoBoot: true,
            defaultDevice: settings.defaultDevice,
            waitSeconds: waitSeconds ?? settings.bootTimeout,
            signal: exec.signal,
          },
        )
        let text = `${bootedNow ? 'Booted' : 'Already booted'} ${deviceLabel(device)}.`
        if (readBoolean(args, 'show_ui')) {
          try {
            await openDeviceHub()
            text += ' Opened the Device Hub window.'
          } catch (error) {
            text += ` Device Hub could not be opened: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        return { text }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_shutdown',
      description: 'Shut down one simulator, or every simulator with all=true.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          all: { type: 'boolean', description: 'Shut down every simulator.' },
        },
      },
      async execute(args, exec) {
        if (readBoolean(args, 'all')) {
          await backend.simctlOk(['shutdown', 'all'], 'shutdown all', { timeoutMs: 120_000, signal: exec.signal })
          return { text: 'Shut down all simulators.' }
        }
        const requested = readString(args, 'device', { label: 'device' })
        let device
        if (requested === undefined) {
          const devices = await listAllDevices(backend)
          const booted = devices.filter((candidate) => candidate.isAvailable && candidate.state === 'Booted')
          if (booted.length === 0) return { text: 'No simulators are booted.' }
          if (booted.length > 1) {
            throw new Error(
              `Multiple simulators are booted: ${booted.map(deviceLabel).join('; ')}. Pass device, or all=true to shut down all.`,
            )
          }
          device = booted[0]
        } else {
          device = await resolveDevice(backend, requested, { requireBooted: false, signal: exec.signal })
        }
        if (device.state !== 'Booted') return { text: `${deviceLabel(device)} was already shut down.` }
        await shutdownDevice(backend, device, { signal: exec.signal })
        return { text: `Shut down ${deviceLabel(device)}.` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_screenshot',
      description:
        'Capture the simulator screen to a PNG file. The image is attached when the current model accepts images; the file path is always returned.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          path: {
            type: 'string',
            description:
              'Optional output PNG path (absolute, or relative to the session workspace). Defaults to a timestamped file in the system temporary directory.',
          },
        },
      },
      output: screenshotOutput(),
      concurrencySafe: true,
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const shot = await captureScreenshot(backend, ctx, exec, device, readString(args, 'path', { label: 'path' }))
        let text = `${bootNote(bootedNow, device)}Screenshot of ${deviceLabel(device)} saved to ${shot.path} (${shot.bytes} bytes).`
        if (shot.note !== undefined) text += ` ${shot.note}`
        if (shot.image !== undefined) text += ' The image is attached.'
        return { text, path: shot.path, ...(shot.image === undefined ? {} : { image: shot.image }) }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_describe_ui',
      description:
        'Describe the visible accessibility hierarchy: element types, labels, accessibility ids, values and frames in points. Use it to find tap targets and to verify screen state. Frames map directly to sim_tap coordinates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          point: {
            type: 'string',
            description: 'Optional "x,y" screen point; describes only the element at that point.',
          },
          max_elements: {
            type: 'integer',
            description: 'Maximum element lines to return (default 200, max 1000).',
          },
          include_containers: {
            type: 'boolean',
            description: 'Also list structural containers such as groups and windows.',
          },
        },
      },
      concurrencySafe: true,
      async execute(args, exec) {
        const { device } = await readyDevice(args, exec)
        const point = readString(args, 'point', { label: 'point' })
        const maxElements = Math.min(
          Math.max(readNumber(args, 'max_elements', { integer: true, min: 1, max: 1000, label: 'max_elements' }) ?? 200, 1),
          1000,
        )
        const command = ['describe-ui', '--udid', device.udid]
        if (point !== undefined) {
          if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(point)) {
            throw new Error('point must be formatted as "x,y" (for example "120,480")')
          }
          command.push('--point', point)
        }
        const result = await backend.axeOk(command, 'describe-ui', { timeoutMs: 60_000, signal: exec.signal })
        const roots = parseAxJson(result.stdout)
        const flat = flattenAxTree(roots, {
          maxElements,
          includeContainers: readBoolean(args, 'include_containers'),
        })
        const header = `Accessibility tree of ${deviceLabel(device)}${point === undefined ? '' : ` at ${point}`}: ${flat.total} nodes, ${flat.shown} elements shown.`
        if (flat.lines.length === 0) {
          return {
            text: `${header}\n(no actionable elements found; try include_containers=true, a point, or sim_screenshot)`,
          }
        }
        const truncation = flat.capped ? `\n(Truncated at ${maxElements} elements; raise max_elements or pass point.)` : ''
        return { text: `${header}\n${flat.lines.join('\n')}${truncation}` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_tap',
      description:
        'Tap the screen at coordinates or on an accessibility element found by label, id or value. Returns once the event is dispatched; verify the resulting UI with sim_describe_ui.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          x: { type: 'number', description: 'Screen x in points; requires y.' },
          y: { type: 'number', description: 'Screen y in points; requires x.' },
          label: { type: 'string', description: 'Accessibility label of the element to tap.' },
          id: { type: 'string', description: 'Accessibility identifier (AXUniqueId) of the element to tap.' },
          value: { type: 'string', description: 'Accessibility value of the element to tap.' },
          element_type: {
            type: 'string',
            description: 'Optional accessibility type filter for label/id/value matching (for example "Button").',
          },
          wait_timeout: {
            type: 'number',
            description:
              'Seconds to wait for a label/id/value target to appear. Default 2 for selector taps; ignored for coordinates.',
          },
          pre_delay: {
            type: 'number',
            description: 'Seconds to wait before tapping, for animations.',
          },
          tap_style: {
            type: 'string',
            enum: ['physical', 'automatic', 'simulator'],
            description:
              'How the tap is delivered. "physical" (default) sends touch down/up and works across Xcode versions; "automatic" and "simulator" use Xcode\'s simulator tap path.',
          },
        },
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const result = await tapAction(backend, device, args, exec.signal)
        return { text: `${bootNote(bootedNow, device)}Tapped ${result.target} on ${deviceLabel(device)}.` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_type',
      description:
        'Type text into the focused field using the simulator keyboard. Only US keyboard characters are supported (letters, digits, common symbols); international characters are not.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          text: { type: 'string', description: 'Text to type.' },
          submit: { type: 'boolean', description: 'Press Return after typing.' },
          replace: {
            type: 'boolean',
            description: 'Select all existing text first, so typing replaces the field content.',
          },
        },
        required: ['text'],
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const result = await typeAction(backend, device, args, exec.signal)
        return {
          text: `${bootNote(bootedNow, device)}Typed ${result.length} character${result.length === 1 ? '' : 's'} on ${deviceLabel(device)}${result.submit ? ' and pressed Return' : ''}.`,
        }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_swipe',
      description:
        'Swipe the screen, either between explicit points or with a direction from the screen centre. "up" means the finger moves up (content scrolls down).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Finger movement direction; ignored when explicit start/end points are given.',
          },
          start_x: { type: 'number', description: 'Start x in points (requires start_y, end_x, end_y).' },
          start_y: { type: 'number', description: 'Start y in points.' },
          end_x: { type: 'number', description: 'End x in points.' },
          end_y: { type: 'number', description: 'End y in points.' },
          duration: { type: 'number', description: 'Swipe duration in seconds (default 0.25).' },
        },
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const result = await swipeAction(backend, device, args, exec.signal)
        const description =
          result.direction === undefined
            ? `from (${result.startX}, ${result.startY}) to (${result.endX}, ${result.endY})`
            : `${result.direction} from (${result.startX}, ${result.startY}) to (${result.endX}, ${result.endY})`
        return { text: `${bootNote(bootedNow, device)}Swiped ${description} on ${deviceLabel(device)}.` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_button',
      description: 'Press a simulated hardware button: home, lock, side-button, siri, or apple-pay.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          button: {
            type: 'string',
            enum: ['home', 'lock', 'side-button', 'siri', 'apple-pay'],
            description: 'Hardware button to press.',
          },
          duration: { type: 'number', description: 'Optional hold duration in seconds.' },
        },
        required: ['button'],
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const result = await buttonAction(backend, device, args, exec.signal)
        let detail
        if (result.method === 'already-home') {
          detail = `Already on the home screen of ${deviceLabel(device)}.`
        } else if (result.method === 'escape') {
          detail = `Returned to the home screen of ${deviceLabel(device)} by dismissing a system overlay.`
        } else if (result.method === 'app-cycle') {
          detail = `Returned to the home screen of ${deviceLabel(device)} by cycling a system app (this simulator ignored the Home button).`
        } else if (result.method === 'terminate') {
          detail = `Returned to the home screen by terminating ${result.bundleId ?? 'the foreground app'} (this simulator ignored the Home button).`
        } else {
          detail = `Pressed ${result.button} on ${deviceLabel(device)}.`
        }
        return { text: `${bootNote(bootedNow, device)}${detail}` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_open_url',
      description: 'Open a URL or custom app scheme (deep link) on the simulator.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          url: { type: 'string', description: 'URL or scheme URL to open, for example "myapp://screen?id=1".' },
        },
        required: ['url'],
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const result = await openUrlAction(backend, device, args, exec.signal)
        return { text: `${bootNote(bootedNow, device)}Opened ${result.url} on ${deviceLabel(device)}.` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_app',
      description:
        'Inspect or control apps on the simulator. "find" lists simulator .app builds in the user\'s DerivedData (newest first); "run" installs when needed and launches; "install" accepts app_path or a bundle_id resolved from DerivedData. Also: list user apps, launch/terminate/uninstall, and print container paths.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          action: {
            type: 'string',
            enum: ['list', 'find', 'install', 'launch', 'terminate', 'uninstall', 'container', 'run'],
            description:
              'Operation to perform. "find" needs no device; "run" installs (when needed) and launches; "container" prints a data/app/groups path.',
          },
          bundle_id: {
            type: 'string',
            description: 'App bundle identifier, for launch/terminate/uninstall/container/run/install-by-bundle.',
          },
          app_path: {
            type: 'string',
            description: 'Path to a simulator .app bundle for install/run (absolute, or relative to the session workspace).',
          },
          container: {
            type: 'string',
            enum: ['data', 'app', 'groups'],
            description: 'Container kind for the container action (default data).',
          },
          filter: {
            type: 'string',
            description: 'Case-insensitive name or bundle-id filter for the list and find actions.',
          },
        },
        required: ['action'],
      },
      async execute(args, exec) {
        const action = readEnum(
          args,
          'action',
          ['list', 'find', 'install', 'launch', 'terminate', 'uninstall', 'container', 'run'],
          { required: true, label: 'action' },
        )

        if (action === 'find') {
          const filter = readString(args, 'filter', { label: 'filter' })
          const apps = await findBuiltApps(filter)
          if (apps.length === 0) {
            return {
              text:
                filter === undefined
                  ? 'No simulator .app builds found in ~/Library/Developer/Xcode/DerivedData.'
                  : `No simulator .app builds match "${filter}" in ~/Library/Developer/Xcode/DerivedData.`,
            }
          }
          const shown = apps.slice(0, 25)
          const lines = shown.map(
            (app) =>
              `  • ${app.name} — ${app.bundleId}${app.version === undefined ? '' : ` — v${app.version}`}\n    ${app.path}\n    built ${app.modifiedAt}`,
          )
          const more = apps.length > shown.length ? `\n… ${apps.length - shown.length} more (narrow with filter).` : ''
          return { text: `${apps.length} built simulator app${apps.length === 1 ? '' : 's'} (newest first):\n${lines.join('\n')}${more}` }
        }

        const { device, bootedNow } = await readyDevice(args, exec)
        const bundleId = readString(args, 'bundle_id', { label: 'bundle_id' })

        if (action === 'list') {
          const text = await listUserApps(backend, device, readString(args, 'filter', { label: 'filter' }), exec.signal)
          return { text }
        }
        if (action === 'install') {
          const rawPath = readString(args, 'app_path', { label: 'app_path' })
          const appPath = rawPath === undefined ? undefined : resolveUserPath(ctx, exec, rawPath)
          if (appPath === undefined && bundleId === undefined) {
            throw new Error('install needs app_path, or bundle_id to locate a DerivedData simulator build')
          }
          const result = await installApp(backend, device, { appPath, bundleId }, exec.signal)
          return {
            text: `${bootNote(bootedNow, device)}Installed ${result.bundleId ?? 'app'} from ${result.path} on ${deviceLabel(device)}.`,
          }
        }
        if (action === 'run') {
          const rawPath = readString(args, 'app_path', { label: 'app_path' })
          const appPath = rawPath === undefined ? undefined : resolveUserPath(ctx, exec, rawPath)
          if (appPath === undefined && bundleId === undefined) {
            throw new Error('run needs bundle_id, or app_path to install then launch')
          }
          const result = await runApp(backend, device, { appPath, bundleId }, exec.signal)
          const installed = result.installedPath === undefined ? '' : ` Installed from ${result.installedPath}.`
          return {
            text: `${bootNote(bootedNow, device)}Launched ${result.bundleId} on ${deviceLabel(device)} (${result.detail}).${installed}`,
          }
        }
        if (bundleId === undefined) {
          throw new Error(`${action} needs bundle_id`)
        }
        if (action === 'launch') {
          const result = await launchApp(backend, device, bundleId, exec.signal)
          return { text: `${bootNote(bootedNow, device)}Launched ${result.bundleId} on ${deviceLabel(device)} (${result.detail}).` }
        }
        if (action === 'terminate') {
          const result = await terminateApp(backend, device, bundleId, exec.signal)
          return {
            text: result.wasRunning
              ? `${bootNote(bootedNow, device)}Terminated ${bundleId} on ${deviceLabel(device)}.`
              : `${bundleId} was not running on ${deviceLabel(device)}.`,
          }
        }
        if (action === 'uninstall') {
          await uninstallApp(backend, device, bundleId, exec.signal)
          return { text: `${bootNote(bootedNow, device)}Uninstalled ${bundleId} from ${deviceLabel(device)}.` }
        }
        const kind = readEnum(args, 'container', ['data', 'app', 'groups'], { label: 'container' }) ?? 'data'
        const result = await getAppContainer(backend, device, bundleId, kind, exec.signal)
        return {
          text: `${bootNote(bootedNow, device)}${kind} container of ${bundleId} on ${deviceLabel(device)}:\n${result.path}`,
        }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_env',
      description:
        'Adjust the simulator environment or show its window: appearance, status bar override, simulated location, privacy grants, pasteboard, or the Xcode Device Hub window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          action: {
            type: 'string',
            enum: ['appearance', 'status_bar', 'location', 'privacy', 'pasteboard', 'display'],
            description:
              'environment facet. appearance: optional value light|dark. status_bar: clear or override fields. location: latitude+longitude or clear=true. privacy: mode+service[+bundle_id]. pasteboard: optional text (omit to read). display: open Device Hub (no device needed).',
          },
          value: { type: 'string', enum: ['light', 'dark'], description: 'Appearance value for the appearance action.' },
          clear: { type: 'boolean', description: 'Clear the current status bar override or simulated location.' },
          time: { type: 'string', description: 'Status bar clock text, for example "9:41".' },
          battery_level: { type: 'number', description: 'Status bar battery percentage, 0-100.' },
          battery_state: {
            type: 'string',
            enum: ['charging', 'charged', 'discharging'],
            description: 'Status bar battery state.',
          },
          wifi_bars: { type: 'number', description: 'Status bar Wi-Fi bars, 0-3.' },
          cellular_bars: { type: 'number', description: 'Status bar cellular bars, 0-4.' },
          latitude: { type: 'number', description: 'Simulated latitude, -90 to 90.' },
          longitude: { type: 'number', description: 'Simulated longitude, -180 to 180.' },
          mode: {
            type: 'string',
            enum: ['grant', 'revoke', 'reset'],
            description: 'Privacy operation (default grant).',
          },
          service: {
            type: 'string',
            description:
              'Privacy service: all, calendar, contacts-limited, contacts, location, location-always, photos-add, photos, media-library, microphone, motion, reminders, siri.',
          },
          bundle_id: { type: 'string', description: 'App bundle id for privacy operations (required for most services).' },
          text: { type: 'string', description: 'Pasteboard text to write; omit to read the pasteboard.' },
        },
        required: ['action'],
      },
      async execute(args, exec) {
        const action = readEnum(
          args,
          'action',
          ['appearance', 'status_bar', 'location', 'privacy', 'pasteboard', 'display'],
          { required: true, label: 'action' },
        )
        if (action === 'display') {
          await openDeviceHub()
          return { text: 'Opened the Device Hub window.' }
        }
        const { device, bootedNow } = await readyDevice(args, exec)
        const prefix = bootNote(bootedNow, device)
        if (action === 'appearance') {
          const appearance = readEnum(args, 'value', ['light', 'dark'], { label: 'value' })
          if (appearance === undefined) {
            const result = await backend.simctlOk(['ui', device.udid, 'appearance'], 'read appearance', {
              timeoutMs: 30_000,
              signal: exec.signal,
            })
            return { text: `${prefix}Appearance of ${deviceLabel(device)}: ${result.stdout.trim() || 'unknown'}.` }
          }
          await backend.simctlOk(['ui', device.udid, 'appearance', appearance], 'set appearance', {
            timeoutMs: 30_000,
            signal: exec.signal,
          })
          return { text: `${prefix}Set ${deviceLabel(device)} appearance to ${appearance}.` }
        }
        if (action === 'status_bar') {
          if (readBoolean(args, 'clear')) {
            await backend.simctlOk(['status_bar', device.udid, 'clear'], 'clear status bar', {
              timeoutMs: 30_000,
              signal: exec.signal,
            })
            return { text: `${prefix}Cleared the status bar override on ${deviceLabel(device)}.` }
          }
          const command = ['status_bar', device.udid, 'override']
          let overridden = false
          const time = readString(args, 'time', { label: 'time' })
          if (time !== undefined) {
            command.push('--time', time)
            overridden = true
          }
          const batteryLevel = readNumber(args, 'battery_level', { min: 0, max: 100, label: 'battery_level' })
          if (batteryLevel !== undefined) {
            command.push('--batteryLevel', String(batteryLevel))
            overridden = true
          }
          const batteryState = readEnum(args, 'battery_state', ['charging', 'charged', 'discharging'], {
            label: 'battery_state',
          })
          if (batteryState !== undefined) {
            command.push('--batteryState', batteryState)
            overridden = true
          }
          const wifiBars = readNumber(args, 'wifi_bars', { min: 0, max: 3, label: 'wifi_bars' })
          if (wifiBars !== undefined) {
            command.push('--wifiBars', String(wifiBars))
            overridden = true
          }
          const cellularBars = readNumber(args, 'cellular_bars', { min: 0, max: 4, label: 'cellular_bars' })
          if (cellularBars !== undefined) {
            command.push('--cellularBars', String(cellularBars))
            overridden = true
          }
          if (!overridden) {
            throw new Error('Provide at least one status bar field, or clear=true to remove the override')
          }
          await backend.simctlOk(command, 'status bar override', { timeoutMs: 30_000, signal: exec.signal })
          return { text: `${prefix}Applied the status bar override on ${deviceLabel(device)}.` }
        }
        if (action === 'location') {
          const latitude = readNumber(args, 'latitude', { min: -90, max: 90, label: 'latitude' })
          const longitude = readNumber(args, 'longitude', { min: -180, max: 180, label: 'longitude' })
          if (latitude === undefined && longitude === undefined) {
            if (!readBoolean(args, 'clear')) {
              throw new Error('Provide both latitude and longitude, or clear=true to clear the simulated location')
            }
            await backend.simctlOk(['location', device.udid, 'clear'], 'clear location', {
              timeoutMs: 30_000,
              signal: exec.signal,
            })
            return { text: `${prefix}Cleared the simulated location on ${deviceLabel(device)}.` }
          }
          if (latitude === undefined || longitude === undefined) {
            throw new Error('Provide both latitude and longitude, or neither to clear')
          }
          await backend.simctlOk(['location', device.udid, 'set', `${latitude},${longitude}`], 'set location', {
            timeoutMs: 30_000,
            signal: exec.signal,
          })
          return { text: `${prefix}Set the simulated location of ${deviceLabel(device)} to ${latitude},${longitude}.` }
        }
        if (action === 'privacy') {
          const mode = readEnum(args, 'mode', ['grant', 'revoke', 'reset'], { label: 'mode' }) ?? 'grant'
          const service = readString(args, 'service', { required: true, label: 'service' })
          const bundleId = readString(args, 'bundle_id', { label: 'bundle_id' })
          if (mode !== 'reset' && bundleId === undefined) {
            throw new Error('bundle_id is required to grant or revoke privacy permissions (reset accepts an optional bundle_id)')
          }
          const command = ['privacy', device.udid, mode, service]
          if (bundleId !== undefined) command.push(bundleId)
          await backend.simctlOk(command, `${mode} privacy`, { timeoutMs: 30_000, signal: exec.signal })
          return {
            text: `${prefix}${mode === 'grant' ? 'Granted' : mode === 'revoke' ? 'Revoked' : 'Reset'} privacy "${service}"${bundleId === undefined ? '' : ` for ${bundleId}`} on ${deviceLabel(device)}.`,
          }
        }
        const text = readText(args, 'text', { label: 'text' })
        if (text === undefined) {
          const result = await backend.simctlOk(['pbpaste', device.udid], 'read pasteboard', {
            timeoutMs: 30_000,
            signal: exec.signal,
          })
          return { text: `${prefix}Pasteboard of ${deviceLabel(device)}:\n${clipToString(result.stdout, 4000) || '(empty)'}` }
        }
        await backend.simctlOk(['pbcopy', device.udid], 'write pasteboard', {
          timeoutMs: 30_000,
          signal: exec.signal,
          input: text,
        })
        let note = ''
        try {
          const verify = await backend.simctl(['pbpaste', device.udid], { timeoutMs: 30_000, signal: exec.signal })
          const current = verify.stdout.trim()
          if (verify.code === 0 && current !== text) {
            note = ` The device pasteboard currently reads "${clipToString(current, 120) || '(empty)'}" — a simulator pasteboard synced with the host clipboard can override this write.`
          }
        } catch {
          // Verification is best-effort.
        }
        return { text: `${prefix}Wrote ${text.length} characters to the pasteboard of ${deviceLabel(device)}.${note}` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_logs',
      description:
        'Read recent simulator log output, optionally filtered by an NSPredicate. Useful for diagnosing crashes and app errors after an interaction.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: DEVICE_PARAMETER,
          predicate: {
            type: 'string',
            description: 'Optional log predicate, for example "process == \\"MyApp\\" or eventMessage CONTAINS[c] \\"error\\"".',
          },
          last_seconds: { type: 'number', description: 'Window of recent log history in seconds (default 30).' },
          limit: { type: 'integer', description: 'Maximum lines to return, newest last (default 150).' },
        },
      },
      concurrencySafe: true,
      async execute(args, exec) {
        const { device } = await readyDevice(args, exec)
        const predicate = readString(args, 'predicate', { label: 'predicate' })
        const lastSeconds = readNumber(args, 'last_seconds', { min: 1, max: 3600, label: 'last_seconds' }) ?? 30
        const limit = readNumber(args, 'limit', { integer: true, min: 1, max: 2000, label: 'limit' }) ?? 150
        const command = ['spawn', device.udid, 'log', 'show', '--style', 'compact', '--last', `${lastSeconds}s`]
        if (predicate !== undefined) command.push('--predicate', predicate)
        const result = await backend.simctlOk(command, 'read logs', { timeoutMs: 120_000, signal: exec.signal })
        const lines = result.stdout.split('\n').filter((line) => line.trim() !== '')
        if (lines.length === 0) {
          return { text: `No log lines found on ${deviceLabel(device)} in the last ${lastSeconds}s.` }
        }
        const shown = lines.slice(-limit)
        const header = `Logs from ${deviceLabel(device)} (last ${lastSeconds}s${predicate === undefined ? '' : `, predicate ${predicate}`}): ${lines.length} lines, showing the last ${shown.length}.`
        return { text: `${header}\n${shown.join('\n')}` }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_test',
      description:
        'Run a multi-step UI test on the simulator in one call and report per-step pass/fail. Supports steps: tap, type, swipe, button, open_url, sleep, screenshot, assert, launch, terminate, install. `assert` steps poll the accessibility tree until an element appears (or disappears with exists=false). Stops at the first failure by default and attaches a final screenshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['steps'],
        properties: {
          device: DEVICE_PARAMETER,
          steps: {
            type: 'array',
            description:
              'Ordered steps. Each is an object with an "action". Examples: {"action":"tap","id":"com.apple.settings.general"} | {"action":"type","text":"hello","submit":true} | {"action":"assert","label":"General","timeout":5} | {"action":"assert","id":"BackButton","exists":false} | {"action":"swipe","direction":"up"} | {"action":"button","button":"home"} | {"action":"sleep","seconds":1} | {"action":"screenshot"} | {"action":"launch","bundle_id":"com.example.app"} | {"action":"install","bundle_id":"com.example.app"} | {"action":"open_url","url":"myapp://screen"}.',
            items: { type: 'object', additionalProperties: true },
          },
          stop_on_failure: {
            type: 'boolean',
            description: 'Stop after the first failed step (default true).',
          },
          screenshot_on_failure: {
            type: 'boolean',
            description: 'Capture a screenshot when a step fails (default true).',
          },
          final_screenshot: {
            type: 'boolean',
            description: 'Capture and attach a screenshot after the flow (default true).',
          },
          settle: {
            type: 'number',
            description: 'Seconds to wait after tap/type/swipe/button/launch steps (default 0.6).',
          },
        },
      },
      output: screenshotOutput(),
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const rawSteps = args?.steps
        if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
          throw new Error('steps must be a non-empty array of step objects')
        }
        if (rawSteps.length > 200) throw new Error('steps is limited to 200 entries')
        const stopOnFailure = args?.stop_on_failure !== false
        const screenshotOnFailure = args?.screenshot_on_failure !== false
        const finalScreenshot = args?.final_screenshot !== false
        const settleSeconds = readNumber(args, 'settle', { min: 0, max: 10, label: 'settle' }) ?? 0.6
        const options = {
          settleMs: Math.round(settleSeconds * 1000),
          defaultTimeoutSeconds: 5,
          screenshots: [],
        }
        const lines = []
        let failures = 0
        for (let index = 0; index < rawSteps.length; index += 1) {
          const step = rawSteps[index]
          if (step === null || typeof step !== 'object' || Array.isArray(step)) {
            failures += 1
            lines.push(`FAIL ${index + 1}. (step is not an object)`)
            if (stopOnFailure) break
            continue
          }
          try {
            const detail = await runFlowStep(backend, ctx, exec, device, step, options)
            lines.push(`PASS ${index + 1}. ${describeStep(step)}${detail === undefined ? '' : ` — ${detail}`}`)
          } catch (error) {
            failures += 1
            lines.push(`FAIL ${index + 1}. ${describeStep(step)} — ${error instanceof Error ? error.message : String(error)}`)
            if (screenshotOnFailure) {
              try {
                const shot = await captureScreenshot(backend, ctx, exec, device)
                options.screenshots.push(shot.path)
              } catch {
                // A screenshot failure must not mask the step failure.
              }
            }
            if (stopOnFailure) break
          }
        }

        let finalShot
        if (finalScreenshot) {
          try {
            finalShot = await captureScreenshot(backend, ctx, exec, device)
          } catch {
            finalShot = undefined
          }
        }
        const executed = lines.length
        const passed = executed - failures
        let text = `${bootNote(bootedNow, device)}Flow on ${deviceLabel(device)}: ${passed}/${executed} steps passed${failures > 0 ? `, ${failures} failed` : ''}.`
        text += `\n${lines.join('\n')}`
        const uniqueScreenshots = [...new Set(options.screenshots)]
        if (uniqueScreenshots.length > 0) {
          text += `\nScreenshots: ${uniqueScreenshots.join(', ')}`
        }
        if (finalShot !== undefined) {
          if (finalShot.image !== undefined) {
            text += '\nThe final screenshot is attached.'
          } else if (finalShot.note !== undefined) {
            text += `\n${finalShot.note}`
          }
        }
        return {
          text,
          ...(finalShot === undefined ? {} : { path: finalShot.path }),
          ...(finalShot?.image === undefined ? {} : { image: finalShot.image }),
        }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_video',
      description:
        'Record a video clip of the simulator screen. Start a recording, reproduce the behavior, then stop to save an H.264 MP4 and get its path. Only one recording per simulator at a time.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          device: DEVICE_PARAMETER,
          action: {
            type: 'string',
            enum: ['start', 'stop'],
            description: 'start begins a recording; stop finalizes the active recording for the device.',
          },
          path: {
            type: 'string',
            description:
              'Optional output MP4 path for start (absolute, or relative to the session workspace). Defaults to a timestamped file in the system temporary directory.',
          },
        },
      },
      async execute(args, exec) {
        const { device, bootedNow } = await readyDevice(args, exec)
        const action = readEnum(args, 'action', ['start', 'stop'], { required: true, label: 'action' })
        if (action === 'start') {
          const requestedPath = readString(args, 'path', { label: 'path' })
          const resolvedPath = requestedPath === undefined ? undefined : resolveUserPath(ctx, exec, requestedPath)
          const started = await video.start(device, resolvedPath, exec.signal)
          return {
            text: `${bootNote(bootedNow, device)}Recording ${deviceLabel(device)} to ${started.path}. Reproduce the behavior, then call sim_video with action "stop".`,
          }
        }
        const stopped = await video.stop(device)
        const seconds = (stopped.durationMs / 1000).toFixed(1)
        return {
          text: `Recording saved: ${stopped.path} (${formatBytes(stopped.bytes)}, ${seconds}s${stopped.timedOut ? ', forced stop' : ''}).`,
        }
      },
    }),
  )

  tools.push(
    simTool({
      name: 'sim_doctor',
      description:
        'Check the simulator toolchain (Xcode, simctl, AXe, Device Hub), automatic boot settings, and report setup problems with suggested fixes.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      concurrencySafe: true,
      async execute() {
        const lines = []
        const xcodeSelect = await safeRun('/usr/bin/xcode-select', ['-p'], 10_000)
        const developerDirectory = xcodeSelect.stdout.trim()
        if (xcodeSelect.code === 0 && developerDirectory !== '') {
          lines.push(`✔ Developer directory: ${developerDirectory}`)
        } else {
          lines.push('✖ No Xcode developer directory selected. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer')
        }
        const xcodeVersion = await safeRun('/usr/bin/xcodebuild', ['-version'], 30_000)
        if (xcodeVersion.code === 0) {
          lines.push(`✔ ${xcodeVersion.stdout.trim().split('\n').slice(0, 2).join(' ')}`)
        } else {
          lines.push('✖ xcodebuild is unavailable; install or select a full Xcode (Command Line Tools are not enough for simulators).')
        }
        try {
          const axe = await backend.findAxe()
          lines.push(`✔ AXe ${axe.version}: ${axe.path}`)
        } catch (error) {
          lines.push(`✖ ${error instanceof Error ? error.message : String(error)}`)
        }
        const hub = await stat(DEVICE_HUB_PATH).catch(() => undefined)
        lines.push(
          hub === undefined ? `✖ Device Hub not found at ${DEVICE_HUB_PATH}` : `✔ Device Hub: ${DEVICE_HUB_PATH}`,
        )
        lines.push(
          `✔ Automatic boot: ${settings.autoBoot ? 'enabled' : 'disabled (DSH_SIM_AUTOBOOT=0)'}${settings.defaultDevice === '' ? '' : `, preferred device "${settings.defaultDevice}"`}`,
        )
        try {
          const devices = await listAllDevices(backend)
          const available = devices.filter((device) => device.isAvailable)
          const booted = available.filter((device) => device.state === 'Booted')
          lines.push(
            `✔ ${available.length} available simulators, ${booted.length} booted${booted.length === 0 ? '' : `: ${booted.map((device) => device.name).join(', ')}`}`,
          )
          const pick = chooseDefaultDevice(devices, settings.defaultDevice)
          if (pick !== undefined) lines.push(`✔ Auto-boot target: ${pick.name} (${pick.runtime})`)
        } catch (error) {
          lines.push(`✖ Could not list simulators: ${error instanceof Error ? error.message : String(error)}`)
        }
        const posterCrashes = await countRecentPosterBoardCrashes()
        lines.push(
          posterCrashes === 0
            ? '✔ No PosterBoard (simulator wallpaper service) crash reports in the last 24h.'
            : `⚠ ${posterCrashes} PosterBoard crash report${posterCrashes === 1 ? '' : 's'} in the last 24h. A simulator stuck in this loop usually needs a reboot, or an erase from Device Hub; the plugin settles boot/shutdown transitions to avoid causing it.`,
        )
        return { text: `Simulator toolchain check\n${lines.join('\n')}` }
      },
    }),
  )

  return tools
}

function clipToString(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value.trim()
  return `${value.slice(0, max)}…`
}

async function safeRun(command, args, timeoutMs) {
  try {
    return await run(command, args, { timeoutMs })
  } catch (error) {
    return {
      code: -1,
      timedOut: false,
      aborted: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Count recent simulator PosterBoard crash reports. PosterBoard is the
 * simulator's wallpaper/poster service; on Xcode 27.1 it can enter a crash loop
 * after abrupt simulator boot/shutdown cycles, independent of any tool call.
 */
async function countRecentPosterBoardCrashes(withinMs = 24 * 60 * 60 * 1000) {
  const directory = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - withinMs
  let count = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('PosterBoard-') || !entry.name.endsWith('.ips')) continue
    try {
      const info = await stat(join(directory, entry.name))
      if (info.mtimeMs >= cutoff) count += 1
    } catch {
      // Skip unreadable reports.
    }
  }
  return count
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const settings = loadSettings()
  const backend = createBackend({ axe: settings.axePath })
  const video = createVideoManager()
  try {
    ctx.effect(() => () => video.dispose())
  } catch {
    // Cleanup is best-effort; recording handles are also reaped by process exit.
  }
  let order = 500
  try {
    order = ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 0.5
  } catch {
    // A future prompt-order rename must not disable the plugin.
  }
  ctx.systemPrompt.section({ name: 'tool:simulator', order, text: PROMPT_SECTION })
  for (const definition of buildToolDefinitions(ctx, backend, settings, video)) {
    ctx.tools.register(definition)
  }
  // The side panel's HTTP routes live on the Web carrier; headless profiles
  // simply do not mount it and keep the tool-only surface.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      registerWebRoutes(webCtx, backend, settings)
    })
  }
}
