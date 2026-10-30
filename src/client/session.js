// 实时语音会话引擎：宿主 WebSocket（同源反代）+ 麦克风采集 + 播放队列。
// 视图层只通过 createVoiceSession({...}) 的回调感知状态，不直接碰 Socket/AudioContext。
//
// 关键背景（DSH 桌面 Electron）：
// - 主窗口页面 origin 是 dsh-app://app，不是 http://127.0.0.1:<port>，所以不能用
//   location.host 拼 WS 地址（会得到 ws://app/... → DNS 失败 → close 1006）。
// - 桌面主进程通过 IPC boot 注入 globalThis.__DSH_TRANSPORT__ = { ownsHost, streamBaseUrl }，
//   streamBaseUrl 是宿主真实 origin（http://127.0.0.1:<webServerPort>）。主进程的
//   webRequest 钩子会把来自 dsh-app://app 的 ws://127.0.0.1/* 请求的 Origin 改写成宿主
//   origin 并注入 host cookie —— 这是 DSH 官方支持的 WS 通道。
// - 普通浏览器 web 模式没有 __DSH_TRANSPORT__，此时页面 origin 就是宿主 origin。
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { b64encode, b64decodeToFloat32, downmixTo16k, WORKLET, MIC_BATCH_SAMPLES } from './pcm.js'

export const STATUS_PATH = '/voice-ayuan/status'
export const REALTIME_PATH = '/voice-ayuan/rt'
export const REPORT_PATH = '/voice-ayuan/report'
export const DEFAULT_RETRY_DELAYS = [300, 900, 2000]
export const DEFAULT_INPUT_RATE = 16000
export const DEFAULT_OUTPUT_RATE = 24000

const BARGE_IN_RMS = 0.02
const BARGE_IN_HOLD_MS = 80
const BARGE_IN_COOLDOWN_MS = 600
const MAX_SOCKET_BUFFERED = 2 * 1024 * 1024
const PLAYBACK_LEAD_S = 0.03
const STATUS_RETRY_MS = 400

function delay(ms, setTimeoutImpl) {
  return new Promise((resolve) => setTimeoutImpl(resolve, ms))
}

function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * 解析宿主 base（导出供测试）。
 * 桌面 dsh-app://app 页面必须走 __DSH_TRANSPORT__.streamBaseUrl；普通 http(s) 页面用 location.origin。
 * 两者都没有时返回 base=null 与可读 error，调用方必须明确报错，不能静默拼 location.host。
 */
export function resolveHostBase(globals = globalThis) {
  const result = { base: null, source: 'none', transport: null, error: null }
  const transport = globals && globals.__DSH_TRANSPORT__
  if (transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl.trim()) {
    result.transport = transport.streamBaseUrl.trim()
    const normalized = normalizeBase(result.transport)
    if (normalized) {
      result.base = normalized
      result.source = 'transport'
      return result
    }
    result.error = '__DSH_TRANSPORT__.streamBaseUrl 不是可用的 http(s) 地址：' + result.transport
  }
  const location = globals && globals.location
  if (location && (location.protocol === 'http:' || location.protocol === 'https:') && location.origin && location.origin !== 'null') {
    const normalized = normalizeBase(location.origin)
    if (normalized) {
      result.base = normalized
      result.source = 'location'
      result.error = null
      return result
    }
  }
  if (!result.error) {
    result.error = location && location.protocol === 'dsh-app:'
      ? '页面 origin 是 dsh-app://app，但缺少 __DSH_TRANSPORT__.streamBaseUrl（桌面 boot 注入缺失）'
      : '页面没有 http(s) origin，也没有 __DSH_TRANSPORT__.streamBaseUrl，无法确定宿主地址'
  }
  return result
}

/** 由宿主 base 构造实时反代 WS 地址（导出供测试）。http→ws，https→wss。 */
export function buildRealtimeUrl(base, path = REALTIME_PATH) {
  const normalized = normalizeBase(base)
  if (!normalized) return null
  try {
    const url = new URL(path, normalized)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  } catch {
    return null
  }
}

/**
 * 浏览器音频引擎：AudioWorklet（兜底 ScriptProcessor）采集、16k PCM 批量回调、
 * 播放队列（按 audio.delta 自带采样率排程）、用户说话打断检测。
 * 测试里可以注入假的 audioFactory，不依赖浏览器。
 */
