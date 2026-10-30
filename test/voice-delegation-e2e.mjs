#!/usr/bin/env node
/**
 * 语音派活端到端验证（不需要浏览器/麦克风）：
 *
 *   用真实前端客户端模块（src/client/session.js）连 **正在运行的** 插件宿主
 *   （默认 http://127.0.0.1:3240，即 leo 上这个 DSH），注入一段由上游 TTS 合成的
 *   「用户语音请求」→ 网关 → 上游 speech-to-speech → 前台模型 → spawn_thinking
 *   → 宿主 bridge → 用户在阿源工作区的 live 会话真正执行 → 语音播报结果。
 *
 * 断言（全部来自真实日志/事件，不做任何 mock）：
 *   1. 网关日志出现 spawn_thinking 的 `realtime.tool_call.received`（且发生在 response.done 之前）；
 *   2. 宿主 voice-ayuan.log 出现 `bridge-task-accepted`，任务是本次请求；
 *   3. 任务走到 `bridge-task-terminal` 且 state=result（或至少不是静默丢失）；
 *   4. 客户端收到助手语音（audio played）与助手转写（captions）。
 *
 * 用法：
 *   node test/voice-delegation-e2e.mjs                 # 正常一轮
 *   node test/voice-delegation-e2e.mjs --race          # 助手说话时注入 160ms 微噪声（复现 speculative reopen）
 *   node test/voice-delegation-e2e.mjs --no-noise --request "帮我查一下今天有哪些待办"
 *
 * 环境变量：
 *   VOICE_HOST            插件宿主地址，默认 127.0.0.1:3240
 *   S2S_TUNNEL_URL        上游实时服务，默认 ws://127.0.0.1:18765/v1/realtime（由插件隧道维护）
 *   E2E_TIMEOUT_MS        整体超时，默认 180000
 *   E2E_KEEP_AUDIO        设为 1 时把本次合成/收到的音频写到系统临时目录
 *
 * 前置：本机 DSH 在跑、voice-ayuan 已接线、隧道 18765 可用、阿源工作区至少可自动建会话。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createVoiceSession } from '../src/client/session.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const HOST = process.env.VOICE_HOST || '127.0.0.1:3240'
const BASE = 'http://' + HOST
const TUNNEL_URL = process.env.S2S_TUNNEL_URL || 'ws://127.0.0.1:18765/v1/realtime'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180_000)
const KEEP_AUDIO = process.env.E2E_KEEP_AUDIO === '1'
const CACHE_DIR = join(tmpdir(), 'voice-ayuan-e2e-fixtures')
const OUT_DIR = join(HERE, '.out')
const GATEWAY_LOG = join(homedir(), '.config', 'qwaudio', 'state', 'logs', 'gateway.log')
const BRIDGE_LOG = join(homedir(), '.dsh', 'logs', 'voice-ayuan.log')

const args = process.argv.slice(2)
const RACE = args.includes('--race')
const argValue = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const REQUEST = argValue('--request', '帮我查一下今天有哪些待办')
const NOISE_TEXT = '呃'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b64 = buf => Buffer.from(buf).toString('base64')
const unB64 = s => Buffer.from(String(s || ''), 'base64')
const log = (...a) => console.log('[e2e]', ...a)

mkdirSync(CACHE_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------- PCM helpers

function resampleLinear(input, fromRate, toRate) {
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

const decodePcm16 = buf => {
  const samples = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2) / 32768
  return samples
}

const encodePcm16 = samples => {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  }
  return out
}

function writeWav16k(path, samples) {
  const pcm = encodePcm16(samples)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([header, pcm]))
}

// ------------------------------------------------------- 上游 TTS 合成用户语音

/** 通过上游实时服务让 TTS 把一句话说成 16k PCM（真实音色，STT/VAD 都会当真）。 */
async function synthesize16k(text) {
  const key = createHash('sha1').update('v1:' + text).digest('hex').slice(0, 16)
  const cache = join(CACHE_DIR, key + '.json')
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8'))
    return { samples: decodePcm16(unB64(saved.pcm16)), cached: true }
  }
  const ws = new WebSocket(TUNNEL_URL)
  const events = []
  const waiters = []
  const emit = e => { events.push(e); for (const w of [...waiters]) if (w.predicate(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e) } }
  const waitEvent = (predicate, label, ms = 60_000) => new Promise((res, rej) => {
    const hit = events.find(predicate)
    if (hit) { res(hit); return }
    const timer = setTimeout(() => rej(new Error('timeout waiting for ' + label)), ms)
    waiters.push({ predicate, resolve: e => { clearTimeout(timer); res(e) } })
  })
  ws.on('message', raw => { try { emit(JSON.parse(raw.toString())) } catch {} })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      audio: {
        input: { turn_detection: { type: 'server_vad', interrupt_response: true } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  }))
  await sleep(150)
  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `请逐字原样朗读下面这句话，不要添加任何别的内容：${text}` }] },
  }))
  ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }))
  let done
  try {
    done = await waitEvent(e => e.type === 'response.done', 'response.done')
  } finally {
    try { ws.close() } catch {}
  }
  const chunks = events.filter(e => e.type === 'response.output_audio.delta').map(e => unB64(e.delta))
  const pcm24 = Buffer.concat(chunks)
  if (pcm24.length < 16000) throw new Error('合成的用户语音太短：' + pcm24.length + ' bytes (' + (done?.response?.status || '?') + ')')
  const samples = resampleLinear(decodePcm16(pcm24), 24000, 16000)
  writeFileSync(cache, JSON.stringify({ text, pcm16: b64(encodePcm16(samples)) }))
  if (KEEP_AUDIO) writeWav16k(join(OUT_DIR, 'input-' + key + '.wav'), samples)
  return { samples, cached: false }
}

