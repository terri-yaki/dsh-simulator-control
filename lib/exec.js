/**
 * Process execution for the Simulator Control plugin.
 *
 * The Host process is typically launched from a GUI, so its PATH may not include
 * Homebrew. Absolute candidates are probed before falling back to PATH lookup.
 */

import { spawn } from 'node:child_process'

const OUTPUT_CAP_BYTES = 8 * 1024 * 1024
const XCRUN = '/usr/bin/xcrun'
const PLUTIL = '/usr/bin/plutil'
const AXE_CANDIDATES = [
  '/opt/homebrew/bin/axe',
  '/usr/local/bin/axe',
  '/opt/homebrew/opt/axe/bin/axe',
]
const AXE_INSTALL_HINT =
  'AXe (the iOS Simulator automation CLI this plugin uses for taps, swipes, typing and UI inspection) is not installed or not runnable. Install it once with `brew install cameroncooke/axe/axe`, then retry.'

/**
 * Spawn a process, collect bounded stdout/stderr, and honor caller cancellation.
 *
 * @param {string} command absolute executable path or PATH-resolved name.
 * @param {string[]} args argv (no shell involved).
 * @param {{ input?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean, aborted: boolean, stdout: string, stderr: string }>}
 */
export function run(command, args, options = {}) {
  const { input, timeoutMs = 120_000, signal } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let aborted = false
    let settled = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
      : undefined
    timer?.unref?.()
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
    }
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= OUTPUT_CAP_BYTES) stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= OUTPUT_CAP_BYTES) stderrChunks.push(chunk)
    })
    child.once('error', (error) => settle(reject, error))
    child.once('close', (code, signalName) =>
      settle(resolve, {
        code,
        signal: signalName,
        timedOut,
        aborted,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }),
    )
    child.stdin.on('error', () => {})
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input, 'utf8')
  })
}

/** Trim, normalize and elbow-clip command output for an error message. */
export function clip(text, max = 1200) {
  const normalized = String(text ?? '').replaceAll('\u0000', '').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}… (${normalized.length - max} more characters)`
}

/** Human-readable detail for a failed command result. */
export function failureText(result) {
  return clip(result.stderr, 1400) || clip(result.stdout, 1400) || `exit code ${result.code ?? 'unknown'}`
}

/** Throw an actionable Error for a failed command result. */
export function throwCommandFailure(label, result) {
  if (result.timedOut) throw new Error(`${label} timed out`)
  if (result.aborted) throw new Error(`${label} was cancelled`)
  const detail = failureText(result)
  const suffix = result.code === null || result.code === undefined ? '' : ` (exit ${result.code})`
  throw new Error(`${label} failed${suffix}: ${detail}`)
}

/**
 * Build the command backend used by the tool definitions.
 *
 * @param {{ axe?: string }} [config] optional explicit AXe executable path.
 * @returns {{
 *   simctl: (args: string[], options?: object) => Promise<object>,
 *   simctlOk: (args: string[], label: string, options?: object) => Promise<object>,
 *   axe: (args: string[], options?: object) => Promise<object>,
 *   axeOk: (args: string[], label: string, options?: object) => Promise<object>,
 *   findAxe: () => Promise<{ path: string, version: string }>,
 *   plutilJson: (text: string, options?: object) => Promise<unknown>,
 * }}
 */
export function createBackend(config = {}) {
  const axeOverride = typeof config.axe === 'string' && config.axe.trim() !== '' ? config.axe.trim() : undefined
  let axeLookup

  async function findAxe() {
    if (axeLookup === undefined) {
      axeLookup = (async () => {
        const failures = []
        for (const candidate of [...(axeOverride === undefined ? [] : [axeOverride]), ...AXE_CANDIDATES, 'axe']) {
          try {
            const probe = await run(candidate, ['--version'], { timeoutMs: 15_000 })
            if (probe.code === 0) {
              const version = /(\d+\.\d+(?:\.\d+)?)/.exec(probe.stdout)?.[1]
              return { path: candidate, version: version ?? probe.stdout.trim() }
            }
            failures.push(`${candidate}: exit ${probe.code ?? 'unknown'}`)
          } catch (error) {
            failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        throw new Error(`${AXE_INSTALL_HINT} Probe results: ${failures.join('; ')}`)
      })()
    }
    return await axeLookup
  }

  const simctl = async (args, options = {}) =>
    await run(XCRUN, ['simctl', ...args], { timeoutMs: 60_000, ...options })

  const simctlOk = async (args, label, options = {}) => {
    const result = await simctl(args, options)
    if (result.timedOut || result.aborted || result.code !== 0) throwCommandFailure(`simctl ${label}`, result)
    return result
  }

  const axe = async (args, options = {}) => {
    const resolved = await findAxe()
    return await run(resolved.path, args, { timeoutMs: 60_000, ...options })
  }

  const axeOk = async (args, label, options = {}) => {
    const result = await axe(args, options)
    if (result.timedOut || result.aborted || result.code !== 0) throwCommandFailure(`axe ${label}`, result)
    return result
  }

  const plutilJson = async (text, options = {}) => {
    const result = await run(PLUTIL, ['-convert', 'json', '-o', '-', '-'], {
      input: text,
      timeoutMs: 20_000,
      ...options,
    })
    if (result.timedOut || result.aborted || result.code !== 0) throwCommandFailure('plutil plist conversion', result)
    try {
      return JSON.parse(result.stdout)
    } catch (error) {
      throw new Error(`could not parse converted plist as JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { simctl, simctlOk, axe, axeOk, findAxe, plutilJson }
}
