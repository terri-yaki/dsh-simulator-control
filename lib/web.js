/**
 * Host-side HTTP routes for the Simulator side panel.
 *
 * The Web GUI's client half polls `/simulator-control/frame` for the live
 * screen, reads `/simulator-control/state` for devices, and posts taps,
 * typing and boot/shutdown commands to `/simulator-control/action`.
 *
 * Every route applies the Connection trust checks (`requestRejection`), because
 * the raw webserver carrier has no authentication of its own.
 */

import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buttonAction,
  ensureDevice,
  launchApp,
  readAxTree,
  shutdownDevice,
  swipeAction,
  tapAction,
  terminateApp,
  typeAction,
} from './actions.js'
import { chooseDefaultDevice, deviceLabel, findDeviceInList, listAllDevices } from './devices.js'
import { run } from './exec.js'
import { screenSizeFromAxTree } from './format.js'

const ROUTE_PREFIX = '/simulator-control'
const MAX_BODY_BYTES = 64 * 1024
const FRAME_CACHE_MS = 200
const SCREEN_CACHE_MS = 15_000
const DEFAULT_SCREEN = { width: 402, height: 874 }

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

function authorize(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection === undefined) return true
  let rejection
  try {
    rejection = connection.requestRejection({ headers: req.headers })
  } catch {
    rejection = 401
  }
  if (rejection === undefined) return true
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('unauthorized')
  return false
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('request body must be JSON')
  }
}