// ------------------------------------------------------------------ 假音频设备

function createFakeAudio() {
  const rec = { played: [], flushed: 0, started: 0, stopped: 0, onFrame: null, totalPlayedSamples: 0 }
  const factory = ({ onFrame }) => {
    rec.onFrame = onFrame
    return {
      start: async () => { rec.started += 1; return { sampleRate: 16000, worklet: true, state: 'running' } },
      stop: () => { rec.stopped += 1 },
      play: (samples) => { rec.played.push(samples); rec.totalPlayedSamples += samples.length },
      flush: () => { rec.flushed += 1 },
      isPlaying: () => rec.played.length > rec.flushed,
      get sampleRate() { return 16000 },
    }
  }
  rec.emit = samples => { try { rec.onFrame?.(samples) } catch {} }
  return { rec, factory }
}

/** 按 20ms 一帧实时推入麦克风帧（320 samples @16k）。 */
async function pushPaced(rec, samples, { realtime = true } = {}) {
  const chunk = 320
  for (let offset = 0; offset < samples.length; offset += chunk) {
    rec.emit(samples.subarray(offset, Math.min(samples.length, offset + chunk)))
    if (realtime) await sleep(20)
  }
}

const silence = ms => new Float32Array(Math.round(16000 * ms / 1000))

// ------------------------------------------------------------------ 日志断言

function readJsonl(file, startMs) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const out = []
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        const t = row.t ? Date.parse(row.t) : (row.time ? Date.parse(row.time) : 0)
        if (t >= startMs) out.push({ ...row, _t: t })
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- gateway log

function gatewayEventsSince(startMs) {
  // gateway.log 的 time 是 ISO，正文是扁平 JSON；按行解析即可。
  return readJsonl(GATEWAY_LOG, startMs)
}

// ---------------------------------------------------------------------- main

const startedAt = Date.now()
const report = { startedAt: new Date().toISOString(), host: HOST, request: REQUEST, race: RACE, checks: [], audio: {}, logs: {} }
const check = (ok, name, detail) => {
  report.checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))
  return ok
}

const { rec, factory } = createFakeAudio()
const captions = []
const states = []
const session = createVoiceSession({
  globals: {
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: BASE },
    location: { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' },
    isSecureContext: true,
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('not used')) },
      userAgent: 'voice-delegation-e2e',
      permissions: { query: async () => ({ state: 'granted' }) },
    },
    AbortController, Intl, URL, Blob, WebSocket,
  },
  fetchImpl: (path, init) => fetch(new URL(path, BASE), init),
  createSocket: url => new WebSocket(url, { headers: { Origin: BASE } }),
  audioFactory: factory,
  report: false,
  retryDelays: [300, 900, 2000],
  onState: state => { states.push(state); log('state', state) },
  onStep: step => log('step', step),
  onDetail: detail => log('detail', detail),
  onCaption: delta => { captions.push(delta) },
  onDiag: diag => log('diag', JSON.stringify(diag).slice(0, 200)),
  onMic: mic => log('mic', JSON.stringify(mic).slice(0, 160)),
})

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  throw new Error('waitFor timeout: ' + label)
}

