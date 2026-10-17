/**
 * Canonical simulator operations shared by the individual tools and the
 * multi-step `sim_test` flow runner.
 *
 * Keeping one implementation per operation means a flow step behaves exactly
 * like the equivalent single tool call.
 */

import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import { readBoolean, readEnum, readNumber, readString, readText } from './args.js'
import { clip, run, throwCommandFailure } from './exec.js'
import {
  chooseDefaultDevice,
  deviceLabel,
  findDeviceInList,
  listAllDevices,
} from './devices.js'
import { flattenAxTree, formatUserApps, screenSizeFromAxTree } from './format.js'

export const DEFAULT_SCREEN_SIZE = { width: 390, height: 844 }

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/* ------------------------------------------------------------------ */
/* AX tree helpers                                                     */
/* ------------------------------------------------------------------ */

/** Normalize `axe describe-ui` output (array for a full tree, object for --point). */
export function parseAxJson(text) {
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    throw new Error(`could not parse the accessibility tree: ${clip(text, 500) || '(empty output)'}`)
  }
}

export async function readAxTree(backend, device, options = {}) {
  const result = await backend.axeOk(['describe-ui', '--udid', device.udid], 'describe-ui', {
    timeoutMs: 60_000,
    ...options,
  })
  return parseAxJson(result.stdout)
}

function findNodeInTree(roots, matches) {
  const stack = []
  const list = Array.isArray(roots) ? roots : [roots]
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index] !== null && typeof list[index] === 'object') stack.push(list[index])
  }
  while (stack.length > 0) {
    const node = stack.pop()
    if (matches(node)) return node
    const children = Array.isArray(node.children) ? node.children : []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (children[index] !== null && typeof children[index] === 'object') stack.push(children[index])
    }
  }
  return undefined
}

/** Whether one accessibility node satisfies every field of an element matcher. */
export function matchesElement(node, matcher = {}) {
  if (matcher.label !== undefined && String(node.AXLabel ?? '') !== matcher.label) return false
  if (matcher.id !== undefined && String(node.AXUniqueId ?? '') !== matcher.id) return false
  if (matcher.value !== undefined && String(node.AXValue ?? '') !== matcher.value) return false
  if (matcher.type !== undefined && String(node.type ?? '') !== matcher.type) return false
  if (matcher.text !== undefined) {
    const haystack = `${node.AXLabel ?? ''}\n${node.AXValue ?? ''}`.toLowerCase()
    if (!haystack.includes(String(matcher.text).toLowerCase())) return false
  }
  return true
}

export function matcherFromArgs(args) {
  const matcher = {}
  const label = readString(args, 'label', { label: 'label' })
  if (label !== undefined) matcher.label = label
  const id = readString(args, 'id', { label: 'id' })
  if (id !== undefined) matcher.id = id
  const value = readString(args, 'value', { label: 'value' })
  if (value !== undefined) matcher.value = value
  const type = readString(args, 'type', { label: 'type' })
  if (type !== undefined) matcher.type = type
  const text = readString(args, 'text', { label: 'text' })
  if (text !== undefined) matcher.text = text
  if (Object.keys(matcher).length === 0) {
    throw new Error('Provide at least one of label, id, value, type, or text')
  }
  return matcher
}

export function describeMatcher(matcher) {
  const parts = []
  if (matcher.id !== undefined) parts.push(`#${matcher.id}`)
  if (matcher.label !== undefined) parts.push(`label "${matcher.label}"`)
  if (matcher.value !== undefined) parts.push(`value "${matcher.value}"`)
  if (matcher.type !== undefined) parts.push(`type ${matcher.type}`)
  if (matcher.text !== undefined) parts.push(`text "${matcher.text}"`)
  return parts.join(' & ')
}

export function findElementInTree(roots, matcher) {
  return findNodeInTree(roots, (node) => matchesElement(node, matcher))
}

/**
 * Poll the accessibility tree until an element appears (or disappears when
 * `present` is false).
 */
