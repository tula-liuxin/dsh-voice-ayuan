import { apply } from './index.js'

const routes = new Map()
const upgrades = new Map()
const disposers = []
const ctx = {
  logger: { info: (...a) => console.log('[log]', ...a) },
  effect: (fn, label) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  provide: (name, value) => console.log('[provide]', name, typeof value),
  webServer: {
    register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) },
    registerUpgrade: (route) => { upgrades.set(route.path, route); return () => upgrades.delete(route.path) },
  },
}

apply(ctx, {
  remote: { host: '58.246.75.58', port: 44022, user: 'qiu_team', tunnelLocalPort: 18765, remotePort: 8765 },
  gateway: { allowedOrigin: 'http://127.0.0.1:7969' },
})
console.log('routes:', [...routes.keys()], 'upgrades:', [...upgrades.keys()])

// 等就绪后直接调用 status handler
await new Promise((r) => setTimeout(r, 30000))
const route = routes.get('/voice-ayuan/status')
let body = ''
const res = {
  setHeader: () => {},
  end: (chunk) => { body = String(chunk) },
}
await route.handler({}, res)
console.log('STATUS_BODY', body.slice(0, 300))

for (const d of disposers.reverse()) d()
setTimeout(() => process.exit(0), 500)
