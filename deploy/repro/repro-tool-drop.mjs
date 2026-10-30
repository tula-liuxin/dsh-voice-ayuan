#!/usr/bin/env node
// 复现「助手回复带 tool call，但客户端收不到 response.function_call_arguments.done」。
//
// 场景（对齐 2026-10-30 19:07:53 真实通话）：
//   1) 用户说一句要「做事」的话（TTS 合成 fixture）→ VAD soft-end → 服务向 DeepSeek 发请求；
//   2) 模型生成中，用户插话（短促继续说话）→ VAD confirm speculative reopen →
//      send loop cancel_scope.cancel()（discarding=True）并 cancel LLM 生成；
//   3) 插话段结束 → 重新转写 → 第二次 LLM 请求 → 模型回复 + spawn_thinking；
//      若真实 bug 存在，tool-bearing AssistantTextEvent 被静默丢弃，raw WS 收不到 function_call。
//
// 直接连上游 s2s（默认 ws://127.0.0.1:18765/v1/realtime，插件维护的隧道）：
// 不经过 gateway，因此「有没有收到 function_call」就是最干净的判据。
//
// Usage:
//   node deploy/repro/repro-tool-drop.mjs gen                # 生成 query/bargein 语音 fixture
//   node deploy/repro/repro-tool-drop.mjs run                # 单次跑带插话场景
//   node deploy/repro/repro-tool-drop.mjs run --runs 5       # 连续跑 5 次
//   node deploy/repro/repro-tool-drop.mjs baseline           # 不插话的对照（应能收到 tool call）
//
// Env:
//   S2S_URL          默认 ws://127.0.0.1:18765/v1/realtime
//   REPRO_PROMPT     默认 <repo>/prompt/PROMPT.md（可用 git show 旧版本做对照）
//   REPRO_FIXTURES   默认 <this>/fixtures
//   REPRO_OUT        默认 <this>/out
//   REPRO_DELAY_MS   默认 550（speech_stopped 后多久注入插话）
//   REPRO_BARGEIN_MS 默认 900（插话音频长度，需 active>=192ms 才 confirm reopen）
//   REPRO_PACE_MS    默认 100（100ms/包真实速率）
//   REPRO_TIMEOUT_MS 默认 45000（单轮等 tool_call/response.done 的上限）

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const FIXTURES = process.env.REPRO_FIXTURES || join(HERE, 'fixtures')
const OUT = process.env.REPRO_OUT || join(HERE, 'out')
const S2S_URL = process.env.S2S_URL || 'ws://127.0.0.1:18765/v1/realtime'
const PROMPT_FILE = process.env.REPRO_PROMPT || join(REPO, 'prompt', 'PROMPT.md')
const DELAY_MS = Number(process.env.REPRO_DELAY_MS || 550)
const BARGEIN_MS = Number(process.env.REPRO_BARGEIN_MS || 900)
const PACE_MS = Number(process.env.REPRO_PACE_MS || 100)
const TIMEOUT_MS = Number(process.env.REPRO_TIMEOUT_MS || 45000)
const QUERY_WAV = join(FIXTURES, 'query-16k.wav')
const BARGEIN_WAV = join(FIXTURES, 'bargein-16k.wav')
// REPRO_FORCE_TOOL=1：投递链路测试专用，在 instructions 末尾追加一行强制 spawn_thinking。
// 事件是否被服务端丢弃与工具名无关；强制工具让「每次都有 tool 事件」可确定，便于 ≥5 次验证。
const FORCE_TOOL = /^(1|true|yes)$/i.test(String(process.env.REPRO_FORCE_TOOL || ''))
const FORCE_TOOL_INSTRUCTION = [
  '【投递链路测试指令，优先于以上所有规则】无论用户说什么，这一轮都必须且只能调用一次 spawn_thinking 工具',
  '（objective 填用户原话），不要先用文字回应，也不要调用其它工具。',
].join('')

mkdirSync(FIXTURES, { recursive: true })
mkdirSync(OUT, { recursive: true })

