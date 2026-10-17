import { apply } from '../index.js'

const defs = []
let section
const ctx = {
  tools: { register(definition) { defs.push(definition); return () => {} } },
  systemPrompt: { getSectionOrder() { return 1000 }, section(s) { section = s } },
  get() { return undefined },
}
apply(ctx)
console.log('registered:', defs.map((d) => d.name).join(', '))
console.log('section:', section.name, section.order)
console.log('---')
const byName = new Map(defs.map((d) => [d.name, d]))
const exec = { signal: new AbortController().signal, agent: undefined }
async function call(name, args) {
  const def = byName.get(name)
  const value = await def.execute(args ?? {}, exec)
  console.log(`\n=== ${name} ===\n${(value.text ?? '').slice(0, 1500)}\n`)
  return value
}
const device = 'iPhone 18 Pro'
await call('sim_devices', { booted_only: true })
await call('sim_doctor', {})
await call('sim_describe_ui', { device, max_elements: 50 })
const sheet = await call('sim_screenshot', { device, path: '/tmp/dsh-smoke-shot.png' })
console.log('screenshot value keys:', Object.keys(sheet))
await call('sim_app', { device, action: 'list', filter: 'com.apple.preferences' })
await call('sim_logs', { device, last_seconds: 5, limit: 8 })
await call('sim_env', { device, action: 'appearance' })