export function createBrowserAudioEngine({ onFrame, onBargeIn, globals = globalThis } = {}) {
  let ctx = null
  let stream = null
  let sourceNode = null
  let workletNode = null
  let scriptNode = null
  let muteGain = null
  let stopped = false
  let muted = false
  let zeroBuf = new Float32Array(0)
  let worklet = true
  let pending = new Float32Array(MIC_BATCH_SAMPLES)
  let pendingLength = 0
  let voicedMs = 0
  let lastBargeAt = 0
  const queue = { nextTime: 0, sources: new Set() }

  const resume = () => {
    if (ctx && ctx.state === 'suspended') return Promise.resolve(ctx.resume()).catch(() => {})
    return Promise.resolve()
  }

  const play = (float32, sampleRate = DEFAULT_OUTPUT_RATE) => {
    if (!ctx || ctx.state === 'closed' || !float32 || float32.length === 0) return
    const rate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_OUTPUT_RATE
    try {
      const buffer = ctx.createBuffer(1, float32.length, rate)
      buffer.copyToChannel(float32, 0)
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime + PLAYBACK_LEAD_S, queue.nextTime)
      node.start(startAt)
      queue.nextTime = startAt + buffer.duration
      queue.sources.add(node)
      node.onended = () => { queue.sources.delete(node) }
      resume()
    } catch {
      // 单帧播放失败不致命，继续接收后续 delta。
    }
  }

  const flush = () => {
    for (const node of queue.sources) {
      try { node.stop() } catch {}
    }
    queue.sources.clear()
    queue.nextTime = 0
  }

  const isPlaying = () => queue.sources.size > 0

  // 静音期间上游收到的仍是等长零样本：音频流节奏连续（服务端不会因为「没数据」告警/超时），
  // 但 VAD 听不到人声；本端也不做打断检测——用户已主动关麦。
  const zeroes = (length) => {
    if (zeroBuf.length < length) zeroBuf = new Float32Array(Math.max(length, 1024))
    return zeroBuf.subarray(0, length)
  }

  const pushBatch = (channel) => {
    // 批量聚合到 ~2048 样本再回调（48k ≈ 43ms/条）。
    if (pendingLength + channel.length > pending.length) {
      const grown = new Float32Array(Math.max(pending.length * 2, pendingLength + channel.length, MIC_BATCH_SAMPLES))
      grown.set(pending.subarray(0, pendingLength))
      pending = grown
    }
    pending.set(channel, pendingLength)
    pendingLength += channel.length
    if (pendingLength >= MIC_BATCH_SAMPLES) {
      const batch = pending.slice(0, pendingLength)
      pendingLength = 0
      try { onFrame?.(batch) } catch {}
    }
  }

  const pushFrame = (channel) => {
    if (stopped || !ctx || !channel || channel.length === 0) return
    if (muted) { pushBatch(zeroes(channel.length)); return }
    const frameMs = (channel.length / ctx.sampleRate) * 1000
    // 本端打断检测：只在播放中、能量持续超过阈值时触发一次（带冷却）。
    let energy = 0
    for (let i = 0; i < channel.length; i += 1) energy += channel[i] * channel[i]
    const rms = Math.sqrt(energy / channel.length)
    if (isPlaying() && rms >= BARGE_IN_RMS) {
      voicedMs += frameMs
      const at = Date.now()
      if (voicedMs >= BARGE_IN_HOLD_MS && at - lastBargeAt >= BARGE_IN_COOLDOWN_MS) {
        lastBargeAt = at
        voicedMs = 0
        try { onBargeIn?.() } catch {}
      }
    } else if (voicedMs > 0) {
      voicedMs = Math.max(0, voicedMs - frameMs * 0.5)
    }
    pushBatch(channel)
  }

  // 关麦 = 停止上行真实人声（静音帧保活连接）并禁用采集轨道；开麦恢复。
  const setMuted = (value) => {
    muted = Boolean(value)
    voicedMs = 0
    try { if (stream) stream.getAudioTracks().forEach((track) => { track.enabled = !muted }) } catch {}
    return muted
  }

  const describe = () => ({
    sampleRate: ctx ? ctx.sampleRate : 0,
    worklet,
    state: ctx ? ctx.state : 'none',
  })

  const start = async () => {
    if (ctx) return describe()
    const AudioContextCtor = globals.AudioContext || globals.webkitAudioContext
    if (!AudioContextCtor) throw new Error('AudioContext 不可用')
    const mediaDevices = globals.navigator && globals.navigator.mediaDevices
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') throw new Error('navigator.mediaDevices.getUserMedia 不可用')
    ctx = new AudioContextCtor()
    stream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    if (stopped) { try { stream.getTracks().forEach((track) => track.stop()) } catch {} ; throw new Error('会话已关闭') }
    if (ctx.state === 'suspended') { try { await ctx.resume() } catch {} }
    sourceNode = ctx.createMediaStreamSource(stream)
    try {
      const url = globals.URL.createObjectURL(new globals.Blob([WORKLET], { type: 'application/javascript' }))
      try { await ctx.audioWorklet.addModule(url) } finally { globals.URL.revokeObjectURL(url) }
      const WorkletNodeCtor = globals.AudioWorkletNode
      if (!WorkletNodeCtor) throw new Error('AudioWorkletNode 不可用')
      workletNode = new WorkletNodeCtor(ctx, 'voice-ayuan-capture')
      workletNode.port.onmessage = (event) => pushFrame(event.data)
      sourceNode.connect(workletNode)
      worklet = true
    } catch (error) {
      // 只有这里（Worklet 不可用）才降级到 ScriptProcessor；不是假语音，只是采集实现不同。
      const ScriptProcessorCtor = ctx.createScriptProcessor ? 'createScriptProcessor' : null
      if (!ScriptProcessorCtor) throw error
      worklet = false
      scriptNode = ctx.createScriptProcessor(2048, 1, 1)
      muteGain = ctx.createGain()
      muteGain.gain.value = 0
      scriptNode.onaudioprocess = (event) => pushFrame(event.inputBuffer.getChannelData(0))
      sourceNode.connect(scriptNode)
      scriptNode.connect(muteGain)
      muteGain.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') { try { await ctx.resume() } catch {} }
    return describe()
  }

  const stop = () => {
    stopped = true
    muted = false
    flush()
    try { if (workletNode) workletNode.port.onmessage = null } catch {}
    try { if (scriptNode) scriptNode.onaudioprocess = null } catch {}
    try { if (sourceNode) sourceNode.disconnect() } catch {}
    try { if (workletNode) workletNode.disconnect() } catch {}
    try { if (scriptNode) scriptNode.disconnect() } catch {}
    try { if (muteGain) muteGain.disconnect() } catch {}
    try { if (stream) stream.getTracks().forEach((track) => track.stop()) } catch {}
    try { if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {}) } catch {}
    ctx = null
    stream = null
    sourceNode = null
    workletNode = null
    scriptNode = null
    muteGain = null
  }

  return {
    start,
    stop,
    play,
    flush,
    isPlaying,
    resume,
    setMuted,
    toggleMuted: () => setMuted(!muted),
    get muted() { return muted },
    get sampleRate() { return ctx ? ctx.sampleRate : 0 },
  }
}

