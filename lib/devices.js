/** Device discovery, default selection, and name/UDID resolution for `xcrun simctl`. */

import { throwCommandFailure } from './exec.js'

/**
 * Turn a CoreSimulator runtime identifier into a readable runtime name.
 * `com.apple.CoreSimulator.SimRuntime.iOS-27-0` becomes `iOS 27.0`.
 *
 * @param {string} runtimeKey
 * @returns {string}
 */
export function parseRuntimeKey(runtimeKey) {
  const short = String(runtimeKey).split('.').pop() ?? String(runtimeKey)
  const match = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(short)
  if (match === null) return short
  return `${match[1]} ${match[2].split('-').join('.')}`
}

/** Parse a readable runtime name such as `iOS 27.0` into comparable numeric parts. */
export function parseRuntimeVersion(runtime) {
  const match = /(\d+(?:\.\d+)*)/.exec(String(runtime ?? ''))
  if (match === null) return [0]
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a - b
  }
  return 0
}

/**
 * Parse `xcrun simctl list devices --json` output.
 *
 * @param {string} jsonText
 * @returns {Array<{
 *   udid: string, name: string, state: string, runtime: string, runtimeKey: string,
 *   runtimeVersion: number[], isAvailable: boolean, lastUsedAt: string | undefined,
 *   deviceTypeIdentifier: string | undefined,
 * }>}
 */
export function parseDeviceList(jsonText) {
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('could not parse `xcrun simctl list devices --json` output')
  }
  const devices = []
  for (const [runtimeKey, entries] of Object.entries(parsed.devices ?? {})) {
    const runtime = parseRuntimeKey(runtimeKey)
    const runtimeVersion = parseRuntimeVersion(runtime)
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry === null || typeof entry !== 'object') continue
      devices.push({
        udid: String(entry.udid ?? ''),
        name: String(entry.name ?? ''),
        state: String(entry.state ?? 'Unknown'),
        runtime,
        runtimeKey,
        runtimeVersion,
        isAvailable: entry.isAvailable !== false,
        lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : undefined,
        deviceTypeIdentifier:
          typeof entry.deviceTypeIdentifier === 'string' ? entry.deviceTypeIdentifier : undefined,
      })
    }
  }
  return devices
}

/** List every simulator known to CoreSimulator, including unavailable runtimes. */
export async function listAllDevices(backend, options = {}) {
  const result = await backend.simctl(['list', 'devices', '--json'], { timeoutMs: 30_000, ...options })
  if (result.timedOut || result.aborted || result.code !== 0) throwCommandFailure('simctl list devices', result)
  return parseDeviceList(result.stdout)
}

/** Render one device as a stable, human-readable reference. */
export function deviceLabel(device) {
  return `"${device.name}" (${device.runtime}, ${device.udid})`
}

const SAMPLE_LIMIT = 8

function sampleDevices(devices) {
  return devices.slice(0, SAMPLE_LIMIT).map((device) => device.name).join(', ')
}

function isPhone(device) {
  return /iphone/i.test(device.name) || /iphone/i.test(device.deviceTypeIdentifier ?? '')
}

function lastUsedMs(device) {
  const parsed = Date.parse(device.lastUsedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Pick the simulator to boot when the caller did not choose one: the preferred
 * device when it exists, else the most recently used iPhone on the newest
 * runtime, else any most recently used device.
 *
 * @param {Awaited<ReturnType<typeof listAllDevices>>} devices
 * @param {string | undefined} preferred device name or UDID
 * @returns {(typeof devices)[number] | undefined}
 */
export function chooseDefaultDevice(devices, preferred) {
  const available = devices.filter((device) => device.isAvailable)
  const preference = typeof preferred === 'string' ? preferred.trim().toLowerCase() : ''
  if (preference !== '') {
    const preferredDevice =
      available.find((device) => device.udid.toLowerCase() === preference) ??
      available.find((device) => device.name.toLowerCase() === preference) ??
      available.find((device) => device.name.toLowerCase().includes(preference))
    if (preferredDevice !== undefined) return preferredDevice
  }
  if (available.length === 0) return undefined
  const phones = available.filter(isPhone)
  const pool = phones.length > 0 ? phones : available
  return [...pool].sort(
    (left, right) =>
      compareVersions(right.runtimeVersion, left.runtimeVersion) ||
      lastUsedMs(right) - lastUsedMs(left) ||
      left.name.localeCompare(right.name),
  )[0]
}

function pickFromNamed(devices, query) {
  if (devices.length === 0) return undefined
  if (devices.length === 1) return devices[0]
  const booted = devices.filter((device) => device.state === 'Booted')
  if (booted.length === 1) return booted[0]
  throw new Error(
    `"${query}" matches several simulators: ${devices
      .slice(0, SAMPLE_LIMIT)
      .map(deviceLabel)
      .join('; ')}. Pass the exact name or the UDID.`,
  )
}

/**
 * Resolve a model-supplied device reference against an already-fetched device
 * list. Empty references are not handled here (there may be several booted).
 *
 * @param {Awaited<ReturnType<typeof listAllDevices>>} devices
 * @param {string} requested
 * @returns {(typeof devices)[number]}
 */
export function findDeviceInList(devices, requested) {
  const query = String(requested ?? '').trim()
  const available = devices.filter((device) => device.isAvailable)
  for (const pool of [available, devices]) {
    const byUdid = pool.find((device) => device.udid.toLowerCase() === query.toLowerCase())
    if (byUdid !== undefined) return byUdid
    const exact = pool.filter((device) => device.name.toLowerCase() === query.toLowerCase())
    if (exact.length > 0) return pickFromNamed(exact, query)
    const partial = pool.filter((device) => device.name.toLowerCase().includes(query.toLowerCase()))
    if (partial.length > 0) return pickFromNamed(partial, query)
  }
  throw new Error(
    `No simulator matches "${query}". Run sim_devices to list available simulators (${sampleDevices(available) || 'none installed'}).`,
  )
}

/**
 * Resolve a device reference to one device record, validating its boot state.
 *
 * @param {{ simctl: Function }} backend
 * @param {string | undefined} requested
 * @param {{ requireBooted?: boolean, signal?: AbortSignal }} [options]
 */
export async function resolveDevice(backend, requested, options = {}) {
  const { requireBooted = true, signal } = options
  const devices = await listAllDevices(backend, signal === undefined ? {} : { signal })
  const query = typeof requested === 'string' ? requested.trim() : ''

  if (query === '') {
    const booted = devices.filter((device) => device.isAvailable && device.state === 'Booted')
    if (booted.length === 0) {
      throw new Error(
        'No simulator is booted. Boot one with sim_boot first (for example sim_boot with device "iPhone 17"); run sim_devices to list installed simulators.',
      )
    }
    if (booted.length > 1) {
      throw new Error(
        `Multiple simulators are booted: ${booted.map(deviceLabel).join('; ')}. Pass device (a name or UDID) to choose one.`,
      )
    }
    return booted[0]
  }

  const device = findDeviceInList(devices, query)
  if (requireBooted && device.state !== 'Booted') {
    throw new Error(`Simulator ${deviceLabel(device)} is not booted (state: ${device.state}). Boot it with sim_boot first.`)
  }
  return device
}
