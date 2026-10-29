// 状态机/音频链路单测：本地假网关模拟 1006 重试、session.ready、音频 append/播放、打断。
import http from 'node:http'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { WebSocket } from 'ws'
import { createVoiceSession } from '../src/client/session.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

function encodeServerFrame(text) {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
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
      const b0 = buffer[0]
      const b1 = buffer[1]
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) break
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) break
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
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

function createFakeGateway({ failUpgrades = 0, silentHandshake = false } = {}) {
  const state = {
    attempts: 0,
    helloCount: 0,
    appendCount: 0,
    appendBytes: 0,
    interruptCount: 0,
    readySent: 0,
    audioDeltas: 0,
    playbackStarted: 0,
    playbackEnded: 0,
    playbackCancelled: 0,
    sockets: new Set(),
  }
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    state.attempts += 1
    const attempt = state.attempts
    if (attempt <= failUpgrades) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key']) + '\r\n\r\n',
    )
    state.sockets.add(socket)
    socket.on('close', () => state.sockets.delete(socket))
    socket.on('error', () => {})
    if (silentHandshake) return
    let n = 0
    const send = (obj) => {
      n += 1
      try { socket.write(encodeServerFrame(JSON.stringify(obj))) } catch {}
    }
    const parse = createFrameParser()
    socket.on('data', (chunk) => {
      for (const frame of parse(chunk)) {
        if (frame.opcode === 8) { try { socket.end() } catch {} ; continue }
        if (frame.opcode !== 1) continue
        let message
        try { message = JSON.parse(frame.payload.toString('utf8')) } catch { continue }
        if (message.type === 'session.hello') {
          state.helloCount += 1
          send({
            type: 'session.ready',
            event_id: 'evt_srv_ready_' + state.helloCount,
            request_event_id: message.event_id,
            protocol_version: '7.0.0',
            session_id: 'session-fake',
            capabilities: ['input.audio', 'session.output_voice'],
          })
          state.readySent += 1
          send({ type: 'voice.ready', event_id: 'evt_srv_voice_' + n, inputSampleRate: 16000, provider: 'fake-s2s' })
        } else if (message.type === 'audio.append' || message.type === 'input_audio_buffer.append') {
          state.appendCount += 1
          const bytes = Buffer.from(String(message.audio || ''), 'base64')
          state.appendBytes += bytes.length
          if (state.appendCount === 1) {
            const pcm = Buffer.alloc(960)
            for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1200, i)
            send({ type: 'audio.delta', event_id: 'evt_srv_audio_' + n, audio: pcm.toString('base64'), sampleRate: 24000, responseId: 'resp_fake_1' })
            send({ type: 'transcript.delta', event_id: 'evt_srv_tr_' + n, role: 'assistant', content: '你好，测试语音。', responseId: 'resp_fake_1' })
            state.audioDeltas += 1
            send({ type: 'audio.done', event_id: 'evt_srv_done_' + n, responseId: 'resp_fake_1' })
          } else if (state.appendCount === 3) {
            const pcm = Buffer.alloc(960)
            for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(900, i)
            send({ type: 'audio.delta', event_id: 'evt_srv_audio2_' + n, audio: pcm.toString('base64'), sampleRate: 24000, responseId: 'resp_fake_2' })
            send({ type: 'audio.done', event_id: 'evt_srv_done2_' + n, responseId: 'resp_fake_2' })
          }
        } else if (message.type === 'interrupt' || message.type === 'response.cancel') {
          state.interruptCount += 1
        } else if (message.type === 'playback.started') {
          state.playbackStarted += 1
        } else if (message.type === 'playback.ended') {
          state.playbackEnded += 1
        } else if (message.type === 'playback.cancelled') {
          state.playbackCancelled += 1
        }
      }
    })
  })
  return { server, state }
}

function createFakeAudio() {
  const record = {
    started: 0, stopped: 0, flushed: 0, frameCalls: 0, playing: false,
    played: [], onFrame: null, onBargeIn: null,
  }
  const factory = ({ onFrame, onBargeIn }) => {
    record.onFrame = onFrame
    record.onBargeIn = onBargeIn
    return {
      start: async () => { record.started += 1; return { sampleRate: 16000, worklet: true, state: 'running' } },
      stop: () => { record.stopped += 1 },
      play: (float32, rate) => { record.playing = true; record.played.push({ length: float32.length, rate }) },
      flush: () => { record.flushed += 1; record.playing = false },
      isPlaying: () => record.playing,
      get sampleRate() { return 16000 },
    }
  }
  record.emit = (samples) => { record.frameCalls += 1; if (record.onFrame) record.onFrame(samples) }
  record.barge = () => { if (record.onBargeIn) record.onBargeIn() }
  record.drain = () => { record.playing = false }
  return { record, factory }
}

