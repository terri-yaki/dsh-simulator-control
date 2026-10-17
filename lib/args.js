/** Defensive readers for model-supplied tool arguments. */

export function readString(args, key, options = {}) {
  const { required = false, label = key, maxLength = 4000 } = options
  const raw = args?.[key]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new Error(`${label} is required`)
    return undefined
  }
  if (typeof raw !== 'string') throw new Error(`${label} must be a string`)
  if (raw.length > maxLength) throw new Error(`${label} is longer than ${maxLength} characters`)
  const trimmed = raw.trim()
  if (trimmed === '') {
    if (required) throw new Error(`${label} cannot be empty`)
    return undefined
  }
  return trimmed
}

/** Like readString, but preserves the exact text (for typed input). */
export function readText(args, key, options = {}) {
  const { required = false, label = key, maxLength = 10_000 } = options
  const raw = args?.[key]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new Error(`${label} is required`)
    return undefined
  }
  if (typeof raw !== 'string') throw new Error(`${label} must be a string`)
  if (raw.length > maxLength) throw new Error(`${label} is longer than ${maxLength} characters`)
  return raw
}

export function readNumber(args, key, options = {}) {
  const { required = false, label = key, min, max, integer = false } = options
  const raw = args?.[key]
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`${label} is required`)
    return undefined
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${label} must be a finite number`)
  if (integer && !Number.isInteger(raw)) throw new Error(`${label} must be an integer`)
  if (min !== undefined && raw < min) throw new Error(`${label} must be >= ${min}`)
  if (max !== undefined && raw > max) throw new Error(`${label} must be <= ${max}`)
  return raw
}

export function readBoolean(args, key) {
  const raw = args?.[key]
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'boolean') throw new Error(`${key} must be a boolean`)
  return raw
}

export function readEnum(args, key, values, options = {}) {
  const raw = readString(args, key, options)
  if (raw === undefined) return undefined
  const lower = raw.toLowerCase()
  const match = values.find((value) => value.toLowerCase() === lower)
  if (match === undefined) throw new Error(`${options.label ?? key} must be one of: ${values.join(', ')}`)
  return match
}
