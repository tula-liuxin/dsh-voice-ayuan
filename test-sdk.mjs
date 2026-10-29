import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

const mode = process.argv[2] || 'proxy'
const origin = 'http://127.0.0.1:4273'
const url = mode === 'direct' ? 'ws://127.0.0.1:11490/api/realtime' : 'ws://127.0.0.1:4273/voice-ayuan/rt'
const withOrigin = mode !== 'noorigin'

const client = new GatewayClient({
  url,
  createSocket: (u) => new WebSocket(u, withOrigin ? { headers: { Origin: origin } } : {}),
  clientType: 'web',
  clientVersion: '0.1.2',
  clientInstanceId: 'test-' + Math.random().toString(36).slice(2),
  timeZone: 'Asia/Shanghai',
  capabilities: ['input.audio', 'session.output_voice'],
  onStatus: (s) => console.log('[status]', JSON.stringify({ state: s.state, code: s.error && (s.error.code || s.error.message) })),
  onEvent: (e) => console.log('[event]', e && e.type, JSON.stringify(e).slice(0, 220)),
})
client.socket; // noop
client.start()
setTimeout(() => { console.log('[done] ready=' + client.ready); client.stop(); setTimeout(() => process.exit(0), 200) }, 10000)
