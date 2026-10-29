/**
 * 测试用 mock：模拟插件宿主的 lib/bridge.js HTTP+SSE 协议。
 * 只用于测试 BackendPort 适配器/gateway 组合，不代表真实实现。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function writeEvent(task, payload) {
  task.seq += 1
  const event = { seq: task.seq, time: Date.now(), ...payload }
  task.events.push(event)
  for (const res of task.subscribers) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }
  return event
}

function finish(task, payload) {
  task.terminal = true
  writeEvent(task, payload)
  for (const res of task.subscribers) {
    try { res.end() } catch {}
  }
  task.subscribers.clear()
}

/**
 * @param {{ behaviors?: Record<string, string> }} [options]
 */
export async function createMockBridge(options = {}) {
  const token = 'mock-token-' + randomUUID()
  const tasks = new Map()
  const requests = []
  const behaviors = new Map(Object.entries(options.behaviors || {}))
  const held = new Map()

  function behaviorFor(instruction) {
    if (behaviors.has(instruction)) return behaviors.get(instruction)
    if (instruction.includes('MOCK_HOLD')) return 'hold'
    if (instruction.includes('MOCK_ERROR')) return 'error'
    if (instruction.includes('MOCK_PERMISSION')) return 'permission'
    if (instruction.includes('MOCK_INPUT')) return 'input'
    return 'success'
  }

  function startTask(task) {
    task.startedAt = Date.now()
    writeEvent(task, { type: 'accepted', target: { sessionId: 'mock-session', label: 'mock 会话' } })
    writeEvent(task, {
      type: 'activity',
      activity: { id: 'running', kind: 'status', status: 'running', label: '模拟执行中' },
    })
    if (task.mode === 'hold') {
      const waiter = held.get(task.instruction)
      if (waiter) { waiter.resolve(task); held.delete(task.instruction) }
      return
    }
    if (task.mode === 'error') {
      setTimeout(() => finish(task, { type: 'error', error: { code: 'MOCK_FAILED', message: '模拟失败' } }), 10)
      return
    }
    if (task.mode === 'permission') {
      setTimeout(() => {
        writeEvent(task, {
          type: 'permission.requested',
          permission: { id: 'perm-1', taskId: task.bridgeTaskId, status: 'pending', category: 'tool', summary: '模拟权限请求', approvalScope: 'session' },
        })
      }, 10)
      return
    }
    if (task.mode === 'input') {
      setTimeout(() => {
        writeEvent(task, {
          type: 'input.requested',
          input: { id: 'input-1', taskId: task.bridgeTaskId, status: 'pending', kind: 'input', mode: 'text', prompt: '请回答 mock 问题' },
        })
      }, 10)
      return
    }
    setTimeout(() => {
      finish(task, { type: 'result', result: { content: 'MOCK_RESULT_OK', artifacts: [] } })
    }, 15)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${token}`) {
      json(res, 401, { error: { code: 'UNAUTHORIZED' } })
      return
    }
    const method = String(req.method || 'GET').toUpperCase()
    const path = url.pathname
    if (path === '/health' && method === 'GET') {
      requests.push({ type: 'health' })
      json(res, 200, { ok: true, phase: 'ready', target: { sessionId: 'mock-session', label: 'mock 会话' } })
      return
    }
    if (path === '/status' && method === 'GET') {
      json(res, 200, { ok: true, tasks: [...tasks.values()].map(task => ({ id: task.bridgeTaskId, state: task.terminal ? 'terminal' : 'open' })) })
      return
    }
    if (path === '/tasks' && method === 'POST') {
      const body = await readBody(req)
      requests.push({ type: 'create', body })
      const task = {
        bridgeTaskId: 'btask_mock_' + randomUUID(),
        gatewayTaskId: body?.taskId,
        ownerId: body?.ownerId,
        instruction: String(body?.instruction || ''),
        mode: behaviorFor(String(body?.instruction || '')),
        seq: 0,
        events: [],
        subscribers: new Set(),
        terminal: false,
      }
      tasks.set(task.bridgeTaskId, task)
      startTask(task)
      json(res, 202, { bridgeTaskId: task.bridgeTaskId, acceptedAt: Date.now(), target: { sessionId: 'mock-session', label: 'mock 会话' } })
      return
    }
    let match = path.match(/^\/tasks\/([^/]+)\/events$/)
    if (match && method === 'GET') {
      const task = tasks.get(match[1])
      if (!task) { json(res, 404, { error: { code: 'TASK_NOT_FOUND' } }); return }
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.flushHeaders?.()
      res.write('retry: 300\n\n')
      for (const event of task.events) {
        if (event.seq > since) res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (task.terminal) { res.end(); return }
      task.subscribers.add(res)
      req.on('close', () => task.subscribers.delete(res))
      return
    }
    match = path.match(/^\/tasks\/([^/]+)\/cancel$/)
    if (match && method === 'POST') {
      const task = tasks.get(match[1])
      requests.push({ type: 'cancel', bridgeTaskId: match[1] })
      if (!task) { json(res, 404, { error: { code: 'TASK_NOT_FOUND' } }); return }
      if (!task.terminal) finish(task, { type: 'cancelled', reason: { message: 'mock cancelled' } })
      json(res, 200, { ok: true, state: 'cancelled' })
      return
    }
    match = path.match(/^\/tasks\/([^/]+)\/permission$/)
    if (match && method === 'POST') {
      const body = await readBody(req)
      requests.push({ type: 'permission', bridgeTaskId: match[1], body })
      const task = tasks.get(match[1])
      if (!task) { json(res, 404, { error: { code: 'TASK_NOT_FOUND' } }); return }
      writeEvent(task, { type: 'permission.resolved', permission: { id: body?.permissionId, status: body?.decision === 'reject' ? 'denied' : 'approved' } })
      if (body?.decision === 'reject') {
        finish(task, { type: 'result', result: { content: 'MOCK_PERMISSION_REJECTED' } })
      } else {
        finish(task, { type: 'result', result: { content: 'MOCK_PERMISSION_ALLOWED' } })
      }
      json(res, 200, { ok: true })
      return
    }
    match = path.match(/^\/tasks\/([^/]+)\/input$/)
    if (match && method === 'POST') {
      const body = await readBody(req)
      requests.push({ type: 'input', bridgeTaskId: match[1], body })
      const task = tasks.get(match[1])
      if (!task) { json(res, 404, { error: { code: 'TASK_NOT_FOUND' } }); return }
      writeEvent(task, { type: 'input.resolved', input: { id: body?.inputRequestId, status: body?.action === 'accept' ? 'accepted' : 'cancelled' } })
      finish(task, { type: 'result', result: { content: `MOCK_INPUT_${body?.action || ''}_${body?.text || ''}` } })
      json(res, 200, { ok: true })
      return
    }
    json(res, 404, { error: { code: 'NOT_FOUND' } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    tasks,
    requests,
    /** 等待某条 MOCK_HOLD 指令的提交真正到达宿主（对应 conformance 的 started 语义）。 */
    waitForHold(instruction) {
      const existing = [...tasks.values()].find(task => task.instruction === instruction)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('mock bridge hold timeout')), 5_000)
        timer.unref?.()
        held.set(instruction, { resolve: (task) => { clearTimeout(timer); resolve(task) } })
      })
    },
    release(bridgeTaskId, content = 'MOCK_HOLD_DONE') {
      const task = tasks.get(bridgeTaskId)
      if (task && !task.terminal) finish(task, { type: 'result', result: { content } })
    },
    close() {
      for (const task of tasks.values()) {
        for (const res of task.subscribers) { try { res.end() } catch {} }
        task.subscribers.clear()
      }
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
    },
  }
}
