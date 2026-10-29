// 协议探针：验证真实网关接受 7.0 客户端的播放回执（playback.started/ended/cancelled）。
// 用途：qwen-audio-agent 只有在收到 playback.started 后才 flush 助手转写；见 realtime-presentation-runtime。
import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

const HOST = process.env.VOICE_HOST || '127.0.0.1:4273'
const ORIGIN = 'http://' + HOST
const client = new GatewayClient({
  url: 'ws://' + HOST + '/voice-ayuan/rt',
  createSocket: (u) => new WebSocket(u, { headers: { Origin: ORIGIN } }),
  clientType: 'web',
  clientVersion: '0.1.7-probe',
  clientInstanceId: 'probe-' + Math.random().toString(36).slice(2, 10),
  capabilities: ['input.audio', 'session.output_voice', 'playback.receipts'],
  reconnect: false,
  onStatus: (status) => console.log('[status]', status.state, status.error ? String(status.error.message || status.error) : ''),
  onEvent: (event) => console.log('[event]', event.type, JSON.stringify(event).slice(0, 120)),
})
client.start()
await new Promise((resolve) => setTimeout(resolve, 1500))
console.log('ready=' + client.ready)
console.log('negotiatedCapabilities=' + JSON.stringify(client.negotiatedCapabilities))
let fail = 0
if (!client.ready) {
  console.error('FAIL: session.ready not reached')
  process.exit(1)
}
if (!client.negotiatedCapabilities.includes('playback.receipts')) {
  console.error('FAIL: playback.receipts not negotiated')
  fail += 1
}
const receipts = [
  { type: 'playback.started', responseId: 'resp_probe_1' },
  { type: 'playback.ended', responseId: 'resp_probe_1' },
  { type: 'playback.cancelled', responseId: 'resp_probe_2', reason: 'user_interruption' },
  { type: 'input_audio_buffer.append', audio: Buffer.alloc(640).toString('base64') },
  { type: 'response.cancel' },
]
for (const receipt of receipts) {
  const sent = client.send(receipt)
  console.log('send ' + receipt.type + ' => ' + sent)
  if (!sent) fail += 1
}
await new Promise((resolve) => setTimeout(resolve, 1500))
console.log('after sends: ready=' + client.ready + ' readyState=' + client.readyState)
if (!client.ready) fail += 1
client.stop()
setTimeout(() => {
  console.log(fail === 0 ? 'protocol-probe: PASS' : 'protocol-probe: FAIL(' + fail + ')')
  process.exit(fail === 0 ? 0 : 1)
}, 300)
