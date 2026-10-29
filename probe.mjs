import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { WebSocket } from 'ws'
const port = process.argv[2] || '14975'
const origin = 'http://127.0.0.1:' + port
const client = new GatewayClient({
  url: 'ws://127.0.0.1:' + port + '/voice-ayuan/rt',
  createSocket: (u) => new WebSocket(u, { headers: { Origin: origin } }),
  clientType: 'web', clientVersion: '0.1.4',
  clientInstanceId: 'probe-' + Math.random().toString(36).slice(2),
  capabilities: ['input.audio', 'session.output_voice'],
  onStatus: (s) => console.log('STATUS', JSON.stringify(s).slice(0, 160)),
  onEvent: () => {},
})
client.start()
setTimeout(() => { console.log('ready=', client.ready); client.stop(); process.exit(0) }, 12000)