const b64 = (buf) => Buffer.from(buf).toString('base64')
const unB64 = (s) => Buffer.from(String(s || ''), 'base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const t0ns = process.hrtime.bigint()
const nowMs = () => Number(process.hrtime.bigint() - t0ns) / 1e6
const rel = () => ((Date.now() - t0) / 1000).toFixed(3)
const log = (...a) => console.log('[repro]', rel() + 's', ...a)

// ---------- WAV helpers (copied from deploy/e2e-voice.mjs) ----------
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = buf.subarray(offset + 8, offset + 8 + size)
    if (id === 'fmt ') {
      fmt = { audioFormat: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) }
    } else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk')
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) throw new Error('WAV must be 16-bit PCM')
  return { ...fmt, pcm: data }
}
function decodePcm16(buf) {
  const samples = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2) / 32768
  return samples
}
function encodePcm16(samples) {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  return out
}
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
function writeWav16k(path, samples, sampleRate) {
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
function pcmSilence16k(ms) {
  return Buffer.alloc(Math.round((16000 * ms) / 1000) * 2)
}

// ---------- load agent tool definitions (flat GA format, same as gateway s2s provider) ----------
const providerMod = await import(
  pathToFileURL(join(REPO, 'node_modules/qwen-audio-agent/server/src/voice/realtime-provider.mjs')).href
)
function buildSessionUpdate() {
  const prompt = readFileSync(PROMPT_FILE, 'utf8') + (FORCE_TOOL ? '\n\n' + FORCE_TOOL_INSTRUCTION : '')
  const tools = providerMod.frontendTools({}).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: prompt,
      tools,
      tool_choice: 'auto',
      output_modalities: ['audio'],
      audio: {
        input: { turn_detection: { type: 'server_vad', interrupt_response: true } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  }
}

// ---------- upstream ws session ----------
async function openSession({ label = 'session' } = {}) {
  const ws = new WebSocket(S2S_URL, { handshakeTimeout: 15000 })
  const events = []
  const handlers = []
  ws.on('message', (raw) => {
    let event
    try { event = JSON.parse(String(raw)) } catch { return }
    event.__t = nowMs()
    events.push(event)
    for (const h of handlers) h(event)
  })
  ws.on('error', (e) => log(label, 'ws error:', e.message))
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const send = (payload) => ws.send(JSON.stringify(payload))
  const waitEvent = (pred, ms, what) => new Promise((res, rej) => {
    const hit = events.find(pred)
    if (hit) return res(hit)
    const timer = setTimeout(() => rej(new Error('timeout waiting for ' + what)), ms)
    const handler = (e) => {
      if (!pred(e)) return
      clearTimeout(timer)
      const i = handlers.indexOf(handler)
      if (i >= 0) handlers.splice(i, 1)
      res(e)
    }
    handlers.push(handler)
  })
  return { ws, events, send, waitEvent, close: () => { try { ws.close() } catch {} } }
}

// ---------- mode: gen fixtures via server TTS ----------
async function modeGen() {
  const text = process.env.REPRO_QUERY_TEXT || '帮我查一下明天我该做点什么'
  const bargeText = process.env.REPRO_BARGEIN_TEXT || '呃，等下，我再补充一句'
  for (const [name, line, out] of [['query', '请用中文说：' + text, QUERY_WAV], ['bargein', '请用中文说：' + bargeText, BARGEIN_WAV]]) {
    const s = await openSession({ label: name })
    try {
      s.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: { input: { turn_detection: { type: 'server_vad', interrupt_response: true } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
        },
      })
      await sleep(150)
      s.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } })
      s.send({ type: 'response.create', response: { output_modalities: ['audio'] } })
      await s.waitEvent((e) => e.type === 'response.done', 120000, name + ' response.done')
      const audio = Buffer.concat(s.events.filter((e) => e.type === 'response.output_audio.delta').map((e) => unB64(e.delta)))
      if (audio.length < 8000) throw new Error(name + ' TTS audio too short: ' + audio.length)
      const s24 = decodePcm16(audio.subarray(0, audio.length - (audio.length % 2)))
      const s16 = resampleLinear(s24, 24000, 16000)
      writeWav16k(out, s16, 16000)
      log('fixture', name, out, (s16.length / 16000).toFixed(2) + 's')
    } finally { s.close() }
  }
}