function createFetch(statusBody) {
  const reports = []
  const fetchImpl = async (path, init = {}) => {
    if (path === '/voice-ayuan/status') {
      return { ok: true, status: 200, text: async () => JSON.stringify(statusBody) }
    }
    if (path === '/voice-ayuan/report') {
      try { reports.push(JSON.parse(init.body || '{}')) } catch { reports.push({ raw: String(init.body || '') }) }
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    }
    return { ok: false, status: 404, text: async () => '' }
  }
  return { fetchImpl, reports }
}

function createTestGlobals(base) {
  return {
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: base },
    location: { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' },
    isSecureContext: true,
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('not used in test')) },
      userAgent: 'node-state-machine-test',
      permissions: { query: async () => ({ state: 'granted' }) },
    },
    AbortController,
    Intl,
    URL,
    Blob,
    WebSocket,
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout: ' + label)
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

let pass = 0
let fail = 0
async function scenario(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('PASS ' + name)
  } catch (error) {
    fail += 1
    console.error('FAIL ' + name + ' :: ' + (error && error.message))
  }
}

const statusBody = {
  ok: true,
  phase: 'ready',
  origin: 'http://127.0.0.1:11490',
  tunnel: { phase: 'ready' },
  body: { realtimeProvider: 'speech-to-speech', realtimeInputSampleRate: 16000 },
}

// 场景 1：前两次升级被拒（403→浏览器侧 1006），第三次成功；ready→mic→live→append→播放→打断
await scenario('retry-1006-then-live-audio', async () => {
  const gateway = createFakeGateway({ failUpgrades: 2 })
  const port = await listen(gateway.server)
  const base = 'http://127.0.0.1:' + port
  const { fetchImpl, reports } = createFetch(statusBody)
  const { record, factory } = createFakeAudio()
  const states = []
  const steps = []
  const details = []
  const captions = []
  const session = createVoiceSession({
    globals: createTestGlobals(base),
    fetchImpl,
    createSocket: (url) => new WebSocket(url),
    audioFactory: factory,
    retryDelays: [80, 120, 160],
    statusWaitMs: 3000,
    connectTimeoutMs: 800,
    handshakeTimeoutMs: 1200,
    onState: (state) => states.push(state),
    onStep: (step) => steps.push(step),
    onDetail: (detail) => details.push(detail),
    onCaption: (delta) => captions.push(delta),
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'live', 8000, 'live')
    assert.equal(session.wsUrl, 'ws://127.0.0.1:' + port + '/voice-ayuan/rt')
    assert.equal(session.baseSource, 'transport')
    assert.equal(gateway.state.attempts, 3, 'server attempts=' + gateway.state.attempts)
    assert.equal(gateway.state.readySent, 1)
    assert.ok(states.includes('reconnecting'), 'states=' + states.join(','))
    assert.equal(states.filter((value) => value === 'reconnecting').length >= 2, true, 'need 2 retries: ' + states.join(','))
    assert.equal(states[states.length - 1], 'live')
    assert.ok(record.started === 1, 'audio started=' + record.started)

    // 麦克风帧 → 16k PCM base64 append（fake sampleRate=16000，即直通 2048 样本 = 4096 字节）
    record.emit(new Float32Array(2048))
    await waitFor(() => gateway.state.appendCount >= 1, 3000, 'audio.append')
    await new Promise((resolve) => setTimeout(resolve, 150))
    record.emit(new Float32Array(2048))
    await waitFor(() => gateway.state.appendCount >= 2, 3000, 'audio.append 2')
    assert.ok(gateway.state.appendBytes % 4096 === 0, 'appendBytes=' + gateway.state.appendBytes)
    assert.ok(steps.some((step) => step.includes('session.ready')), 'steps=' + steps.join(' | '))

    // 服务端 audio.delta → 播放
    await waitFor(() => record.played.length >= 1, 3000, 'audio play')
    assert.equal(record.played[0].rate, 24000)

    // 助手转写 → caption
    await waitFor(() => captions.join('').includes('测试语音'), 3000, 'caption')
    assert.equal(captions.join(''), '你好，测试语音。')

    // 播放回执：audio.delta → playback.started；audio.done + 队列排空 → playback.ended
    await waitFor(() => gateway.state.playbackStarted >= 1, 3000, 'playback.started')
    record.drain()
    await waitFor(() => gateway.state.playbackEnded >= 1, 3000, 'playback.ended')

    // 第二条响应（第 3 批 append 触发）→ 在播放中打断 → playback.cancelled + response.cancel（服务端 alias interrupt）
    record.emit(new Float32Array(2048))
    await waitFor(() => gateway.state.appendCount >= 3, 3000, 'append 3')
    await waitFor(() => record.played.length >= 2, 3000, 'second response audio')
    record.barge()
    await waitFor(() => gateway.state.interruptCount >= 1, 3000, 'interrupt')
    await waitFor(() => gateway.state.playbackCancelled >= 1, 3000, 'playback.cancelled')
    assert.ok(record.flushed >= 1, 'flushed=' + record.flushed)
    assert.ok(steps.some((step) => step.includes('barge-in')), 'steps=' + steps.join(' | '))

    // 诊断上报有阶段记录
    assert.ok(reports.some((entry) => entry.kind === 'voice-ready'), 'report kinds=' + reports.map((entry) => entry.kind).join(','))
    assert.ok(reports.some((entry) => entry.kind === 'voice-live'))
    assert.equal(session.stats.sends >= 2, true, 'sends=' + session.stats.sends)
  } catch (error) {
    console.error('DEBUG states:', JSON.stringify(states))
    console.error('DEBUG steps:', JSON.stringify(steps))
    console.error('DEBUG details:', JSON.stringify(details))
    console.error('DEBUG server:', JSON.stringify({ ...gateway.state, sockets: gateway.state.sockets.size }))
    throw error
  } finally {
    session.stop()
    for (const socket of gateway.state.sockets) { try { socket.destroy() } catch {} }
    await new Promise((resolve) => gateway.server.close(resolve))
  }
})

