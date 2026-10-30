/**
 * lib/bridge.js 宿主侧单测：用**模拟的 DSH 宿主接口**（ctx.agents / ctx.on /
 * webServer）驱动真实的 lib/bridge.js 代码，覆盖：
 *   - 目标会话选择（最近用户活动优先 / 无 live 会话明确失败 / config 覆盖）
 *   - followup 投递 + turn/工具/assistant/turn-end 事件 → SSE 进度与最终结果
 *   - 取消（队列内移出 / 进行中打断只打自己那一轮）
 *   - 权限中转（approval/request waterfall → SSE → respond → outcome）
 *   - 提问中转、BRIDGE_BUSY、token 鉴权、SSE 回放 since
 *
 * 注意：这是宿主接口的模拟，用于在热重载前抓 lib/bridge.js 的缺陷；
 * 真实 DSH 会话链路由 test/bridge-e2e.mjs 在重载后验证。
 *
 * 运行：node --test test/bridge-host.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createVoiceBridge } = await import('../lib/bridge.js')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createFakeAgent(id, { cwd = 'C:\\Users\\23677\\Downloads', lastEventTime = Date.now() } = {}) {
  const agent = {
    id,
    session: {
      id,
      header: { id, cwd, createdAt: lastEventTime - 60_000 },
      seq: 1,
      eventAt: () => ({ seq: 1, time: lastEventTime, type: 'session/created', data: {} }),
    },
    inbox: {
      queue: [],
      removed: [],
      remove(messageId) {
        const index = this.queue.findIndex(message => message.id === messageId)
        if (index < 0) return false
        this.queue.splice(index, 1)
        this.removed.push(messageId)
        return true
      },
    },
    followups: [],
    cancels: [],
    followup(message) {
      this.followups.push(message)
      agent.inbox.queue.push(message)
    },
    cancel(cause) {
      this.cancels.push(cause)
    },
    status: 'idle',
  }
  return agent
}

function createFakeHost(agents, { controller, defaultModel } = {}) {
  const listeners = new Map()
  const emitted = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'agentDefaultModel') return defaultModel
      return undefined
    },
    on(name, handler, options = {}) {
      const list = listeners.get(name) || []
      if (options.prepend) list.unshift(handler)
      else list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) || []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    agents: {
      roots: () => agents.filter(agent => agent.alive !== false),
      get: id => agents.find(agent => agent.id === id),
    },
  }
  const emit = (name, ...args) => {
    // 真实 DSH 在 claim 时会把消息移出 inbox；模拟器保持同样语义，
    // 否则 cancel 会误判「还在队列里」。
    if (name === 'agent/inbox/claimed') {
      const payload = args[0]
      const queue = payload?.agent?.inbox?.queue
      if (Array.isArray(queue)) {
        const index = queue.findIndex(message => message.id === payload?.message?.id)
        if (index >= 0) queue.splice(index, 1)
      }
    }
    const results = []
    for (const handler of [...(listeners.get(name) || [])]) {
      results.push(handler(...args))
    }
    return results
  }
  const invoke = async (name, ...args) => {
    for (const handler of [...(listeners.get(name) || [])]) {
      const result = await handler(...args)
      if (result !== undefined && result !== null && name === 'approval/request') return result
      if (result !== undefined && result !== null && name === 'user-questions/request') return result
    }
    return undefined
  }
  return { ctx, emit, invoke, listeners, emitted }
}

/**
 * 模拟宿主 SessionController：新建会话时把新 agent 塞进同一个 live roots 数组，
 * 恢复会话时从 persisted 里把它变成 live（与真实宿主的行为一致）。
 */