// ---------- core scenario ----------
async function runOnce({ withBargein = true, runIndex = 0 } = {}) {
  const query = parseWav(readFileSync(QUERY_WAV)).pcm
  const barge = withBargein ? parseWav(readFileSync(BARGEIN_WAV)).pcm : Buffer.alloc(0)
  const bargeBytes = Math.round((BARGEIN_MS / 1000) * 16000) * 2
  const bargePcm = barge.subarray(0, Math.min(barge.length, bargeBytes))
  const CHUNK = 3200 // 100ms @16k PCM16

  const s = await openSession({ label: 'run' + runIndex })
  const timeline = []
  let injected = false
  let stoppedAt = 0
  let silenceTimer = null
  const pushPcm = async (pcm, label) => {
    for (let off = 0; off < pcm.length; off += CHUNK) {
      const chunk = pcm.subarray(off, Math.min(pcm.length, off + CHUNK))
      s.send({ type: 'input_audio_buffer.append', audio: b64(chunk) })
      await sleep(PACE_MS)
    }
    return label
  }
  try {
    await s.waitEvent((e) => e.type === 'session.created', 15000, 'session.created')
    s.send(buildSessionUpdate())
    await sleep(300)

    const interesting = new Set([
      'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'error',
      'response.created', 'response.done', 'response.output_audio_transcript.done',
      'response.function_call_arguments.done', 'response.function_call_arguments.delta',
      'response.output_item.done', 'session.created',
    ])
    s.ws.on('message', (raw) => {
      let e
      try { e = JSON.parse(String(raw)) } catch { return }
      if (!interesting.has(e.type)) return
      const item = e.item || {}
      timeline.push({
        at: nowMs() / 1000,
        type: e.type,
        responseId: e.response_id || e.response?.id || item.response_id || '',
        status: e.response?.status || '',
        callId: e.call_id || item.call_id || '',
        name: e.name || item.name || '',
        transcript: e.transcript || '',
        itemType: item.type || '',
      })
      if (e.type === 'input_audio_buffer.speech_stopped' && !injected && withBargein) {
        stoppedAt = Date.now()
        log('speech_stopped observed; inject barge-in in', DELAY_MS, 'ms')
        silenceTimer = setTimeout(async () => {
          if (injected) return
          injected = true
          log('injecting barge-in speech', (bargePcm.length / 2 / 16000).toFixed(2) + 's')
          await pushPcm(bargePcm, 'bargein')
          // 插话结束后补静音让 VAD 收本轮 turn
          await pushPcm(pcmSilence16k(2500), 'silence-after-bargein')
          log('barge-in + trailing silence pushed')
        }, DELAY_MS)
      }
    })

    log('push query audio', (query.length / 2 / 16000).toFixed(2) + 's')
    await pushPcm(query, 'query')
    await pushPcm(pcmSilence16k(2000), 'silence')
    log('query + trailing silence pushed; waiting for assistant response / tool call')

    // 等 tool call 或 response.done（取第一个满足者）；总超时 TIMEOUT_MS
    const deadline = Date.now() + TIMEOUT_MS
    let doneEvt = null
    while (Date.now() < deadline) {
      doneEvt = s.events.find((e) => e.type === 'response.function_call_arguments.done')
        || s.events.find((e) => e.type === 'response.done')
      if (doneEvt) break
      await sleep(100)
    }
    // 再等一点，收集可能晚到的 tool call
    await sleep(1200)
    if (silenceTimer) clearTimeout(silenceTimer)

    const toolCalls = s.events.filter((e) => e.type === 'response.function_call_arguments.done')
    const doneEvents = s.events.filter((e) => e.type === 'response.done')
    const transcriptDone = s.events.filter((e) => e.type === 'response.output_audio_transcript.done')
    const audioDeltas = s.events.filter((e) => e.type === 'response.output_audio.delta')
    const speechStarts = s.events.filter((e) => e.type === 'input_audio_buffer.speech_started')
    const errors = s.events.filter((e) => e.type === 'error')

    const order = []
    for (const e of s.events) {
      if (e.type === 'response.function_call_arguments.done') order.push('tool_call')
      else if (e.type === 'response.done') order.push('response.done')
      else if (e.type === 'response.output_audio_transcript.done') order.push('transcript.done')
      else if (e.type === 'response.created') order.push('response.created')
    }
    const toolBeforeDone = (() => {
      const ti = s.events.findIndex((e) => e.type === 'response.function_call_arguments.done')
      const di = s.events.findIndex((e) => e.type === 'response.done')
      if (ti < 0 || di < 0) return false
      return ti < di
    })()
    const toolFirst = s.events.find((e) => e.type === 'response.function_call_arguments.done')
    const doneFirst = s.events.find((e) => e.type === 'response.done')
    const toolCallToDoneMs = toolFirst && doneFirst ? +(doneFirst.__t - toolFirst.__t).toFixed(3) : null

    const report = {
      run: runIndex,
      withBargein,
      url: S2S_URL,
      promptFile: PROMPT_FILE,
      injectedBargein: injected,
      speechStarts: speechStarts.length,
      toolCalls: toolCalls.map((e) => ({ name: e.name, callId: e.call_id, at: (e.__t / 1000).toFixed(3), responseId: e.response_id })),
      responseDone: doneEvents.map((e) => ({ at: (e.__t / 1000).toFixed(3), status: e.response?.status, responseId: e.response?.id })),
      assistantTranscripts: transcriptDone.map((e) => ({ at: (e.__t / 1000).toFixed(3), transcript: e.transcript, responseId: e.response_id })),
      audioDeltas: audioDeltas.length,
      audioSeconds: +(audioDeltas.reduce((n, e) => n + unB64(e.delta).length, 0) / 2 / 24000).toFixed(2),
      errors: errors.map((e) => e.error?.message || e.message || JSON.stringify(e).slice(0, 200)),
      eventOrder: order,
      functionCallReceived: toolCalls.length > 0,
      functionCallBeforeResponseDone: toolBeforeDone,
      toolCallToResponseDoneMs: toolCallToDoneMs,
      timeline,
    }
    return report
  } finally {
    if (silenceTimer) clearTimeout(silenceTimer)
    s.close()
  }
}

