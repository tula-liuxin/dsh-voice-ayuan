#!/usr/bin/env node
/**
 * 真实端到端验证（需要插件已接线并加载）：
 *
 *   语音客户端协议层（GatewayClient → task.create）
 *     → 独立测试用 qwen-audio-agent 网关实例（bridge/gateway-host.mjs，PORT=0，临时 QWAUDIO 目录）
 *     → BridgeSessionBackend（BackendPort）
 *     → 插件宿主 lib/bridge.js（127.0.0.1 + bearer token）
 *     → 用户当前 live DSH 会话（agent.followup，真实执行 pwsh 工具）
 *     → 事件回流 → 任务完成 → 结果进入前台会话历史
 *
 * 两种模式：
 *   node test/bridge-e2e.mjs            # 隔离网关（默认，不碰用户正在通话的网关）
 *   node test/bridge-e2e.mjs --live     # 走插件正在运行的网关（会占用主 session 'main'，
 *                                       # 任务完成通知可能被用户当前通话播报；仅供人工验收）
 *
 * 前置：
 *   - 插件已接线（index.js 启动 bridge + bridge/gateway-host.mjs 作为网关入口）并已热重载；
 *   - 宿主的 ~/.dsh/voice-ayuan-bridge.json 存在（{url, token}）；
 *   - 用户当前有打开的 DSH 会话（live root agent）。
 *
 * 产出：test/.out/bridge-e2e-report.json（供 Lead/验收留档）。
 */
import assert from 'node:assert/strict'
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
const LIVE = process.argv.includes('--live')
const READY_TYPE = 'qwen-audio-agent:gateway-ready'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = {
  startedAt: new Date().toISOString(),
  mode: LIVE ? 'live-plugin-gateway' : 'isolated-test-gateway',
  checks: [],
  tasks: {},
}

function record(name, value, note) {
  report.checks.push({ name, at: new Date().toISOString(), ...(note ? { note } : {}), value })
  console.log(`[check] ${name}`, typeof value === 'string' ? value : JSON.stringify(value))
}

function fail(error) {
  report.ok = false
  report.error = { message: String(error && error.message || error), stack: String(error && error.stack || '') }
  throw error
}

function readBridgeCredentials() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed?.url || !parsed?.token) throw new Error(`${TOKEN_FILE} 缺少 url/token`)
  return parsed
}

