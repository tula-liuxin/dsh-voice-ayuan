// 分角色字幕（session.js 侧）集成测试：假网关发 transcript 事件，断言 onTranscript 分段事件正确。
// 覆盖：用户 STT / 助手回复分角色增量；turn.started 新一轮清空；用户打断 reset；onCaption 兼容旧视图。
import http from 'node:http'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { WebSocket } from 'ws'
import { createVoiceSession } from '../src/client/session.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64')

function encodeServerFrame(text) {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, payload.length])
  else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function createFrameParser() {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const frames = []
    for (;;) {
      if (buffer.length < 2) break
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const maskLength = masked ? 4 : 0
      if (buffer.length < offset + maskLength + length) break
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskLength
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(offset + length)
      frames.push({ opcode, payload })
    }
    return frames
  }
}

function createFakeGateway() {
  const state = { attempts: 0, appendCount: 0, sockets: new Set(), sent: [] }
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    state.attempts += 1
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key']) + '\r\n\r\n',
    )
    state.sockets.add(socket)
    socket.on('close', () => state.sockets.delete(socket))
    socket.on('error', () => {})
    let n = 0
    const send = (obj) => { n += 1; state.sent.push(obj); try { socket.write(encodeServerFrame(JSON.stringify(obj))) } catch {} }
    const parse = createFrameParser()
    socket.on('data', (chunk) => {
      for (const frame of parse(chunk)) {
        if (frame.opcode === 8) { try { socket.end() } catch {} ; continue }
        if (frame.opcode !== 1) continue
        let message
        try { message = JSON.parse(frame.payload.toString('utf8')) } catch { continue }
        if (message.type === 'session.hello') {
          send({
            type: 'session.ready',
            event_id: 'evt_srv_ready_' + state.attempts,
            request_event_id: message.event_id,
            protocol_version: '7.0.0',
            session_id: 'session-fake',
            capabilities: ['input.audio', 'session.output_voice'],
          })
          send({ type: 'voice.ready', event_id: 'evt_srv_voice_' + state.attempts, inputSampleRate: 16000, provider: 'fake-s2s' })
          continue
        }
        if (message.type !== 'audio.append' && message.type !== 'input_audio_buffer.append') continue
        state.appendCount += 1
        if (state.appendCount === 1) {
          send({ type: 'turn.started', turnId: 'turn-1', event_id: 'evt_turn_1' })
          send({ type: 'transcript.delta', role: 'user', content: '你好', turnId: 'turn-1', event_id: 'evt_u1' })
          send({ type: 'transcript.delta', role: 'user', content: '阿源', turnId: 'turn-1', event_id: 'evt_u2' })
          send({ type: 'transcript.delta', role: 'assistant', content: '我在', responseId: 'resp-1', turnId: 'turn-1', event_id: 'evt_a1' })
          send({ type: 'transcript.final', role: 'assistant', content: '我在呢', turnId: 'turn-1', event_id: 'evt_a2' })
        } else if (state.appendCount === 2) {
          send({ type: 'turn.started', turnId: 'turn-2', event_id: 'evt_turn_2' })
          send({ type: 'transcript.delta', role: 'user', content: '第二个问题', turnId: 'turn-2', event_id: 'evt_u3' })
          send({ type: 'transcript.discard', role: 'user', turnId: 'turn-2', event_id: 'evt_discard' })
        }
      }
    })
  })
  return { server, state }
}

function createFakeAudio() {
  const record = { onFrame: null, onBargeIn: null, started: 0 }
  const factory = ({ onFrame, onBargeIn }) => {
    record.onFrame = onFrame
    record.onBargeIn = onBargeIn
    return {
      start: async () => { record.started += 1; return { sampleRate: 16000, worklet: true, state: 'running' } },
      stop: () => {},
      play: () => {},
      flush: () => {},
      isPlaying: () => false,
      get sampleRate() { return 16000 },
    }
  }
  record.emit = (samples) => { if (record.onFrame) record.onFrame(samples) }
  record.barge = () => { if (record.onBargeIn) record.onBargeIn() }
  return { record, factory }
}