let exitCode = 1
try {
  log('synthesizing user speech via upstream TTS …')
  const request = await synthesize16k(REQUEST)
  const noise = RACE ? await synthesize16k(NOISE_TEXT) : null
  log('user speech', (request.samples.length / 16000).toFixed(2) + 's', request.cached ? '(cached)' : '(generated)',
    RACE ? '| noise ' + (noise.samples.length / 16000).toFixed(2) + 's' : '')
  report.requestAudio = { seconds: +(request.samples.length / 16000).toFixed(2), cached: request.cached }
  if (RACE) report.noiseAudio = { seconds: +(noise.samples.length / 16000).toFixed(2) }

  const conversationStart = Date.now()
  await session.start()
  await waitFor(() => session.phase === 'live' || session.phase === 'error', 30_000, 'session live')
  if (!check(session.phase === 'live', 'session-live', 'phase=' + session.phase)) throw new Error('session not live')

  // 1) 用户说出请求（真实语音帧），再补静音让 VAD 收轮。
  await pushPaced(rec, request.samples)
  log('pushed request speech, waiting for assistant …')
  await pushPaced(rec, silence(700))

  // 2) 助手开始说话时注入 160ms 微噪声（--race），复现 speculative reopen 窗口。
  let injected = false
  if (RACE) {
    const playbackDeadline = Date.now() + 40_000
    while (Date.now() < playbackDeadline && !injected) {
      if (rec.played.length > 0) {
        await sleep(350)
        await pushPaced(rec, noise.samples.subarray(0, Math.min(noise.samples.length, 160 * 16)))
        log('injected 160ms micro-noise while assistant speaking')
        injected = true
      }
      await sleep(40)
    }
  }
  // 3) 收尾静音（同时保证 VAD turn 关闭、user 不会被判一直说话）。
  await pushPaced(rec, silence(2500))
  log('trailing silence pushed; waiting for tool call / bridge task …')

  // 4) 等派活发生：网关 tool_call.received 或 bridge-task-accepted。
  const deadline = Date.now() + TIMEOUT_MS
  let toolCall = null
  let taskAccepted = null
  while (Date.now() < deadline) {
    const gws = gatewayEventsSince(conversationStart)
    toolCall = gws.find(e => e.event === 'realtime.tool_call.received' && e.toolName === 'spawn_thinking') || null
    const bridge = readJsonl(BRIDGE_LOG, conversationStart)
    taskAccepted = bridge.find(e => e.kind === 'bridge-task-accepted' && e._t >= conversationStart) || null
    if (taskAccepted) break
    if (toolCall && Date.now() - conversationStart > TIMEOUT_MS) break
    await sleep(500)
  }
  check(Boolean(toolCall), 'gateway-received-spawn_thinking',
    toolCall ? `callId=${toolCall.callId} responseId=${toolCall.responseId} at ${new Date(toolCall._t).toISOString()}` : 'no realtime.tool_call.received(spawn_thinking) in gateway.log')
  check(Boolean(taskAccepted), 'bridge-task-accepted',
    taskAccepted ? `task=${taskAccepted.task} session=${taskAccepted.session} instruction=${String(taskAccepted.instruction || '').slice(0, 80)}` : 'no bridge-task-accepted in voice-ayuan.log')

  // 5) 等任务终态（result / failed），并等助手语音播报（音频 + 转写）。
  let terminal = null
  if (taskAccepted) {
    const termDeadline = Date.now() + 150_000
    while (Date.now() < termDeadline) {
      const bridge = readJsonl(BRIDGE_LOG, conversationStart)
      terminal = bridge.find(e => e.kind === 'bridge-task-terminal' && e.task === taskAccepted.task) || null
      if (terminal) break
      await sleep(500)
    }
  }
  // 给网关一点时间把结果播报出来（等音频/转写）
  await sleep(6000)
  const assistantText = captions.join('').trim()
  report.checks.push({ name: 'assistant-captions', ok: Boolean(assistantText), detail: assistantText.slice(0, 300) })
  if (assistantText) log('assistant said:', JSON.stringify(assistantText.slice(0, 300)))
  check(Boolean(terminal), 'bridge-task-terminal',
    terminal ? `state=${terminal.state} elapsedMs=${terminal.elapsedMs} preview=${String(terminal.preview || '').slice(0, 120)}` : 'task never reached a terminal state')
  check(rec.played.length > 0, 'assistant-audio-played', `deltas=${rec.played.length} seconds=${(rec.totalPlayedSamples / 24000).toFixed(2)}`)
  check(Boolean(assistantText), 'assistant-transcript-received', assistantText.slice(0, 120))

  report.audio = { playedDeltas: rec.played.length, playedSeconds: +(rec.totalPlayedSamples / 24000).toFixed(2), captions: assistantText.slice(0, 500) }
  report.logs = { toolCall, taskAccepted, terminal }
  const ok = report.checks.every(c => c.ok || c.name === 'assistant-audio-played')
  const core = ['gateway-received-spawn_thinking', 'bridge-task-accepted', 'bridge-task-terminal']
  exitCode = core.every(n => report.checks.find(c => c.name === n)?.ok) ? 0 : 1
  if (!ok) log('some non-core checks failed; see report')
} catch (error) {
  console.error('[e2e] FAILED:', error?.stack || String(error))
  report.error = String(error?.message || error)
} finally {
  try { session.stop() } catch {}
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT_DIR, 'voice-delegation-report.json'), JSON.stringify(report, null, 2))
  log('report:', join(OUT_DIR, 'voice-delegation-report.json'))
  // 等 WS 关闭再退出，避免 release 掉未完成的 turn。
  await sleep(500)
  process.exit(exitCode)
}