export async function pollElement(backend, device, matcher, options = {}) {
  const { present = true, timeoutMs = 5000, intervalMs = 300, signal } = options
  const deadline = Date.now() + timeoutMs
  let lastMatch
  let lastError
  for (;;) {
    if (signal?.aborted === true) throw new Error('the operation was cancelled')
    try {
      const roots = await readAxTree(backend, device, signal === undefined ? {} : { signal })
      lastMatch = findElementInTree(roots, matcher)
      if (present ? lastMatch !== undefined : lastMatch === undefined) {
        return { satisfied: true, match: lastMatch }
      }
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) return { satisfied: false, match: lastMatch, error: lastError }
    await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())))
  }
}

async function tryReadAxTree(backend, device, signal) {
  try {
    return await readAxTree(backend, device, signal === undefined ? {} : { signal })
  } catch {
    return undefined
  }
}

/** Whether the accessibility root is the springboard (home screen). */
export function isSpringboardTree(roots) {
  const root = Array.isArray(roots) ? roots[0] : roots
  if (root === null || typeof root !== 'object') return false
  const label = String(root.AXLabel ?? '').trim()
  if (label === '') return true
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (String(node.AXUniqueId ?? '') === 'Home screen icons') return true
    for (const child of node.children ?? []) stack.push(child)
  }
  return false
}

/** Process id of the foreground application from an accessibility tree. */
export function rootApplicationPid(roots) {
  const root = Array.isArray(roots) ? roots[0] : roots
  return typeof root?.pid === 'number' ? root.pid : undefined
}

/** Accessibility label of the root application (empty for the springboard). */
export function rootApplicationLabel(roots) {
  const root = Array.isArray(roots) ? roots[0] : roots
  return String(root?.AXLabel ?? '').trim()
}

const OVERLAY_LABELS = ['spotlight', 'siri', 'control center', 'notification center', 'app switcher']

/** Whether the root application looks like a dismissable system overlay. */
export function isSystemOverlay(roots) {
  const label = rootApplicationLabel(roots).toLowerCase()
  return OVERLAY_LABELS.some((name) => label.includes(name))
}

/** Map a simulator process id to the foreground app bundle id via launchctl. */
export async function resolveBundleIdForPid(backend, device, pid, signal) {
  const result = await backend.simctl(['spawn', device.udid, 'launchctl', 'list'], {
    timeoutMs: 20_000,
    signal,
  })
  if (result.code !== 0) return undefined
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+)\s+\S+\s+UIKitApplication:([^\s[]+)/u.exec(line)
    if (match === null) continue
    if (Number.parseInt(match[1], 10) === pid) return match[2]
  }
  return undefined
}

async function waitForSpringboard(backend, device, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const roots = await tryReadAxTree(backend, device, signal)
    if (roots !== undefined && isSpringboardTree(roots)) return true
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

/** Wait until a normal app (not the springboard, not a system overlay) is foreground. */
async function waitForAppForeground(backend, device, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const roots = await tryReadAxTree(backend, device, signal)
    if (roots !== undefined && !isSpringboardTree(roots) && !isSystemOverlay(roots)) return true
    if (Date.now() >= deadline) return false
    await sleep(200)
  }
}

/* ------------------------------------------------------------------ */
/* Workspace and attachment helpers                                    */
/* ------------------------------------------------------------------ */

export function sessionCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory === undefined || exec?.agent === undefined) return undefined
    return workingDirectory.get(exec.agent.session)
  } catch {
    return undefined
  }
}

export function resolveUserPath(ctx, exec, path) {
  if (isAbsolute(path)) return path
  return resolve(sessionCwd(ctx, exec) ?? process.cwd(), path)
}