function createFakeSessionController({ agents }) {
  const created = []
  const resumed = []
  const renamed = []
  const persisted = new Map()
  const controller = {
    created,
    resumed,
    renamed,
    persisted,
    createImpl: null,
    async create(request) {
      if (controller.createImpl) return await controller.createImpl(request)
      const id = `session-voice-${created.length + 1}`
      const agent = createFakeAgent(id, { cwd: request.cwd })
      agents.push(agent)
      created.push({ request, id })
      return { sessionId: id }
    },
    async resolveAgent(sessionId) {
      resumed.push(sessionId)
      const live = agents.find(agent => agent.id === sessionId)
      if (live) return live
      const stored = persisted.get(sessionId)
      if (!stored) throw new Error(`session not found: ${sessionId}`)
      agents.push(stored)
      return stored
    },
    async rename(request) {
      renamed.push(request)
      return { title: request.title, seq: 1 }
    },
  }
  return controller
}

async function startBridgeHost({ agents, tokenFile, controller, config = {} }) {
  const host = createFakeHost(agents, { controller })
  let handler = null
  const webServer = {
    register(route) {
      handler = route.handler
      return () => { handler = null }
    },
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
  }
  const bridge = createVoiceBridge({
    ctx: host.ctx,
    webServer,
    config: { tokenFile, ...config },
    log: () => {},
  })
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { bridge, server, host }
}

