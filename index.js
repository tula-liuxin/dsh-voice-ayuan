import { GatewayProcess } from './lib/gateway.js'
import { SshTunnel } from './lib/tunnel.js'
import { proxyRealtimeUpgrade } from './lib/ws-proxy.js'
import { appendReport, diag, diagPaths, tailLog, writeReport } from './lib/diag.js'

export const name = 'voice-ayuan'
export const inject = ['webServer']

function requestSummary(req) {
  const h = req.headers || {}
  return {
    kind: 'upgrade',
    url: String(req.url || '').slice(0, 120),
    host: h.host || null,
    origin: h.origin ?? null,
    cookie: Boolean(h.cookie),
    ext: Boolean(h['sec-websocket-extensions']),
    protocol: h['sec-websocket-protocol'] || '',
    version: h['sec-websocket-version'] || '',
    fetchSite: h['sec-fetch-site'] || '',
    fetchMode: h['sec-fetch-mode'] || '',
    ua: String(h['user-agent'] || '').slice(0, 90),
    remote: req.socket && req.socket.remoteAddress,
  }
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(''); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function json(res, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

export function apply(ctx, config = {}) {
  const log = (...args) => ctx.logger?.info?.('[voice-ayuan]', ...args)
  const remote = {
    host: '127.0.0.1',
    port: 22,
    user: 'your-user',
    tunnelLocalPort: 18765,
    remotePort: 8765,
    ...(config.remote ?? {}),
  }
  const configuredOrigin = config.gateway?.allowedOrigin ?? ''
  const allowedOrigin = () => {
    const origins = []
    try {
      const live = ctx.webServer.getOrigin()
      if (live) origins.push(live)
    } catch {}
    if (configuredOrigin) origins.push(configuredOrigin)
    return [...new Set(origins)].join(',')
  }

  const tunnel = new SshTunnel({
    host: remote.host,
    port: remote.port,
    user: remote.user,
    localPort: remote.tunnelLocalPort,
    remotePort: remote.remotePort,
    log,
  })
  const gateway = new GatewayProcess({
    tunnelUrl: `ws://127.0.0.1:${remote.tunnelLocalPort}/v1/realtime`,
    allowedOrigin,
    log,
  })

  const boot = (async () => {
    try {
      diag({ kind: 'boot-start' })
      await tunnel.start()
      await gateway.start()
      diag({ kind: 'boot-ready', gateway: gateway.status() })
    } catch (error) {
      diag({ kind: 'boot-failed', message: String(error).slice(0, 300) })
      log('voice stack failed:', String(error).slice(0, 300))
    }
  })()

  ctx.effect(() => () => {
    gateway.stop()
    tunnel.stop()
  }, 'voice-ayuan: voice stack')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/voice-ayuan/rt',
    handler: async (req, socket, head) => {
      diag(requestSummary(req))
      const fail = (status, reason) => {
        diag({ kind: 'upgrade-refused', status, reason })
        try {
          if (!socket.destroyed && socket.writable) {
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}`)
          }
        } catch {}
        try { socket.destroy() } catch {}
      }
      // 首次点击可能早于网关就绪：等 boot 最多 25s，而不是直接断链。
      if (!gateway.origin) {
        await Promise.race([
          boot.catch(() => {}),
          new Promise((resolve) => { const timer = setTimeout(resolve, 25000); timer.unref?.() }),
        ])
      }
      if (!gateway.origin) return fail('503 Service Unavailable', 'voice gateway is starting')
      let target
      try {
        const url = new URL(gateway.origin)
        target = { host: url.hostname, port: Number(url.port) || 80 }
      } catch {
        return fail('503 Service Unavailable', 'voice gateway address unavailable')
      }
      // 网关只接受 loopback 同源。这里把 Host/Origin 一起改写成网关自己的 loopback 地址，
      // 于是桌面 dsh-app:// 页面、远程门户 https 页面、任意 Origin 都能通过校验
      // （WS 只能由本机插件代理进入，网关不对外暴露，不存在伪造来源的风险）。
      const loopbackBase = `http://127.0.0.1:${target.port}`
      proxyRealtimeUpgrade(req, socket, head, target, {
        rewriteOrigin: loopbackBase,
        rewriteHost: `127.0.0.1:${target.port}`,
        onEvent: (event) => diag({ ...event, kind: 'proxy' }),
      })
    },
  }), 'voice-ayuan: realtime ws proxy')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-ayuan/status',
    handler: async (req, res) => {
      let status
      try {
        status = await gateway.health()
      } catch (error) {
        status = { ok: false, phase: 'error', error: String(error && error.message || error).slice(0, 200) }
      }
      if (!status || !status.ok) {
        diag({ kind: 'status-not-ready', status: status && status.phase })
        json(res, {
          ok: false,
          phase: (status && status.phase) || 'starting',
          error: '语音网关启动中，请稍后重试',
          tunnel: tunnel.status(),
          ready: Boolean(gateway.origin),
        })
        return
      }
      json(res, {
        ...status,
        allowedOrigin: allowedOrigin(),
        ready: Boolean(gateway.origin),
        tunnel: tunnel.status(),
        boot: Boolean(status.ok),
      })
    },
  }), 'voice-ayuan: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-ayuan/report',
    handler: async (req, res) => {
      if (req.method === 'POST') {
        const body = await readBody(req)
        let payload = {}
        try { payload = body ? JSON.parse(body) : {} } catch { payload = { raw: String(body).slice(0, 4000) } }
        const file = writeReport(payload)
        const reportLog = appendReport(payload)
        diag({
          kind: 'client-report',
          file,
          reportLog,
          source: String(payload.source || payload.kind || '').slice(0, 60),
          phase: payload.phase || (payload.metrics && (payload.metrics.pass ? 'metrics-pass' : 'metrics-fail')),
          reason: payload.reason || '',
          mode: payload.metrics ? payload.metrics.mode : '',
          pass: payload.metrics ? payload.metrics.pass : undefined,
          wsUrl: String(payload.wsUrl || '').slice(0, 120),
          baseSource: payload.baseSource || '',
          attempt: payload.attempt,
          close: payload.close,
          detail: String(payload.detail || '').slice(0, 200),
        })
        json(res, { ok: true, file, reportLog })
        return
      }
      json(res, { ok: true, ...diagPaths() })
    },
  }), 'voice-ayuan: client report route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-ayuan/log',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const n = Math.min(2000, Math.max(1, Number(url.searchParams.get('n')) || 200))
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(tailLog(n))
    },
  }), 'voice-ayuan: log route')

  try {
    ctx.provide('voiceCall', {
      status: () => ({ gateway: gateway.status(), tunnel: tunnel.status() }),
      health: () => gateway.health(),
      start: async () => { await tunnel.start(); return gateway.start() },
      stop: async () => { await gateway.stop(); tunnel.stop() },
      diagPaths,
    })
  } catch (error) {
    log('provide(voiceCall) failed:', String(error).slice(0, 200))
  }
}