export async function canAttachImages(ctx, exec) {
  try {
    const llm = ctx.get('llm')
    const agent = exec?.agent
    if (llm === undefined || agent === undefined) return false
    const routed = agent.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent.options?.provider
    const model = routed?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** Attach a saved image when the profile and model route can carry images. */
export async function attachScreenshot(ctx, exec, filePath) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    return { note: 'The image is not attached because this profile mounts no attachment store.' }
  }
  if (!(await canAttachImages(ctx, exec))) {
    return {
      note: 'The image is not attached because the current model route does not accept image input; use sim_describe_ui to inspect the UI instead.',
    }
  }
  try {
    const data = await readFile(filePath)
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(filePath) })
    return {
      image: {
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    }
  } catch (error) {
    return { note: `The screenshot was saved but could not be attached: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function openDeviceHub() {
  const deviceHubPath = '/Applications/Xcode.app/Contents/Applications/DeviceHub.app'
  const result = await run('/usr/bin/open', [deviceHubPath], { timeoutMs: 20_000 })
  if (result.timedOut || result.aborted || result.code !== 0) {
    throw new Error(`could not open Device Hub: ${clip(result.stderr || result.stdout, 500) || 'open failed'}`)
  }
}

/* ------------------------------------------------------------------ */
/* Device preparation                                                  */
/* ------------------------------------------------------------------ */

/** When this plugin booted a device; used to avoid shutting it down mid-initialization. */
const bootedAt = new Map()

/** Boot one simulator and wait until its automation connection is warm. */
export async function bootDevice(backend, device, options = {}) {
  const { waitSeconds = 180, signal } = options
  await backend.simctlOk(['boot', device.udid], 'boot', { timeoutMs: 60_000, signal })
  await backend.simctlOk(['bootstatus', device.udid, '-b'], 'bootstatus', {
    timeoutMs: Math.max(30, waitSeconds) * 1000,
    signal,
  })
  bootedAt.set(device.udid, Date.now())
  // The first accessibility connection after a boot is slow (seconds); warm it
  // up so the first tap is less likely to be dropped. Failure is not fatal.
  try {
    await backend.axeOk(['describe-ui', '--udid', device.udid], 'connect automation', {
      timeoutMs: 20_000,
      signal,
    })
  } catch {
    // The caller verifies interactions with sim_describe_ui anyway.
  }
}

/**
 * Shut down a simulator gracefully. A device this plugin booted moments ago is
 * given a short settle window first: pulling a simulator down while its system
 * services (notably PosterBoard, the wallpaper service) are still initializing
 * can leave the device in a crash-looping state on Xcode 27.1.
 */
export async function shutdownDevice(backend, device, options = {}) {
  const { signal, minUptimeMs = 12_000 } = options
  const bootedTime = bootedAt.get(device.udid)
  if (bootedTime !== undefined) {
    const remaining = minUptimeMs - (Date.now() - bootedTime)
    if (remaining > 0) await sleep(Math.min(remaining, minUptimeMs))
    bootedAt.delete(device.udid)
  }
  await backend.simctlOk(['shutdown', device.udid], 'shutdown', { timeoutMs: 120_000, signal })
}

/**
 * Resolve the target simulator and make sure it is booted. With no explicit
 * device this uses the only booted simulator, or — when none is booted —
 * boots the automatic choice (`defaultDevice`, else the most recently used
 * iPhone on the newest runtime).
 *
 * @returns {Promise<{ device: object, bootedNow: boolean }>}
 */
export async function ensureDevice(backend, requested, options = {}) {
  const { autoBoot = true, defaultDevice, waitSeconds = 180, signal } = options
  const devices = await listAllDevices(backend, signal === undefined ? {} : { signal })
  const available = devices.filter((device) => device.isAvailable)
  const query = typeof requested === 'string' ? requested.trim() : ''

  if (query !== '') {
    const device = findDeviceInList(devices, query)
    if (device.state === 'Booted') return { device, bootedNow: false }
    if (!autoBoot) {
      throw new Error(`Simulator ${deviceLabel(device)} is not booted (state: ${device.state}). Boot it with sim_boot first.`)
    }
    await bootDevice(backend, device, { waitSeconds, signal })
    return { device: { ...device, state: 'Booted' }, bootedNow: true }
  }

  const booted = available.filter((device) => device.state === 'Booted')
  if (booted.length === 1) return { device: booted[0], bootedNow: false }
  if (booted.length > 1) {
    throw new Error(
      `Multiple simulators are booted: ${booted.map(deviceLabel).join('; ')}. Pass device (a name or UDID) to choose one.`,
    )
  }

  const pick = chooseDefaultDevice(devices, defaultDevice)
  if (pick === undefined) {
    throw new Error('No simulator is installed. Install an iOS runtime in Xcode first (Xcode > Settings > Components).')
  }
  if (!autoBoot) {
    throw new Error(
      `No simulator is booted and automatic boot is off. Boot ${deviceLabel(pick)} with sim_boot, or unset DSH_SIM_AUTOBOOT=0.`,
    )
  }
  await bootDevice(backend, pick, { waitSeconds, signal })
  return { device: { ...pick, state: 'Booted' }, bootedNow: true }
}

/* ------------------------------------------------------------------ */
/* Screen capture                                                      */
/* ------------------------------------------------------------------ */

function safeFilePart(name) {
  return String(name).replaceAll(/[^A-Za-z0-9_-]+/g, '-') || 'simulator'
}

/**
 * Capture the simulator screen to a PNG. Uses AXe's fast display path and
 * falls back to `simctl io` when AXe is unavailable.
 */
export async function captureScreenshot(backend, ctx, exec, device, requestedPath) {
  let filePath
  if (typeof requestedPath === 'string' && requestedPath.trim() !== '') {
    filePath = resolveUserPath(ctx, exec, requestedPath.trim())
  } else {
    const directory = resolve(tmpdir(), 'dsh-simulator')
    filePath = resolve(directory, `${safeFilePart(device.name)}-${Date.now()}.png`)
  }
  await mkdir(dirname(filePath), { recursive: true })
  try {
    await backend.axeOk(['screenshot', '--udid', device.udid, '--output', filePath], 'screenshot', {
      timeoutMs: 30_000,
      signal: exec?.signal,
    })
  } catch {
    await backend.simctlOk(['io', device.udid, 'screenshot', '--type=png', filePath], 'screenshot', {
      timeoutMs: 30_000,
      signal: exec?.signal,
    })
  }
  const info = await stat(filePath)
  const attached = await attachScreenshot(ctx, exec, filePath)
  return { path: filePath, bytes: info.size, ...attached }
}

/* ------------------------------------------------------------------ */
/* Input actions                                                       */
/* ------------------------------------------------------------------ */

/** Tap an element (label/id/value, with optional element-type filter) or a point. */
export async function tapAction(backend, device, args, signal) {
  const x = readNumber(args, 'x', { label: 'x' })
  const y = readNumber(args, 'y', { label: 'y' })
  const label = readString(args, 'label', { label: 'label' })
  const id = readString(args, 'id', { label: 'id' })
  const value = readString(args, 'value', { label: 'value' })
  const hasPoint = x !== undefined || y !== undefined
  if (hasPoint && (x === undefined || y === undefined)) {
    throw new Error('Provide both x and y for a coordinate tap')
  }
  if (!hasPoint && label === undefined && id === undefined && value === undefined) {
    throw new Error('Provide label, id, value, or x and y for the tap target')
  }
  const tapStyle =
    readEnum(args, 'tap_style', ['physical', 'automatic', 'simulator'], { label: 'tap_style' }) ?? 'physical'
  const command = ['tap', '--udid', device.udid, '--tap-style', tapStyle]
  let target
  if (hasPoint) {
    command.push('-x', String(x), '-y', String(y))
    target = `(${x}, ${y})`
  } else {
    if (label !== undefined) {
      command.push('--label', label)
      target = `"${label}"`
    } else if (id !== undefined) {
      command.push('--id', id)
      target = `#${id}`
    } else {
      command.push('--value', value)
      target = `value "${value}"`
    }
    const elementType = readString(args, 'element_type', { label: 'element_type' })
    if (elementType !== undefined) command.push('--element-type', elementType)
    const waitTimeout = readNumber(args, 'wait_timeout', { min: 0, max: 300, label: 'wait_timeout' }) ?? 2
    command.push('--wait-timeout', String(waitTimeout))
  }
  const preDelay = readNumber(args, 'pre_delay', { min: 0, max: 60, label: 'pre_delay' })
  if (preDelay !== undefined) command.push('--pre-delay', String(preDelay))
  await backend.axeOk(command, 'tap', { timeoutMs: 120_000, signal })
  return { target }
}