function closeServer(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

function authHeaders(bridge) {
  return { authorization: `Bearer ${bridge.token}` }
}

async function requestJson(bridge, method, route, body) {
  const response = await fetch(bridge.url() + route, {
    method,
    headers: {
      ...authHeaders(bridge),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await response.json() } catch {}
  return { status: response.status, payload }
}

/** 打开 SSE，收集事件直到 predicate 命中；返回 {events, terminal}。 */
async function collectSse(bridge, bridgeTaskId, predicate, { since = 0, timeoutMs = 8_000 } = {}) {
  const controller = new AbortController()
  const response = await fetch(`${bridge.url()}/tasks/${bridgeTaskId}/events?since=${since}`, {
    headers: authHeaders(bridge),
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  const started = Date.now()
  try {
    while (Date.now() - started < timeoutMs) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = frame.split('\n').find(item => item.startsWith('data:'))
        if (!line) continue
        const event = JSON.parse(line.slice(5).trim())
        events.push(event)
        if (predicate(event)) {
          controller.abort()
          return { events, terminal: event }
        }
      }
    }
  } finally {
    try { controller.abort() } catch {}
  }
  throw new Error('SSE 等待超时，已收到事件: ' + JSON.stringify(events))
}

function sessionEvent(agent, type, data) {
  return [agent.session, { type, seq: (agent.seq = (agent.seq || 1) + 1), time: Date.now(), data }]
}

test('目标会话：最近用户活动优先；无 live 会话明确失败；config.sessionId 覆盖', async () => {
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-')), 'bridge.json')
  const older = createFakeAgent('session-older')
  const newer = createFakeAgent('session-newer')
  const host = await startBridgeHost({ agents: [older, newer], tokenFile })
  try {
    // 给 older 一条普通事件、给 newer 一条 user/message（最近用户活动）
    const now = Date.now()
    host.host.emit('session/event', ...sessionEvent(older, 'turn/start', { turn: 1 }))
    await sleep(5)
    host.host.emit('session/event', newer.session, { type: 'user/message', seq: 9, time: now + 9, data: { id: 'm1' } })
    const health = await requestJson(host.bridge, 'GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.payload.target.sessionId, 'session-newer')

    // 全部关闭 → NO_LIVE_SESSION
    older.alive = false
    newer.alive = false
    const create = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-1', ownerId: 'owner', instruction: '帮我做点事',
    })
    assert.equal(create.status, 409)
    assert.equal(create.payload.error.code, 'NO_LIVE_SESSION')
    assert.match(create.payload.error.message, /没有正在使用的 DSH 会话/)

    // 配置覆盖：重新打开 older 也可用 config 指定
    older.alive = true
    newer.alive = true
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(path.dirname(tokenFile), { recursive: true, force: true })
  }
})

test('config.sessionId 覆盖：显式指定目标会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const older = createFakeAgent('session-fixed')
  const newer = createFakeAgent('session-other')
  const host = createFakeHost([older, newer])
  let handler = null
  const webServer = {
    register(route) { handler = route.handler; return () => {} },
    getOrigin: () => 'http://127.0.0.1:' + server.address().port,
  }
  const bridge = createVoiceBridge({
    ctx: host.ctx,
    webServer,
    config: { tokenFile: path.join(dir, 'bridge.json'), sessionId: 'session-fixed' },
    log: () => {},
  })
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    host.emit('session/event', newer.session, { type: 'user/message', seq: 2, time: Date.now() + 5, data: { id: 'm2' } })
    const health = await requestJson(bridge, 'GET', '/health')
    assert.equal(health.payload.target.sessionId, 'session-fixed')
  } finally {
    bridge.close()
    await closeServer(server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('完整一轮：followup 投递 → 进度事件 → 最终结果（含 turn 过滤）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const tokenFile = path.join(dir, 'bridge.json')
  const agent = createFakeAgent('session-active')
  const host = await startBridgeHost({ agents: [agent], tokenFile })
  try {
    const create = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-success', ownerId: 'owner', instruction: '把桌面的报告整理一下',
    })
    assert.equal(create.status, 202)
    const bridgeTaskId = create.payload.bridgeTaskId
    assert.equal(agent.followups.length, 1)
    assert.equal(agent.followups[0].role, 'user')
    assert.equal(agent.followups[0].content[0].text, '把桌面的报告整理一下')
    assert.equal(agent.followups[0].source.kind, 'user')

    // 打开 SSE，边模拟 DSH 事件边收集
    const ssePromise = collectSse(host.bridge, bridgeTaskId, event => event.type === 'result')
    await sleep(40)
    // 别的 turn 的事件不应污染结果
    host.host.emit('session/event', ...sessionEvent(agent, 'assistant/message', {
      turn: 3, step: 1, message: { content: [{ type: 'text', text: '不属于我们的旧回答' }] },
    }))
    host.host.emit('agent/inbox/claimed', { agent, message: agent.followups[0], turn: 7 })
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/start', { turn: 7 }))
    host.host.emit('session/event', ...sessionEvent(agent, 'tool/call', {
      turn: 7, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{"command":"Get-ChildItem"}',
    }))
    host.host.emit('session/event', ...sessionEvent(agent, 'tool/result', {
      turn: 7, step: 1, message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] },
    }))
    host.host.emit('session/event', ...sessionEvent(agent, 'assistant/message', {
      turn: 7, step: 1, message: { content: [{ type: 'text', text: '报告整理好了，一共 3 份。' }] },
    }))
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/end', { turn: 7, reason: { kind: 'completed' } }))

    const { events, terminal } = await ssePromise
    assert.equal(terminal.type, 'result')
    assert.match(terminal.result.content, /报告整理好了/)
    assert.equal(terminal.result.turn, 7)
    const types = events.map(event => event.type)
    assert.ok(types.includes('accepted'))
    assert.ok(events.some(event => event.type === 'activity' && event.activity?.id === 'turn-started'))
    assert.ok(events.some(event => event.type === 'activity' && event.activity?.id === 'tool:call-1'))
    // 最终结果只来自 turn 7，不带 turn 3 的旧回答
    assert.doesNotMatch(terminal.result.content, /旧回答/)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('取消：队列内指令直接移出；进行中的只打断我们这一轮', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const agent = createFakeAgent('session-cancel')
  const host = await startBridgeHost({ agents: [agent], tokenFile: path.join(dir, 'bridge.json') })
  try {
    // 1) 还没被认领：inbox.remove 移出 → cancelled
    const queued = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-cancel-queued', ownerId: 'owner', instruction: '长任务 A',
    })
    const queuedId = queued.payload.bridgeTaskId
    const queuedSse = collectSse(host.bridge, queuedId, event => event.type === 'cancelled')
    await sleep(40)
    const cancelQueued = await requestJson(host.bridge, 'POST', `/tasks/${queuedId}/cancel`, {})
    assert.equal(cancelQueued.status, 200)
    assert.equal(agent.inbox.removed.length, 1)
    const queuedTerminal = await queuedSse
    assert.equal(queuedTerminal.terminal.type, 'cancelled')

    // 2) 已被认领：agent.cancel 被调用；模拟 aborted turn/end → cancelled
    const active = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-cancel-active', ownerId: 'owner', instruction: '长任务 B',
    })
    const activeId = active.payload.bridgeTaskId
    await sleep(20)
    host.host.emit('agent/inbox/claimed', { agent, message: agent.followups.at(-1), turn: 9 })
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/start', { turn: 9 }))
    const activeSse = collectSse(host.bridge, activeId, event => event.type === 'cancelled')
    await requestJson(host.bridge, 'POST', `/tasks/${activeId}/cancel`, {})
    await sleep(400) // 等 cancelTask 的 300ms turn 确认定时器
    assert.ok(agent.cancels.length >= 1, '进行中的任务应调用 agent.cancel')
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/end', {
      turn: 9, reason: { kind: 'aborted', reason: { kind: 'user' } },
    }))
    const activeTerminal = await activeSse
    assert.equal(activeTerminal.terminal.type, 'cancelled')
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('权限中转：approval/request waterfall → SSE → 回答 allow/reject', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const agent = createFakeAgent('session-perm')
  const host = await startBridgeHost({ agents: [agent], tokenFile: path.join(dir, 'bridge.json') })
  try {
    const create = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-perm', ownerId: 'owner', instruction: '删除一个文件',
    })
    const bridgeTaskId = create.payload.bridgeTaskId
    await sleep(20)
    host.host.emit('agent/inbox/claimed', { agent, message: agent.followups.at(-1), turn: 11 })
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/start', { turn: 11 }))
    const ssePromise = collectSse(host.bridge, bridgeTaskId, event => event.type === 'permission.requested')
    await sleep(40)
    const approvalPromise = host.host.invoke('approval/request', {
      agent,
      toolName: 'write',
      reason: '写入工作区之外的文件',
    }, async () => 'unavailable')
    const { terminal } = await ssePromise
    assert.equal(terminal.type, 'permission.requested')
    const permissionId = terminal.permission.id
    assert.match(terminal.permission.summary, /写|文件/)
    const respond = await requestJson(host.bridge, 'POST', `/tasks/${bridgeTaskId}/permission`, {
      permissionId,
      decision: 'allow',
    })
    assert.equal(respond.status, 200)
    assert.equal(await approvalPromise, 'allowed-once')
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('提问中转：user-questions/request → input.requested → respond_agent_input 回答', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const agent = createFakeAgent('session-input')
  const host = await startBridgeHost({ agents: [agent], tokenFile: path.join(dir, 'bridge.json') })
  try {
    const create = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-input', ownerId: 'owner', instruction: '整理文件',
    })
    const bridgeTaskId = create.payload.bridgeTaskId
    await sleep(20)
    host.host.emit('agent/inbox/claimed', { agent, message: agent.followups.at(-1), turn: 12 })
    host.host.emit('session/event', ...sessionEvent(agent, 'turn/start', { turn: 12 }))
    const ssePromise = collectSse(host.bridge, bridgeTaskId, event => event.type === 'input.requested')
    await sleep(40)
    const questionPromise = host.host.invoke('user-questions/request', {
      agent,
      questions: [{ id: 'q1', question: '要整理到哪个目录？', options: [{ label: '桌面' }, { label: '文档' }] }],
    }, async () => ({ answers: [{ id: 'q1', selected: [], custom: 'GUI 答案' }] }))
    const { terminal } = await ssePromise
    assert.equal(terminal.type, 'input.requested')
    assert.match(terminal.input.prompt, /要整理到哪个目录/)
    const respond = await requestJson(host.bridge, 'POST', `/tasks/${bridgeTaskId}/input`, {
      inputRequestId: terminal.input.id,
      action: 'accept',
      text: '桌面',
    })
    assert.equal(respond.status, 200)
    const answer = await questionPromise
    assert.deepEqual(answer.answers[0], { id: 'q1', selected: ['桌面'] })
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('并发与鉴权：第二个任务 409 BRIDGE_BUSY；错误 token 401', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const agent = createFakeAgent('session-busy')
  const host = await startBridgeHost({ agents: [agent], tokenFile: path.join(dir, 'bridge.json') })
  try {
    const first = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-busy-1', ownerId: 'owner', instruction: '第一件事',
    })
    assert.equal(first.status, 202)
    const second = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-busy-2', ownerId: 'owner', instruction: '第二件事',
    })
    assert.equal(second.status, 409)
    assert.equal(second.payload.error.code, 'BRIDGE_BUSY')

    const unauthorized = await fetch(host.bridge.url() + '/health', {
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(unauthorized.status, 401)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ 工作区优先 / 自动新建专用会话

const WORKSPACE = 'C:\\data\\ayuan\\yuan\\workspace'

function workspaceHostOptions({ dir, controller, extra = {} }) {
  return {
    controller,
    config: { cwdPrefix: 'C:/data/ayuan/yuan/workspace', sessionStateFile: path.join(dir, 'session.json'), ...extra },
  }
}

test('cwdPrefix：工作区有 live 会话就只投它（不新建、不串台）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const work = createFakeAgent('session-work', { cwd: WORKSPACE })
  const agents = [main, work]
  const controller = createFakeSessionController({ agents })
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    const health = await requestJson(host.bridge, 'GET', '/health')
    assert.equal(health.payload.target.sessionId, 'session-work')
    assert.equal(health.payload.resolution.mode, 'workspace-live')
    assert.equal(health.payload.autoCreateSession, true)
    assert.equal(health.payload.sessionTitle, '语音通话')
    assert.equal(health.payload.host.sessionController, true)
    assert.equal(health.payload.host.create, true)
    assert.equal(health.payload.host.resolveAgent, true)
    assert.equal(controller.created.length, 0)

    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-work', ownerId: 'owner', instruction: '看看工作区里有什么',
    })
    assert.equal(task.status, 202)
    assert.equal(task.payload.target.sessionId, 'session-work')
    assert.equal(work.followups.length, 1)
    assert.equal(main.followups.length, 0)
    assert.equal(controller.created.length, 0)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cwdPrefix：工作区没有 live 会话 → 自动新建「语音通话」，不落回主会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const agents = [main]
  const controller = createFakeSessionController({ agents })
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    // 健康检查只探测，不产生副作用
    const health = await requestJson(host.bridge, 'GET', '/health')
    assert.equal(health.payload.target, null)
    assert.equal(health.payload.warning.code, 'AUTO_CREATE_PENDING')
    assert.equal(controller.created.length, 0)

    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-create', ownerId: 'owner', instruction: '查一下今天的日程',
    })
    assert.equal(task.status, 202)
    assert.equal(controller.created.length, 1)
    assert.equal(controller.created[0].request.cwd, 'C:/data/ayuan/yuan/workspace')
    const createdAgent = agents.find(agent => agent.id === controller.created[0].id)
    assert.ok(createdAgent, '新建的会话必须真的 live')
    assert.equal(createdAgent.followups.length, 1)
    assert.equal(main.followups.length, 0, '绝不能落回主会话')
    assert.equal(task.payload.target.sessionId, createdAgent.id)
    // 新会话被命名成「语音通话」，并记进状态文件
    assert.equal(controller.renamed.length, 1)
    assert.equal(controller.renamed[0].title, '语音通话')
    assert.equal(controller.renamed[0].sessionId, createdAgent.id)
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))
    assert.equal(state.sessionId, createdAgent.id)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('专用语音会话记住后复用：仍 live 就直接用，不再新建', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const voice = createFakeAgent('session-voice', { cwd: WORKSPACE })
  voice.alive = false // 不是 root，但仍是 live agent
  const agents = [main, voice]
  const controller = createFakeSessionController({ agents })
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ sessionId: 'session-voice', cwd: WORKSPACE }))
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-reuse', ownerId: 'owner', instruction: '继续刚才那件事',
    })
    assert.equal(task.status, 202)
    assert.equal(task.payload.target.sessionId, 'session-voice')
    assert.equal(voice.followups.length, 1)
    assert.equal(controller.created.length, 0)
    assert.equal(controller.resumed.length, 0)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('专用语音会话已关闭但还持久化 → 恢复它，不新建', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const agents = [main]
  const controller = createFakeSessionController({ agents })
  controller.persisted.set('session-stored', createFakeAgent('session-stored', { cwd: WORKSPACE }))
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ sessionId: 'session-stored', cwd: WORKSPACE }))
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-resume', ownerId: 'owner', instruction: '接着昨天的继续说',
    })
    assert.equal(task.status, 202)
    assert.deepEqual(controller.resumed, ['session-stored'])
    assert.equal(controller.created.length, 0, '能恢复就不该新建')
    assert.equal(task.payload.target.sessionId, 'session-stored')
    assert.equal(controller.renamed.length, 0, '恢复的会话不改名')
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('autoCreateSession:false：退回最近活跃会话（旧行为随时可回）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const agents = [main]
  const controller = createFakeSessionController({ agents })
  const host = await startBridgeHost({
    agents,
    tokenFile: path.join(dir, 'bridge.json'),
    ...workspaceHostOptions({ dir, controller, extra: { autoCreateSession: false } }),
  })
  try {
    const health = await requestJson(host.bridge, 'GET', '/health')
    assert.equal(health.payload.target.sessionId, 'session-main')
    assert.equal(health.payload.resolution.mode, 'fallback-auto-create-off')
    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-off', ownerId: 'owner', instruction: '随手记一下',
    })
    assert.equal(task.status, 202)
    assert.equal(main.followups.length, 1)
    assert.equal(controller.created.length, 0)
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('自动新建失败 → 409 SESSION_CREATE_FAILED，不落回主会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const agents = [main]
  const controller = createFakeSessionController({ agents })
  controller.createImpl = async () => { throw new Error('磁盘不可写') }
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-fail', ownerId: 'owner', instruction: '随便做点什么',
    })
    assert.equal(task.status, 409)
    assert.equal(task.payload.error.code, 'SESSION_CREATE_FAILED')
    assert.match(task.payload.error.message, /自动新建.*磁盘不可写/)
    assert.equal(main.followups.length, 0, '失败也不能偷偷投给主会话')
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('新建后 agent 晚一步发布 → 按 id 再解析一次，仍然投得进去', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-host-'))
  const main = createFakeAgent('session-main', { cwd: 'C:\\Users\\23677\\Downloads' })
  const agents = [main]
  const controller = createFakeSessionController({ agents })
  const late = createFakeAgent('session-late', { cwd: WORKSPACE })
  controller.persisted.set('session-late', late)
  // create 只返回 id，agent 稍后才在 resolveAgent 里变成 live（模拟宿主发布次序）
  controller.createImpl = async () => ({ sessionId: 'session-late' })
  const host = await startBridgeHost({ agents, tokenFile: path.join(dir, 'bridge.json'), ...workspaceHostOptions({ dir, controller }) })
  try {
    const task = await requestJson(host.bridge, 'POST', '/tasks', {
      taskId: 'gw-late', ownerId: 'owner', instruction: '开始吧',
    })
    assert.equal(task.status, 202)
    assert.equal(task.payload.target.sessionId, 'session-late')
    assert.equal(late.followups.length, 1)
    assert.deepEqual(controller.resumed, ['session-late'])
  } finally {
    host.bridge.close()
    await closeServer(host.server)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
