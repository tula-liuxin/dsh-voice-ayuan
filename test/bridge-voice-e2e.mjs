#!/usr/bin/env node
/**
 * 语音播报端到端验证（结果回流语音模型）：
 *
 *   协议层 task.create（真实任务在主 DSH 会话执行）
 *     → 任务完成 → Gateway 的 SessionTaskCoordinator claim 待播报通知
 *     → 把结果作为 announcement 交给实时语音模型
 *     → 模型用语音回应（audio.delta）+ assistant transcript
 *
 * 使用真实上游 speech-to-speech（ssh 隧道 ws://127.0.0.1:18765/v1/realtime），
 * 起隔离 gateway（临时 QWAUDIO 目录），连的是插件宿主 bridge + 用户当前 DSH 会话。
 *
 * 运行：node test/bridge-voice-e2e.mjs
 * 环境：S2S_TUNNEL_URL（默认 ws://127.0.0.1:18765/v1/realtime）、E2E_TIMEOUT_MS
 *
 * 前置：插件已接线并重载（~/.dsh/voice-ayuan-bridge.json 存在、宿主 bridge ready）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { GatewayClientCapability } from 'qwen-audio-agent/gateway-client-protocol'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const GATEWAY_HOST = path.join(PLUGIN_ROOT, 'bridge', 'gateway-host.mjs')
const TOKEN_FILE = process.env.VOICE_AYUAN_BRIDGE_TOKEN_FILE
  || path.join(os.homedir(), '.dsh', 'voice-ayuan-bridge.json')
const OUT_DIR = path.join(HERE, '.out')
const TUNNEL_URL = process.env.S2S_TUNNEL_URL || 'ws://127.0.0.1:18765/v1/realtime'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 120_000)
const READY_TYPE = 'qwen-audio-agent:gateway-ready'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const report = { startedAt: new Date().toISOString(), tunnelUrl: TUNNEL_URL, checks: [], audioBytes: 0, transcripts: [] }
const record = (name, value) => { report.checks.push({ name, at: new Date().toISOString(), value }); console.log('[check]', name, typeof value === 'string' ? value : JSON.stringify(value)) }

function readCredentials() {
  const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  if (!parsed?.url || !parsed?.token) throw new Error('bridge token file 缺少 url/token')
  return parsed
}

async function bridgeJson(credentials, route, method = 'GET') {
  const response = await fetch(credentials.url + route, {
    method,
    headers: { authorization: 'Bearer ' + credentials.token },
  })
  const body = await response.json()
  if (!response.ok) throw new Error('bridge ' + route + ' HTTP ' + response.status)
  return body
}

function startGateway({ bridgeUrl, bridgeToken }) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-voice-e2e-'))
  const child = fork(GATEWAY_HOST, [], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
      SPEECH_TO_SPEECH_REALTIME_URL: TUNNEL_URL,
      S2S_REALTIME_URL: TUNNEL_URL,
      QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: '',
      QWEN_AUDIO_AGENT_BACKEND: 'none',
      AGENT_PROTOCOL: '',
      QWEN_AUDIO_AGENT_IDENTITY_MODE: 'personal',
      QWEN_AUDIO_LOG_LEVEL: 'warn',
      QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR: path.join(PLUGIN_ROOT, 'prompt'),
      QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH: path.join(PLUGIN_ROOT, 'prompt', 'ASSISTANT.md'),
      QWEN_AUDIO_SCHEDULE_TOOL_ENABLED: '0',
      QWEN_AUDIO_WEB_TOOLS_ENABLED: '0',
      QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED: '0',
      QWEN_AUDIO_NOTES_TOOL_ENABLED: '0',
      QWEN_AUDIO_RECALL_TOOL_ENABLED: '0',
      QWAUDIO_CONFIG_DIR: path.join(stateRoot, 'config'),
      QWAUDIO_DATA_DIR: path.join(stateRoot, 'data'),
      QWAUDIO_STATE_DIR: path.join(stateRoot, 'state'),
      QWAUDIO_CACHE_DIR: path.join(stateRoot, 'cache'),
      VOICE_AYUAN_BRIDGE_URL: bridgeUrl,
      VOICE_AYUAN_BRIDGE_TOKEN: bridgeToken,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const logs = []
  child.stdout.on('data', chunk => { logs.push(String(chunk)); if (process.env.E2E_DEBUG) console.log('[gw]', String(chunk).trim().slice(0, 200)) })
  child.stderr.on('data', chunk => { logs.push(String(chunk)); if (process.env.E2E_DEBUG) console.log('[gw-err]', String(chunk).trim().slice(0, 200)) })
  const origin = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway-host ready timeout\n' + logs.join(''))), 60_000)
    timer.unref?.()
    child.on('message', message => {
      if (message?.type === READY_TYPE) { clearTimeout(timer); resolve(message.origin) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('gateway-host exited code=' + code + '\n' + logs.join(''))) })
  })
  return { child, origin, logs, stateRoot }
}

async function main() {
  const credentials = readCredentials()
  const bridgeHealth = await bridgeJson(credentials, '/health')
  record('host-bridge-health', { target: bridgeHealth.target })
  if (!bridgeHealth.target?.sessionId) throw new Error('宿主 bridge 没有目标会话：' + JSON.stringify(bridgeHealth.warning))

  const nonce = 'VOICE_SPEAK_E2E_' + Math.random().toString(36).slice(2, 8)
  const instruction = '在当前 DSH 会话里做一个无害验证：调用 pwsh 工具运行命令 Write-Output "' + nonce + '"，然后把你这一轮的最终回答就写成这条命令的输出（只写那一行）。'
  report.instruction = instruction
  report.nonce = nonce

  const gateway = startGateway({ bridgeUrl: credentials.url, bridgeToken: credentials.token })
  const audioChunks = []
  const transcripts = []
  const seenTypes = new Set()
  const toolCalls = []
  let connectionState = 'init'
  let voiceState = 'init'
  let playbackStarted = false
  const clientRef = { current: null }
  let client = null
  try {
    const origin = await gateway.origin
    report.gatewayOrigin = origin
    record('isolated-gateway', origin)

    client = new GatewayClient({
      url: origin.replace('http:', 'ws:') + '/api/realtime?sessionId=speak-e2e',
      createSocket: (url) => new WebSocket(url, { headers: { Origin: origin }, handshakeTimeout: 15_000 }),
      clientType: 'web',
      clientVersion: '0.0.0-speak-e2e',
      clientInstanceId: 'speak-e2e-' + Math.random().toString(36).slice(2, 10),
      timeZone: 'Asia/Shanghai',
      locale: 'zh-CN',
      capabilities: [
        GatewayClientCapability.TASK_COMMANDS,
        GatewayClientCapability.INPUT_AUDIO,
        GatewayClientCapability.INPUT_TEXT,
        GatewayClientCapability.PLAYBACK_RECEIPTS,
        GatewayClientCapability.SESSION_HEARTBEAT,
      ],
      configure: () => ({ voiceEnabled: true, inputEnabled: false, outputEnabled: true, provider: 'speech-to-speech' }),
      reconnect: false,
      requestTimeoutMs: 30_000,
      onStatus: status => console.log('[client]', status.state, status.error ? String(status.error.message || status.error) : ''),
      onEvent: (event) => {
        const type = event.type
        seenTypes.add(type)
        if (type === 'voice.connection') { connectionState = event.state; console.log('[client] voice.connection', event.state) }
        else if (type === 'voice.state') voiceState = event.state
        else if (type === 'audio.delta') {
          audioChunks.push(Buffer.from(String(event.audio || ''), 'base64'))
          if (!playbackStarted && event.responseId && clientRef.current) {
            playbackStarted = true
            clientRef.current.send({ type: 'playback.started', responseId: event.responseId })
          }
        } else if (type === 'audio.done') {
          if (clientRef.current && event.responseId) clientRef.current.send({ type: 'playback.ended', responseId: event.responseId })
        } else if (type === 'transcript.final' || type === 'transcript.delta') {
          transcripts.push({ type, role: event.role, content: event.content || event.text || '' })
          if (type === 'transcript.final') console.log('[client] transcript.final', event.role + ':', JSON.stringify(String(event.content || '').slice(0, 160)))
        } else if (type === 'tool.call') {
          toolCalls.push(event)
        }
      },
    })
    clientRef.current = client
    client.start()
    const started = Date.now()
    while (!client.ready && Date.now() - started < 30_000) await sleep(50)
    if (!client.ready) throw new Error('gateway client not ready')
    record('client-ready', client.negotiatedCapabilities)
    const connStarted = Date.now()
    while (!['connected', 'ready'].includes(connectionState) && Date.now() - connStarted < 90_000) await sleep(100)
    if (!['connected', 'ready'].includes(connectionState)) throw new Error('上游语音连接未建立：' + connectionState)
    record('upstream-voice-connected', connectionState)
    await sleep(500)

    // 协议层提交任务（与语音模型调用 spawn_thinking 走同一个 TaskOperations）
    const created = await client.request('task.create', { message: { parts: [{ type: 'text', text: instruction }] } })
    report.taskId = created.task?.id
    record('task-create', { taskId: report.taskId, status: created.task?.status, sessionId: created.task?.sessionId })

    // 等任务完成（任务完成通知会进入公告队列）
    let finalTask = null
    const taskDeadline = Date.now() + Math.min(TIMEOUT_MS, 240_000)
    while (Date.now() < taskDeadline) {
      const got = await client.request('task.get', { task_id: report.taskId })
      finalTask = got.task
      if (['completed', 'failed', 'cancelled'].includes(finalTask?.status)) break
      await sleep(500)
    }
    report.task = { status: finalTask?.status, result: finalTask?.result, notificationStatus: finalTask?.notificationStatus }
    record('task-final', report.task)
    if (finalTask?.status !== 'completed') throw new Error('任务未完成：' + JSON.stringify(report.task))

    // 等实时模型对公告的语音回应：audio.delta 至少 0.2s 且拿到 assistant transcript（或超时）
    const speakDeadline = Date.now() + TIMEOUT_MS
    while (Date.now() < speakDeadline) {
      const totalAudio = audioChunks.reduce((n, b) => n + b.length, 0)
      const assistantText = transcripts.filter(t => t.role === 'assistant').map(t => t.content).join('')
      if (totalAudio >= 24_000 * 2 * 0.2 && assistantText) break
      await sleep(250)
    }
    const audio = Buffer.concat(audioChunks)
    report.audioBytes = audio.length
    report.audioSeconds = +(audio.length / 2 / 24_000).toFixed(2)
    report.transcripts = transcripts.filter(t => t.type === 'transcript.final')
    const assistantText = report.transcripts.filter(t => t.role === 'assistant').map(t => t.content).join('')
    report.assistantText = assistantText
    record('announcement-audio', { bytes: report.audioBytes, seconds: report.audioSeconds })
    record('announcement-transcript', assistantText.slice(0, 300))
    record('seen-event-types', [...seenTypes].join(','))

    if (audio.length < 24_000 * 2 * 0.2) throw new Error('没有收到足够的语音播报音频：' + audio.length + ' bytes')
    if (!assistantText) throw new Error('没有收到助手转写')
    report.ok = true
    console.log('\nBRIDGE_VOICE_E2E_PASS')
    console.log(JSON.stringify({ taskResult: report.task.result, audioSeconds: report.audioSeconds, assistantText: assistantText.slice(0, 200) }, null, 2))
  } catch (error) {
    report.ok = false
    report.error = String(error && error.message || error)
    console.error('\nBRIDGE_VOICE_E2E_FAIL:', report.error)
    if (gateway.logs?.length) console.error('gateway logs tail:\n' + gateway.logs.slice(-20).join(''))
    process.exitCode = 1
  } finally {
    try { client?.stop() } catch {}
    try { gateway.child.kill() } catch {}
    await new Promise(resolve => { const timer = setTimeout(resolve, 3_000); gateway.child.once('exit', () => { clearTimeout(timer); resolve() }) })
    try { fs.rmSync(gateway.stateRoot, { recursive: true, force: true }) } catch {}
    report.finishedAt = new Date().toISOString()
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(path.join(OUT_DIR, 'bridge-voice-e2e-report.json'), JSON.stringify(report, null, 2))
      console.log('report:', path.join(OUT_DIR, 'bridge-voice-e2e-report.json'))
    } catch {}
  }
}

main()