/** Type into the focused field (optionally select-all first, optionally submit). */
export async function typeAction(backend, device, args, signal) {
  const text = readText(args, 'text', { required: true, label: 'text' })
  const replace = readBoolean(args, 'replace')
  if (replace) {
    await backend.axeOk(['key-combo', '--modifiers', '227', '--key', '4', '--udid', device.udid], 'select all', {
      timeoutMs: 30_000,
      signal,
    })
  }
  await backend.axeOk(['type', '--stdin', '--udid', device.udid], 'type', {
    timeoutMs: 120_000,
    signal,
    input: text,
  })
  const submit = readBoolean(args, 'submit')
  if (submit) {
    await backend.axeOk(['key', '40', '--udid', device.udid], 'return key', {
      timeoutMs: 30_000,
      signal,
    })
  }
  return { length: text.length, submit, replace }
}

/** Swipe by direction (from the measured screen centre) or explicit points. */
export async function swipeAction(backend, device, args, signal) {
  const direction = readEnum(args, 'direction', ['up', 'down', 'left', 'right'], { label: 'direction' })
  const duration = readNumber(args, 'duration', { min: 0.05, max: 10, label: 'duration' }) ?? 0.25
  let startX
  let startY
  let endX
  let endY
  if (direction !== undefined) {
    let size = DEFAULT_SCREEN_SIZE
    try {
      const roots = await readAxTree(backend, device, signal === undefined ? {} : { signal })
      size = screenSizeFromAxTree(roots) ?? DEFAULT_SCREEN_SIZE
    } catch {
      // A missing tree just means we fall back to a typical phone size.
    }
    const centreX = Math.round(size.width / 2)
    const centreY = Math.round(size.height / 2)
    const deltaX = Math.max(40, Math.round(size.width * 0.3))
    const deltaY = Math.max(40, Math.round(size.height * 0.3))
    if (direction === 'up') [startX, startY, endX, endY] = [centreX, centreY + deltaY, centreX, centreY - deltaY]
    if (direction === 'down') [startX, startY, endX, endY] = [centreX, centreY - deltaY, centreX, centreY + deltaY]
    if (direction === 'left') [startX, startY, endX, endY] = [centreX + deltaX, centreY, centreX - deltaX, centreY]
    if (direction === 'right') [startX, startY, endX, endY] = [centreX - deltaX, centreY, centreX + deltaX, centreY]
  } else {
    startX = readNumber(args, 'start_x', { label: 'start_x' })
    startY = readNumber(args, 'start_y', { label: 'start_y' })
    endX = readNumber(args, 'end_x', { label: 'end_x' })
    endY = readNumber(args, 'end_y', { label: 'end_y' })
    if ([startX, startY, endX, endY].some((value) => value === undefined)) {
      throw new Error('Provide direction, or all of start_x, start_y, end_x and end_y')
    }
  }
  await backend.axeOk(
    [
      'swipe',
      '--start-x',
      String(startX),
      '--start-y',
      String(startY),
      '--end-x',
      String(endX),
      '--end-y',
      String(endY),
      '--duration',
      String(duration),
      '--udid',
      device.udid,
    ],
    'swipe',
    { timeoutMs: 60_000, signal },
  )
  return { direction, startX, startY, endX, endY }
}

