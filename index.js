import { GatewayProcess } from './lib/gateway.js'
import { SshTunnel } from './lib/tunnel.js'
import { proxyRealtimeUpgrade } from './lib/ws-proxy.js'

export const name = 'voice-ayuan'
export const inject = ['webServer']

export function apply(ctx, config) {
  const log = (...args) => ctx.logger?.info?.('[voice-ayuan]', ...args)
  const remote = config.remote ?? {}
  const tunnel = new SshTunnel({
    host: remote.host,
    port: remote.port ?? 22,
    user: remote.user,
    localPort: remote.tunnelLocalPort ?? 18765,
    remotePort: remote.remotePort ?? 8765,
    log,
  })
  const gateway = new GatewayProcess({
    tunnelUrl: `ws://127.0.0.1:${remote.tunnelLocalPort ?? 18765}/v1/realtime`,
    allowedOrigin: config.gateway?.allowedOrigin ?? 'http://127.0.0.1:7969',
    log,
  })

  const boot = (async () => {
    try {
      await tunnel.start()
      await gateway.start()
    } catch (error) {
      log('voice stack failed:', String(error).slice(0, 300))
    }
  })()

  ctx.effect(() => () => {
    gateway.stop()
    tunnel.stop()
  }, 'voice-ayuan: voice stack')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/voice-ayuan/rt',
    handler: (req, socket, head) => {
      if (!gateway.origin) { socket.destroy(); return }
      const url = new URL(gateway.origin)
      proxyRealtimeUpgrade(req, socket, head, { host: url.hostname, port: Number(url.port) || 80 })
    },
  }), 'voice-ayuan: realtime ws proxy')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-ayuan/status',
    handler: async (req, res) => {
      await boot
      const status = await gateway.health()
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ...status, tunnel: tunnel.status() }))
    },
  }), 'voice-ayuan: status route')

  ctx.provide('voice', {
    status: () => ({ gateway: gateway.status(), tunnel: tunnel.status() }),
    health: () => gateway.health(),
    start: async () => { await tunnel.start(); return gateway.start() },
    stop: async () => { await gateway.stop(); tunnel.stop() },
  })
}

export const Config = {
  remote: {
    host: '58.246.75.58',
    port: 44022,
    user: 'qiu_team',
    unit: 'speech-to-speech.service',
    gpuPolicy: 'idle',
    tunnelLocalPort: 18765,
    remotePort: 8765,
  },
  gateway: { allowedOrigin: 'http://127.0.0.1:7969' },
  time: 'basic',
  record: 'off',
  permission: 'task',
}