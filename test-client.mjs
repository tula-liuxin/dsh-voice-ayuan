import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { WebSocket } from 'ws'

const url = 'ws://127.0.0.1:14975/voice-ayuan/rt'
const client = new GatewayClient({
  url,
  createSocket: (u) => new WebSocket(u, { headers: { Origin: 'http://127.0.0.1:14975' } }),
  clientType: 'web',
  clientVersion: '0.1.2',
  clientInstanceId: 'test-' + Math.random().toString(36).slice(2),
  capabilities: ['input.audio', 'session.output_voice'],
  onStatus: (s) => console.log('STATUS', JSON.stringify(s)),
  onEvent: (e) => { if (e && e.type) console.log('EVENT', e.type) },
})
client.start()
setTimeout(() => { console.log('final readyState', client.ready); client.stop(); process.exit(0) }, 15000)