async function goHome(backend, device, signal) {
  const before = await tryReadAxTree(backend, device, signal)
  if (before !== undefined && isSpringboardTree(before)) {
    return { button: 'home', method: 'already-home' }
  }
  let lastButtonError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await backend.axeOk(['button', 'home', '--udid', device.udid], 'button home', {
        timeoutMs: 30_000,
        signal,
      })
    } catch (error) {
      lastButtonError = error
    }
    if (await waitForSpringboard(backend, device, 2500, signal)) {
      return { button: 'home', method: attempt === 0 ? 'button' : 'button-retry' }
    }
  }
  // Some Xcode/Device Hub states drop system HID events (Home/lock) while
  // touch/keyboard events keep working. Dismiss a system overlay with Escape.
  const overlayRoots = await tryReadAxTree(backend, device, signal)
  if (overlayRoots !== undefined && isSystemOverlay(overlayRoots)) {
    try {
      await backend.axeOk(['key', '41', '--udid', device.udid], 'escape key', {
        timeoutMs: 30_000,
        signal,
      })
    } catch {
      // Fall through to the other fallbacks.
    }
    if (await waitForSpringboard(backend, device, 2500, signal)) {
      return { button: 'home', method: 'escape' }
    }
    // Spotlight in particular can ignore injected Escape when its field is not
    // focused. Launching and terminating a system app dismisses the overlay.
    // Launch a system app, drop the Spotlight process while it is covered,
    // then terminate the app: SpringBoard lands on the last home screen page
    // instead of restoring the search overlay. Retry once if the launch
    // transition was still in flight.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      try {
        await backend.simctlOk(['launch', device.udid, 'com.apple.Preferences'], 'overlay dismissal', {
          timeoutMs: 20_000,
          signal,
        })
        await waitForAppForeground(backend, device, 4000, signal)
        await backend.simctl(['terminate', device.udid, 'com.apple.Spotlight'], {
          timeoutMs: 20_000,
          signal,
        })
        await sleep(300)
        await backend.simctl(['terminate', device.udid, 'com.apple.Preferences'], {
          timeoutMs: 20_000,
          signal,
        })
        if (await waitForSpringboard(backend, device, 3000, signal)) {
          return { button: 'home', method: 'app-cycle' }
        }
      } catch {
        // Retry the cycle once.
      }
      await sleep(500)
    }
  }
  const roots = overlayRoots ?? (await tryReadAxTree(backend, device, signal))
  const pid = roots === undefined ? undefined : rootApplicationPid(roots)
  if (pid !== undefined) {
    const bundleId = await resolveBundleIdForPid(backend, device, pid, signal)
    if (bundleId !== undefined) {
      const result = await backend.simctl(['terminate', device.udid, bundleId], {
        timeoutMs: 30_000,
        signal,
      })
      if (result.code === 0 && (await waitForSpringboard(backend, device, 3000, signal))) {
        return { button: 'home', method: 'terminate', bundleId }
      }
    }
  }
  const detail = lastButtonError instanceof Error ? `: ${lastButtonError.message}` : ''
  throw new Error(
    `The simulator ignored the Home button and no foreground app could be terminated to return home${detail}`,
  )
}

