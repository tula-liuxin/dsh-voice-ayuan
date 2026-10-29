/**
 * BridgeSessionBackend — qwen-audio-agent 的 BackendPort 适配器（自定义后端）。
 *
 * 这个文件运行在「网关子进程」里（由 bridge/gateway-host.mjs 组合进 Gateway），
 * 把语音侧产生的 Task 通过本机回环 HTTP + SSE 交给插件宿主（lib/bridge.js），
 * 再由宿主把任务投递到用户当前正在聊的 DSH 会话里真正执行，并把进度/结果带回来。
 *
 * 设计要点：
 * - 不直接操作 DSH：BackendPort 是网关与后台之间唯一协议边界，DSH 只会出现在宿主进程里。
 * - 网关只监听 127.0.0.1，本适配器额外带 bearer token；token 由插件宿主生成并只经
 *   子进程环境变量传入，宿主同时把 {url, token} 以 0600 权限写在
 *   ~/.dsh/voice-ayuan-bridge.json 供本机验证脚本使用（不含任何模型可见内容）。
 * - 事件全部归一化为 backend.* 事件（backend.activity / backend.message /
 *   backend.permission.requested|resolved / backend.input.requested|resolved），
 *   不把 DSH 的 session id、turn、原始协议对象泄漏给 TaskManager 或前端模型。
 * - submit 的最终返回只有 { content, artifacts }；content 是唯一的"事实文本"，
 *   由 Gateway 的前台模型决定怎么用语音表达。
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const MAX_STREAM_RETRIES = 8
const STREAM_RETRY_BASE_MS = 500

function clean(value, max = 2_000) {
  return String(value == null ? '' : value).replaceAll('\u0000', ' ').trim().slice(0, max)
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseSseFrame(frame) {
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export class BridgeBackendError extends Error {
  constructor(message, { code = 'BRIDGE_BACKEND_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BridgeBackendError'
    this.code = code
  }
}

/**
 * 把宿主 activity 归一化到 Gateway 协议可接受的形状：GatewayActivitySchema 要求
 * updatedAt 是 ISO 字符串；这里兜住宿主将来可能发数字/缺失的情况，避免整条
 * task.* 响应在客户端校验时被丢弃（表现为 task.get 超时）。
 */
function normalizeActivity(activity) {
  if (!activity || typeof activity !== 'object') return null
  const normalized = { ...activity }
  if (normalized.updatedAt !== undefined && typeof normalized.updatedAt !== 'string') {
    const time = Number(normalized.updatedAt)
    normalized.updatedAt = Number.isFinite(time) ? new Date(time).toISOString() : undefined
    if (normalized.updatedAt === undefined) delete normalized.updatedAt
  }
  if (typeof normalized.kind !== 'string' || !normalized.kind.trim()) {
    normalized.kind = 'status'
  }
  return normalized
}

function cancellationError(taskId, cause) {
  return new BridgeBackendError(`任务 ${taskId} 已取消`, {
    code: 'WORK_CANCELLED',
    cause,
  })
}

/**
 * One BackendPort implementation. Conforms to qwen-audio-agent's
 * assertBackendPort contract and verifyBackendAdapterConformance.
 */
