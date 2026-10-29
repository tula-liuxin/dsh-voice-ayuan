#!/usr/bin/env node
// End-to-end harness for 网关 → ssh 隧道 → speech-to-speech 实时语音链路.
//
// Usage:
//   node deploy/e2e-voice.mjs generate   # 经上游 TTS 生成中文测试语音 fixture（16k PCM）
//   node deploy/e2e-voice.mjs e2e        # 起独立 gateway → session.hello → 发 PCM → 断言收到 24k 音频/转写
//   node deploy/e2e-voice.mjs tool       # 直连上游验证 function calling（session.update tools → function_call_arguments.done）
//   node deploy/e2e-voice.mjs interrupt  # 验证用户插话打断（server_vad interrupt_response）
//   node deploy/e2e-voice.mjs all        # generate（如缺 fixture）→ e2e → tool
//
// Env:
//   S2S_TUNNEL_URL  默认 ws://127.0.0.1:18765/v1/realtime
//   E2E_GATEWAY_PORT 默认 11500
//   E2E_FIXTURE     默认 deploy/fixtures/zh-user-16k.wav
//   E2E_TIMEOUT_MS  默认 120000

import { fork } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const BOOTSTRAP = join(REPO, 'node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs')
const FIXTURES = join(HERE, 'fixtures')
const OUT = join(HERE, 'out')
const TUNNEL_URL = process.env.S2S_TUNNEL_URL || 'ws://127.0.0.1:18765/v1/realtime'
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT || 11500)
const FIXTURE = process.env.E2E_FIXTURE || join(FIXTURES, 'zh-user-16k.wav')
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120000)
const LOG_PREFIX = '[e2e]'

mkdirSync(FIXTURES, { recursive: true })
mkdirSync(OUT, { recursive: true })

const b64 = (buf) => Buffer.from(buf).toString('base64')
const unB64 = (s) => Buffer.from(String(s || ''), 'base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString().replace('T', ' ').slice(11, 23)
const log = (...a) => console.log(LOG_PREFIX, ...a)
const fail = (msg) => { const e = new Error(msg); throw e }

// ---------- WAV / PCM helpers ----------
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') fail('not a WAV file')
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = buf.subarray(offset + 8, offset + 8 + size)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      }
    } else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt || !data) fail('WAV missing fmt/data chunk')
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) fail('WAV must be 16-bit PCM, got format=' + fmt.audioFormat + ' bits=' + fmt.bitsPerSample)
  return { ...fmt, pcm: data }
}

export function decodePcm16(buf) {
  const samples = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2) / 32768
  return samples
}

export function encodePcm16(samples) {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(s * 32767), i * 2)
  }
  return out
}

export function mono(channels, count) {
  if (!channels || channels === 1) return { channels: 1, samples: count }
  const frames = Math.floor(count / channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let v = 0
    for (let c = 0; c < channels; c += 1) v += channels[c][i] ?? 0
    out[i] = v / channels
  }
  return { channels: 1, samples: out }
}

export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i += 1) {
    const pos = i / ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

export function writeWav16k(path, samples, sampleRate) {
  const pcm = encodePcm16(samples)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([header, pcm]))
  return pcm.length
}

// ---------- isolated gateway process ----------
async function startGateway(port, { tunnelUrl = TUNNEL_URL, env: extraEnv = {} } = {}) {
  const root = join(tmpdir(), 'voice-ayuan-e2e-' + port)
  mkdirSync(root, { recursive: true })
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
    // 关键：s2s provider 只认 SPEECH_TO_SPEECH_REALTIME_URL / S2S_REALTIME_URL。
    SPEECH_TO_SPEECH_REALTIME_URL: tunnelUrl,
    QWEN_AUDIO_AGENT_BACKEND: 'none',
    QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: 'http://127.0.0.1:' + port,
    QWEN_AUDIO_LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'info',
    QWAUDIO_CONFIG_DIR: join(root, 'config'),
    QWAUDIO_DATA_DIR: join(root, 'data'),
    QWAUDIO_STATE_DIR: join(root, 'state'),
    QWEN_AUDIO_AGENT_AUTH_SECRET: 'e2e-' + '0'.repeat(64),
    ...extraEnv,
  }
  const child = fork(BOOTSTRAP, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  const state = { child, origin: null, stderr: '', stdout: '', exited: null, events: 0 }
  child.stdout?.on('data', (d) => { state.stdout += String(d) })
  child.stderr?.on('data', (d) => { state.stderr += String(d) })
  child.on('exit', (code, signal) => { state.exited = { code, signal } })
  const ready = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('gateway start timeout' + '\n' + state.stderr.slice(-2000))), 45000)
    child.on('message', (msg) => {
      if (msg && msg.type === 'qwen-audio-agent:gateway-ready') {
        clearTimeout(timer)
        state.origin = msg.origin
        resolvePromise(msg.origin)
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectPromise(new Error('gateway exited early code=' + code + ' signal=' + signal + '\n' + state.stderr.slice(-3000)))
    })
  })
  log('gateway ready at', ready, '(pid=' + child.pid + ')')
  return state
}

