// 诊断：连独立网关实例（test/standalone），打印 voice.connection 与错误；配合 standalone gateway 日志看上游失败原因。
import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

const port = Number(process.argv[2] || 1421)
const origin = process.argv[3] || 'http://127.0.0.1:4273'
const client = new GatewayClient({
  url: 'ws://127.0.0.1:' + port + '/api/realtime',
  createSocket: (u) => new WebSocket(u, { headers: { Origin: origin } }),
  clientType: 'web',
  clientVersion: '0.1.7-standalone-probe',
  clientInstanceId: 'standalone-' + Math.random().toString(36).slice(2, 10),
  capabilities: ['input.audio'],
  reconnect: false,
  onStatus: (s) => console.log('[status]', s.state, s.error ? String(s.error.message || s.error) : ''),
  onEvent: (e) => console.log('[event]', JSON.stringify(e).slice(0, 300)),
})
client.start()
await new Promise((resolve) => setTimeout(resolve, 1000))
console.log('ready=', client.ready)
if (client.ready) {
  client.send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(3200).toString('base64') })
}
await new Promise((resolve) => setTimeout(resolve, 12000))
client.stop()
setTimeout(() => process.exit(0), 300)