export class BridgeSessionBackend {
  constructor({
    bridgeUrl,
    token = '',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    label = '阿源（当前 DSH 会话）',
    log = () => {},
  } = {}) {
    if (!bridgeUrl) throw new TypeError('bridgeUrl is required')
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch API is required')
    this.bridgeUrl = String(bridgeUrl).replace(/\/+$/, '')
    this.token = clean(token, 4_000)
    this.requestTimeoutMs = Math.max(1_000, Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
    this.fetch = fetchImpl
    this.label = label
    this.log = log
    this.listeners = new Set()
    this.records = new Map()
    this.phase = 'stopped'
    this.closed = false
  }

  // ---------------------------------------------------------------- BackendPort

  describe() {
    return {
      enabled: true,
      configured: true,
      protocol: 'dsh-session',
      kind: 'dsh-session',
      label: this.label,
      status: this.closed ? 'stopped' : this.phase === 'ready' ? 'ready' : 'starting',
      capabilities: {
        // DSH 的 approval 服务可以接出来，因此声明支持权限中转。
        permissions: true,
        // ask_user_question 的提问也会被中转成 backend.input.requested。
        input: true,
        cancellation: true,
        activity: true,
        // 结果只交付文本；DSH 产物留在用户会话里，不伪造 artifacts。
        artifacts: false,
      },
    }
  }

  /** Idempotent. The gateway only probes health(); start() exists for conformance and embedders. */
  async start() {
    if (this.closed) return { ok: false, error: 'backend is closed' }
    this.phase = this.phase === 'ready' ? 'ready' : 'starting'
    const health = await this.health()
    this.phase = health.ok ? 'ready' : 'degraded'
    return { ok: true }
  }

  async health() {
    if (this.closed) return { ok: false, status: 'stopped', code: 'BACKEND_CLOSED' }
    try {
      const body = await this.#request('GET', '/health', undefined, {
        timeoutMs: Math.min(this.requestTimeoutMs, 8_000),
      })
      this.phase = 'ready'
      return {
        ok: true,
        status: 'ready',
        protocol: 'dsh-session',
        target: body?.target || null,
      }
    } catch (error) {
      this.phase = 'degraded'
      return {
        ok: false,
        status: 'unavailable',
        code: 'BACKEND_UNAVAILABLE',
        error: clean(error?.message || error, 300),
      }
    }
  }

  status(taskId, { ownerId } = {}) {
    if (!clean(taskId)) {
      return {
        ok: !this.closed,
        backend: 'dsh-session',
        protocol: 'dsh-session',
        phase: this.closed ? 'closed' : this.phase,
        activeTasks: this.records.size,
      }
    }
    const record = this.records.get(clean(taskId))
    if (!record || (clean(ownerId) && record.ownerId !== clean(ownerId))) {
      return { taskId: clean(taskId), state: 'not_found' }
    }
    return {
      taskId: record.taskId,
      state: record.cancelRequested ? 'cancelling' : 'working',
      startedAt: record.startedAt,
    }
  }

  async submit(work, context = {}) {
    const taskId = clean(work?.id, 200)
    const ownerId = clean(work?.ownerId, 200)
    const instruction = clean(work?.instruction || work?.objective, 20_000)
    if (!taskId || !ownerId || !instruction) {
      throw new BridgeBackendError('submit requires task id, owner and input', {
        code: 'INVALID_WORK',
      })
    }
    if (this.closed) {
      throw new BridgeBackendError('后台桥接已关闭', { code: 'BACKEND_CLOSED' })
    }
    if (this.records.has(taskId)) {
      throw new BridgeBackendError(`task ${taskId} is already active`, {
        code: 'TASK_ALREADY_ACTIVE',
      })
    }
    const signal = context?.signal
    const onEvent = typeof context?.onEvent === 'function' ? context.onEvent : null
    const record = {
      taskId,
      ownerId,
      instruction,
      bridgeTaskId: null,
      state: 'starting',
      startedAt: Date.now(),
      cancelRequested: false,
      settled: false,
      resolve: null,
      reject: null,
      abort: new AbortController(),
      onEvent,
      signal,
    }
    this.records.set(taskId, record)
    const publish = (event) => this.#publish(event, record)

    // The promise below owns the only resolvers; cancel()/abort() settle it
    // through record.reject so a pending submit never leaks.
    let resolveImpl
    let rejectImpl
    const outcome = new Promise((resolve, reject) => {
      resolveImpl = resolve
      rejectImpl = reject
    })
    // cancel()/abort() 可能在 submit 还停在 #consumeEvents 时就同步拒绝 outcome；
    // 先挂一个空处理器，避免 Node 把它当成 unhandled rejection（调用方仍会收到 reject）。
    outcome.catch(() => {})
    record.resolve = (value) => {
      if (record.settled) return
      record.settled = true
      this.records.delete(taskId)
      try { record.abort.abort() } catch {}
      resolveImpl(value)
    }
    record.reject = (error) => {
      if (record.settled) return
      record.settled = true
      this.records.delete(taskId)
      try { record.abort.abort() } catch {}
      rejectImpl(error)
    }

    const onAbort = () => {
      record.cancelRequested = true
      if (record.bridgeTaskId) {
        void this.#request('POST', `/tasks/${encodeURIComponent(record.bridgeTaskId)}/cancel`, {})
          .catch(() => {})
      }
      record.reject(cancellationError(taskId, signal?.reason))
    }
    if (signal) {
      if (signal.aborted) {
        record.reject(cancellationError(taskId, signal.reason))
        return outcome
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    publish({
      type: 'backend.activity',
      activity: {
        id: 'accepted',
        kind: 'status',
        status: 'running',
        label: '已收到任务',
        detail: `准备在阿源当前 DSH 会话里执行：${instruction.slice(0, 160)}`,
      },
    })

    try {
      const created = await this.#createTask(record)
      record.bridgeTaskId = clean(created?.bridgeTaskId, 200)
      if (!record.bridgeTaskId) throw new BridgeBackendError('后台桥接没有返回任务 id', {
        code: 'BRIDGE_PROTOCOL_ERROR',
      })
      record.state = 'running'
      if (record.cancelRequested) {
        // 提交任务的过程中已经收到取消：把宿主侧任务也取消掉，不再消费事件流。
        void this.#request('POST', `/tasks/${encodeURIComponent(record.bridgeTaskId)}/cancel`, {})
          .catch(() => {})
        return outcome
      }
      if (!record.settled) {
        // 任务从「已收到」进入「开始执行」。
        publish({
          type: 'backend.activity',
          activity: {
            id: 'running',
            kind: 'status',
            status: 'running',
            label: '正在阿源会话里执行',
            ...(created?.target?.label ? { detail: created.target.label } : {}),
          },
        })
      }
      await this.#consumeEvents(record)
      if (!record.settled) {
        throw new BridgeBackendError('任务事件流结束但没有收到结果', {
          code: 'EVENT_STREAM_INCOMPLETE',
        })
      }
    } catch (error) {
      if (!record.settled) {
        record.reject(error instanceof Error ? error : new BridgeBackendError(String(error)))
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    return outcome
  }

  async cancel(taskId, { ownerId } = {}) {
    const id = clean(taskId, 200)
    const record = this.records.get(id)
    // 终态/未知任务返回 not_found（与官方适配器一致），不属于错误。
    if (!record) return { taskId: id, state: 'not_found' }
    // 别人的任务不能被取消：这是权限边界，必须显式失败。
    if (clean(ownerId) && record.ownerId !== clean(ownerId)) {
      throw new BridgeBackendError('task not found', { code: 'TASK_NOT_FOUND' })
    }
    record.cancelRequested = true
    if (record.bridgeTaskId) {
      try {
        await this.#request('POST', `/tasks/${encodeURIComponent(record.bridgeTaskId)}/cancel`, {})
        // 兼容旧宿主：取消请求送达后可能还有一小段"正在取消"窗口。这里等宿主真正
        // 释放 activeTask 再让 submit 拒绝，避免用户取消后立刻派新任务撞上 BRIDGE_BUSY。
        await this.#waitHostTaskReleased(record.bridgeTaskId, 2_000)
      } catch (error) {
        // 宿主不可达也要让调用方拿到确定的取消结果；本地仍然终止这条提交。
        this.log('cancel request failed:', String(error && error.message || error))
      }
    }
    record.reject(cancellationError(id))
    this.records.delete(id)
    return { taskId: id, state: 'cancelled' }
  }

  async respondAuthorization(taskId, authorizationId, decision, { ownerId } = {}) {
    const record = this.#requireRecord(taskId, ownerId)
    const normalized = decision === 'reject' || decision === 'rejected' || decision === 'denied'
      ? 'reject'
      : 'allow'
    await this.#request(
      'POST',
      `/tasks/${encodeURIComponent(record.bridgeTaskId)}/permission`,
      { permissionId: clean(authorizationId, 200), decision: normalized },
    )
    return { acknowledged: true }
  }

  async respondInput(taskId, inputRequestId, response, { ownerId } = {}) {
    const record = this.#requireRecord(taskId, ownerId)
    await this.#request(
      'POST',
      `/tasks/${encodeURIComponent(record.bridgeTaskId)}/input`,
      {
        inputRequestId: clean(inputRequestId, 200),
        action: clean(response?.action, 20) || 'accept',
        text: clean(response?.text, 8_000),
        ...(response?.values && typeof response.values === 'object'
          ? { values: response.values }
          : {}),
      },
    )
    return { acknowledged: true }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  close() {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.phase = 'stopped'
    for (const record of [...this.records.values()]) {
      if (record.bridgeTaskId) {
        void this.#request('POST', `/tasks/${encodeURIComponent(record.bridgeTaskId)}/cancel`, {})
          .catch(() => {})
      }
      record.reject(new BridgeBackendError('后台桥接已关闭', { code: 'BACKEND_CLOSED' }))
    }
    this.records.clear()
    this.listeners.clear()
    return Promise.resolve()
  }

  // ------------------------------------------------------------------ internals

  #requireRecord(taskId, ownerId) {
    const record = this.records.get(clean(taskId, 200))
    if (!record || (clean(ownerId) && record.ownerId !== clean(ownerId))) {
      throw new BridgeBackendError('task not found', { code: 'TASK_NOT_FOUND' })
    }
    return record
  }

  #publish(event, record) {
    const published = {
      ...event,
      taskId: record.taskId,
      ownerId: record.ownerId,
    }
    try {
      record.onEvent?.(published)
    } catch {
      // 单次提交的观察者异常不得中断后端执行（BackendPort 契约）。
    }
    for (const listener of this.listeners) {
      try { listener(published) } catch { /* 订阅者互相隔离 */ }
    }
  }

  async #createTask(record) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#request('POST', '/tasks', {
          taskId: record.taskId,
          ownerId: record.ownerId,
          instruction: record.instruction,
        })
      } catch (error) {
        lastError = error
        // 只有连接类错误值得重试；业务拒绝（409/503）立即上抛。
        if (error?.code !== 'BACKEND_UNAVAILABLE' && error?.code !== 'BRIDGE_UNREACHABLE') break
        await delay(STREAM_RETRY_BASE_MS * (attempt + 1))
      }
    }
    throw lastError || new BridgeBackendError('无法把任务交给 DSH 会话', {
      code: 'BACKEND_UNAVAILABLE',
    })
  }

  async #consumeEvents(record) {
    let since = 0
    let failures = 0
    while (!record.settled) {
      let response
      try {
        const url = `${this.bridgeUrl}/tasks/${encodeURIComponent(record.bridgeTaskId)}/events?since=${since}`
        response = await this.fetch(url, {
          method: 'GET',
          headers: this.#headers({ accept: 'text/event-stream' }),
          signal: record.abort.signal,
        })
        if (!response.ok || !response.body) {
          throw new BridgeBackendError(`任务事件流不可用（HTTP ${response.status}）`, {
            code: 'EVENT_STREAM_UNAVAILABLE',
          })
        }
        failures = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!record.settled) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const event = parseSseFrame(frame)
            if (!event || !Number.isInteger(event.seq) || event.seq <= since) continue
            since = event.seq
            this.#handleBridgeEvent(record, event)
            if (record.settled) {
              try { await reader.cancel() } catch {}
              return
            }
          }
        }
        if (record.settled) return
        throw new BridgeBackendError('任务事件流提前结束', { code: 'EVENT_STREAM_INCOMPLETE' })
      } catch (error) {
        if (record.settled) return
        if (record.abort.signal.aborted) {
          record.reject(cancellationError(record.taskId, record.abort.signal.reason))
          return
        }
        failures += 1
        if (failures > MAX_STREAM_RETRIES) {
          record.reject(new BridgeBackendError(
            `与 DSH 会话桥的事件流中断（已重试 ${MAX_STREAM_RETRIES} 次）`,
            { code: 'EVENT_STREAM_LOST', cause: error },
          ))
          return
        }
        await delay(STREAM_RETRY_BASE_MS * failures, record.abort.signal).catch(() => {})
      }
    }
  }

  #handleBridgeEvent(record, event) {
    switch (event.type) {
      case 'accepted':
        return
      case 'activity': {
        const activity = normalizeActivity(event.activity)
        if (activity) {
          this.#publish({ type: 'backend.activity', activity }, record)
        }
        return
      }
      case 'message':
        if (event.message) {
          this.#publish({ type: 'backend.message', message: event.message }, record)
        }
        return
      case 'permission.requested':
        if (event.permission) {
          this.#publish({ type: 'backend.permission.requested', permission: event.permission }, record)
        }
        return
      case 'permission.resolved':
        if (event.permission) {
          this.#publish({ type: 'backend.permission.resolved', permission: event.permission }, record)
        }
        return
      case 'input.requested':
        if (event.input) {
          this.#publish({ type: 'backend.input.requested', input: event.input }, record)
        }
        return
      case 'input.resolved':
        if (event.input) {
          this.#publish({ type: 'backend.input.resolved', input: event.input }, record)
        }
        return
      case 'result': {
        const content = clean(event.result?.content, 20_000)
        this.#publish({
          type: 'backend.activity',
          activity: { id: 'completed', kind: 'status', status: 'completed', label: '任务完成' },
        }, record)
        record.resolve({
          content: content || '任务已完成，但当前会话没有返回可播报的文本。',
          artifacts: [],
        })
        return
      }
      case 'cancelled': {
        this.#publish({
          type: 'backend.activity',
          activity: { id: 'cancelled', kind: 'status', status: 'cancelled', label: '任务已取消' },
        }, record)
        record.reject(new BridgeBackendError(
          clean(event.reason?.message, 500) || '任务已取消',
          { code: 'WORK_CANCELLED' },
        ))
        return
      }
      case 'error': {
        const message = clean(event.error?.message, 1_000) || '任务在执行中失败'
        this.#publish({
          type: 'backend.activity',
          activity: {
            id: 'failed',
            kind: 'status',
            status: 'failed',
            label: '任务失败',
            detail: message,
          },
        }, record)
        record.reject(new BridgeBackendError(message, {
          code: clean(event.error?.code, 80) || 'BACKEND_TASK_FAILED',
        }))
        return
      }
      default:
        this.log('unknown bridge event', event.type)
    }
  }

  async #waitHostTaskReleased(bridgeTaskId, timeoutMs) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        const status = await this.#request('GET', '/status', undefined, { timeoutMs: 2_000 })
        if (status?.activeTask?.bridgeTaskId !== bridgeTaskId) return
      } catch {
        return
      }
      await delay(75)
    }
  }

  #headers(extra = {}) {
    return {
      ...extra,
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    }
  }

  async #request(method, path, body, { timeoutMs = this.requestTimeoutMs } = {}) {
    const url = `${this.bridgeUrl}${path}`
    const controller = AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || this.requestTimeoutMs))
    let response
    try {
      response = await this.fetch(url, {
        method,
        headers: this.#headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller,
      })
    } catch (error) {
      const code = error?.name === 'TimeoutError' ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNREACHABLE'
      throw new BridgeBackendError(
        `无法连接 DSH 会话桥（${clean(error?.message || error, 200)}）`,
        { code, cause: error },
      )
    }
    let payload = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok) {
      const code = clean(payload?.error?.code, 80) || 'BACKEND_UNAVAILABLE'
      const message = clean(payload?.error?.message, 1_000)
        || `DSH 会话桥返回 HTTP ${response.status}`
      throw new BridgeBackendError(message, { code })
    }
    return payload
  }
}

/** Composition helper used by bridge/gateway-host.mjs and by tests. */
export function createBridgeSessionBackend(options = {}) {
  return new BridgeSessionBackend(options)
}