async function bridgeFetch(credentials, method, route, body) {
  const response = await fetch(credentials.url + route, {
    method,
    headers: {
      authorization: `Bearer ${credentials.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) {
    const message = payload?.error?.message || `bridge HTTP ${response.status}`
    const error = new Error(message)
    error.code = payload?.error?.code
    throw error
  }
  return payload
}

function startIsolatedGateway({ bridgeUrl, bridgeToken }) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-e2e-'))
  const child = fork(GATEWAY_HOST, [], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
      SPEECH_TO_SPEECH_REALTIME_URL: 'ws://127.0.0.1:1/v1/realtime',
      S2S_REALTIME_URL: 'ws://127.0.0.1:1/v1/realtime',
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
  child.stdout.on('data', chunk => logs.push(String(chunk)))
  child.stderr.on('data', chunk => logs.push(String(chunk)))
  const origin = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway-host ready timeout\n' + logs.join(''))), 60_000)
    timer.unref?.()
    child.on('message', message => {
      if (message?.type === READY_TYPE) {
        clearTimeout(timer)
        resolve(message.origin)
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`gateway-host exited code=${code}\n` + logs.join('')))
    })
  })
  return { child, origin, logs, stateRoot }
}

function createGatewayClient(url, statuses, serverEvents = []) {
  const client = new GatewayClient({
    url,
    createSocket: (socketUrl, options) => new WebSocket(socketUrl, options?.headers ? { headers: options.headers } : undefined),
    clientType: 'client',
    clientVersion: '0.0.0-e2e',
    clientInstanceId: 'bridge-e2e-' + Date.now(),
    capabilities: [
      GatewayClientCapability.TASK_COMMANDS,
      GatewayClientCapability.PERMISSION_RESPOND,
      GatewayClientCapability.INPUT_RESPOND,
      GatewayClientCapability.CONVERSATION_HISTORY,
    ],
    configure: { voiceEnabled: false, inputEnabled: false, outputEnabled: false, textOnly: true },
    reconnect: false,
    // 目标会话可能正被用户手打的消息占用，任务会排队；单次 RPC 给足超时。
    requestTimeoutMs: 30_000,
    onStatus: status => statuses.push(status),
    onEvent: event => {
      serverEvents.push({
        type: event.type,
        at: Date.now(),
        ...(event.task ? { taskStatus: event.task.status, taskResult: event.task.result || null } : {}),
      })
    },
  })
  client.start()
  return client
}

async function waitClientReady(client, statuses, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (client.ready) return
    await sleep(50)
  }
  throw new Error('gateway client not ready: ' + JSON.stringify(statuses.slice(-3)))
}

async function waitForTask(client, taskId, predicate, { timeoutMs = 240_000, label = '' } = {}) {
  const started = Date.now()
  let last = null
  let lastStatus = ''
  while (Date.now() - started < timeoutMs) {
    const result = await client.request('task.get', { task_id: taskId })
    last = result.task
    if (last.status !== lastStatus) {
      lastStatus = last.status
      console.log(`  [task ${label || taskId}] status=${last.status} workState=${last.workState}` +
        (last.message ? ` message=${JSON.stringify(String(last.message).slice(0, 120))}` : ''))
    }
    if (predicate(last)) return last
    await sleep(300)
  }
  throw new Error(`task wait timeout (${label})\nlast=` + JSON.stringify(last, null, 2))
}

/**
 * 宿主 bridge v1 全局串行：如果用户此刻正好用语音派了任务，我们的测试任务会立刻收到
 * BRIDGE_BUSY。这里识别该错误并稍后重试（最多 8 次），其余错误照常抛出。
 */
async function createTaskWithBusyRetry(client, instruction, { attempts = 8, observeMs = 5_000 } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const created = await client.request('task.create', { message: { parts: [{ type: 'text', text: instruction }] } })
    const taskId = created.task?.id
    if (!taskId) throw new Error('task.create 没有返回任务 id')
    const started = Date.now()
    let current = created.task
    let sawRunning = false
    while (Date.now() - started < observeMs) {
      const result = await client.request('task.get', { task_id: taskId })
      current = result.task
      if (['completed', 'failed', 'cancelled'].includes(current.status)) break
      if (['running', 'delegated'].includes(current.status)) sawRunning = true
      // 先 running 后又立刻失败（例如 BRIDGE_BUSY）也要在窗口内捕获，不能提前返回 running。
      if (sawRunning && Date.now() - started > 1_500) break
      await sleep(200)
    }
    if (current.status !== 'failed') return { task: current, taskId, attempt }
    const message = String(current.error || '')
    if (!/上一项语音任务|还没结束|BRIDGE_BUSY/.test(message)) {
      throw new Error('任务创建后立即失败：' + message)
    }
    lastError = message
    console.log(`  [task] 宿主桥忙，第 ${attempt} 次重试：${message}`)
    await sleep(1_000)
  }
  throw new Error('宿主桥持续忙，任务无法创建：' + lastError)
}

/** 等插件自己的网关也切到 bridge 模式（重载后 gateway.entry='bridge'）。 */
async function waitLivePluginBridge(credentials, timeoutMs = 30_000) {
  const pluginOrigin = new URL(credentials.url).origin
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(pluginOrigin + '/voice-ayuan/status', { signal: AbortSignal.timeout(5_000) })
      last = await response.json()
      if (
        last?.ok
        && last?.bridge?.phase === 'ready'
        && last?.body?.backend?.protocol === 'dsh-session'
      ) {
        // 注：/voice-ayuan/status 的顶层字段来自 gateway.health()（不含 gateway.status()），
        // 因此以 backend.protocol + bridge.phase 作为「插件网关已切 bridge 模式」的硬指标；
        // 若将来 status 透出 gateway.entry，也会在这里保留。
        return last
      }
    } catch (error) {
      last = { error: String(error && error.message || error) }
    }
    await sleep(1_000)
  }
  throw new Error('插件网关还没有切到 bridge 模式：' + JSON.stringify(last))
}

async function main() {
  const credentials = readBridgeCredentials()
  record('bridge-token-file', { file: TOKEN_FILE, url: credentials.url })

  // 0) 先证明「插件自己的网关」已经是 bridge 模式（重载生效的硬指标）
  const liveStatus = await waitLivePluginBridge(credentials)
  record('live-plugin-gateway', {
    origin: liveStatus.origin,
    gatewayEntry: liveStatus.gateway?.entry ?? null,
    gatewayBridge: liveStatus.gateway?.bridge ?? null,
    bridgePhase: liveStatus.bridge?.phase,
    backendProtocol: liveStatus.body?.backend?.protocol,
    backendLabel: liveStatus.body?.backend?.label,
    backendStatus: liveStatus.body?.backend?.status,
  })

  const health = await bridgeFetch(credentials, 'GET', '/health')
  record('host-bridge-health', {
    ok: health.ok,
    phase: health.phase,
    target: health.target,
    warning: health.warning || null,
  })
  if (!health.target?.sessionId) {
    throw new Error('宿主 bridge 没有可用目标会话：' + JSON.stringify(health.warning || health))
  }
  report.targetSession = health.target

  const status = await bridgeFetch(credentials, 'GET', '/status')
  record('host-bridge-targets', (status.targets || []).map(target => ({
    sessionId: target.sessionId,
    label: target.label,
    lastUserAt: target.lastUserAt,
  })))

  const nonce = 'VOICE_BRIDGE_E2E_OK_' + Math.random().toString(36).slice(2, 10)
  const instruction = `在当前 DSH 会话里做一个无害的桥梁验证：调用 pwsh 工具运行命令 Write-Output "${nonce}"，然后把这条命令的原始输出原样作为你这一轮的最终回答。只输出这一行，不要添加解释。`

  let gateway = null
  const statuses = []
  const serverEvents = []
  let client = null
  try {
    let wsUrl
    if (LIVE) {
      const { host, protocol } = new URL(credentials.url)
      wsUrl = `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/voice-ayuan/rt`
      record('live-gateway', wsUrl)
    } else {
      gateway = startIsolatedGateway({ bridgeUrl: credentials.url, bridgeToken: credentials.token })
      const origin = await gateway.origin
      report.gatewayOrigin = origin
      const gatewayHealth = await (await fetch(origin + '/api/health')).json()
      record('isolated-gateway-health', {
        ok: gatewayHealth.ok,
        backendProtocol: gatewayHealth.backend?.protocol,
        backendEnabled: gatewayHealth.backend?.enabled,
        backendLabel: gatewayHealth.backend?.label,
      })
      assert.equal(gatewayHealth.backend?.protocol, 'dsh-session')
      wsUrl = origin.replace(/^http/, 'ws') + '/api/realtime?sessionId=bridge-e2e'
    }

    client = createGatewayClient(wsUrl, statuses, serverEvents)
    await waitClientReady(client, statuses)
    record('gateway-client-ready', ['tasks.commands', 'conversations'].join(','))

    // ---- 1) 成功任务：真实命令输出经 DSH 会话回流 ----
    const created = await createTaskWithBusyRetry(client, instruction)
    report.tasks.success = { taskId: created.taskId, objective: instruction, attempts: created.attempt }
    record('task-create', { taskId: created.taskId, status: created.task.status, sessionId: created.task.sessionId })
    const completed = await waitForTask(client, created.taskId, task => ['completed', 'failed', 'cancelled'].includes(task.status), {
      timeoutMs: 300_000,
      label: 'success',
    })
    report.tasks.success.final = {
      status: completed.status,
      result: completed.result,
      error: completed.error,
      elapsedMs: completed.elapsedMs,
      notificationStatus: completed.notificationStatus,
      activityCount: Array.isArray(completed.activity) ? completed.activity.length : 0,
      activities: (completed.activity || []).map(item => ({ kind: item.kind, status: item.status, title: item.title, label: item.label })),
    }
    assert.equal(completed.status, 'completed', '成功任务应以 completed 结束')
    assert.ok(String(completed.result || '').includes(nonce), `任务结果应包含真实命令输出 ${nonce}，实际：${completed.result}`)
    record('task-result-has-command-output', String(completed.result).slice(0, 300))
    record('task-notification-status', completed.notificationStatus)

    // ---- 2) 结果回流语音侧的硬证据 ----
    // (a) 协议层：服务端把 task.completed 推给客户端（这就是前台实时会话收到的事件流）。
    const completedEvent = serverEvents.find(event => event.type === 'task.completed'
      && String(event.taskResult || '').includes(nonce))
    record('server-task-completed-event', completedEvent || { serverEvents: serverEvents.slice(-10) })
    assert.ok(completedEvent, '客户端应收到 task.completed 事件且带真实结果')
    // (b) 公告队列：完成通知已进入待播报队列（notificationStatus=pending），
    //     输出使能的前台实时会话会在下一次轮转 claim → recordTaskResult → 语音播报。
    //     注意：本测试客户端 textOnly（outputEnabled=false），按 qwen-audio-agent 的
    //     SessionTaskCoordinator.canDeliver() 设计不会 claim 公告，因此这里断言 pending 而不是
    //     硬造 history；真实语音会话的播报链路由用户通话实测（见 DESIGN §8 人工验收）。
    assert.equal(completed.notificationStatus, 'pending', '任务完成通知应进入待播报队列')
    const history = await client.request('conversation.history', {})
    const messages = Array.isArray(history.messages) ? history.messages : []
    report.tasks.success.frontendHistory = messages.slice(-5).map(message => ({
      role: message.role,
      source: message.source,
      content: String(message.content || '').slice(0, 300),
    }))
    record('frontend-history (textOnly client, announcement not claimed by design)', {
      messageCount: messages.length,
      note: 'textOnly 客户端 outputEnabled=false 不会 claim 公告；语音模型播报由输出使能会话完成',
    })

    // ---- 3) 取消：打断进行中的一轮，明确 cancelled 终态 ----
    const cancelInstruction = '在当前 DSH 会话里运行 pwsh 命令：Start-Sleep -Seconds 20; Write-Output "SHOULD_NOT_FINISH"。在命令返回前不要结束这一轮。'
    const longTask = await createTaskWithBusyRetry(client, cancelInstruction)
    report.tasks.cancel = { taskId: longTask.taskId, attempts: longTask.attempt }
    record('cancel-task-create', { taskId: longTask.taskId })
    const running = await waitForTask(client, longTask.taskId, task => ['running', 'delegated', 'queued'].includes(task.status), {
      timeoutMs: 120_000,
      label: 'cancel-running',
    })
    report.tasks.cancel.running = running.status
    const cancelReceipt = await client.request('task.cancel', { task_id: longTask.taskId })
    record('task-cancel-request', { status: cancelReceipt.task?.status })
    const cancelled = await waitForTask(client, longTask.taskId, task => ['cancelled', 'failed', 'completed'].includes(task.status), {
      timeoutMs: 120_000,
      label: 'cancel-terminal',
    })
    report.tasks.cancel.final = { status: cancelled.status, error: cancelled.error, elapsedMs: cancelled.elapsedMs }
    assert.equal(cancelled.status, 'cancelled', '取消后任务应是 cancelled 终态，而不是静默消失')

    // ---- 4) 取消后立刻再派新任务：锁必须已经释放，不能再 BRIDGE_BUSY ----
    const afterNonce = 'VOICE_BRIDGE_E2E_AFTER_CANCEL_OK_' + Math.random().toString(36).slice(2, 8)
    const afterInstruction = `在当前 DSH 会话里运行 pwsh 命令 Write-Output "${afterNonce}"，然后只回答这条命令的输出（一行）。`
    const afterTask = await createTaskWithBusyRetry(client, afterInstruction)
    report.tasks.afterCancel = { taskId: afterTask.taskId, attempts: afterTask.attempt }
    record('after-cancel-task-create', { taskId: afterTask.taskId, attempts: afterTask.attempt })
    assert.equal(afterTask.attempt, 1, '取消后立刻派新任务不应重试（说明桥的串行锁已释放）')
    const afterCompleted = await waitForTask(client, afterTask.taskId, task => ['completed', 'failed', 'cancelled'].includes(task.status), {
      timeoutMs: 300_000,
      label: 'after-cancel',
    })
    report.tasks.afterCancel.final = { status: afterCompleted.status, result: afterCompleted.result, error: afterCompleted.error }
    assert.equal(afterCompleted.status, 'completed', '取消后新任务应正常完成（不 BRIDGE_BUSY）')
    assert.ok(String(afterCompleted.result || '').includes(afterNonce), `取消后新任务结果应含真实输出 ${afterNonce}，实际：${afterCompleted.result}`)
    record('after-cancel-task-result', String(afterCompleted.result).slice(0, 200))

    report.ok = true
  } catch (error) {
    // 失败时把测试网关子进程的日志带上，方便定位
    if (gateway) {
      report.gatewayLogs = gateway.logs.slice(-40)
      console.error('测试网关日志（尾部）:\n' + gateway.logs.slice(-30).join(''))
    }
    fail(error)
  } finally {
    try { client?.stop() } catch {}
    if (gateway) {
      try { gateway.child.kill() } catch {}
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3_000)
        gateway.child.once('exit', () => { clearTimeout(timer); resolve() })
      })
      try { fs.rmSync(gateway.stateRoot, { recursive: true, force: true }) } catch {}
    }
  }
}

main().then(() => {
  report.finishedAt = new Date().toISOString()
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'bridge-e2e-report.json'), JSON.stringify(report, null, 2))
  } catch {}
  console.log('\nBRIDGE_E2E_PASS')
  console.log(JSON.stringify({
    mode: report.mode,
    targetSession: report.targetSession,
    successResult: report.tasks?.success?.final?.result,
    cancelStatus: report.tasks?.cancel?.final?.status,
    report: path.join(OUT_DIR, 'bridge-e2e-report.json'),
  }, null, 2))
}).catch((error) => {
  report.finishedAt = new Date().toISOString()
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'bridge-e2e-report.json'), JSON.stringify(report, null, 2))
  } catch {}
  console.error('\nBRIDGE_E2E_FAIL')
  console.error(String(error && error.stack || error))
  process.exitCode = 1
})