// 场景 2：握手超时（WS 101 但永不回 session.ready）→ 重试 3 次后人类可读的 error
await scenario('handshake-timeout-terminal-error', async () => {
  const gateway = createFakeGateway({ silentHandshake: true })
  const port = await listen(gateway.server)
  const base = 'http://127.0.0.1:' + port
  const { fetchImpl } = createFetch(statusBody)
  const { factory } = createFakeAudio()
  const states = []
  const details = []
  const session = createVoiceSession({
    globals: createTestGlobals(base),
    fetchImpl,
    createSocket: (url) => new WebSocket(url),
    audioFactory: factory,
    retryDelays: [40, 40, 40],
    statusWaitMs: 2000,
    connectTimeoutMs: 300,
    handshakeTimeoutMs: 250,
    onState: (state) => states.push(state),
    onDetail: (detail) => details.push(detail),
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'error', 6000, 'terminal error')
    assert.equal(states[states.length - 1], 'error')
    assert.equal(gateway.state.attempts, 4, 'attempts=' + gateway.state.attempts)
    const finalDetail = details[details.length - 1] || ''
    assert.ok(/session\.ready|握手/.test(finalDetail), 'detail=' + finalDetail)
    assert.ok(/重试/.test(finalDetail), 'detail=' + finalDetail)
    // 面板可见的重试入口
    assert.equal(typeof session.retry, 'function')
  } finally {
    session.stop()
    for (const socket of gateway.state.sockets) { try { socket.destroy() } catch {} }
    await new Promise((resolve) => gateway.server.close(resolve))
  }
})

// 场景 3：全部升级被拒 → 三次重试后明确 1006 类错误
await scenario('all-upgrades-rejected-terminal-1006', async () => {
  const gateway = createFakeGateway({ failUpgrades: 99 })
  const port = await listen(gateway.server)
  const base = 'http://127.0.0.1:' + port
  const { fetchImpl } = createFetch(statusBody)
  const { factory } = createFakeAudio()
  const details = []
  const session = createVoiceSession({
    globals: createTestGlobals(base),
    fetchImpl,
    createSocket: (url) => new WebSocket(url),
    audioFactory: factory,
    retryDelays: [30, 30, 30],
    statusWaitMs: 2000,
    connectTimeoutMs: 500,
    handshakeTimeoutMs: 500,
    onDetail: (detail) => details.push(detail),
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'error', 6000, 'terminal error')
    assert.equal(gateway.state.attempts, 4, 'attempts=' + gateway.state.attempts)
    const finalDetail = details[details.length - 1] || ''
    assert.ok(/1006|握手失败|升级/.test(finalDetail), 'detail=' + finalDetail)
  } finally {
    session.stop()
    for (const socket of gateway.state.sockets) { try { socket.destroy() } catch {} }
    await new Promise((resolve) => gateway.server.close(resolve))
  }
})

