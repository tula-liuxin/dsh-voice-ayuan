// 上游诊断探针：连网关 → 观察 voice.connection 状态 + 轮询网关 /api/health 拿 provider error。
// 用途：定位 speech-to-speech 上游连接失败的具体错误串（浏览器端链路已单独验证）。
import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

const HOST = process.env.VOICE_HOST || '127.0.0.1:4273'
const ORIGIN = 'http://' + HOST

async function status() {
  const res = await fetch('http://' + HOST + '/voice-ayuan/status', { cache: 'no-store' })
  return res.json()
}
const initial = await status()
const gatewayOrigin = initial.origin
console.log('gatewayOrigin=', gatewayOrigin, 'ok=', initial.ok, 'tunnel=', initial.tunnel && initial.tunnel.phase)

const events = []
const client = new GatewayClient({
  url: 'ws://' + HOST + '/voice-ayuan/rt',
  createSocket: (u) => new WebSocket(u, { headers: { Origin: ORIGIN } }),
  clientType: 'web',
  clientVersion: '0.1.7-upstream-probe',
  clientInstanceId: 'upstream-probe-' + Math.random().toString(36).slice(2, 10),
  capabilities: ['input.audio', 'session.output_voice', 'playback.receipts'],
  reconnect: false,
  onStatus: (s) => console.log('[status]', s.state, s.error ? String(s.error.message || s.error) : ''),
  onEvent: (e) => { events.push(e); console.log('[event]', JSON.stringify(e).slice(0, 400)) },
})
client.start()
await new Promise((resolve) => setTimeout(resolve, 1200))
console.log('ready=', client.ready)
if (!client.ready) process.exit(1)
// 发送 1 秒 16k PCM（静音）触发上游使用
const pcm = Buffer.alloc(32000)
client.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
let lastError = ''
for (let i = 0; i < 40; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const res = await fetch(gatewayOrigin + '/api/health', { cache: 'no-store' })
    const health = await res.json()
    const realtime = health.voiceClients && health.voiceClients.realtime
    const provider = realtime && realtime.byProvider && realtime.byProvider['speech-to-speech']
    if (provider && provider.error) {
      const text = JSON.stringify(provider.error).slice(0, 400)
      if (text !== lastError) { lastError = text; console.log('[provider-error]', text) }
    }
    const state = provider && provider.connected ? 'connected' : (provider && provider.connecting ? 'connecting' : (provider ? 'unavailable' : 'no-provider'))
    if (i % 8 === 0) console.log('[health]', 'providerState=' + state, 'error=' + (provider && provider.error ? String(provider.error).slice(0, 120) : 'none'))
  } catch (error) {
    console.log('[health error]', String(error && error.message || error))
  }
}
const connectionEvents = events.filter((e) => e.type === 'voice.connection')
console.log('voice.connection trace:', connectionEvents.map((e) => e.state).join(' -> '))
const audioEvents = events.filter((e) => e.type === 'audio.delta' || e.type === 'transcript.delta')
console.log('audio/transcript events:', audioEvents.length)
client.stop()
setTimeout(() => process.exit(0), 300)