export async function buttonAction(backend, device, args, signal) {
  const button = readEnum(args, 'button', ['home', 'lock', 'side-button', 'siri', 'apple-pay'], {
    required: true,
    label: 'button',
  })
  if (button === 'home') return await goHome(backend, device, signal)
  const command = ['button', button, '--udid', device.udid]
  const duration = readNumber(args, 'duration', { min: 0, max: 60, label: 'duration' })
  if (duration !== undefined) command.push('--duration', String(duration))
  await backend.axeOk(command, `button ${button}`, { timeoutMs: 30_000, signal })
  return { button }
}

export async function openUrlAction(backend, device, args, signal) {
  const url = readString(args, 'url', { required: true, label: 'url' })
  await backend.simctlOk(['openurl', device.udid, url], 'openurl', { timeoutMs: 30_000, signal })
  return { url }
}

/* ------------------------------------------------------------------ */
/* Installed apps and DerivedData lookup                               */
/* ------------------------------------------------------------------ */

export async function listUserApps(backend, device, filter, signal) {
  const result = await backend.simctlOk(['listapps', device.udid], 'list apps', {
    timeoutMs: 60_000,
    signal,
  })
  const data = await backend.plutilJson(result.stdout, signal === undefined ? {} : { signal })
  return formatUserApps(data, { filter })
}