function stopGateway(state) {
  try { state.child.kill() } catch {}
}

// ---------- gateway client ----------
function newClient(origin, { tools = [], onEvent } = {}) {
  const client = new GatewayClient({
    url: origin.replace('http:', 'ws:') + '/api/realtime',
    createSocket: (u) => new WebSocket(u, { headers: { Origin: origin }, handshakeTimeout: 15000 }),
    clientType: 'web',
    clientVersion: '0.1.6',
    clientInstanceId: 'e2e-' + Math.random().toString(36).slice(2, 10),
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
    tools,
    capabilities: ['input.audio', 'input.text', 'session.output_voice', 'session.heartbeat', 'playback.receipts'],
    configure: () => ({
      voiceEnabled: true,
      inputEnabled: true,
      outputEnabled: true,
      provider: 'speech-to-speech',
    }),
    reconnect: false,
    onStatus: (s) => log('client.status', s.state, s.error ? String(s.error.message || s.error) : ''),
    onEvent: (event) => {
      if (onEvent) onEvent(event)
    },
  })
  client.start()
  return client
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now()
    const tick = () => {
      let value
      try { value = predicate() } catch (e) { rejectPromise(e); return }
      if (value) { resolvePromise(value); return }
      if (Date.now() - started > timeoutMs) { rejectPromise(new Error('timeout waiting for ' + label)); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}

// ---------- direct upstream WS (fixture + tool tests) ----------
async function upstreamSession({ onOpen, onEvent, timeoutMs = 60000 }) {
  const ws = new WebSocket(TUNNEL_URL, { handshakeTimeout: 15000 })
  const events = []
  const waiters = []
  ws.on('message', (raw) => {
    let event
    try { event = JSON.parse(String(raw)) } catch { return }
    events.push(event)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i]
      if (w.predicate(event)) { waiters.splice(i, 1); w.resolve(event) }
    }
    if (onEvent) onEvent(event, events)
  })
  await new Promise((resolvePromise, rejectPromise) => {
    ws.once('open', resolvePromise)
    ws.once('error', rejectPromise)
  })
  const send = (payload) => ws.send(JSON.stringify(payload))
  const waitEvent = (predicate, label, ms = timeoutMs) => new Promise((resolvePromise, rejectPromise) => {
    const hit = events.find(predicate)
    if (hit) { resolvePromise(hit); return }
    const timer = setTimeout(() => rejectPromise(new Error('timeout waiting for ' + label)), ms)
    waiters.push({ predicate, resolve: (e) => { clearTimeout(timer); resolvePromise(e) } })
  })
  return { ws, send, events, waitEvent, close: () => { try { ws.close() } catch {} } }
}

const UPSTREAM_SESSION_UPDATE = {
  type: 'session.update',
  session: {
    type: 'realtime',
    output_modalities: ['audio'],
    audio: {
      input: { turn_detection: { type: 'server_vad', interrupt_response: true } },
      output: { format: { type: 'audio/pcm', rate: 24000 } },
    },
  },
}