// ---------- main ----------
const mode = process.argv[2] || 'run'
const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : def
}
try {
  if (mode === 'gen') {
    await modeGen()
  } else if (mode === 'run' || mode === 'baseline') {
    const runs = Number(arg('--runs', 1))
    const withBargein = mode !== 'baseline'
    if (!existsSync(QUERY_WAV)) await modeGen()
    const reports = []
    for (let i = 1; i <= runs; i += 1) {
      log('===== run ' + i + '/' + runs + (withBargein ? ' (barge-in)' : ' (baseline)') + ' =====')
      const report = await runOnce({ withBargein, runIndex: i })
      reports.push(report)
      writeFileSync(join(OUT, `repro-run-${Date.now()}-${i}.json`), JSON.stringify(report, null, 2))
      log('RESULT', JSON.stringify({
        functionCallReceived: report.functionCallReceived,
        functionCallBeforeResponseDone: report.functionCallBeforeResponseDone,
        toolCallToResponseDoneMs: report.toolCallToResponseDoneMs,
        toolCalls: report.toolCalls,
        responseDone: report.responseDone,
        assistantTranscripts: report.assistantTranscripts,
        errors: report.errors,
        eventOrder: report.eventOrder,
      }, null, 2))
      await sleep(800)
    }
    const ok = reports.filter((r) => r.functionCallReceived && r.functionCallBeforeResponseDone).length
    writeFileSync(join(OUT, 'repro-summary.json'), JSON.stringify({ mode, runs, ok, reports: reports.map((r) => ({ run: r.run, received: r.functionCallReceived, beforeDone: r.functionCallBeforeResponseDone, toolCalls: r.toolCalls.length })) }, null, 2))
    log(`SUMMARY: ${ok}/${reports.length} runs received function_call before response.done`)
    process.exit(ok === reports.length ? 0 : 2)
  } else {
    throw new Error('unknown mode: ' + mode + ' (gen|run|baseline)')
  }
  process.exit(0)
} catch (error) {
  console.error('[repro] FAILED:', error?.stack || String(error))
  process.exit(1)
}


