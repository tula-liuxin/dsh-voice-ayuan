import http from 'node:http'
import { SshTunnel } from './lib/tunnel.js'
import { GatewayProcess } from './lib/gateway.js'
import { proxyRealtimeUpgrade } from './lib/ws-proxy.js'
import { WebSocket } from 'ws'

const log = () => {}
const tunnel = new SshTunnel({ host: '58.246.75.58', port: 44022, user: 'qiu_team', localPort: 18765, remotePort: 8765, log })
let server, gateway
try {
  server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pagePort = server.address().port
  const pageOrigin = 'http://127.0.0.1:' + pagePort
  gateway = new GatewayProcess({ tunnelUrl: 'ws://127.0.0.1:18765/v1/realtime', allowedOrigin: pageOrigin, log })
  await tunnel.start()
  const gatewayOrigin = await gateway.start()
  const target = new URL(gatewayOrigin)
  server.on('upgrade', (req, socket, head) => {
    proxyRealtimeUpgrade(req, socket, head, { host: target.hostname, port: Number(target.port) })
  })
  const ws = new WebSocket('ws://127.0.0.1:' + pagePort + '/voice-ayuan/rt', { origin: pageOrigin })
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 12000)
    ws.on('open', () => console.log('ws open (proxy ok)'))
    ws.on('message', (data) => { clearTimeout(timer); console.log('first message:', String(data).slice(0, 180)); resolve({ ok: true }) })
    ws.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: String(e).slice(0, 200) }) })
    ws.on('close', (c, r) => { clearTimeout(timer); resolve({ ok: false, reason: 'closed ' + c + ' ' + String(r).slice(0, 100) }) })
  })
  console.log('RESULT', JSON.stringify(result))
  ws.close()
} catch (e) {
  console.log('FAILED', String(e).slice(0, 300))
} finally {
  await gateway?.stop?.(); tunnel.stop(); server?.close()
  setTimeout(() => process.exit(0), 300)
}