// ---------- mode: generate fixture (upstream text → TTS audio) ----------
async function modeGenerate() {
  const session = await upstreamSession({
    onEvent: (e) => {
      const show = ['error', 'response.done', 'response.output_text.done', 'response.function_call_arguments.done']
      if (show.includes(e.type)) log('upstream.event', e.type, JSON.stringify(e).slice(0, 400))
    },
  })
  try {
    session.send(UPSTREAM_SESSION_UPDATE)
    await sleep(150)
    const text = process.env.E2E_FIXTURE_TEXT
      || '今天天气不错，我们开始测试实时语音通话，请把这句话说一遍。'
    session.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请用中文说：' + text }] },
    })
    session.send({ type: 'response.create', response: { output_modalities: ['audio'] } })
    const done = await session.waitEvent((e) => e.type === 'response.done', 'response.done', 120000)
    const audio = Buffer.concat(session.events.filter((e) => e.type === 'response.output_audio.delta').map((e) => unB64(e.delta)))
    const transcript = session.events.filter((e) => e.type === 'response.output_audio_transcript.done' || e.type === 'response.output_text.done').map((e) => e.transcript || e.text || '').join('')
    log('generated audio bytes=' + audio.length, 'duration@24k=' + (audio.length / 2 / 24000).toFixed(2) + 's', 'transcript=' + JSON.stringify(transcript))
    if (audio.length < 24000) fail('generated audio too short: ' + audio.length)
    const pcm24 = audio.subarray(0, audio.length - (audio.length % 2))
    const samples24 = decodePcm16(pcm24)
    const samples16 = resampleLinear(samples24, 24000, 16000)
    const wavPath = join(FIXTURES, 'zh-user-24k.wav')
    writeWav16k(wavPath, samples24, 24000)
    writeWav16k(join(FIXTURES, 'zh-user-16k.wav'), samples16, 16000)
    log('fixture written', wavPath, '->', join(FIXTURES, 'zh-user-16k.wav'))
    if (done.response?.status && done.response.status !== 'completed') fail('response status ' + done.response.status)
  } finally {
    session.close()
  }
}

