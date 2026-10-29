import { SshTunnel } from './lib/tunnel.js'
import { GatewayProcess } from './lib/gateway.js'
import { WebSocket } from 'ws'

const log = () => {}
const tunnel = new SshTunnel({ host: '58.246.75.58', port: 44022, user: 'qiu_team', localPort: 18765, remotePort: 8765, log })
const gateway = new GatewayProcess({ tunnelUrl: 'ws://127.0.0.1:18765/v1/realtime', allowedOrigin: 'http://127.0.0.1:7969', log })
try {
  await tunnel.start()
  const origin = await gateway.start()
  const url = origin.replace('http', 'ws') + '/api/realtime'
  const ws = new WebSocket(url, { origin: 'http://127.0.0.1:7969' })
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 12000)
    ws.on('open', () => console.log('ws open'))
    ws.on('message', (data) => {
      const text = String(data).slice(0, 220)
      console.log('first message:', text)
      clearTimeout(timer)
      resolve({ ok: true })
    })
    ws.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, reason: String(error).slice(0, 200) }) })
    ws.on('close', (code, reason) => { clearTimeout(timer); resolve({ ok: false, reason: 'closed ' + code + ' ' + String(reason).slice(0, 120) }) })
  })
  console.log('RESULT', JSON.stringify(result))
  ws.close()
} catch (e) {
  console.log('FAILED', String(e).slice(0, 300))
} finally {
  await gateway.stop(); tunnel.stop()
  setTimeout(() => process.exit(0), 300)
}