function createFetch(statusBody) {
  return async (path) => {
    if (path === '/voice-ayuan/status') return { ok: true, status: 200, text: async () => JSON.stringify(statusBody) }
    return { ok: true, status: 200, text: async () => '{"ok":true}' }
  }
}

function createTestGlobals(base) {
  return {
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: base },
    location: { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' },
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('not used')) }, userAgent: 'node-transcript-test' },
    AbortController, Intl, URL, Blob, WebSocket,
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout: ' + label)
}

const statusBody = {
  ok: true,
  phase: 'ready',
  origin: 'http://127.0.0.1:1',
  tunnel: { phase: 'ready' },
  body: { realtimeProvider: 'speech-to-speech', realtimeInputSampleRate: 16000 },
}

const gateway = createFakeGateway()
const port = await listen(gateway.server)
const base = 'http://127.0.0.1:' + port
const { record, factory } = createFakeAudio()
const transcripts = []
const captions = []
const session = createVoiceSession({
  globals: createTestGlobals(base),
  fetchImpl: createFetch(statusBody),
  createSocket: (url) => new WebSocket(url),
  audioFactory: factory,
  retryDelays: [],
  statusWaitMs: 3000,
  connectTimeoutMs: 800,
  handshakeTimeoutMs: 1200,
  onTranscript: (event) => transcripts.push(event),
  onCaption: (delta) => captions.push(delta),
})

let passed = 0
let failed = 0
async function scenario(name, fn) {
  try { await fn(); passed += 1; console.log('PASS ' + name) }
  catch (error) { failed += 1; console.error('FAIL ' + name + ' :: ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)) }
}

try {
  await session.start()
  await waitFor(() => session.phase === 'live', 8000, 'live')

  await scenario('用户 STT 与助手回复分角色上送', async () => {
    record.emit(new Float32Array(2048))
    await waitFor(() => transcripts.some((e) => e.role === 'assistant' && e.kind === 'final'), 5000, 'assistant final')
    const userDeltas = transcripts.filter((e) => e.kind === 'delta' && e.role === 'user').map((e) => e.content)
    assert.deepEqual(userDeltas, ['你好', '阿源'])
    const assistant = transcripts.filter((e) => e.role === 'assistant')
    assert.equal(assistant[0].kind, 'delta')
    assert.equal(assistant[0].content, '我在')
    assert.equal(assistant[1].kind, 'final')
    assert.equal(assistant[1].content, '我在呢')
    const reset = transcripts.find((e) => e.kind === 'reset')
    assert.ok(reset, 'should emit reset for turn-1 start')
    assert.equal(reset.turnId, 'turn-1')
    assert.equal(captions.join(''), '我在我在呢') // 旧 onCaption 仍可用（兼容）
  })

  await scenario('新一轮 turn.started 清空上一轮 + discard 清用户栏', async () => {
    const before = transcripts.length
    record.emit(new Float32Array(2048))
    await waitFor(() => transcripts.slice(before).some((e) => e.kind === 'discard'), 5000, 'turn-2 discard')
    const batch = transcripts.slice(before)
    assert.ok(batch.some((e) => e.kind === 'reset' && e.turnId === 'turn-2' && e.reason === 'turn-started'), JSON.stringify(batch))
    assert.ok(batch.some((e) => e.kind === 'delta' && e.role === 'user' && e.content === '第二个问题'))
    assert.ok(batch.some((e) => e.kind === 'discard' && e.role === 'user'))
  })

  await scenario('用户打断（barge-in）清空上一轮字幕', async () => {
    const before = transcripts.length
    record.barge()
    await waitFor(() => transcripts.slice(before).some((e) => e.kind === 'reset' && e.reason === 'barge-in'), 3000, 'barge reset')
  })
} finally {
  session.stop()
  for (const socket of gateway.state.sockets) { try { socket.destroy() } catch {} }
  await new Promise((resolve) => gateway.server.close(resolve))
}

console.log('session-transcript: ' + passed + ' pass, ' + failed + ' fail')
if (failed > 0) process.exitCode = 1