export async function installedBundleIds(backend, device, signal) {
  const result = await backend.simctlOk(['listapps', device.udid], 'list apps', {
    timeoutMs: 60_000,
    signal,
  })
  const data = await backend.plutilJson(result.stdout, signal === undefined ? {} : { signal })
  return new Set(Object.keys(data ?? {}))
}

async function plutilExtract(plistPath, key) {
  const result = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    timeoutMs: 10_000,
  })
  if (result.code !== 0) return undefined
  const value = result.stdout.trim()
  return value === '' || value === '(null)' ? undefined : value
}

/** Read display name, bundle id and version from a built simulator .app bundle. */
export async function readAppMetadata(appPath) {
  const plist = join(appPath, 'Info.plist')
  const [bundleId, displayName, bundleName, version] = await Promise.all([
    plutilExtract(plist, 'CFBundleIdentifier'),
    plutilExtract(plist, 'CFBundleDisplayName'),
    plutilExtract(plist, 'CFBundleName'),
    plutilExtract(plist, 'CFBundleShortVersionString'),
  ])
  return {
    bundleId,
    name: displayName ?? bundleName ?? basename(appPath).replace(/\.app$/u, ''),
    version,
  }
}

let builtAppsCache = { at: 0, apps: [] }

async function scanDerivedData() {
  const derivedData = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData')
  const apps = []
  let projects
  try {
    projects = await readdir(derivedData, { withFileTypes: true })
  } catch {
    return apps
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const productsBase = join(derivedData, project.name, 'Build', 'Products')
    let products
    try {
      products = await readdir(productsBase, { withFileTypes: true })
    } catch {
      continue
    }
    for (const product of products) {
      if (!product.isDirectory() || !/-iphonesimulator$/u.test(product.name)) continue
      const productDir = join(productsBase, product.name)
      let bundles
      try {
        bundles = await readdir(productDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const bundle of bundles) {
        if (!bundle.isDirectory() || !bundle.name.endsWith('.app')) continue
        const appPath = join(productDir, bundle.name)
        try {
          const info = await stat(appPath)
          const metadata = await readAppMetadata(appPath)
          if (metadata.bundleId === undefined) continue
          apps.push({
            name: metadata.name,
            bundleId: metadata.bundleId,
            version: metadata.version,
            path: appPath,
            modifiedAt: info.mtime.toISOString(),
            modifiedMs: info.mtimeMs,
          })
        } catch {
          // Unreadable bundles are skipped; the rest of the list stays usable.
        }
      }
    }
  }
  apps.sort((left, right) => right.modifiedMs - left.modifiedMs)
  return apps
}

/** Find simulator .app bundles built in the user's DerivedData, newest first. */
export async function findBuiltApps(filter) {
  if (Date.now() - builtAppsCache.at > 15_000) {
    builtAppsCache = { at: Date.now(), apps: await scanDerivedData() }
  }
  const query = typeof filter === 'string' ? filter.trim().toLowerCase() : ''
  if (query === '') return [...builtAppsCache.apps]
  return builtAppsCache.apps.filter(
    (app) => app.bundleId.toLowerCase().includes(query) || app.name.toLowerCase().includes(query),
  )
}

/** Newest built app matching a bundle identifier. */
export async function findBuiltApp(bundleId) {
  const apps = await findBuiltApps(bundleId)
  return apps.find((app) => app.bundleId === bundleId)
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

/**
 * Install a simulator build. With no explicit path, the newest DerivedData
 * build matching `bundleId` is used.
 */
export async function installApp(backend, device, options, signal) {
  const { appPath, bundleId } = options
  let targetPath = appPath
  let resolvedBundleId = bundleId
  if (targetPath === undefined) {
    if (bundleId === undefined) {
      throw new Error('Provide app_path, or bundle_id to locate a DerivedData simulator build')
    }
    const built = await findBuiltApp(bundleId)
    if (built === undefined) {
      throw new Error(
        `No simulator build for ${bundleId} was found in ~/Library/Developer/Xcode/DerivedData. Build it for a simulator destination, or pass app_path.`,
      )
    }
    targetPath = built.path
    resolvedBundleId = built.bundleId
  }
  const info = await stat(targetPath).catch(() => undefined)
  if (info === undefined) throw new Error(`app_path does not exist: ${targetPath}`)
  await backend.simctlOk(['install', device.udid, targetPath], 'install app', {
    timeoutMs: 180_000,
    signal,
  })
  if (resolvedBundleId === undefined) {
    resolvedBundleId = (await readAppMetadata(targetPath)).bundleId
  }
  return { path: targetPath, bundleId: resolvedBundleId }
}

export async function launchApp(backend, device, bundleId, signal) {
  const result = await backend.simctlOk(['launch', device.udid, bundleId], 'launch app', {
    timeoutMs: 60_000,
    signal,
  })
  return { bundleId, detail: result.stdout.trim() || 'started' }
}

export async function terminateApp(backend, device, bundleId, signal) {
  const result = await backend.simctl(['terminate', device.udid, bundleId], {
    timeoutMs: 30_000,
    signal,
  })
  if (result.timedOut || result.aborted) throwCommandFailure('simctl terminate app', result)
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`
    if (/found nothing to terminate|not running|No such process/i.test(detail)) {
      return { bundleId, wasRunning: false }
    }
    throwCommandFailure('simctl terminate app', result)
  }
  return { bundleId, wasRunning: true }
}

export async function uninstallApp(backend, device, bundleId, signal) {
  await backend.simctlOk(['uninstall', device.udid, bundleId], 'uninstall app', {
    timeoutMs: 60_000,
    signal,
  })
  return { bundleId }
}

export async function getAppContainer(backend, device, bundleId, kind, signal) {
  const result = await backend.simctlOk(['get_app_container', device.udid, bundleId, kind], 'get app container', {
    timeoutMs: 30_000,
    signal,
  })
  const containerPath = result.stdout.trim()
  if (containerPath === '' || containerPath === '(null)') {
    throw new Error(`${bundleId} has no ${kind} container on ${deviceLabel(device)}; system apps often do not expose one`)
  }
  return { kind, path: containerPath }
}

/**
 * Locate, install when needed, and launch a simulator app. `appPath` wins when
 * given; otherwise `bundleId` is looked up in DerivedData when the app is not
 * already installed on the device.
 */
export async function runApp(backend, device, options, signal) {
  const { appPath, bundleId } = options
  let targetBundleId = bundleId
  let installedPath
  if (appPath !== undefined) {
    const installed = await installApp(backend, device, { appPath }, signal)
    targetBundleId = installed.bundleId
    installedPath = installed.path
  } else {
    if (bundleId === undefined) throw new Error('Provide bundle_id, or app_path to install then launch')
    const installed = await installedBundleIds(backend, device, signal)
    if (!installed.has(bundleId)) {
      const result = await installApp(backend, device, { bundleId }, signal)
      installedPath = result.path
    }
  }
  if (targetBundleId === undefined) throw new Error('could not determine the app bundle identifier')
  const launched = await launchApp(backend, device, targetBundleId, signal)
  return { ...launched, installedPath }
}