// ---------- mode: full e2e through gateway ----------
async function modeE2e({ skipGateway = false, sampleRate = 16000, fixturePath = FIXTURE } = {}) {
  if (!existsSync(fixturePath)) {
    log('fixture missing, generating …')
    await modeGenerate()
  }
  const wav = parseWav(readFileSync(fixturePath))
  const pcm = wav.pcm
  const seconds = pcm.length / 2 / wav.sampleRate
  log('fixture', fixturePath, wav.sampleRate + 'Hz', wav.channels + 'ch', seconds.toFixed(2) + 's', pcm.length + ' bytes')

  let gateway = null
  let origin = 'http://127.0.0.1:' + GATEWAY_PORT
  if (!skipGateway) {
    gateway = await startGateway(GATEWAY_PORT)
    origin = gateway.origin
  }

  const seen = []
  const audioChunks = []
  const transcripts = []
  const toolCalls = []
  const rawEvents = []
  let connectionState = 'init'
  let voiceState = 'init'
  let playbackStarted = false
  let audioDone = false
  const latency = { pushEnd: 0, userFinal: 0, responseStarted: 0, firstAudio: 0, audioDone: 0 }
  const clientRef = { current: null }
  const client = newClient(origin, {
    onEvent: (event) => {
      const type = event.type
      rawEvents.push(event)
      seen.push(type)
      if (type === 'response.started' && !latency.responseStarted) latency.responseStarted = Date.now()
      if (type === 'audio.delta' && !latency.firstAudio) latency.firstAudio = Date.now()
      if (type === 'voice.connection') { connectionState = event.state; log('voice.connection', event.state, event.provider || '') }
      else if (type === 'voice.state') { voiceState = event.state; log('voice.state', event.state) }
      else if (type === 'audio.delta') {
        audioChunks.push(unB64(event.audio))
        if (audioChunks.length <= 3 || audioChunks.length % 10 === 0) log('audio.delta', 'chunk=' + audioChunks.length, 'b64=' + String(event.audio || '').length, 'rate=' + event.sampleRate)
        // 真客户端会回 playback.started；不回的话网关不会 flush assistant transcript。
        if (!playbackStarted && event.responseId && clientRef.current) {
          playbackStarted = true
          clientRef.current.send({ type: 'playback.started', responseId: event.responseId })
          log('sent playback.started', event.responseId)
        }
      } else if (type === 'audio.done') {
        if (clientRef.current && event.responseId) {
          clientRef.current.send({ type: 'playback.ended', responseId: event.responseId })
          log('sent playback.ended', event.responseId)
        }
        audioDone = true
        log('audio.done', JSON.stringify({ responseId: event.responseId }).slice(0, 200))
      } else if (type === 'transcript.final' || type === 'transcript.delta') {
        transcripts.push(event)
        if (type === 'transcript.final') {
          if (event.role === 'user' && !latency.userFinal) latency.userFinal = Date.now()
          log('transcript.final', event.role + ':', JSON.stringify(event.content || '').slice(0, 200))
        }
      } else if (type === 'tool.call') { toolCalls.push(event); log('tool.call', JSON.stringify(event).slice(0, 300)) }
      else if (type === 'error') log('client.event.error', JSON.stringify(event).slice(0, 300))
      else log('event', type, JSON.stringify(event).slice(0, 180))
    },
  })
  clientRef.current = client

  try {
    await waitFor(() => client.ready, 30000, 'session.ready')
    log('session ready; negotiated:', JSON.stringify(client.negotiatedCapabilities))
    await waitFor(() => connectionState === 'connected' || connectionState === 'ready', 90000, 'voice.connection connected')
    log('upstream voice connection is', connectionState)
    await sleep(500)

    // 推流：100ms 一包恒速。末尾必须补静音，否则上游 server_vad 等不到
    // speech_stopped，本轮永远不会触发 LLM/TTS（实测：不补静音会卡在 transcript）。
    const chunkBytes = Math.round(sampleRate * 0.1) * 2
    const paceMs = Number(process.env.E2E_PACE_MS || 25)
    const silenceMs = Number(process.env.E2E_TRAILING_SILENCE_MS || 2500)
    const sendStarted = Date.now()
    const pushBuffer = async (buffer, label) => {
      for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
        const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + chunkBytes))
        const ok = client.send({ type: 'input_audio_buffer.append', audio: b64(chunk) })
        if (!ok) fail('client.send(input_audio_buffer.append) failed at ' + label + ' offset ' + offset)
        await sleep(paceMs)
      }
    }
    await pushBuffer(pcm, 'speech')
    log('pushed ' + (pcm.length / 2 / sampleRate).toFixed(2) + 's of PCM16/' + sampleRate + ' in', Date.now() - sendStarted, 'ms')
    const silence = Buffer.alloc(Math.round(sampleRate * silenceMs / 1000) * 2)
    await pushBuffer(silence, 'silence')
    log('pushed ' + (silenceMs / 1000).toFixed(2) + 's trailing silence (VAD turn close)')
    latency.pushEnd = Date.now()

    // 等待：1) 输入转写（说话人识别） 2) 助手音频 3) 助手转写
    const deadline = Date.now() + TIMEOUT_MS
    let totalAudio = () => audioChunks.reduce((n, b) => n + b.length, 0)
    let lastProgress = 0
    while (Date.now() < deadline) {
      if (totalAudio() !== lastProgress) lastProgress = totalAudio()
      const inputTranscript = transcripts.find((t) => t.role === 'user' && (t.content || t.text))
      const assistantTranscript = transcripts.find((t) => t.role === 'assistant' && (t.content || t.text))
      if (totalAudio() > 0 && assistantTranscript && audioDone) break
      await sleep(250)
    }
    const audio = Buffer.concat(audioChunks)
    const outRate = 24000
    const assistantT = transcripts.filter((t) => t.role === 'assistant')
    const userT = transcripts.filter((t) => t.role === 'user')
    const assistantText = assistantT.map((t) => t.content || t.text || '').join('')
    const userText = userT.map((t) => t.content || t.text || '').join('')
    const report = {
      mode: 'e2e',
      gatewayOrigin: origin,
      tunnelUrl: TUNNEL_URL,
      input: { sampleRate, channels: 1, bytes: pcm.length, seconds: +(pcm.length / 2 / sampleRate).toFixed(2) },
      output: { sampleRate: outRate, bytes: audio.length, seconds: +(audio.length / 2 / outRate).toFixed(2), chunks: audioChunks.length },
      transcripts: { user: userText, assistant: assistantText, events: transcripts.length },
      connectionState, voiceState,
      eventTypes: [...new Set(seen)],
    }
    if (audio.length > 0) {
      writeWav16k(join(OUT, 'e2e-output-24k.wav'), decodePcm16(audio.subarray(0, audio.length - (audio.length % 2))), outRate)
    }
    writeFileSync(join(OUT, 'e2e-events.jsonl'), rawEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')
    latency.audioDone = audioDone ? Date.now() : 0
    const ms = (from, to) => (from && to ? to - from : null)
    report.latencyMs = {
      pushEndToUserFinal: ms(latency.pushEnd, latency.userFinal),
      pushEndToResponseStarted: ms(latency.pushEnd, latency.responseStarted),
      userFinalToResponseStarted: ms(latency.userFinal, latency.responseStarted),
      responseStartedToFirstAudio: ms(latency.responseStarted, latency.firstAudio),
      pushEndToFirstAudio: ms(latency.pushEnd, latency.firstAudio),
      responseStartedToAudioDone: ms(latency.responseStarted, latency.audioDone),
    }
    writeFileSync(join(OUT, 'e2e-report.json'), JSON.stringify(report, null, 2))
    log('REPORT', JSON.stringify(report, null, 2))
    log('LATENCY(ms)', JSON.stringify(report.latencyMs))
    const ok = audio.length >= 24000 * 2 * 0.3 // 至少 0.3 秒语音
    if (!ok) fail('no/too little output audio (' + audio.length + ' bytes)')
    if (!assistantText && !userText) fail('no transcript received')
    log('E2E PASS: audio=' + (audio.length / 2 / outRate).toFixed(2) + 's, assistant=' + JSON.stringify(assistantText.slice(0, 80)) + ', user=' + JSON.stringify(userText.slice(0, 80)))
    return report
  } finally {
    client.stop()
    if (gateway) stopGateway(gateway)
  }
}