export function createVoiceSession({
  globals = globalThis,
  onState = () => {},
  onStep = () => {},
  onDetail = () => {},
  onCaption = () => {},
  onTranscript = () => {},
  onMic = () => {},
  onMuted = () => {},
  onDiag = () => {},
  onLog = () => {},
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  createSocket = (url) => new globals.WebSocket(url),
  audioFactory = createBrowserAudioEngine,
  transportBase = null,
  resolveBase = null,
  retryDelays = DEFAULT_RETRY_DELAYS,
  statusWaitMs = 15000,
  statusTimeoutMs = 5000,
  connectTimeoutMs = 8000,
  handshakeTimeoutMs = 12000,
  report = true,
  now = () => Date.now(),
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (id) => clearTimeout(id),
} = {}) {
  let disposed = false
  let starting = false
  let terminal = false
  let baseInfo = { base: null, source: 'none', transport: null, error: null }
  let wsUrl = null
  let client = null
  let audio = null
  let micReady = false
  let muted = false
  let phase = 'idle'
  let attempt = 0
  let openCount = 0
  let startedAt = 0
  let lastFailure = ''
  let lastClose = null
  let retryTimer = null
  let generation = 0
  let sessionReady = false
  let permissionState = 'unknown'
  let statusBody = null
  let inputRate = DEFAULT_INPUT_RATE
  let diagExtra = ''
  const stats = { sends: 0, events: 0, captions: 0, bargeIns: 0, reports: 0, liveAt: null }
  let reportChain = Promise.resolve()

  const capability = () => ({
    secure: globals.isSecureContext === true,
    media: Boolean(globals.navigator && globals.navigator.mediaDevices && typeof globals.navigator.mediaDevices.getUserMedia === 'function'),
    permission: permissionState,
  })

  const diagnostics = () => {
    const caps = capability()
    const parts = [
      '媒体 ' + (caps.media ? '可用' : '缺失'),
      '权限 ' + permissionState,
      '安全上下文 ' + (caps.secure ? '是' : '否'),
      'base=' + baseInfo.source + (baseInfo.base ? '(' + baseInfo.base + ')' : ''),
      'ws=' + (wsUrl || '?'),
    ]
    if (lastClose) parts.push('上次关闭 ' + lastClose.code + (lastClose.wasClean ? '(正常)' : '(异常)') + ' ' + Math.round(lastClose.elapsedMs) + 'ms')
    if (retryDelays.length) parts.push('attempt=' + attempt + '/' + retryDelays.length)
    if (muted) parts.push('mic 静音')
    if (diagExtra) parts.push(diagExtra)
    return parts.join(' · ')
  }

  const pushDiag = (extra) => {
    if (extra !== undefined) diagExtra = extra
    onDiag(diagnostics())
  }

  const postReport = (kind, extra = {}) => {
    if (report === false || typeof fetchImpl !== 'function') return
    try {
      const body = {
        kind,
        at: new Date(now()).toISOString(),
        phase,
        base: baseInfo.base,
        baseSource: baseInfo.source,
        wsUrl,
        attempt,
        openCount,
        elapsedMs: startedAt ? now() - startedAt : 0,
        close: lastClose,
        liveAt: stats.liveAt,
        detail: lastFailure || undefined,
        capability: capability(),
        reportSeq: (++stats.reports),
        ua: globals.navigator && typeof globals.navigator.userAgent === 'string'
          ? globals.navigator.userAgent.slice(0, 200)
          : (typeof process !== 'undefined' ? 'node ' + process.version : 'unknown'),
        ...extra,
      }
      // 串行发送：宿主 report 文件只保留最后一次 payload，顺序必须等于阶段顺序。
      reportChain = reportChain.then(() => fetchImpl(REPORT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })).catch(() => {})
    } catch {
      // 上报是可选的诊断通道，任何失败都静默。
    }
  }

  const setPhase = (next, { step, state, detail } = {}) => {
    phase = next
    if (step !== undefined) onStep(step)
    if (detail !== undefined) onDetail(detail)
    if (state) onState(state)
    pushDiag()
    postReport('voice-stage', { step: step === undefined ? undefined : String(step).slice(0, 400) })
  }

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeoutImpl(retryTimer)
      retryTimer = null
    }
  }

  const clearClient = () => {
    const current = client
    client = null
    if (current) {
      try { current.stop() } catch {}
    }
  }

  const describeFailure = (reason, sdkStatus) => {
    const close = lastClose
    const suffix = close
      ? '（close ' + close.code + (close.reason ? ' ' + close.reason : '') + '，' + Math.round(close.elapsedMs) + 'ms）'
      : ''
    const closeMap = {
      4001: '会话已被新客户端替换',
      4002: '网关已被另一个客户端占用',
      4003: '网关凭证已撤销',
      1002: '网关关闭了协议错误的连接',
      1008: '网关拒绝了会话（协议/策略）',
      1011: '网关内部错误',
      1012: '网关服务重启',
      1013: '网关暂时不可用',
    }
    if (close && closeMap[close.code]) return closeMap[close.code] + suffix
    if (sdkStatus && sdkStatus.phase === 'handshake') {
      return 'WebSocket 已连上，但 ' + Math.round(handshakeTimeoutMs / 1000) + 's 内没收到 session.ready（网关/上游会话握手超时）' + suffix
    }
    if (sdkStatus && sdkStatus.phase === 'connection') {
      return 'WebSocket ' + Math.round(connectTimeoutMs / 1000) + 's 内没建立连接（DNS / 端口 / 代理不可达）' + suffix
    }
    if (!baseInfo.base) return '无法建立 WebSocket：宿主地址未知（' + (baseInfo.error || '缺少 __DSH_TRANSPORT__') + '）'
    const hostReachable = Boolean(statusBody && statusBody.ok === true)
    if (close && (close.code === 1006 || close.code === 1005 || close.code === 1015 || close.code === 0)) {
      return hostReachable
        ? 'WebSocket 握手失败（close ' + close.code + '）：宿主 HTTP 可达，但 WS 升级被拒绝/不可达（检查 ws URL、代理和 Origin 校验）' + suffix
        : 'WebSocket 握手失败（close ' + close.code + '）：宿主地址不可达（DNS / 端口 / 自定义 scheme 转发失败）' + suffix
    }
    if (reason === 'unavailable' && sdkStatus && sdkStatus.error) {
      const code = String(sdkStatus.error.code || sdkStatus.error.name || 'socket_error')
      return '连接异常（' + code + '）：' + String(sdkStatus.error.message || '').slice(0, 160) + suffix
    }
    return '连接未成功：' + reason + suffix
  }

  const fail = (detail, options = {}) => {
    if (disposed) return
    terminal = options.retryable !== true
    starting = false
    clearRetry()
    lastFailure = String(detail || '未知错误')
    setPhase('error', {
      step: 'error · base=' + baseInfo.source + (lastClose ? ' · close ' + lastClose.code : ''),
      state: 'error',
      detail: lastFailure,
    })
    postReport('voice-error', { detail: lastFailure })
  }

  const scheduleRetry = (reason, sdkStatus) => {
    if (disposed || terminal) return
    if (retryTimer !== null) return
    lastFailure = describeFailure(reason, sdkStatus)
    if (attempt >= retryDelays.length) {
      fail(lastFailure + '；已自动重试 ' + retryDelays.length + ' 次仍失败')
      return
    }
    const wait = retryDelays[attempt]
    attempt += 1
    clearClient()
    sessionReady = false
    setPhase('reconnecting', {
      step: '重连 ' + attempt + '/' + retryDelays.length + ' · ' + wait + 'ms 后',
      state: 'reconnecting',
      detail: lastFailure,
    })
    postReport('voice-reconnect', { retryDelayMs: wait })
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null
      connect()
    }, wait)
  }

  // 播放回执：网关只有在收到 playback.started 后才 flush 助手转写、切 voice.state=speaking；
  // 收到 playback.ended/cancelled 才收尾 turn（见 qwen-audio-agent realtime-presentation-runtime）。
  const playback = { started: new Set(), done: new Set(), ended: new Set(), cancelled: new Set(), current: null }
  let playbackWatch = null

  const sendPlaybackReceipt = (type, responseId, extra = {}) => {
    const id = String(responseId || '').slice(0, 128)
    if (!id || !client) return false
    try { return client.send({ type, responseId: id, ...extra }) } catch { return false }
  }

  const markPlaybackStarted = (responseId) => {
    const id = String(responseId || '')
    if (!id || playback.started.has(id)) return
    playback.started.add(id)
    playback.current = id
    if (sendPlaybackReceipt('playback.started', id)) postReport('voice-playback', { playback: 'started', responseId: id.slice(0, 64) })
  }

  const markPlaybackEnded = (responseId) => {
    const id = String(responseId || '')
    if (!id || !playback.started.has(id) || playback.ended.has(id) || playback.cancelled.has(id)) return
    playback.ended.add(id)
    if (playback.current === id) playback.current = null
    if (sendPlaybackReceipt('playback.ended', id)) postReport('voice-playback', { playback: 'ended', responseId: id.slice(0, 64) })
  }

  const markPlaybackCancelled = (responseId, reason) => {
    const id = String(responseId || '')
    if (!id || !playback.started.has(id) || playback.ended.has(id) || playback.cancelled.has(id)) return
    playback.cancelled.add(id)
    if (playback.current === id) playback.current = null
    const why = String(reason || 'user_interruption').slice(0, 80)
    if (sendPlaybackReceipt('playback.cancelled', id, { reason: why })) postReport('voice-playback', { playback: 'cancelled', responseId: id.slice(0, 64), reason: why })
  }

  const settlePlayback = () => {
    if (disposed) return
    playbackWatch = null
    const playing = Boolean(audio && typeof audio.isPlaying === 'function' && audio.isPlaying())
    if (!playing) {
      for (const responseId of playback.done) markPlaybackEnded(responseId)
    }
    for (const responseId of playback.done) {
      if (!playback.ended.has(responseId) && !playback.cancelled.has(responseId)) {
        playbackWatch = setTimeoutImpl(settlePlayback, 150)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 转写（分角色）：把网关的 transcript.delta/final/discard 归并成视图层能直接用的分段事件。
  // - 用户 STT：role=user（让用户看到自己的话被识别成什么）；
  // - 助手回复：role=assistant。
  // 按 turnId 切轮：新一轮开始（turn.started 或首个新 turnId 的转写）→ reset，只保留最近一轮。
  // replace=true 表示该条内容是整段替换而不是增量追加（见 qwen-audio-agent TUI 的 user delta 处理）。
  // ---------------------------------------------------------------------------
  const transcriptState = { turnId: null, phase: 'idle', user: '', assistant: '' }
  const emitTranscript = (payload) => {
    try { onTranscript(payload) } catch {}
  }
  const beginTranscriptTurn = (rawTurnId, reason) => {
    if (rawTurnId == null || rawTurnId === '') return false
    const turnId = String(rawTurnId)
    if (turnId === transcriptState.turnId) return false
    transcriptState.turnId = turnId
    transcriptState.phase = 'idle'
    transcriptState.user = ''
    transcriptState.assistant = ''
    emitTranscript({ kind: 'reset', reason: reason || 'new-turn', turnId })
    return true
  }
  const transcriptRole = (event) => (event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : null)
  const transcriptTurnId = (event) => (event.turnId == null || event.turnId === '' ? null : String(event.turnId))
  const handleTranscriptDelta = (event) => {
    const role = transcriptRole(event)
    const content = typeof event.content === 'string' ? event.content : ''
    if (!role || !content) return
    const turnId = transcriptTurnId(event)
    beginTranscriptTurn(turnId, 'transcript-turn')
    // 上游没给 turnId 时：用户再次开口（上一段是助手）视为新一轮，清掉上一轮。
    if (!turnId && role === 'user' && transcriptState.phase === 'assistant') {
      transcriptState.phase = 'idle'
      transcriptState.user = ''
      transcriptState.assistant = ''
      emitTranscript({ kind: 'reset', reason: 'user-turn' })
    }
    transcriptState.phase = role
    if (role === 'user') {
      transcriptState.user = (event.replace === true ? content : transcriptState.user + content).slice(-4000)
      stats.captions += 1
      emitTranscript({ kind: 'delta', role, content, replace: event.replace === true, turnId })
      return
    }
    transcriptState.assistant = (transcriptState.assistant + content).slice(-8000)
    stats.captions += 1
    emitTranscript({ kind: 'delta', role, content, turnId })
    onCaption(content)
  }
  const handleTranscriptFinal = (event) => {
    const role = transcriptRole(event)
    if (!role) return
    const content = typeof event.content === 'string' ? event.content.trim() : ''
    const turnId = transcriptTurnId(event)
    beginTranscriptTurn(turnId, 'transcript-turn')
    if (role === 'user' && content) transcriptState.user = content.slice(-4000)
    if (role === 'assistant' && content) transcriptState.assistant = content.slice(-8000)
    emitTranscript({ kind: 'final', role, content, turnId })
    if (role === 'assistant' && content) onCaption(content)
  }
  const handleTranscriptDiscard = (event) => {
    const role = transcriptRole(event)
    if (!role) return
    if (role === 'user') transcriptState.user = ''
    else transcriptState.assistant = ''
    emitTranscript({ kind: 'discard', role, turnId: transcriptTurnId(event) })
  }
  const resetTranscript = (reason) => {
    transcriptState.phase = 'idle'
    transcriptState.user = ''
    transcriptState.assistant = ''
    emitTranscript({ kind: 'reset', reason: reason || 'reset' })
  }

  const handleEvent = (event) => {
    if (disposed || !event || typeof event.type !== 'string') return
    stats.events += 1
    switch (event.type) {
      case 'audio.delta': {
        if (typeof event.audio === 'string' && event.audio.length > 0) {
          if (audio) {
            const rate = Number(event.sampleRate) > 0 ? Number(event.sampleRate) : DEFAULT_OUTPUT_RATE
            try { audio.play(b64decodeToFloat32(event.audio), rate) } catch {}
          }
          markPlaybackStarted(event.responseId)
        }
        break
      }
      case 'audio.done': {
        if (event.responseId) {
          playback.done.add(String(event.responseId))
          settlePlayback()
        }
        break
      }
      case 'playback.clear': {
        if (audio) audio.flush()
        const id = event.responseId || playback.current
        if (id) markPlaybackCancelled(id, event.reason || 'cleared')
        onStep('服务端 playback.clear · 已清空播放队列' + (event.reason ? '（' + event.reason + '）' : ''))
        break
      }
      case 'response.started':
        onStep('响应生成中 · ' + String(event.responseId || '').slice(0, 48))
        break
      case 'response.interrupted':
        if (audio) audio.flush()
        if (event.responseId) markPlaybackCancelled(event.responseId, 'interrupted')
        onStep('响应已被打断')
        break
      case 'transcript.delta':
        handleTranscriptDelta(event)
        break
      case 'transcript.final':
        handleTranscriptFinal(event)
        break
      case 'transcript.discard':
        handleTranscriptDiscard(event)
        break
      case 'voice.ready': {
        const rate = Number(event.inputSampleRate)
        if (rate > 0) {
          inputRate = rate
          if (rate !== DEFAULT_INPUT_RATE) diagExtra = '注意：网关输入采样率 ' + rate + 'Hz（本端按 16kHz 发送）'
          pushDiag()
        }
        onStep('voice.ready · 输入 ' + (rate || '?') + 'Hz · ' + (event.provider || '?'))
        break
      }
      case 'voice.connection': {
        const state = String(event.state || '?')
        onStep('voice ' + state + (event.provider ? ' · ' + event.provider : ''))
        if (state === 'unavailable' || state === 'failed') {
          onDetail('上游语音服务 ' + state + '（provider=' + (event.provider || (statusBody && statusBody.body && statusBody.body.realtimeProvider) || '?') + '），本端 WS/麦克风链路正常')
          postReport('voice-upstream', { upstream: state })
        }
        break
      }
      case 'voice.state':
        onStep('voice ' + String(event.state || '?') + (event.origin ? ' · ' + event.origin : ''))
        break
      case 'voice.ownership':
        onStep('voice ownership ' + String(event.state || '?'))
        break
      case 'turn.started':
        beginTranscriptTurn(event.turnId, 'turn-started')
        onStep('turn ' + String(event.turnId || '').slice(0, 40))
        break
      case 'input.suspend':
        if (audio) audio.flush()
        onStep('输入被宿主挂起 · ' + String(event.reason || ''))
        break
      case 'input.resume':
        onStep('输入恢复')
        break
      case 'error': {
        const message = (event.error && event.error.message) || event.message || JSON.stringify(event).slice(0, 160)
        onDetail('网关错误：' + String(message).slice(0, 200))
        postReport('voice-gateway-error', { detail: String(message).slice(0, 300) })
        break
      }
      default:
        break
    }
    onLog({ kind: 'event', type: event.type })
  }

  const handleMicFrame = (samples) => {
    if (disposed || !client || !samples || samples.length === 0) return
    const buffered = typeof client.bufferedAmount === 'number' ? client.bufferedAmount : 0
    if (buffered > MAX_SOCKET_BUFFERED) return // 背压保护：网络拥塞时丢帧而不是无限堆积
    try {
      const pcm = downmixTo16k(samples, audio && audio.sampleRate ? audio.sampleRate : DEFAULT_INPUT_RATE)
      if (client.send({ type: 'input_audio_buffer.append', audio: b64encode(pcm) })) stats.sends += 1
    } catch {}
  }

  const handleBargeIn = () => {
    if (disposed) return
    stats.bargeIns += 1
    if (audio) audio.flush()
    if (playback.current) markPlaybackCancelled(playback.current, 'user_interruption')
    if (client) {
      try { client.send({ type: 'response.cancel' }) } catch {}
    }
    resetTranscript('barge-in')
    onStep('barge-in · 用户说话，已清空播放并发送 response.cancel')
    postReport('voice-barge-in')
  }

  const applyMuted = (value) => {
    muted = Boolean(value)
    try { if (audio && typeof audio.setMuted === 'function') audio.setMuted(muted) } catch {}
    try { onMuted(muted) } catch {}
  }

  // 通话中切换麦克风：关麦后不再上行真实人声（静音帧保活连接），开麦立即恢复。
  const setMuted = (value) => {
    if (disposed) return muted
    const next = Boolean(value)
    if (next === muted) return muted
    applyMuted(next)
    onStep(next ? 'mic muted · 本端静音，不再上行人声' : 'mic live · 已恢复上行麦克风')
    pushDiag()
    postReport(next ? 'voice-mic-muted' : 'voice-mic-unmuted')
    return muted
  }

  const openMic = async () => {
    if (disposed || micReady) return
    setPhase('mic', { step: 'mic open', state: 'ready' })
    try {
      audio = audioFactory({ onFrame: handleMicFrame, onBargeIn: handleBargeIn, globals })
      const info = await audio.start()
      if (disposed) { try { audio.stop() } catch {} ; audio = null ; return }
      micReady = true
      onMic('on')
      if (muted) applyMuted(true)
      const capture = info && info.worklet === false ? 'ScriptProcessor 兜底' : 'AudioWorklet'
      const rateNote = info && info.sampleRate ? info.sampleRate + 'Hz→16kHz' : '16kHz'
      stats.liveAt = new Date(now()).toISOString()
      setPhase('live', { step: 'live · ' + capture + ' · ' + rateNote, state: 'live', detail: '' })
      postReport('voice-live', { capture, inputSampleRate: inputRate })
    } catch (error) {
      micReady = false
      const name = error && error.name ? error.name + ' ' : ''
      const message = String((error && error.message) || error || '未知错误').slice(0, 180)
      try { if (audio) audio.stop() } catch {}
      audio = null
      onMic('error')
      fail('麦克风不可用：' + name + message)
    }
  }

  const handleSessionReady = () => {
    if (disposed || sessionReady) return
    sessionReady = true
    attempt = 0
    clearRetry()
    lastFailure = ''
    const caps = client && Array.isArray(client.negotiatedCapabilities) ? client.negotiatedCapabilities : []
    setPhase('ready', {
      step: 'session.ready · ' + (caps.length ? caps.join(',') : '未协商能力'),
      state: 'ready',
      detail: '',
    })
    postReport('voice-ready', { capabilities: caps })
    if (micReady && audio) {
      stats.liveAt = stats.liveAt || new Date(now()).toISOString()
      setPhase('live', { step: 'live · 连接已恢复', state: 'live', detail: '' })
      postReport('voice-live', { resume: true })
      return
    }
    openMic()
  }

  const connect = () => {
    if (disposed) return
    clearRetry()
    const gen = ++generation
    const started = now()
    const isRetry = attempt > 0
    setPhase(isRetry ? 'reconnecting' : 'ws-connecting', {
      step: isRetry ? 'ws connecting（第 ' + attempt + ' 次重试）' : 'ws connecting',
      state: isRetry ? 'reconnecting' : 'connecting',
    })
    const guard = () => !disposed && gen === generation
    const socketFactory = (url) => {
      const socket = createSocket(url)
      socket.addEventListener('open', () => {
        if (!guard()) return
        openCount += 1
        lastFailure = ''
        pushDiag()
        setPhase('ws-open', { step: 'ws connected · 等待 session.ready', state: 'connecting', detail: '' })
        postReport('voice-open', { openCount })
      })
      socket.addEventListener('error', () => {
        if (!guard()) return
        postReport('voice-socket-error')
      })
      socket.addEventListener('close', (event) => {
        if (!guard()) return
        const elapsedMs = now() - started
        lastClose = {
          code: Number(event && event.code) || 0,
          reason: String((event && event.reason) || '').slice(0, 160),
          wasClean: Boolean(event && event.wasClean),
          elapsedMs,
        }
        pushDiag()
        postReport('voice-close', { close: lastClose })
      })
      return socket
    }
    const instance = new GatewayClient({
      url: wsUrl,
      createSocket: socketFactory,
      clientType: 'web',
      clientVersion: '0.1.7',
      clientInstanceId: 'voice-ayuan-' + Math.random().toString(36).slice(2, 12),
      timeZone: (() => {
        try { return new globals.Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
      })(),
      capabilities: ['input.audio', 'session.output_voice', 'playback.receipts'],
      reconnect: false, // 重连由本引擎统一控制（有限次 + 可视化阶段）
      connectTimeoutMs,
      handshakeTimeoutMs,
      onStatus: (status) => {
        if (!guard()) return
        const state = status && status.state
        onLog({ kind: 'sdk-status', state })
        if (state === 'ready') {
          handleSessionReady()
        } else if (state === 'unavailable') {
          lastFailure = describeFailure('unavailable', status)
          postReport('voice-unavailable', { sdkPhase: status && status.phase })
          scheduleRetry('unavailable', status)
        } else if (state === 'disconnected') {
          if (sessionReady) onDetail('连接断开（' + (lastClose ? 'close ' + lastClose.code : '无 close 事件') + '），正在重连…')
          scheduleRetry('disconnected')
        } else if (state === 'replaced') {
          fail('会话已被另一个客户端接管（close 4001），本面板已停止；如需继续请重新打开通话')
        } else if (state === 'occupied') {
          fail('网关已被另一个客户端占用（close 4002），请先关闭其他端后再试')
        } else if (state === 'revoked') {
          fail('网关凭证已撤销（close 4003），请在插件设置里重新配对')
        }
      },
      onEvent: handleEvent,
    })
    client = instance
    instance.start()
  }

  const loadStatus = async () => {
    if (typeof fetchImpl !== 'function') return { ok: false, detail: '当前环境没有 fetch，无法访问宿主 ' + STATUS_PATH }
    const deadline = now() + statusWaitMs
    let last = null
    while (!disposed && now() <= deadline) {
      let timer = null
      try {
        const controller = typeof globals.AbortController === 'function' ? new globals.AbortController() : null
        if (controller) timer = setTimeoutImpl(() => { try { controller.abort() } catch {} }, statusTimeoutMs)
        const response = await fetchImpl(STATUS_PATH, { cache: 'no-store', signal: controller ? controller.signal : undefined })
        if (timer !== null) { clearTimeoutImpl(timer); timer = null }
        const text = typeof response.text === 'function' ? await response.text() : ''
        let body = {}
        try { body = text ? JSON.parse(text) : {} } catch { body = {} }
        last = { http: response.status, body }
        if (response.status === 503) {
          onStep('等待宿主启动（HTTP 503）')
          await delay(STATUS_RETRY_MS, setTimeoutImpl)
          continue
        }
        if (!response.ok) return { ok: false, detail: '宿主 ' + STATUS_PATH + ' 返回 HTTP ' + response.status, last }
        if (!body || body.ok !== true || !body.origin) {
          const bodyPhase = body.phase || (body.body && body.body.phase) || 'unknown'
          onStep('等待网关就绪 · phase=' + bodyPhase)
          await delay(STATUS_RETRY_MS, setTimeoutImpl)
          continue
        }
        return { ok: true, status: body }
      } catch (error) {
        if (timer !== null) { clearTimeoutImpl(timer); timer = null }
        const message = (error && error.name ? error.name + ' ' : '') + String((error && error.message) || error)
        last = { error: message.slice(0, 200) }
        await delay(STATUS_RETRY_MS, setTimeoutImpl)
      }
    }
    if (disposed) return { ok: false, detail: '已取消' }
    const bodyPhase = last && last.body && (last.body.phase || (last.body.body && last.body.body.phase))
    return {
      ok: false,
      detail: '宿主语音服务 ' + Math.round(statusWaitMs / 1000) + 's 内未就绪（phase=' + (bodyPhase || 'unknown') + (last && last.error ? '，' + last.error : '') + '）',
      last,
    }
  }

  const probePermission = async () => {
    try {
      const permissions = globals.navigator && globals.navigator.permissions
      if (!permissions || typeof permissions.query !== 'function') return
      const status = await permissions.query({ name: 'microphone' })
      permissionState = (status && status.state) || 'unknown'
    } catch {
      permissionState = 'unknown'
    }
  }

  const start = async () => {
    if (disposed || starting) return
    starting = true
    terminal = false
    startedAt = now()
    attempt = 0
    openCount = 0
    sessionReady = false
    lastFailure = ''
    lastClose = null
    diagExtra = ''
    onMic('opening')
    setPhase('status', { step: 'fetch status', state: 'connecting', detail: '' })
    postReport('voice-start')
    await probePermission()
    pushDiag()
    const loaded = await loadStatus()
    if (disposed) return
    if (!loaded.ok) { fail(loaded.detail); return }
    statusBody = loaded.status
    const provider = (statusBody.body && statusBody.body.realtimeProvider) || '?'
    inputRate = Number(statusBody.body && statusBody.body.realtimeInputSampleRate) || DEFAULT_INPUT_RATE
    onStep('status ok · 网关 ready · ' + provider + ' · 输入 ' + inputRate + 'Hz')
    if (transportBase) {
      baseInfo = { base: normalizeBase(transportBase), source: 'option', transport: transportBase, error: null }
      if (!baseInfo.base) baseInfo.error = '注入的 transportBase 不是 http(s)：' + transportBase
    } else if (typeof resolveBase === 'function') {
      baseInfo = resolveBase()
    } else {
      baseInfo = resolveHostBase(globals)
    }
    wsUrl = buildRealtimeUrl(baseInfo.base)
    pushDiag()
    postReport('voice-base')
    if (!wsUrl) {
      fail('无法确定宿主地址：' + (baseInfo.error || '缺少 __DSH_TRANSPORT__ 且页面不是 http(s)'))
      return
    }
    onStep('ws connect · ' + wsUrl)
    connect()
    starting = false
  }

  const retry = () => {
    if (disposed || starting) return
    if (phase !== 'error' && phase !== 'reconnecting') return
    terminal = false
    attempt = 0
    clearRetry()
    clearClient()
    sessionReady = false
    if (audio) { try { audio.stop() } catch {} ; audio = null }
    micReady = false
    applyMuted(false)
    onMic('opening')
    start()
  }

  const stop = () => {
    if (disposed) return
    disposed = true
    if (playbackWatch !== null) { clearTimeoutImpl(playbackWatch); playbackWatch = null }
    clearRetry()
    postReport('voice-stop')
    clearClient()
    if (audio) {
      try { audio.stop() } catch {}
      audio = null
    }
    micReady = false
    muted = false
    phase = 'stopped'
  }

  return {
    start,
    stop,
    retry,
    setMuted,
    toggleMuted: () => setMuted(!muted),
    get muted() { return muted },
    get phase() { return phase },
    get openCount() { return openCount },
    get wsUrl() { return wsUrl },
    get baseSource() { return baseInfo.source },
    get base() { return baseInfo.base },
    get stats() { return stats },
    get diagnostic() { return diagnostics() },
  }
}
