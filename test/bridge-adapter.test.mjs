/**
 * BackendPort 适配器契约测试：
 * - 用官方 verifyBackendAdapterConformance 验证 createBackendAgentHost 能接受的最小契约；
 * - 用 mock 宿主桥验证事件映射（accepted/activity/message/permission/input/result/error/cancelled）、
 *   cancel、abort、错误路径。
 *
 * 运行：node --test test/bridge-adapter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyBackendAdapterConformance } from 'qwen-audio-agent/backend-adapter-sdk'
import { BridgeSessionBackend } from '../bridge/backend-adapter.mjs'
import { createMockBridge } from './helpers/mock-bridge.mjs'

function fixtureFactory() {
  return async ({ hold = false } = {}) => {
    const mock = await createMockBridge()
    const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
    const originalClose = backend.close.bind(backend)
    backend.close = async () => {
      try { await originalClose() } finally { await mock.close() }
    }
    const work = {
      id: `task-${Math.random().toString(16).slice(2)}`,
      ownerId: 'owner-conformance',
      instruction: hold ? 'MOCK_HOLD conformance' : 'conformance work',
    }
    const nextWork = {
      id: `task-${Math.random().toString(16).slice(2)}`,
      ownerId: 'owner-conformance',
      instruction: 'conformance work next',
    }
    return {
      backend,
      work,
      nextWork,
      ...(hold ? { started: mock.waitForHold(work.instruction) } : {}),
    }
  }
}

test('BackendPort 官方 conformance 全套通过', async () => {
  await verifyBackendAdapterConformance({ createFixture: fixtureFactory() })
})

test('成功任务：submit 返回 content/artifacts，事件带 taskId/ownerId', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    const events = []
    backend.subscribe(event => events.push(event))
    const outcome = await backend.submit({ id: 't-success', ownerId: 'owner-a', instruction: '普通任务' })
    assert.equal(outcome.content, 'MOCK_RESULT_OK')
    assert.deepEqual(outcome.artifacts, [])
    assert.ok(events.length >= 3)
    assert.ok(events.every(event => event.taskId === 't-success' && event.ownerId === 'owner-a'))
    assert.ok(events.some(event => event.type === 'backend.activity'))
    assert.equal(backend.status('t-success').state, 'not_found')
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('失败任务：submit 以宿主错误消息 reject（不静默）', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    await assert.rejects(
      backend.submit({ id: 't-error', ownerId: 'owner-a', instruction: 'MOCK_ERROR' }),
      (error) => {
        assert.match(error.message, /模拟失败/)
        assert.equal(error.code, 'MOCK_FAILED')
        return true
      },
    )
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('权限请求：backend.permission.requested 发出，respondAuthorization 后继续并完成', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    const events = []
    backend.subscribe(event => events.push(event))
    const pending = backend.submit({ id: 't-perm', ownerId: 'owner-a', instruction: 'MOCK_PERMISSION' })
    const permission = await waitFor(() => events.find(event => event.type === 'backend.permission.requested'))
    assert.ok(permission.permission.id)
    assert.ok(permission.permission.summary)
    await backend.respondAuthorization('t-perm', permission.permission.id, 'once')
    const outcome = await pending
    assert.equal(outcome.content, 'MOCK_PERMISSION_ALLOWED')
    assert.ok(events.some(event => event.type === 'backend.permission.resolved'))
    const request = mock.requests.find(item => item.type === 'permission')
    assert.equal(request.body.permissionId, permission.permission.id)
    assert.equal(request.body.decision, 'allow')
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('输入请求：backend.input.requested 发出，respondInput 后继续并完成', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    const events = []
    backend.subscribe(event => events.push(event))
    const pending = backend.submit({ id: 't-input', ownerId: 'owner-a', instruction: 'MOCK_INPUT' })
    const input = await waitFor(() => events.find(event => event.type === 'backend.input.requested'))
    assert.equal(input.input.prompt, '请回答 mock 问题')
    await backend.respondInput('t-input', input.input.id, { action: 'accept', text: '好的' })
    const outcome = await pending
    assert.equal(outcome.content, 'MOCK_INPUT_accept_好的')
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('cancel：宿主侧任务被取消，submit 以 WORK_CANCELLED reject，二次 cancel 返回 not_found', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    const pending = backend.submit({ id: 't-cancel', ownerId: 'owner-a', instruction: 'MOCK_HOLD 取消我' })
    pending.catch(() => {})
    const task = await waitFor(() => [...mock.tasks.values()].find(item => item.instruction === 'MOCK_HOLD 取消我'))
    assert.equal(backend.status('t-cancel', { ownerId: 'owner-a' }).state, 'working')
    const result = await backend.cancel('t-cancel', { ownerId: 'owner-a' })
    assert.deepEqual(result, { taskId: 't-cancel', state: 'cancelled' })
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'WORK_CANCELLED')
      return true
    })
    assert.equal((await backend.cancel('t-cancel', { ownerId: 'owner-a' })).state, 'not_found')
    assert.ok(mock.requests.some(item => item.type === 'cancel' && item.bridgeTaskId === task.bridgeTaskId))
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('abort signal：取消提交并向宿主发送 cancel', async () => {
  const mock = await createMockBridge()
  const backend = new BridgeSessionBackend({ bridgeUrl: mock.url, token: mock.token })
  try {
    const controller = new AbortController()
    const pending = backend.submit(
      { id: 't-abort', ownerId: 'owner-a', instruction: 'MOCK_HOLD abort' },
      { signal: controller.signal },
    )
    pending.catch(() => {})
    await waitFor(() => [...mock.tasks.values()].find(item => item.instruction === 'MOCK_HOLD abort'))
    controller.abort(new Error('用户打断'))
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'WORK_CANCELLED')
      return true
    })
    await waitFor(() => mock.requests.some(item => item.type === 'cancel'))
  } finally {
    await backend.close()
    await mock.close()
  }
})

test('宿主不可达：health 明确 unavailable，submit 给出可播报错误', async () => {
  const backend = new BridgeSessionBackend({
    bridgeUrl: 'http://127.0.0.1:9/',
    token: 'nope',
    requestTimeoutMs: 1_500,
  })
  try {
    const health = await backend.health()
    assert.equal(health.ok, false)
    assert.equal(health.code, 'BACKEND_UNAVAILABLE')
    await assert.rejects(
      backend.submit({ id: 't-down', ownerId: 'owner-a', instruction: '任意' }),
      /无法连接 DSH 会话桥/,
    )
  } finally {
    await backend.close()
  }
})

function waitFor(check, timeoutMs = 5_000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      let value
      try { value = check() } catch (error) { clearInterval(timer); reject(error); return }
      if (value) {
        clearInterval(timer)
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('waitFor timeout'))
      }
    }, intervalMs)
    timer.unref?.()
  })
}