// ---------- mode: function calling against upstream ----------
async function modeTool() {
  const session = await upstreamSession({ onEvent: (e) => { if (e.type === 'error') log('upstream.error', JSON.stringify(e)) } })
  try {
    session.send({
      ...UPSTREAM_SESSION_UPDATE,
      session: {
        ...UPSTREAM_SESSION_UPDATE.session,
        instructions: '你是测试助手。用户要求调用工具时必须调用对应工具，不要只用文字回答。',
        tools: [{
          type: 'function',
          name: 'test_echo',
          description: '回声测试：原样返回 text 参数。',
          parameters: { type: 'object', properties: { text: { type: 'string', description: '要回显的文本' } }, required: ['text'] },
        }],
        tool_choice: 'auto',
      },
    })
    await sleep(150)
    session.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请调用 test_echo 工具，把 text 参数设为「你好阿源」。' }] },
    })
    session.send({ type: 'response.create', response: { output_modalities: ['text'] } })
    const done = await session.waitEvent(
      (e) => e.type === 'response.function_call_arguments.done' || e.type === 'response.output_item.done' && e.item?.type === 'function_call',
      'function_call_arguments.done',
      120000,
    )
    const call = session.events.find((e) => e.type === 'response.function_call_arguments.done')
      || session.events.flatMap((e) => (e.item ? [e.item] : [])).find((i) => i.type === 'function_call')
    const report = {
      mode: 'tool',
      event: done.type,
      name: call?.name,
      arguments: call?.arguments,
      callId: call?.call_id || call?.callId,
      events: [...new Set(session.events.map((e) => e.type))],
    }
    writeFileSync(join(OUT, 'tool-report.json'), JSON.stringify(report, null, 2))
    log('TOOL REPORT', JSON.stringify(report, null, 2))
    if (!call || !call.name) fail('no function_call event')
    log('TOOL PASS: model called ' + call.name + ' with ' + call.arguments)
    return report
  } finally {
    session.close()
  }
}