function enqueue(chains, key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/**
 * Build the handlers plus their shared caches. Returned separately from route
 * registration so development tests can exercise the handlers directly.
 */
export function createWebRuntime(ctx, backend, settings) {
  const frameCache = new Map()
  const screenCache = new Map()
  const frameChains = new Map()
  const actionChains = new Map()

  async function captureFrame(device) {
    const cached = frameCache.get(device.udid)
    if (cached !== undefined && Date.now() - cached.at < FRAME_CACHE_MS) return cached.buffer
    const file = join(tmpdir(), 'dsh-simulator', `frame-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    await mkdir(dirname(file), { recursive: true })
    try {
      try {
        await backend.axeOk(['screenshot', '--udid', device.udid, '--output', file], 'screenshot', {
          timeoutMs: 15_000,
        })
      } catch {
        await backend.simctlOk(['io', device.udid, 'screenshot', '--type=png', file], 'screenshot', {
          timeoutMs: 15_000,
        })
      }
      // Downscale for the panel; the full-resolution PNG is 3–4 MB per frame.
      await run('/usr/bin/sips', ['-Z', '900', file], { timeoutMs: 5_000 }).catch(() => {})
      const buffer = await readFile(file)
      frameCache.set(device.udid, { at: Date.now(), buffer })
      if (frameCache.size > 8) frameCache.delete(frameCache.keys().next().value)
      return buffer
    } finally {
      await unlink(file).catch(() => {})
    }
  }

  async function screenPoints(device) {
    const cached = screenCache.get(device.udid)
    if (cached !== undefined && Date.now() - cached.at < SCREEN_CACHE_MS) return cached.size
    let size = DEFAULT_SCREEN
    try {
      const roots = await readAxTree(backend, device)
      size = screenSizeFromAxTree(roots) ?? DEFAULT_SCREEN
    } catch {
      // Keep the default; a stale estimate only shifts a tap slightly.
    }
    screenCache.set(device.udid, { at: Date.now(), size })
    return size
  }

  async function handleState(req, res) {
    if (!authorize(ctx, req, res)) return
    try {
      const devices = await listAllDevices(backend)
      const available = devices.filter((device) => device.isAvailable)
      const defaultDevice = chooseDefaultDevice(devices, settings.defaultDevice)
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('udid')
      const selected =
        (query === null ? undefined : available.find((device) => device.udid === query)) ?? defaultDevice ?? available[0]
      sendJson(res, 200, {
        ok: true,
        autoBoot: settings.autoBoot,
        selected: selected?.udid ?? null,
        devices: available.map((device) => ({
          name: device.name,
          udid: device.udid,
          runtime: device.runtime,
          booted: device.state === 'Booted',
        })),
      })
    } catch (error) {
      sendError(res, 500, error)
    }
  }

  async function handleFrame(req, res) {
    if (!authorize(ctx, req, res)) return
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const udid = url.searchParams.get('udid')
      if (udid === null || udid === '') {
        sendJson(res, 400, { ok: false, error: 'udid is required' })
        return
      }
      const devices = await listAllDevices(backend)
      let device
      try {
        device = findDeviceInList(devices, udid)
      } catch {
        sendJson(res, 404, { ok: false, error: 'unknown simulator' })
        return
      }
      if (device.state !== 'Booted') {
        sendJson(res, 409, { ok: false, error: `"${device.name}" is not booted` })
        return
      }
      const buffer = await enqueue(frameChains, device.udid, () => captureFrame(device))
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': String(buffer.length),
      })
      res.end(buffer)
    } catch (error) {
      sendError(res, 500, error)
    }
  }

  async function handleAction(req, res) {
    if (!authorize(ctx, req, res)) return
    try {
      const body = await readJsonBody(req)
      const udid = typeof body.udid === 'string' ? body.udid : ''
      const action = typeof body.action === 'string' ? body.action : ''
      if (udid === '' || action === '') {
        sendJson(res, 400, { ok: false, error: 'udid and action are required' })
        return
      }
      const devices = await listAllDevices(backend)
      let device
      try {
        device = findDeviceInList(devices, udid)
      } catch {
        sendJson(res, 404, { ok: false, error: 'unknown simulator' })
        return
      }
      const message = await enqueue(actionChains, device.udid, async () => await performAction(device, action, body))
      sendJson(res, 200, { ok: true, message })
    } catch (error) {
      sendError(res, 400, error)
    }
  }

  async function performAction(device, action, body) {
    if (action === 'boot') {
      const { bootedNow } = await ensureDevice(backend, device.udid, {
        autoBoot: true,
        defaultDevice: settings.defaultDevice,
        waitSeconds: settings.bootTimeout,
      })
      return `${bootedNow ? 'Booted' : 'Already booted'} ${deviceLabel(device)}.`
    }
    if (action === 'shutdown') {
      if (device.state !== 'Booted') return `${deviceLabel(device)} was already shut down.`
      await shutdownDevice(backend, device)
      return `Shut down ${deviceLabel(device)}.`
    }
    if (device.state !== 'Booted') throw new Error(`"${device.name}" is not booted`)
    if (action === 'tap') {
      const nx = typeof body.x === 'number' ? Math.min(Math.max(body.x, 0), 1) : undefined
      const ny = typeof body.y === 'number' ? Math.min(Math.max(body.y, 0), 1) : undefined
      if (nx === undefined || ny === undefined) throw new Error('tap needs normalized x and y')
      const size = await screenPoints(device)
      const x = Math.round(nx * size.width)
      const y = Math.round(ny * size.height)
      const result = await tapAction(backend, device, { x, y, tap_style: 'physical' })
      return `Tapped ${result.target}.`
    }
    if (action === 'type') {
      const text = typeof body.text === 'string' ? body.text : ''
      if (text === '') throw new Error('type needs text')
      const result = await typeAction(backend, device, { text, submit: body.submit === true })
      return `Typed ${result.length} character${result.length === 1 ? '' : 's'}${result.submit ? ' and pressed Return' : ''}.`
    }
    if (action === 'home') {
      const result = await buttonAction(backend, device, { button: 'home' })
      if (result.method === 'terminate') {
        return `Returned home by terminating ${result.bundleId ?? 'the foreground app'}.`
      }
      return 'Returned to the home screen.'
    }
    if (action === 'swipe') {
      const direction = typeof body.direction === 'string' ? body.direction : ''
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new Error('swipe needs direction up/down/left/right')
      }
      await swipeAction(backend, device, { direction })
      return `Swiped ${direction}.`
    }
    if (action === 'launch') {
      const bundleId = typeof body.bundle_id === 'string' ? body.bundle_id : ''
      if (bundleId === '') throw new Error('launch needs bundle_id')
      const result = await launchApp(backend, device, bundleId)
      return `Launched ${result.bundleId} (${result.detail}).`
    }
    if (action === 'terminate') {
      const bundleId = typeof body.bundle_id === 'string' ? body.bundle_id : ''
      if (bundleId === '') throw new Error('terminate needs bundle_id')
      const result = await terminateApp(backend, device, bundleId)
      return result.wasRunning ? `Terminated ${bundleId}.` : `${bundleId} was not running.`
    }
    throw new Error(`unknown action "${action}"`)
  }

  return { handleState, handleFrame, handleAction }
}

/**
 * Register the panel's HTTP routes on the Host webserver. Must be called with a
 * context whose `webServer` service is available.
 */
export function registerWebRoutes(ctx, backend, settings) {
  const runtime = createWebRuntime(ctx, backend, settings)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: runtime.handleState,
      }),
    'simulator-control: state route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/frame`,
        handler: runtime.handleFrame,
      }),
    'simulator-control: frame route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/action`,
        handler: runtime.handleAction,
      }),
    'simulator-control: action route',
  )
  return runtime
}
