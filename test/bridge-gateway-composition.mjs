/**
 * 组合测试：把 voice-ayuan 的 bridge/gateway-host.mjs 当真实网关子进程拉起，
 * 用网关自带的客户端协议（task.create / task.get / task.cancel /
 * permission.respond / task.input.respond）把任务打进去，验证：
 *   - gateway-host 组合成功、IPC ready、/api/health 报告 backend=dsh-session；
 *   - 任务经 BackendPort 适配器 → mock 宿主桥 → 结果按协议回传；
 *   - 权限/输入/取消全链路。
 * 这一层不需要 DSH 宿主，也不碰用户正在使用的网关（PORT=0 + 临时 QWAUDIO 目录）。
 *
 * 运行：node --test test/bridge-gateway-composition.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { GatewayClientCapability } from 'qwen-audio-agent/gateway-client-protocol'
import { createMockBridge } from './helpers/mock-bridge.mjs'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const GATEWAY_HOST = path.join(PLUGIN_ROOT, 'bridge', 'gateway-host.mjs')
const READY_TYPE = 'qwen-audio-agent:gateway-ready'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function startGatewayHost({ bridgeUrl, bridgeToken }) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-gw-'))
  const env = {
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
    VOICE_AYUAN_BRIDGE_URL: bridgeUrl,
    VOICE_AYUAN_BRIDGE_TOKEN: bridgeToken,
    QWAUDIO_DATA_DIR: path.join(stateRoot, 'data'),
    QWAUDIO_STATE_DIR: path.join(stateRoot, 'state'),
    QWAUDIO_CACHE_DIR: path.join(stateRoot, 'cache'),
  }
  const child = fork(GATEWAY_HOST, [], {
    cwd: PLUGIN_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const logs = []
  child.stderr.on('data', (chunk) => { logs.push(String(chunk)); })
  child.stdout.on('data', (chunk) => { logs.push(String(chunk)); })
  const origin = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway-host ready timeout\n' + logs.join(''))), 60_000)
    timer.unref?.()
    child.on('message', (message) => {
      if (message?.type === READY_TYPE) {
        clearTimeout(timer)
        resolve(message.origin)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`gateway-host exited early code=${code}\n` + logs.join('')))
    })
  })
  return { child, origin, logs, stateRoot }
}

function createClient(url) {
  const statuses = []
  const client = new GatewayClient({
    url,
    createSocket: (socketUrl, options) => new WebSocket(socketUrl, options?.headers ? { headers: options.headers } : undefined),
    clientType: 'client',
    clientVersion: '0.0.0-test',
    clientInstanceId: 'bridge-composition-test',
    capabilities: [
      GatewayClientCapability.TASK_COMMANDS,
      GatewayClientCapability.PERMISSION_RESPOND,
      GatewayClientCapability.INPUT_RESPOND,
    ],
    configure: { voiceEnabled: false, inputEnabled: false, outputEnabled: false, textOnly: true },
    reconnect: false,
    onStatus: (status) => statuses.push(status),
  })
  client.statuses = statuses
  return client
}

async function waitClientReady(client, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (client.ready) return
    await sleep(50)
  }
  throw new Error('gateway client not ready: ' + JSON.stringify(client.statuses.slice(-3)))
}

async function waitForTask(client, taskId, predicate, timeoutMs = 20_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const result = await client.request('task.get', { task_id: taskId })
    last = result.task
    if (predicate(last)) return last
    await sleep(100)
  }
  throw new Error('task wait timeout: ' + JSON.stringify(last))
}

test('gateway-host 组合 + 客户端协议全链路（成功/权限/输入/取消）', async (t) => {
  const mock = await createMockBridge()
  const gateway = startGatewayHost({ bridgeUrl: mock.url, bridgeToken: mock.token })
  let client = null
  try {
    const origin = await gateway.origin
    // 1) /api/health 报出 dsh-session 后端
    const health = await (await fetch(origin + '/api/health')).json()
    assert.equal(health.ok, true)
    assert.equal(health.backend.protocol, 'dsh-session')
    assert.equal(health.backend.enabled, true)
    assert.equal(health.backend.label, '阿源（当前 DSH 会话）')

    // 2) 客户端协议：task.create → 结果回传
    client = createClient(origin.replace(/^http/, 'ws') + '/api/realtime?sessionId=bridge-composition')
    client.start()
    await waitClientReady(client)

    const created = await client.request('task.create', {
      message: { parts: [{ type: 'text', text: '普通任务' }] },
    })
    assert.ok(created.task?.id, 'task.create 应返回任务')
    const completed = await waitForTask(client, created.task.id, task => task.status === 'completed')
    assert.equal(completed.result, 'MOCK_RESULT_OK')
    assert.equal(completed.ownerId, 'user_personal')
    assert.equal(completed.sessionId, 'bridge-composition')
    assert.ok(mock.requests.some(item => item.type === 'create' && item.body.instruction === '普通任务'))

    // 3) 权限：task.create → authorization pending → permission.respond → 完成
    const permissionTask = await client.request('task.create', {
      message: { parts: [{ type: 'text', text: 'MOCK_PERMISSION' }] },
    })
    const awaiting = await waitForTask(client, permissionTask.task.id, task => task.authorization?.status === 'pending')
    assert.ok(awaiting.authorization.id)
    await client.request('permission.respond', {
      permission_id: awaiting.authorization.id,
      decision: 'task',
    })
    const permissionDone = await waitForTask(client, permissionTask.task.id, task => task.status === 'completed')
    assert.equal(permissionDone.result, 'MOCK_PERMISSION_ALLOWED')
    assert.equal(mock.requests.find(item => item.type === 'permission')?.body?.decision, 'allow')

    // 4) 输入：inputRequest pending → task.input.respond → 完成
    const inputTask = await client.request('task.create', {
      message: { parts: [{ type: 'text', text: 'MOCK_INPUT' }] },
    })
    const asking = await waitForTask(client, inputTask.task.id, task => task.inputRequest?.status === 'pending')
    assert.equal(asking.inputRequest.prompt, '请回答 mock 问题')
    await client.request('task.input.respond', {
      task_id: inputTask.task.id,
      input_request_id: asking.inputRequest.id,
      action: 'accept',
      text: '好的',
    })
    const inputDone = await waitForTask(client, inputTask.task.id, task => task.status === 'completed')
    assert.equal(inputDone.result, 'MOCK_INPUT_accept_好的')

    // 5) 取消：长任务 → task.cancel → cancelled（明确终态，不静默）
    const holdTask = await client.request('task.create', {
      message: { parts: [{ type: 'text', text: 'MOCK_HOLD 长任务' }] },
    })
    const running = await waitForTask(client, holdTask.task.id, task => ['running', 'delegated'].includes(task.status))
    assert.ok(running)
    const cancelled = await client.request('task.cancel', { task_id: holdTask.task.id })
    assert.ok(['cancelling', 'cancelled'].includes(cancelled.task.status))
    const terminal = await waitForTask(client, holdTask.task.id, task => task.status === 'cancelled')
    assert.equal(terminal.status, 'cancelled')
  } finally {
    client?.stop()
    try { gateway.child.kill() } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3_000)
      gateway.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    await mock.close()
    try { fs.rmSync(gateway.stateRoot, { recursive: true, force: true }) } catch {}
  }
})