// ---------- mode: interruption while assistant speaks ----------
async function modeInterrupt() {
  const session = await upstreamSession({ onEvent: (e) => {
    if (['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'response.interrupted', 'response.done', 'response.created', 'error'].includes(e.type)) {
      log('upstream.event', e.type, JSON.stringify(e).slice(0, 300))
    }
  } })
  try {
    if (!existsSync(FIXTURE)) await modeGenerate()
    const wav = parseWav(readFileSync(FIXTURE))
    session.send(UPSTREAM_SESSION_UPDATE)
    await sleep(150)
    // 先让助手开始说一段较长的话
    session.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请用中文讲一段大约二十秒的关于春天的短文。' }] },
    })
    session.send({ type: 'response.create', response: { output_modalities: ['audio'] } })
    await session.waitEvent((e) => e.type === 'response.created' || e.type === 'response.output_audio.delta', 'assistant started', 60000)
    log('assistant started, feeding user barge-in speech …')
    const chunkBytes = 3200
    for (let offset = 0; offset < wav.pcm.length; offset += chunkBytes) {
      session.send({ type: 'input_audio_buffer.append', audio: b64(wav.pcm.subarray(offset, Math.min(wav.pcm.length, offset + chunkBytes))) })
      await sleep(15)
    }
    const interrupted = await session.waitEvent((e) => e.type === 'input_audio_buffer.speech_started' || e.type === 'response.interrupted', 'interrupt', 60000)
    const report = {
      mode: 'interrupt',
      firstSignal: interrupted.type,
      sawSpeechStarted: session.events.some((e) => e.type === 'input_audio_buffer.speech_started'),
      sawResponseInterrupted: session.events.some((e) => e.type === 'response.interrupted'),
      sawCanceledDone: session.events.some((e) => e.type === 'response.done' && e.response?.status === 'cancelled'),
      events: [...new Set(session.events.map((e) => e.type))],
    }
    writeFileSync(join(OUT, 'interrupt-report.json'), JSON.stringify(report, null, 2))
    log('INTERRUPT REPORT', JSON.stringify(report, null, 2))
    log('INTERRUPT PASS: ' + interrupted.type)
    return report
  } finally {
    session.close()
  }
}

// ---------- mode: two concurrent upstream sessions ----------
async function modeConcurrent() {
  const httpPool = async () => {
    const res = await fetch('http://127.0.0.1:18765/v1/pool')
    return await res.json()
  }
  const first = await upstreamSession({ timeoutMs: 30000 })
  const second = await upstreamSession({ timeoutMs: 30000 })
  try {
    await Promise.all([
      first.waitEvent((e) => e.type === 'session.created', 'session.created #1', 20000),
      second.waitEvent((e) => e.type === 'session.created', 'session.created #2', 20000),
    ])
    // 第二条连接成功本身就证明 pool=2 生效（pool=1 时第二个连接会被 1011/拒绝）
    await sleep(500)
    const pool = await httpPool()
    const report = {
      mode: 'concurrent',
      sessionsAccepted: 2,
      pool,
      firstSessionIds: [...new Set(first.events.map((e) => e.session?.id).filter(Boolean))],
      secondSessionIds: [...new Set(second.events.map((e) => e.session?.id).filter(Boolean))],
    }
    writeFileSync(join(OUT, 'concurrent-report.json'), JSON.stringify(report, null, 2))
    log('CONCURRENT REPORT', JSON.stringify(report, null, 2))
    if (Number(pool.in_use) < 2) fail('pool in_use < 2 while both sessions open: ' + JSON.stringify(pool))
    log('CONCURRENT PASS: both upstream sessions accepted, pool in_use=' + pool.in_use)
    return report
  } finally {
    first.close()
    second.close()
  }
}

// ---------- main ----------
const mode = process.argv[2] || 'all'
try {
  if (mode === 'generate') await modeGenerate()
  else if (mode === 'e2e') await modeE2e({ skipGateway: process.argv.includes('--skip-gateway'), sampleRate: Number(process.env.E2E_INPUT_RATE || 16000) })
  else if (mode === 'tool') await modeTool()
  else if (mode === 'interrupt') await modeInterrupt()
  else if (mode === 'concurrent') await modeConcurrent()
  else if (mode === 'all') {
    await modeGenerate()
    await modeE2e({ skipGateway: process.argv.includes('--skip-gateway') })
    await modeTool()
  } else fail('unknown mode: ' + mode + ' (generate|e2e|tool|interrupt|all)')
  process.exit(0)
} catch (error) {
  console.error(LOG_PREFIX, 'FAILED:', error?.stack || String(error))
  process.exit(1)
}
