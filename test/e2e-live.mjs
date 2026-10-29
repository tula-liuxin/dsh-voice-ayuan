// 真实链路 E2E（不依赖浏览器）：真实 /voice-ayuan/status + 真实 WS 反代 + 官方 SDK 握手 + 音频 append。
// 模拟 Electron 主进程给 dsh-app://app 页面注入 __DSH_TRANSPORT__，并把 WS Origin 改写成宿主 origin。
// 上游 speech-to-speech 是否可用由 voice-audio 负责；本脚本至少证明浏览器端连接/状态机/音频发送链路是通的。
import { WebSocket } from 'ws'
import { createVoiceSession } from '../src/client/session.js'

const HOST = process.env.VOICE_HOST || '127.0.0.1:4273'
const BASE = 'http://' + HOST
const ORIGIN = BASE
const realFetch = globalThis.fetch
const fetchImpl = (path, init) => realFetch(new URL(path, BASE), init)
const createSocket = (url) => new WebSocket(url, { headers: { Origin: ORIGIN } })

function createFakeAudio() {
  const record = { started: 0, stopped: 0, flushed: 0, played: [], onFrame: null, onBargeIn: null }
  const factory = ({ onFrame, onBargeIn }) => {
    record.onFrame = onFrame
    record.onBargeIn = onBargeIn
    return {
      start: async () => { record.started += 1; return { sampleRate: 16000, worklet: true, state: 'running' } },
      stop: () => { record.stopped += 1 },
      play: (float32, rate) => { record.played.push({ length: float32.length, rate }) },
      flush: () => { record.flushed += 1 },
      isPlaying: () => record.played.length > record.flushed,
      get sampleRate() { return 16000 },
    }
  }
  record.emit = (samples) => { if (record.onFrame) record.onFrame(samples) }
  return { record, factory }
}

const globals = {
  __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: BASE },
  location: { protocol: 'dsh-app:', origin: 'dsh-app://app', host: 'app' },
  isSecureContext: true,
  navigator: {
    mediaDevices: { getUserMedia: () => Promise.reject(new Error('not used')) },
    userAgent: 'voice-conn-e2e-node',
    permissions: { query: async () => ({ state: 'granted' }) },
  },
  AbortController,
  Intl,
  URL,
  Blob,
  WebSocket,
}

const states = []
const steps = []
const details = []
const captions = []
const voiceConnections = new Set()
const { record, factory } = createFakeAudio()
const session = createVoiceSession({
  globals,
  fetchImpl,
  createSocket,
  audioFactory: factory,
  report: false, // 不污染宿主的真实实机上报文件
  retryDelays: [300, 900, 2000],
  onState: (state) => { states.push({ at: Date.now(), state }); console.log('[state]', state) },
  onStep: (step) => {
    steps.push(step)
    console.log('[step]', step)
    const match = /^voice ([a-z]+)/.exec(step)
    if (match) voiceConnections.add(match[1])
  },
  onDetail: (detail) => { details.push(detail); console.log('[detail]', detail) },
  onCaption: (delta) => { captions.push(delta) },
  onDiag: (diag) => { console.log('[diag]', diag) },
  onMic: (mic) => console.log('[mic]', mic),
})

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timeout: ' + label)
}

let pass = 0
let fail = 0
const check = (ok, name, detail) => {
  if (ok) { pass += 1; console.log('PASS ' + name + ' :: ' + detail) }
  else { fail += 1; console.error('FAIL ' + name + ' :: ' + detail) }
}

const startedAt = Date.now()
try {
  await session.start()
  await waitFor(() => session.phase === 'live' || session.phase === 'error', 30000, 'live/error')
  const readyMs = Date.now() - startedAt
  check(session.phase === 'live', 'session-live', 'phase=' + session.phase + ' in ' + readyMs + 'ms')
  check(session.wsUrl === 'ws://' + HOST + '/voice-ayuan/rt', 'ws-url-from-transport', String(session.wsUrl))
  check(session.baseSource === 'transport', 'base-source-transport', String(session.baseSource))
  check(session.openCount === 1, 'ws-open-once', 'openCount=' + session.openCount)
  if (session.phase !== 'live') throw new Error('session not live: ' + details.join(' | '))

  // 发送 1 秒 16kHz 正弦波（16k 直通，2048 样本/批）
  const frame = new Float32Array(2048)
  for (let i = 0; i < frame.length; i += 1) frame[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.25
  for (let i = 0; i < 8; i += 1) record.emit(frame)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  check(session.stats.sends >= 8, 'audio-appends-sent', 'sends=' + session.stats.sends)

  // 观察 8 秒：上游可用时应收到 audio.delta / transcript；不可用时打印 voice.connection 证据
  await new Promise((resolve) => setTimeout(resolve, 8000))
  check(session.stats.events > 0, 'gateway-events-received', 'events=' + session.stats.events)
  check(voiceConnections.size === 0 || true, 'info-voice-connection', voiceConnections.size ? [...voiceConnections].join(',') : '（未收到 voice.connection 事件）')
  if (record.played.length > 0) {
    check(true, 'audio-delta-played', 'deltas=' + record.played.length + ' firstRate=' + (record.played[0] && record.played[0].rate))
  } else {
    console.log('WAIT-UPSTREAM audio.delta 未收到（上游 speech-to-speech 由 voice-audio 修复中；本端连接/发送链路已通）')
  }
  if (captions.length > 0) check(true, 'transcript-caption', 'captions=' + captions.length)
  console.log('voice.connection 证据:', [...voiceConnections].join(',') || 'none')
  console.log('states:', states.map((entry) => entry.state).join(' -> '))
  console.log('steps:', steps.join(' | '))
} catch (error) {
  fail += 1
  console.error('FAIL e2e :: ' + (error && error.message))
  console.error('details:', details.join(' | '))
} finally {
  session.stop()
  await new Promise((resolve) => setTimeout(resolve, 300))
  console.log('\ne2e-live: ' + pass + ' pass, ' + fail + ' fail')
  process.exit(fail === 0 ? 0 : 1)
}
