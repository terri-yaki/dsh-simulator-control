/** Model-facing formatting for device lists, app lists, and AXe accessibility trees. */

const ACTIONABLE_TYPES = new Set([
  'Application',
  'Alert',
  'Button',
  'Cell',
  'CheckBox',
  'CollectionViewCell',
  'Image',
  'Link',
  'NavigationBar',
  'PopUpButton',
  'RadioButton',
  'SearchField',
  'SecureTextField',
  'SegmentedControl',
  'Sheet',
  'Slider',
  'StaticText',
  'Switch',
  'TabBar',
  'TabBarItem',
  'TextField',
  'TextView',
  'Toggle',
])

const MAX_LABEL_CHARS = 140
const MAX_INDENT_DEPTH = 14

function cleanText(value) {
  if (typeof value !== 'string') return undefined
  const collapsed = value.replaceAll(/\s+/g, ' ').trim()
  if (collapsed === '') return undefined
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS)}…` : collapsed
}

function cleanValue(value) {
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function nodeType(node) {
  return String(node.type ?? node.role ?? 'Element')
}

function nodeText(node) {
  return {
    type: nodeType(node),
    label: cleanText(node.AXLabel),
    id: cleanText(node.AXUniqueId),
    value: cleanValue(node.AXValue),
    frame: node.frame !== null && typeof node.frame === 'object' ? node.frame : undefined,
  }
}

function hasOwnContent(node) {
  const text = nodeText(node)
  return text.label !== undefined || text.id !== undefined || text.value !== undefined
}

function isMeaningful(node) {
  const text = nodeText(node)
  return (
    text.label !== undefined ||
    text.id !== undefined ||
    text.value !== undefined ||
    ACTIONABLE_TYPES.has(text.type)
  )
}

function formatFrame(frame) {
  if (frame === undefined) return ''
  const { x, y, width, height } = frame
  if (![x, y, width, height].every((value) => typeof value === 'number')) return ''
  return ` @${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}`
}

/** Render one accessibility node as a compact single line. */
export function describeAxNode(node, depth = 0) {
  const text = nodeText(node)
  const indent = '  '.repeat(Math.min(depth, MAX_INDENT_DEPTH))
  const parts = [text.type]
  if (text.label !== undefined) parts.push(JSON.stringify(text.label))
  if (text.id !== undefined) parts.push(`#${text.id}`)
  if (text.value !== undefined) parts.push(`value=${text.value}`)
  const frame = formatFrame(text.frame)
  if (frame !== '') parts.push(frame.trim())
  if (node.enabled === false) parts.push('disabled')
  return `${indent}${parts.join(' ')}`
}

/**
 * Flatten an AXe `describe-ui` tree into compact, actionable lines.
 *
 * @param {unknown} roots parsed `axe describe-ui` JSON (array of applications, or one node).
 * @param {{ maxElements?: number, maxDepth?: number, includeContainers?: boolean }} [options]
 * @returns {{ lines: string[], total: number, shown: number, capped: boolean }}
 */
export function flattenAxTree(roots, options = {}) {
  const maxElements = options.maxElements ?? 200
  const maxDepth = options.maxDepth ?? 60
  const includeContainers = options.includeContainers === true
  const list = Array.isArray(roots) ? roots : roots === undefined || roots === null ? [] : [roots]
  const lines = []
  let total = 0
  let shown = 0
  let capped = false

  const walk = (node, depth, displayDepth) => {
    if (node === null || typeof node !== 'object') return
    total += 1
    const include = depth === 0 || includeContainers || isMeaningful(node)
    let childDisplayDepth = displayDepth
    if (include) {
      if (shown < maxElements && depth <= maxDepth) {
        lines.push(describeAxNode(node, displayDepth))
        shown += 1
        childDisplayDepth = displayDepth + 1
      } else {
        capped = true
      }
    }
    if (depth >= maxDepth) return
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) walk(child, depth + 1, childDisplayDepth)
  }

  for (const root of list) walk(root, 0, 0)
  return { lines, total, shown, capped }
}

/** Screen size in points from an AXe `describe-ui` tree, when available. */
export function screenSizeFromAxTree(roots) {
  const list = Array.isArray(roots) ? roots : [roots]
  for (const root of list) {
    const frame = root?.frame
    if (frame !== null && typeof frame === 'object' && typeof frame.width === 'number' && typeof frame.height === 'number') {
      return { width: frame.width, height: frame.height }
    }
  }
  return undefined
}

/** Render device records as a bounded, readable list. */
export function formatDeviceList(devices, options = {}) {
  const bootedOnly = options.bootedOnly === true
  const includeUnavailable = options.includeUnavailable === true
  const filtered = devices.filter(
    (device) => (includeUnavailable || device.isAvailable) && (!bootedOnly || device.state === 'Booted'),
  )
  const booted = filtered.filter((device) => device.state === 'Booted')
  const lines = []
  if (filtered.length === 0) {
    return bootedOnly
      ? 'No booted simulators. Run sim_devices (without booted_only) to see installed simulators.'
      : 'No simulators found. Install an iOS runtime in Xcode first.'
  }
  lines.push(`${filtered.length} simulator${filtered.length === 1 ? '' : 's'} (${booted.length} booted):`)
  if (booted.length > 0) {
    lines.push('Booted:')
    for (const device of booted) lines.push(`  • ${device.name} — ${device.runtime} — ${device.udid}`)
  }
  if (!bootedOnly) {
    const sorted = [...filtered].sort(
      (a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name),
    )
    lines.push('All:')
    for (const device of sorted) {
      const marker = device.state === 'Booted' ? ' [booted]' : ''
      const unavailable = device.isAvailable ? '' : ' [unavailable]'
      lines.push(`  • ${device.name} — ${device.runtime} — ${device.udid}${marker}${unavailable}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render installed user applications from `simctl listapps` converted to JSON.
 *
 * @param {Record<string, unknown>} data
 * @param {{ filter?: string }} [options]
 * @returns {string}
 */
export function formatUserApps(data, options = {}) {
  const filter = typeof options.filter === 'string' ? options.filter.trim().toLowerCase() : ''
  const apps = []
  for (const [bundleId, entry] of Object.entries(data ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry
    if (record.ApplicationType !== 'User') continue
    const name =
      cleanText(record.CFBundleDisplayName) ?? cleanText(record.CFBundleName) ?? bundleId
    const version = cleanText(record.CFBundleShortVersionString) ?? cleanText(record.CFBundleVersion) ?? '?'
    if (filter !== '' && !`${name} ${bundleId}`.toLowerCase().includes(filter)) continue
    apps.push({ name, bundleId, version })
  }
  if (apps.length === 0) {
    return filter === '' ? 'No user apps are installed on this simulator.' : `No user apps match "${filter}".`
  }
  apps.sort((a, b) => a.name.localeCompare(b.name))
  return `${apps.length} user app${apps.length === 1 ? '' : 's'}:\n${apps
    .map((app) => `  • ${app.name} — ${app.bundleId} — v${app.version}`)
    .join('\n')}`
}