// 场景 4：宿主网关一直未就绪（status ok:false / phase=starting）→ 等待窗口后人类可读 error
await scenario('status-not-ready-terminal-error', async () => {
  const fetchImpl = async (path) => {
    if (path === '/voice-ayuan/status') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, phase: 'starting', error: '语音网关启动中，请稍后重试', ready: false }) }
    }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  const { factory } = createFakeAudio()
  const details = []
  const session = createVoiceSession({
    globals: createTestGlobals('http://127.0.0.1:1'),
    fetchImpl,
    createSocket: () => { throw new Error('status 未就绪时不应尝试 WS') },
    audioFactory: factory,
    statusWaitMs: 400,
    onDetail: (detail) => details.push(detail),
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'error', 3000, 'status not ready error')
    const finalDetail = details[details.length - 1] || ''
    assert.ok(/未就绪|starting/.test(finalDetail), 'detail=' + finalDetail)
  } finally {
    session.stop()
  }
})

// 场景 5：status 前两次网络失败，第三次成功 → 继续握手并 live
await scenario('status-retry-then-live', async () => {
  const gateway = createFakeGateway({})
  const port = await listen(gateway.server)
  const base = 'http://127.0.0.1:' + port
  let statusCalls = 0
  const reports = []
  const fetchImpl = async (path, init = {}) => {
    if (path === '/voice-ayuan/status') {
      statusCalls += 1
      if (statusCalls <= 2) throw new TypeError('Failed to fetch')
      return { ok: true, status: 200, text: async () => JSON.stringify(statusBody) }
    }
    if (path === '/voice-ayuan/report') { try { reports.push(JSON.parse(init.body || '{}')) } catch {} ; return { ok: true, status: 200, text: async () => '{}' } }
    return { ok: false, status: 404, text: async () => '' }
  }
  const { factory } = createFakeAudio()
  const session = createVoiceSession({
    globals: createTestGlobals(base),
    fetchImpl,
    createSocket: (url) => new WebSocket(url),
    audioFactory: factory,
    retryDelays: [40, 40, 40],
    statusWaitMs: 3000,
    connectTimeoutMs: 800,
    handshakeTimeoutMs: 1200,
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'live', 6000, 'live after status retry')
    assert.equal(statusCalls >= 3, true, 'statusCalls=' + statusCalls)
    assert.equal(session.baseSource, 'transport')
  } finally {
    session.stop()
    for (const socket of gateway.state.sockets) { try { socket.destroy() } catch {} }
    await new Promise((resolve) => gateway.server.close(resolve))
  }
})

// 场景 6：dsh-app://app 页面且缺少 __DSH_TRANSPORT__ → 明确报「无法确定宿主地址」，不静默拼 location.host
await scenario('missing-transport-terminal-error', async () => {
  const fetchImpl = async (path) => {
    if (path === '/voice-ayuan/status') {
      return { ok: true, status: 200, text: async () => JSON.stringify(statusBody) }
    }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  const { factory } = createFakeAudio()
  const details = []
  const session = createVoiceSession({
    globals: {
      location: { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' },
      isSecureContext: true,
      navigator: { mediaDevices: { getUserMedia: () => {} }, userAgent: 'test' },
      AbortController,
      Intl,
      URL,
      Blob,
      WebSocket,
    },
    fetchImpl,
    createSocket: () => { throw new Error('不应尝试 WS') },
    audioFactory: factory,
    statusWaitMs: 500,
    onDetail: (detail) => details.push(detail),
  })
  try {
    await session.start()
    await waitFor(() => session.phase === 'error', 3000, 'missing transport error')
    const finalDetail = details[details.length - 1] || ''
    assert.ok(/无法确定宿主地址|__DSH_TRANSPORT__|dsh-app/.test(finalDetail), 'detail=' + finalDetail)
  } finally {
    session.stop()
  }
})

console.log('\nstate-machine: ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail === 0 ? 0 : 1)
