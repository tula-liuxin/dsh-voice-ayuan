import { SshTunnel } from './lib/tunnel.js'
import { GatewayProcess } from './lib/gateway.js'

const log = (...a) => console.log('[test]', ...a)
const tunnel = new SshTunnel({ host: '58.246.75.58', port: 44022, user: 'qiu_team', localPort: 18765, remotePort: 8765, log })
const gateway = new GatewayProcess({ tunnelUrl: 'ws://127.0.0.1:18765/v1/realtime', allowedOrigin: 'http://127.0.0.1:7969', log })
try {
  const t0 = Date.now()
  await tunnel.start()
  console.log('tunnel ready in', Date.now() - t0, 'ms')
  const t1 = Date.now()
  const origin = await gateway.start()
  console.log('gateway ready in', Date.now() - t1, 'ms at', origin)
  const health = await gateway.health()
  console.log('health', health.ok, health.body?.status, health.body?.protocolVersion)
} catch (e) {
  console.log('FAILED', String(e).slice(0, 300))
} finally {
  await gateway.stop()
  tunnel.stop()
  setTimeout(() => process.exit(0), 500)
}
