/**
 * lib/bridge.js — 宿主侧「语音任务 → 当前 DSH 会话」桥。
 *
 * 职责边界：
 * - 网关子进程里的 BackendPort 适配器（bridge/backend-adapter.mjs）只通过本机回环
 *   HTTP + SSE 访问这里；它不认识 DSH，也不持有任何会话对象。
 * - 本模块在 DSH 宿主进程内运行，用 DSH 的公开服务把一句语音任务指令作为一条
 *   user 消息投递进「用户当前正在聊的 live root 会话」，订阅这一轮的
 *   turn/assistant/tool 事件，把进度转成 SSE 事件；turn 结束时取这一轮最后的
 *   assistant 文本（截断 <= 600 字）作为任务结果交回适配器。
 * - 权限请求（ctx.approval 的 approval/request waterfall）与阿源的提问
 *   （user-questions/request waterfall）会被拦截并转成语音侧的 permission/input
 *   事件，用户用语音确认后再回到 DSH；除此之外任何请求都 next() 交还 GUI。
 *
 * 目标会话（按优先级）：
 * - bridge.sessionId：只用它（不在 live 就按 id 恢复）；
 * - bridge.cwdPrefix：只用该工作区里的 live 会话；没有就自动新建（或恢复上次新建的）
 *   一个「专用语音会话」，从不落回用户正在长聊的主会话；
 * - 都没配：退回「最近活跃的 live 会话」，一个都没有时显式失败。
 *
 * 明确不做的事：
 * - 不在用户没要求时往「别的」会话里投任务（工作区优先时宁可新建专用会话，也不串台）；
 * - 不做本地 echo / 假结果；结果文本只来自这一轮真实的 assistant/message；
 * - 不改用户会话的 model/权限策略，不伪造 permission 决定。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diag } from './diag.js'

export const BRIDGE_VERSION = 1

const ROUTE_PREFIX = '/voice-ayuan/bridge'
const MAX_INSTRUCTION_CHARS = 8_000
const MAX_RESULT_CHARS = 600
const TASK_TERMINAL_TTL_MS = 60_000
const PERMISSION_TIMEOUT_MS = 120_000
const INPUT_TIMEOUT_MS = 180_000
const TASK_HARD_TIMEOUT_MS = 45 * 60_000
const DEFAULT_SESSION_TITLE = '语音通话'
const HEARTBEAT_MS = 15_000
const MAX_EVENT_BUFFER = 600
const ACTIVITY_STREAM_THROTTLE_MS = 1_200

function clean(value, max = 2_000) {
  return String(value == null ? '' : value).replaceAll('\u0000', ' ').trim().slice(0, max)
}

/** 按 Unicode 码点截断（中文按字算），保留完整字符。 */
function truncateChars(value, max) {
  const chars = [...String(value || '')]
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

function bridgeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isTerminal(state) {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

function jsonResponse(res, status, payload) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {}
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
}

function toolLabel(name) {
  const labels = {
    pwsh: '执行 PowerShell 命令',
    bash: '执行命令',
    read: '读取文件',
    write: '写入文件',
    edit: '修改文件',
    glob: '查找文件',
    grep: '搜索内容',
    web_search: '搜索网页',
    web_fetch: '抓取网页',
    todo_write: '更新待办',
    skill: '加载技能',
    present: '生成交付物',
    ask_user_question: '向你提问',
    job_output: '查看后台任务',
    job_list: '查看后台任务',
    job_kill: '停止后台任务',
    run_code: '执行代码',
  }
  const key = clean(name, 80)
  return labels[key] || `使用工具 ${key || '未知工具'}`
}

function describeArgs(raw) {
  const text = clean(raw, 400)
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'keyword', 'text', 'description']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) {
          return truncateChars(parsed[key], 160)
        }
      }
    }
  } catch {}
  return truncateChars(text, 160)
}

/**
 * @param {object} options
 * @param {object} options.ctx            DSH 插件上下文（需 inject: webServer、agents）
 * @param {object} options.webServer      ctx.webServer
 * @param {object} [options.config]       profile 里的 config.bridge
 * @param {Function} [options.log]
 */
export function createVoiceBridge({ ctx, webServer, config = {}, log = () => {} } = {}) {
  if (!ctx) throw new TypeError('createVoiceBridge requires ctx')
  if (!webServer) throw new TypeError('createVoiceBridge requires webServer')

  const token = crypto.randomBytes(32).toString('hex')
  const tasks = new Map() // bridgeTaskId -> task（含终态，短 TTL 保留给事件流回放）
  const activity = new Map() // sessionId -> { lastEventAt, lastUserAt }
  const disposers = []
  const tokenFile = config.tokenFile
    ? path.resolve(String(config.tokenFile))
    : path.join(os.homedir(), '.dsh', 'voice-ayuan-bridge.json')
  // 阿源工作区没有 live 会话时，用来「新建/复用同一张专用语音会话」的状态。
  const sessionStateFile = config.sessionStateFile
    ? path.resolve(String(config.sessionStateFile))
    : path.join(os.homedir(), '.dsh', 'voice-ayuan-session.json')
  const sessionTitle = clean(config.sessionTitle, 60) || DEFAULT_SESSION_TITLE
  const autoCreateSession = config.autoCreateSession !== false
  let rememberedSession = null
  let lastResolution = { mode: 'none', at: 0 }
  let starting = false
  let activeTask = null
  let closed = false
  let heartbeatTimer = null
  let tokenFileWritten = null

  // ------------------------------------------------------------ 事件订阅

  function onSessionEvent(session, event) {
    try {
      if (!session || !event) return
      const sessionId = String(session.id)
      const record = activity.get(sessionId) || { lastEventAt: 0, lastUserAt: 0 }
      const time = Number(event.time) || Date.now()
      if (time > record.lastEventAt) record.lastEventAt = time
      if (event.type === 'user/message' && time > record.lastUserAt) record.lastUserAt = time
      activity.set(sessionId, record)
      const task = activeTask
      if (!task || task.sessionId !== sessionId || isTerminal(task.state)) return
      handleTaskSessionEvent(task, event)
    } catch (error) {
      log('bridge session event handler failed:', String(error && error.message || error))
    }
  }

  function onInboxClaimed(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const agent = payload?.agent
      const message = payload?.message
      if (!agent || String(agent.id) !== task.sessionId) return
      if (!message || message.id !== task.messageId) return
      task.turn = Number(payload.turn) || null
      task.state = 'running'
      task.updatedAt = Date.now()
      pushEvent(task, {
        type: 'activity',
        activity: {
          id: 'turn-started',
          kind: 'status',
          status: 'running',
          label: '正在当前会话里执行',
          detail: `第 ${task.turn} 轮`,
        },
      })
    } catch (error) {
      log('bridge inbox handler failed:', String(error && error.message || error))
    }
  }

  function onInboxDiscarded(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const message = payload?.message
      if (!message || message.id !== task.messageId) return
      finalizeCancelled(task, '任务指令在开始执行前被移出队列，已取消。')
    } catch (error) {
      log('bridge inbox discard handler failed:', String(error && error.message || error))
    }
  }

  function onAssistantStream(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const agent = payload?.agent
      const frame = payload?.frame
      if (!agent || String(agent.id) !== task.sessionId || !frame) return
      if (frame.type !== 'chunk') return
      if (task.turn === null || frame.turn !== task.turn) return
      if (frame.chunk?.type !== 'text-delta' || !frame.chunk.text) return
      task.streamingText = truncateChars((task.streamingText || '') + frame.chunk.text, 2_000)
      const now = Date.now()
      if (now - (task.lastStreamActivityAt || 0) < ACTIVITY_STREAM_THROTTLE_MS) return
      task.lastStreamActivityAt = now
      const latest = clean(task.streamingText, 200)
      pushEvent(task, {
        type: 'activity',
        activity: {
          id: 'assistant',
          kind: 'thinking',
          status: 'running',
          label: '正在组织回答',
          ...(latest ? { detail: latest } : {}),
        },
      })
    } catch (error) {
      log('bridge assistant stream handler failed:', String(error && error.message || error))
    }
  }

  function onAgentError(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const agent = payload?.agent
      if (!agent || String(agent.id) !== task.sessionId) return
      // 只认「我们这一轮」的错误；用户自己那一轮的失败不能把语音任务判失败。
      if (task.turn === null) return
      const turn = Number(payload?.turn)
      if (Number.isInteger(turn) && turn !== task.turn) return
      const detail = describeAgentError(payload.error)
      failTask(task, { code: 'AGENT_TURN_FAILED', message: `阿源执行时出错：${detail}` })
    } catch (error) {
      log('bridge agent error handler failed:', String(error && error.message || error))
    }
  }

  function onAgentStatus(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const agent = payload?.agent
      if (!agent || String(agent.id) !== task.sessionId) return
      if (payload.status !== 'idle') return
      if (task.turn === null) return
      // turn/end 是权威收尾；这里是兜底，防止某些取消路径漏发 turn/end。
      task.idleAt = Date.now()
      const timer = setTimeout(() => {
        if (closed || isTerminal(task.state)) return
        if (activeTask !== task) return
        finishFromTurn(task, 'turn-end-missing')
      }, 2_000)
      timer.unref?.()
      task.guardTimers.push(timer)
    } catch (error) {
      log('bridge agent status handler failed:', String(error && error.message || error))
    }
  }

  function onAgentDisposed(payload) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return
      const agent = payload?.agent
      if (!agent || String(agent.id) !== task.sessionId) return
      failTask(task, { code: 'SESSION_CLOSED', message: '阿源当前会话被关闭了，这项任务没有完成。' })
    } catch {}
  }

  function onApprovalRequest(req, next) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return next()
      if (task.turn === null || task.state !== 'running') return next()
      const agent = req?.agent
      if (!agent || String(agent.id) !== task.sessionId) return next()
      // 同一时刻只中转一个权限请求；其余交还 GUI，绝不替用户并发决定。
      if (task.pendingPermission) return next()
      return relayPermission(task, req)
    } catch (error) {
      log('bridge approval relay failed:', String(error && error.message || error))
      return next()
    }
  }

  function onUserQuestionRequest(request, next) {
    try {
      const task = activeTask
      if (!task || isTerminal(task.state)) return next()
      if (task.turn === null || task.state !== 'running') return next()
      const agent = request?.agent
      if (!agent || String(agent.id) !== task.sessionId) return next()
      if (task.pendingInput) return next()
      return relayUserQuestion(task, request, next)
    } catch (error) {
      log('bridge user question relay failed:', String(error && error.message || error))
      return next()
    }
  }

  // 注册全局监听：用 ctx.on 返回的 disposer 统一收尾。
  function listen(ctxEvent, handler) {
    try {
      const dispose = ctx.on(ctxEvent, handler, { prepend: ctxEvent === 'approval/request' || ctxEvent === 'user-questions/request' })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`subscribe ${ctxEvent} failed:`, String(error && error.message || error))
    }
  }
  listen('session/event', onSessionEvent)
  listen('agent/inbox/claimed', onInboxClaimed)
  listen('agent/inbox/discarded', onInboxDiscarded)
  listen('agent/assistant-stream', onAssistantStream)
  listen('agent/error', onAgentError)
  listen('agent/status', onAgentStatus)
  listen('agent/disposed', onAgentDisposed)
  listen('approval/request', onApprovalRequest)
  listen('user-questions/request', onUserQuestionRequest)

  // ------------------------------------------------------------ 目标会话

  function liveRoots() {
    let roots = []
    try { roots = ctx.agents.roots() } catch (error) {
      log('agents.roots() failed:', String(error && error.message || error))
      throw bridgeError('AGENT_SERVICE_UNAVAILABLE', '宿主 Agent 服务不可用，无法定位当前会话。')
    }
    return roots.filter((agent) => {
      // SessionHeader 字段在 header 顶层（cwd/origin/delegationDepth），不在 meta 下。
      const header = agent?.session?.header
      if (!header) return true
      if (header.origin === 'subagent') return false
      if (Number(header.delegationDepth) > 0) return false
      return true
    })
  }

  function sessionLastEventTime(session) {
    try {
      const seq = Number(session?.seq) || 0
      if (seq <= 0) return 0
      // Session.eventAt 是 DSH 已标记 deprecated 的日志读取器（新核心代码禁用），
      // 但插件侧没有等价的「末事件时间」公开读取面；只用于跨会话排序兜底。
      const event = session.eventAt(seq - 1)
      return Number(event?.time) || 0
    } catch {
      return 0
    }
  }

  function targetInfo(agent) {
    const header = agent?.session?.header || {}
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    const shortId = String(agent.id).slice(0, 8)
    return {
      sessionId: String(agent.id),
      cwd: cwd || null,
      label: cwd ? `${path.basename(cwd) || cwd}（会话 ${shortId}）` : `会话 ${shortId}`,
    }
  }

  function normalizeCwd(value) {
    return String(value || '').replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase()
  }

  function preferredCwdRaw() {
    return clean(config.cwdPrefix, 300) || clean(config.preferCwd, 300)
  }

  /** cwd 前缀匹配：同一目录或它下面的子目录。 */
  function matchesCwd(agent, wantedCwd) {
    if (!wantedCwd) return false
    const cwd = normalizeCwd(agent && agent.session && agent.session.header && agent.session.header.cwd)
    return Boolean(cwd) && (cwd === wantedCwd || cwd.startsWith(wantedCwd + '\\'))
  }

  function bestAgent(candidates) {
    let best = null
    candidates.forEach((agent, index) => {
      const record = activity.get(String(agent.id)) || {}
      const baseline = sessionLastEventTime(agent.session)
      const score = [
        Number(record.lastUserAt) || 0,
        Number(record.lastEventAt) || baseline,
        baseline,
        index,
      ]
      if (!best) {
        best = { agent, score }
        return
      }
      for (let i = 0; i < score.length; i += 1) {
        const diff = score[i] - best.score[i]
        if (diff > 0) { best = { agent, score }; break }
        if (diff < 0) break
      }
    })
    return best ? best.agent : null
  }

  /** 宿主的会话业务服务（sessionController：create / resolveAgent / rename）；极简宿主可能没有。 */
  function hostSessions() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    } catch {
      return undefined
    }
  }

  /** 只有没有 sessionController 的极简宿主才需要：直接建会话时带上默认模型。 */
  function defaultAgentOptions() {
    try {
      const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined
      return selection && selection.provider && selection.model
        ? { provider: selection.provider, model: selection.model }
        : undefined
    } catch {
      return undefined
    }
  }

  function readSessionState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionStateFile, 'utf8'))
      const sessionId = clean(parsed && parsed.sessionId, 200)
      if (!sessionId) return null
      return { sessionId, cwd: clean(parsed && parsed.cwd, 400), updatedAt: Number(parsed && parsed.updatedAt) || 0 }
    } catch {
      return null
    }
  }

  function writeSessionState(record) {
    rememberedSession = record
    try {
      fs.mkdirSync(path.dirname(sessionStateFile), { recursive: true })
      fs.writeFileSync(
        sessionStateFile,
        JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2),
        { mode: 0o600 },
      )
    } catch (error) {
      log('write voice session state failed:', String(error && error.message || error))
    }
  }

  async function resumeById(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const controller = hostSessions()
    if (controller && typeof controller.resolveAgent === 'function') {
      return await controller.resolveAgent(sessionId)
    }
    return null
  }

  /**
   * 阿源工作区里没有 live 会话时，确保有一张「专用语音会话」：
   * 1) 上次建的那张还 live → 直接复用；2) 还持久化着 → 恢复它；
   * 3) 都没有 → 通过宿主的会话服务在工作区里新建一张，并命名成「语音通话」。
   */
  async function ensureWorkspaceSession(cwdRaw, wantedCwd) {
    const remembered = rememberedSession || readSessionState()
    if (remembered) {
      rememberedSession = remembered
      const live = ctx.agents.get(remembered.sessionId)
      if (live && matchesCwd(live, wantedCwd)) {
        return { agent: live, mode: 'remembered-live', created: false }
      }
      if (matchesCwd({ session: { header: { cwd: remembered.cwd } } }, wantedCwd)) {
        try {
          const agent = await resumeById(remembered.sessionId)
          if (agent && matchesCwd(agent, wantedCwd)) {
            return { agent, mode: 'remembered-resumed', created: false }
          }
        } catch (error) {
          log('resume remembered voice session failed:', String(error && error.message || error))
        }
      }
    }

    const controller = hostSessions()
    let sessionId = ''
    if (controller && typeof controller.create === 'function') {
      try {
        const created = await controller.create({ cwd: cwdRaw })
        sessionId = clean(created && created.sessionId, 200)
      } catch (error) {
        throw bridgeError('SESSION_CREATE_FAILED', `自动新建阿源工作区会话失败：${String(error && error.message || error)}`)
      }
    } else if (typeof ctx.agents.create === 'function') {
      sessionId = `session-${crypto.randomUUID()}`
      const agentOptions = defaultAgentOptions()
      try {
        await ctx.agents.create({
          sessionId,
          meta: { cwd: cwdRaw },
          ...(agentOptions ? { agentOptions } : {}),
        })
      } catch (error) {
        throw bridgeError('SESSION_CREATE_FAILED', `自动新建阿源工作区会话失败：${String(error && error.message || error)}`)
      }
    } else {
      throw bridgeError(
        'SESSION_CREATE_UNAVAILABLE',
        '阿源工作区里没有打开的会话，当前宿主也不支持自动新建会话；请先在阿源工作区打开一个会话。',
      )
    }

    const agent = sessionId ? ctx.agents.get(sessionId) : undefined
    if (!agent) {
      throw bridgeError('SESSION_CREATE_FAILED', '自动新建阿源工作区会话失败：宿主没有返回可用的会话。')
    }
    if (controller && typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId, title: sessionTitle })
      } catch (error) {
        log('rename voice session failed:', String(error && error.message || error))
      }
    }
    writeSessionState({ sessionId, cwd: agent.session?.header?.cwd || cwdRaw })
    return { agent, mode: 'created', created: true }
  }

  /**
   * 解析这条语音任务要投给哪个 live agent。
   * @param {{ create?: boolean }} [options] create=false 只做探测、绝不新建会话（健康检查用）。
   * @returns {Promise<object|null>} live agent；create=false 且需要新建时返回 null。
   */
  async function resolveTarget({ create = true } = {}) {
    const override = clean(config.sessionId, 200)
    if (override) {
      let agent
      try {
        agent = await resumeById(override)
      } catch (error) {
        log('resume configured session failed:', String(error && error.message || error))
        agent = undefined
      }
      if (!agent) {
        throw bridgeError('SESSION_UNAVAILABLE', `配置指定的会话（${override.slice(0, 8)}…）当前不是活动会话；请先在 DSH 里打开它再重试。`)
      }
      lastResolution = { mode: 'override', sessionId: String(agent.id), at: Date.now() }
      return agent
    }

    const roots = liveRoots()
    const cwdRaw = preferredCwdRaw()
    const wantedCwd = normalizeCwd(cwdRaw)

    if (cwdRaw) {
      const preferred = roots.filter(agent => matchesCwd(agent, wantedCwd))
      if (preferred.length) {
        const agent = bestAgent(preferred)
        lastResolution = { mode: 'workspace-live', sessionId: String(agent.id), at: Date.now() }
        return agent
      }
      if (!autoCreateSession) {
        if (!roots.length) {
          throw bridgeError('NO_LIVE_SESSION', '当前没有正在使用的 DSH 会话；请先在 DSH 里打开一个会话再让我执行。')
        }
        const agent = bestAgent(roots)
        lastResolution = { mode: 'fallback-auto-create-off', sessionId: String(agent.id), at: Date.now() }
        return agent
      }
      if (!create) {
        lastResolution = { mode: 'would-create', cwd: cwdRaw, at: Date.now() }
        return null
      }
      const ensured = await ensureWorkspaceSession(cwdRaw, wantedCwd)
      lastResolution = {
        mode: ensured.mode,
        sessionId: String(ensured.agent.id),
        created: ensured.created,
        at: Date.now(),
      }
      return ensured.agent
    }

    if (!roots.length) {
      throw bridgeError('NO_LIVE_SESSION', '当前没有正在使用的 DSH 会话；请先在 DSH 里打开一个会话再让我执行。')
    }
    const agent = bestAgent(roots)
    lastResolution = { mode: 'most-recent', sessionId: String(agent.id), at: Date.now() }
    return agent
  }

  // ------------------------------------------------------------ 任务对象

  function pushEvent(task, payload) {
    if (!task || closed) return null
    const event = { seq: task.seq + 1, time: Date.now(), ...payload }
    task.seq = event.seq
    task.updatedAt = event.time
    task.events.push(event)
    if (task.events.length > MAX_EVENT_BUFFER) {
      task.events.splice(0, task.events.length - MAX_EVENT_BUFFER)
    }
    for (const subscriber of task.subscribers) {
      writeSseEvent(subscriber, event)
    }
    if (payload.type === 'result' || payload.type === 'error' || payload.type === 'cancelled') {
      diag({
        kind: 'bridge-task-terminal',
        task: task.bridgeTaskId,
        gatewayTask: task.gatewayTaskId,
        session: task.sessionId,
        state: payload.type,
        turn: task.turn,
        elapsedMs: Date.now() - task.createdAt,
        preview: truncateChars(payload.result?.content || payload.error?.message || payload.reason?.message || '', 160),
      })
    }
    return event
  }

  function pushActivity(task, activity) {
    // 注意：Gateway 的 GatewayActivitySchema 要求 updatedAt 是 ISO 字符串；
    // 用数字会让前台客户端解析该任务时整条响应校验失败（表现为 task.get 超时）。
    return pushEvent(task, {
      type: 'activity',
      activity: { updatedAt: new Date().toISOString(), ...activity },
    })
  }

  function writeSseEvent(response, event) {
    try {
      if (response.writableEnded || response.destroyed) return
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      // 客户端掉线由 close 事件清理，不打断执行。
    }
  }

  function createTask({ gatewayTaskId, ownerId, instruction, agent }) {
    const task = {
      bridgeTaskId: 'btask_' + crypto.randomUUID(),
      gatewayTaskId,
      ownerId,
      instruction,
      agent,
      sessionId: String(agent.id),
      target: targetInfo(agent),
      state: 'accepted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seq: 0,
      events: [],
      subscribers: new Set(),
      messageId: null,
      turn: null,
      endReason: null,
      assistantTexts: [],
      streamingText: '',
      lastStreamActivityAt: 0,
      toolCalls: new Map(),
      pendingPermission: null,
      pendingInput: null,
      cancelRequested: false,
      result: null,
      error: null,
      guardTimers: [],
    }
    tasks.set(task.bridgeTaskId, task)
    return task
  }

  function createUserMessage(text) {
    // 与 GUI 发送消息同形：createUserMessage({ content, source: { kind: 'user' } })，
    // 会话里显示为用户自己说的话（本来就是用户对着麦克风说的）。
    return {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  async function startTask({ gatewayTaskId, ownerId, instruction }) {
    if (closed) throw bridgeError('BRIDGE_CLOSED', '语音桥已关闭。')
    if (activeTask && !isTerminal(activeTask.state)) {
      throw bridgeError(
        'BRIDGE_BUSY',
        '上一项语音任务还没结束。请先等它完成，或者说「取消当前任务」再派新的。',
      )
    }
    // 目标解析可能要 await（恢复/新建专用语音会话）；先占住入口，避免两个任务并发开工。
    if (starting) {
      throw bridgeError('BRIDGE_BUSY', '正在为这项任务准备会话，请稍等一下再派。')
    }
    starting = true
    let agent
    try {
      agent = await resolveTarget()
    } finally {
      starting = false
    }
    const task = createTask({ gatewayTaskId, ownerId, instruction, agent })
    activeTask = task
    task.state = 'accepted'
    pushEvent(task, { type: 'accepted', target: task.target })
    if (lastResolution.created) {
      pushActivity(task, {
        id: 'session-created',
        kind: 'status',
        status: 'running',
        label: '新建语音会话',
        detail: `阿源工作区里没有打开的会话，已新建「${sessionTitle}」`,
      })
    }
    pushActivity(task, {
      id: 'accepted',
      kind: 'status',
      status: 'running',
      label: '已收到任务',
      detail: `已排队等阿源在「${task.target.label}」里执行`,
    })
    const message = createUserMessage(instruction)
    task.messageId = message.id
    try {
      agent.followup(message)
    } catch (error) {
      const detail = String(error && error.message || error)
      failTask(task, { code: 'DISPATCH_FAILED', message: `把任务投递到当前会话失败：${detail}` })
      throw bridgeError('DISPATCH_FAILED', `把任务投递到当前会话失败：${detail}`)
    }
    task.hardTimeout = setTimeout(() => {
      if (closed || isTerminal(task.state)) return
      failTask(task, { code: 'TASK_TIMEOUT', message: '这项任务执行超过 45 分钟，已停止等待。' })
    }, TASK_HARD_TIMEOUT_MS)
    task.hardTimeout.unref?.()
    diag({
      kind: 'bridge-task-accepted',
      task: task.bridgeTaskId,
      gatewayTask: task.gatewayTaskId,
      session: task.sessionId,
      owner: ownerId,
      instruction: truncateChars(instruction, 200),
    })
    return task
  }

  function clearTaskTimers(task) {
    if (task.hardTimeout) clearTimeout(task.hardTimeout)
    task.hardTimeout = null
    for (const timer of task.guardTimers) clearTimeout(timer)
    task.guardTimers = []
    if (task.pendingPermission?.timer) clearTimeout(task.pendingPermission.timer)
    if (task.pendingInput?.timer) clearTimeout(task.pendingInput.timer)
  }

  function releaseActiveTask(task) {
    clearTaskTimers(task)
    if (activeTask === task) activeTask = null
    const timer = setTimeout(() => {
      tasks.delete(task.bridgeTaskId)
    }, TASK_TERMINAL_TTL_MS)
    timer.unref?.()
  }

  /**
   * 任务终结时把仍挂着的权限/提问 waterfall 明确收尾，避免 DSH 那一轮永远等一个
   * 不再会到来的回答（权限按 cancelled 失败关闭；提问返回无答案，让工具自己报错收尾）。
   */
  function settlePendingRelays(task) {
    if (task.pendingPermission) {
      const pending = task.pendingPermission
      task.pendingPermission = null
      clearTimeout(pending.timer)
      pushEvent(task, {
        type: 'permission.resolved',
        permission: { id: pending.id, status: 'cancelled' },
      })
      pending.resolve('cancelled')
    }
    if (task.pendingInput) {
      const pending = task.pendingInput
      task.pendingInput = null
      clearTimeout(pending.timer)
      pushEvent(task, {
        type: 'input.resolved',
        input: { id: pending.id, status: 'cancelled' },
      })
      pending.resolve(undefined)
    }
  }

  function finalizeCompleted(task, content, meta = {}) {
    if (isTerminal(task.state)) return
    settlePendingRelays(task)
    const bounded = truncateChars(clean(content, 20_000), MAX_RESULT_CHARS)
    task.state = 'completed'
    task.result = {
      content: bounded || '任务已完成，但这一轮没有返回可播报的文本。',
      turn: task.turn,
      sessionId: task.sessionId,
      ...meta,
    }
    pushEvent(task, { type: 'result', result: task.result })
    releaseActiveTask(task)
  }

  function failTask(task, { code, message }) {
    if (isTerminal(task.state)) return
    settlePendingRelays(task)
    task.state = 'failed'
    task.error = { code: clean(code, 80) || 'TASK_FAILED', message: clean(message, 1_000) }
    pushEvent(task, { type: 'error', error: task.error })
    releaseActiveTask(task)
  }

  function finalizeCancelled(task, message) {
    if (isTerminal(task.state)) return
    settlePendingRelays(task)
    task.state = 'cancelled'
    task.error = { code: 'WORK_CANCELLED', message: clean(message, 500) || '任务已取消。' }
    pushEvent(task, { type: 'cancelled', reason: { message: task.error.message } })
    releaseActiveTask(task)
  }

  function finishFromTurn(task, source) {
    if (isTerminal(task.state)) return
    const reason = task.endReason
    const kind = reason?.kind || 'completed'
    if (task.cancelRequested || kind === 'aborted') {
      finalizeCancelled(task, '已按你的要求取消当前任务。')
      return
    }
    if (kind === 'error') {
      failTask(task, {
        code: 'AGENT_TURN_FAILED',
        message: `阿源执行时出错：${describeAgentError(reason.error)}`,
      })
      return
    }
    if (kind === 'max-tokens') {
      // 输出被截断但有文本时按完成交付，并明确说明被截断。
      const text = task.assistantTexts.at(-1) || task.streamingText
      if (text) {
        finalizeCompleted(task, `${text}\n（输出达到长度上限，内容可能不完整。）`, { truncated: true })
      } else {
        failTask(task, { code: 'MAX_TOKENS', message: '阿源的输出达到长度上限且没有产生可播报内容。' })
      }
      return
    }
    const text = (task.assistantTexts.at(-1) || '').trim() || (task.streamingText || '').trim()
    if (!text) {
      failTask(task, {
        code: 'NO_ANSWER',
        message: `这一轮结束了（${kind}），但阿源没有给出可播报的回答。`,
      })
      return
    }
    finalizeCompleted(task, text, { turnEnd: kind, source })
  }

  function describeAgentError(error) {
    if (!error) return '未知错误'
    if (typeof error === 'string') return clean(error, 500)
    const message = error.message || (error.error && error.error.message) || error.code
    return clean(message || JSON.stringify(error), 500)
  }

  function handleTaskSessionEvent(task, event) {
    const type = event.type
    const data = event.data || {}
    if (type === 'user/message' && data.id === task.messageId && task.turn === null) {
      // 兜底：claimed 事件缺失时，用本轮 user/message 之前的 turn 边界无法可靠推断，
      // 因此这里只记录消息序号，turn 仍由 agent/inbox/claimed 提供。
      task.messageSeq = event.seq
      return
    }
    if (task.turn === null) return
    if (type === 'assistant/message' && data.turn === task.turn) {
      const text = messageText(data.message)
      if (text) {
        task.assistantTexts.push(text)
        if (task.state !== 'running') task.state = 'running'
        pushActivity(task, {
          id: 'assistant-message',
          kind: 'thinking',
          status: 'completed',
          label: '阿源已生成一条回答',
          detail: truncateChars(text, 160),
        })
      }
      return
    }
    if (type === 'tool/call' && data.turn === task.turn) {
      const callId = String(data.callId || '')
      const name = clean(data.name, 80)
      const detail = describeArgs(data.arguments)
      task.toolCalls.set(callId, { name, detail })
      pushActivity(task, {
        id: 'tool:' + callId,
        kind: 'tool',
        status: 'running',
        tool: name,
        title: toolLabel(name),
        ...(detail ? { detail } : {}),
      })
      return
    }
    if (type === 'tool/result' && data.turn === task.turn) {
      const message = data.message || {}
      const callId = String(message.toolCallId || message.source?.callId || '')
      const known = task.toolCalls.get(callId)
      const failed = message.isError === true
      const reason = failed ? clean(data.error?.reason || data.error?.code || '工具报告失败', 200) : ''
      pushActivity(task, {
        id: 'tool:' + callId,
        kind: 'tool',
        status: failed ? 'failed' : 'completed',
        ...(known?.tool || known?.name ? { tool: known.tool || known.name } : {}),
        title: known ? toolLabel(known.name) : '工具调用完成',
        ...(reason ? { detail: reason } : {}),
        ...(known?.detail && !reason ? { detail: known.detail } : {}),
      })
      if (failed) {
        task.lastToolFailure = { tool: known?.name || '', reason: reason || '工具失败' }
      }
      return
    }
    if (type === 'turn/end' && data.turn === task.turn) {
      task.endReason = data.reason || { kind: 'completed' }
      task.state = 'finalizing'
      pushActivity(task, {
        id: 'turn-ended',
        kind: 'status',
        status: 'running',
        label: '这一轮执行结束，正在整理结果',
      })
      const timer = setTimeout(() => finishFromTurn(task, 'turn-end'), 200)
      timer.unref?.()
      task.guardTimers.push(timer)
    }
  }

  // ------------------------------------------------------------ 权限 / 提问

  function relayPermission(task, req) {
    if (task.pendingPermission) {
      // 同一时刻只中转一个权限请求，其余交还 GUI（不会替用户决定）。
      return Promise.resolve('unavailable')
    }
    return new Promise((resolve) => {
      const permissionId = 'dshperm_' + crypto.randomUUID()
      const toolName = clean(req.toolName, 120) || '未知工具'
      const reason = clean(req.reason, 400)
      const summary = reason
        ? `阿源想执行「${toolLabel(toolName)}」：${reason}`
        : `阿源想执行「${toolLabel(toolName)}」，需要你确认。`
      const pending = {
        id: permissionId,
        toolName,
        resolve: null,
        timer: null,
      }
      const finish = (outcome, note) => {
        if (task.pendingPermission !== pending) return
        task.pendingPermission = null
        clearTimeout(pending.timer)
        const status = outcome === 'allowed-once' ? 'approved' : 'denied'
        pushEvent(task, {
          type: 'permission.resolved',
          permission: { id: permissionId, status, ...(note ? { summary: note } : {}) },
        })
        pushActivity(task, {
          id: 'permission:' + permissionId,
          kind: 'status',
          status: 'running',
          label: status === 'approved' ? '你已允许这次操作' : '这次操作没有执行',
        })
        resolve(outcome)
      }
      pending.resolve = finish
      task.pendingPermission = pending
      pending.timer = setTimeout(() => {
        finish('rejected', '等待确认超时，已按拒绝处理。')
      }, PERMISSION_TIMEOUT_MS)
      pending.timer.unref?.()
      pushEvent(task, {
        type: 'permission.requested',
        permission: {
          id: permissionId,
          taskId: task.bridgeTaskId,
          status: 'pending',
          category: 'tool',
          summary,
          approvalScope: 'session',
          operation: {
            title: toolName,
            kind: 'tool',
            ...(reason ? { description: reason } : {}),
          },
          createdAt: Date.now(),
        },
      })
      pushActivity(task, {
        id: 'permission:' + permissionId,
        kind: 'status',
        status: 'waiting',
        label: '等待你确认权限',
        detail: summary,
      })
    })
  }

  function answerPermission(task, permissionId, decision) {
    const pending = task?.pendingPermission
    if (!pending || pending.id !== permissionId) {
      throw bridgeError('PERMISSION_NOT_FOUND', '没有找到等待确认的权限请求（可能已超时或已处理）。')
    }
    const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
    pending.resolve(outcome)
    return { permissionId, outcome }
  }

  function relayUserQuestion(task, request, next) {
    const questions = (Array.isArray(request.questions) ? request.questions : [])
      .filter(item => item && item.id && item.question)
      .slice(0, 6)
    if (!questions.length) {
      // 没有可展示的问题就交还 GUI，避免吞掉真实提问。
      return next()
    }
    return new Promise((resolve) => {
      const inputRequestId = 'dshinput_' + crypto.randomUUID()
      const promptLines = questions.map((item) => {
        const options = Array.isArray(item.options) ? item.options.map(option => option.label).filter(Boolean) : []
        return options.length
          ? `${item.question}（选项：${options.join(' / ')}）`
          : item.question
      })
      const pending = { id: inputRequestId, questions, resolve: null, timer: null, callId: clean(request.wait?.callId, 200) }
      const finish = (answer) => {
        if (task.pendingInput !== pending) return
        task.pendingInput = null
        clearTimeout(pending.timer)
        const status = answer ? 'accepted' : 'cancelled'
        pushEvent(task, {
          type: 'input.resolved',
          input: { id: inputRequestId, status },
        })
        resolve(answer || undefined)
      }
      pending.resolve = finish
      task.pendingInput = pending
      pending.timer = setTimeout(() => {
        finish(undefined)
        // 超时没回答：打断这一轮，避免阿源一直挂在提问上。
        try { task.agent.cancel({ kind: 'user' }) } catch {}
      }, INPUT_TIMEOUT_MS)
      pending.timer.unref?.()
      pushEvent(task, {
        type: 'input.requested',
        input: {
          id: inputRequestId,
          taskId: task.bridgeTaskId,
          status: 'pending',
          kind: 'input',
          mode: 'text',
          prompt: truncateChars(promptLines.join('\n'), 1_500),
          createdAt: Date.now(),
        },
      })
      pushActivity(task, {
        id: 'input:' + inputRequestId,
        kind: 'status',
        status: 'waiting',
        label: '阿源在问你问题',
        detail: truncateChars(promptLines.join(' / '), 200),
      })
    })
  }

  function answerInput(task, inputRequestId, { action, text, values }) {
    const pending = task?.pendingInput
    if (!pending || pending.id !== inputRequestId) {
      throw bridgeError('INPUT_NOT_FOUND', '没有找到等待回答的提问（可能已超时或已处理）。')
    }
    if (action === 'decline' || action === 'cancel') {
      pending.resolve(undefined)
      try { task.agent.cancel({ kind: 'user' }) } catch {}
      return { inputRequestId, status: 'cancelled' }
    }
    const answerText = clean(text, 4_000)
    const answers = pending.questions.map((question) => {
      const selected = []
      const optionLabels = Array.isArray(question.options)
        ? question.options.map(option => clean(option?.label, 200)).filter(Boolean)
        : []
      for (const label of optionLabels) {
        if (answerText && (answerText === label || answerText.includes(label))) selected.push(label)
      }
      const custom = answerText && selected.length === 0 ? answerText : undefined
      return {
        id: question.id,
        selected,
        ...(custom ? { custom } : {}),
      }
    })
    const answer = {
      answers,
      ...(values && typeof values === 'object' ? { values } : {}),
    }
    pending.resolve(answer)
    return { inputRequestId, status: 'accepted' }
  }

  // ------------------------------------------------------------ 取消

  function cancelTask(task, message) {
    if (!task || isTerminal(task.state)) {
      return { taskId: task?.bridgeTaskId || '', state: task?.state || 'not_found' }
    }
    task.cancelRequested = true
    task.state = 'cancelling'
    pushActivity(task, {
      id: 'cancelling',
      kind: 'status',
      status: 'cancelling',
      label: '正在取消',
    })
    const agent = task.agent
    // 1) 指令还在队列里：直接移出，不需要打断任何正在跑的一轮。
    let removed = false
    try { removed = agent.inbox.remove(task.messageId) === true } catch {}
    if (removed) {
      finalizeCancelled(task, '已取消：任务指令还没开始执行就被移出了队列。')
      return { taskId: task.bridgeTaskId, state: 'cancelled' }
    }
    // 2) 指令已被这一轮认领：只在我们自己的 turn 上打断，绝不误伤用户手打的那一轮。
    const abortClaimedTurn = () => {
      if (isTerminal(task.state)) return
      try { agent.cancel({ kind: 'user' }) } catch (error) {
        log('agent.cancel failed:', String(error && error.message || error))
      }
      // DSH 的取消是协作式的：长工具可能要几十秒才结束，turn/end 会晚到。
      // 桥不应该因为这个锁住后续语音任务（否则用户取消后立刻派新任务会 BRIDGE_BUSY），
      // 因此取消请求一送达就终结本次 bridge task；晚到的 turn 事件会被 isTerminal 忽略。
      finalizeCancelled(task, '已按你的要求取消当前任务。')
    }
    if (task.turn !== null) {
      abortClaimedTurn()
      return { taskId: task.bridgeTaskId, state: 'cancelled' }
    }
    // turn 未知（claim 事件可能还在路上）：最多等 300ms，然后无论如何终结并释放锁。
    const timer = setTimeout(() => {
      if (isTerminal(task.state)) return
      if (task.turn !== null) abortClaimedTurn()
      else finalizeCancelled(task, '已取消。')
    }, 300)
    timer.unref?.()
    task.guardTimers.push(timer)
    return { taskId: task.bridgeTaskId, state: 'cancelling' }
  }

  // ------------------------------------------------------------ HTTP 路由

  function authOk(req) {
    const header = req.headers?.authorization || ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const direct = String(req.headers?.['x-voice-bridge-token'] || '').trim()
    const provided = bearer || direct
    if (!provided || provided.length !== token.length) return false
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    } catch {
      return false
    }
  }

  function bridgeUrl() {
    const origin = webServer.getOrigin()
    const url = origin.replace(/\/+$/, '') + ROUTE_PREFIX
    if (tokenFileWritten !== url) {
      tokenFileWritten = url
      try {
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
        fs.writeFileSync(tokenFile, JSON.stringify({
          url,
          token,
          pid: process.pid,
          version: BRIDGE_VERSION,
          updatedAt: new Date().toISOString(),
        }, null, 2), { mode: 0o600 })
        try { fs.chmodSync(tokenFile, 0o600) } catch {}
      } catch (error) {
        log('write bridge token file failed:', String(error && error.message || error))
      }
    }
    return url
  }

  function findTask(bridgeTaskId) {
    return tasks.get(clean(bridgeTaskId, 200)) || null
  }

  function summarizeTargets() {
    try {
      return liveRoots().map((agent, index) => {
        const record = activity.get(String(agent.id)) || {}
        return {
          ...targetInfo(agent),
          index,
          lastUserAt: record.lastUserAt || 0,
          lastEventAt: record.lastEventAt || sessionLastEventTime(agent.session),
        }
      })
    } catch (error) {
      return { error: String(error && error.message || error) }
    }
  }

  async function handleHealth(req, res) {
    let target = null
    let warning = null
    try {
      // 健康检查只探测、不新建会话：真正投递任务时才会自动建「语音通话」。
      const agent = await resolveTarget({ create: false })
      if (agent) {
        target = targetInfo(agent)
      } else {
        warning = {
          code: 'AUTO_CREATE_PENDING',
          message: `阿源工作区当前没有活动会话；下一次语音任务会自动新建一个「${sessionTitle}」会话。`,
        }
      }
    } catch (error) {
      warning = { code: error.code || 'TARGET_UNAVAILABLE', message: String(error.message || error) }
    }
    const controller = hostSessions()
    jsonResponse(res, 200, {
      ok: true,
      phase: closed ? 'closed' : 'ready',
      version: BRIDGE_VERSION,
      target,
      resolution: lastResolution,
      autoCreateSession,
      sessionTitle,
      // 宿主会话业务服务的可用性：自动新建/恢复走的就是它。
      host: {
        sessionController: Boolean(controller),
        create: typeof controller?.create === 'function',
        resolveAgent: typeof controller?.resolveAgent === 'function',
        rename: typeof controller?.rename === 'function',
      },
      ...(warning ? { warning } : {}),
      activeTask: activeTask && !isTerminal(activeTask.state)
        ? { bridgeTaskId: activeTask.bridgeTaskId, state: activeTask.state, turn: activeTask.turn }
        : null,
    })
  }

  async function handleStatus(req, res) {
    jsonResponse(res, 200, {
      ok: !closed,
      phase: closed ? 'closed' : 'ready',
      version: BRIDGE_VERSION,
      targets: summarizeTargets(),
      activeTask: activeTask && !isTerminal(activeTask.state)
        ? {
            bridgeTaskId: activeTask.bridgeTaskId,
            gatewayTaskId: activeTask.gatewayTaskId,
            state: activeTask.state,
            turn: activeTask.turn,
            target: activeTask.target,
            createdAt: activeTask.createdAt,
            recentActivity: activeTask.events.slice(-5),
          }
        : null,
      recentTasks: [...tasks.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
        .map(task => ({
          bridgeTaskId: task.bridgeTaskId,
          gatewayTaskId: task.gatewayTaskId,
          state: task.state,
          turn: task.turn,
          target: task.target,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          resultPreview: task.result ? truncateChars(task.result.content, 120) : null,
          error: task.error ? task.error.message : null,
        })),
      tokenFile,
    })
  }

  async function handleCreateTask(req, res) {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object') {
      jsonResponse(res, 400, { error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON。' } })
      return
    }
    const gatewayTaskId = clean(body.taskId, 200)
    const ownerId = clean(body.ownerId, 200)
    const instruction = clean(body.instruction, MAX_INSTRUCTION_CHARS)
    if (!gatewayTaskId || !ownerId || !instruction) {
      jsonResponse(res, 400, {
        error: { code: 'BAD_REQUEST', message: 'taskId / ownerId / instruction 都不能为空。' },
      })
      return
    }
    let task
    try {
      task = await startTask({ gatewayTaskId, ownerId, instruction })
    } catch (error) {
      jsonResponse(res, 409, {
        error: { code: error.code || 'DISPATCH_FAILED', message: String(error.message || error) },
      })
      return
    }
    jsonResponse(res, 202, {
      bridgeTaskId: task.bridgeTaskId,
      acceptedAt: task.createdAt,
      target: task.target,
    })
  }

  function handleEvents(req, res, task) {
    const url = new URL(req.url, 'http://localhost')
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
    try {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      res.flushHeaders?.()
      res.write('retry: 500\n\n')
    } catch {
      return
    }
    const subscriber = res
    for (const event of task.events) {
      if (event.seq > since) writeSseEvent(subscriber, event)
    }
    if (isTerminal(task.state)) {
      // 回放完终态事件后可以收尾（适配器已经拿到 result/error/cancelled）。
      try { res.end() } catch {}
      return
    }
    task.subscribers.add(subscriber)
    const remove = () => task.subscribers.delete(subscriber)
    req.on('close', remove)
    req.on('error', remove)
    res.on('close', remove)
  }

  async function handleCancel(req, res, task) {
    const result = cancelTask(task, '已按你的要求取消当前任务。')
    // 取消响应必须晚于「桥锁释放」：否则用户取消后立刻派新任务会撞上 BRIDGE_BUSY。
    const started = Date.now()
    while (!isTerminal(task.state) && Date.now() - started < 1_500) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    jsonResponse(res, 200, {
      ok: true,
      taskId: task.bridgeTaskId,
      state: isTerminal(task.state) ? task.state : result.state,
    })
  }

  async function handlePermission(req, res, task) {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object') {
      jsonResponse(res, 400, { error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON。' } })
      return
    }
    try {
      const result = answerPermission(
        task,
        clean(body.permissionId, 200),
        body.decision === 'reject' ? 'reject' : 'allow',
      )
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (error) {
      jsonResponse(res, 404, {
        error: { code: error.code || 'PERMISSION_NOT_FOUND', message: String(error.message || error) },
      })
    }
  }

  async function handleInput(req, res, task) {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object') {
      jsonResponse(res, 400, { error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON。' } })
      return
    }
    try {
      const result = answerInput(task, clean(body.inputRequestId, 200), {
        action: clean(body.action, 20),
        text: body.text,
        values: body.values,
      })
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (error) {
      jsonResponse(res, 404, {
        error: { code: error.code || 'INPUT_NOT_FOUND', message: String(error.message || error) },
      })
    }
  }

  async function handleRequest(req, res) {
    try {
      if (!authOk(req)) {
        jsonResponse(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bridge token 无效。' } })
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const suffix = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = String(req.method || 'GET').toUpperCase()
      if (suffix === '/health' && method === 'GET') return await handleHealth(req, res)
      if (suffix === '/status' && method === 'GET') return await handleStatus(req, res)
      if (suffix === '/tasks' && method === 'POST') return await handleCreateTask(req, res)
      const eventsMatch = suffix.match(/^\/tasks\/([^/]+)\/events$/)
      if (eventsMatch && method === 'GET') {
        const task = findTask(eventsMatch[1])
        if (!task) {
          jsonResponse(res, 404, { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期。' } })
          return
        }
        return handleEvents(req, res, task)
      }
      const cancelMatch = suffix.match(/^\/tasks\/([^/]+)\/cancel$/)
      if (cancelMatch && method === 'POST') {
        const task = findTask(cancelMatch[1])
        if (!task) {
          jsonResponse(res, 404, { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期。' } })
          return
        }
        return await handleCancel(req, res, task)
      }
      const permissionMatch = suffix.match(/^\/tasks\/([^/]+)\/permission$/)
      if (permissionMatch && method === 'POST') {
        const task = findTask(permissionMatch[1])
        if (!task) {
          jsonResponse(res, 404, { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期。' } })
          return
        }
        return await handlePermission(req, res, task)
      }
      const inputMatch = suffix.match(/^\/tasks\/([^/]+)\/input$/)
      if (inputMatch && method === 'POST') {
        const task = findTask(inputMatch[1])
        if (!task) {
          jsonResponse(res, 404, { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期。' } })
          return
        }
        return await handleInput(req, res, task)
      }
      jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: '未知的 bridge 路由。' } })
    } catch (error) {
      log('bridge request failed:', String(error && error.stack || error))
      jsonResponse(res, 500, {
        error: { code: 'BRIDGE_INTERNAL', message: String(error && error.message || error) },
      })
    }
  }

  try {
    // WebRoute.path 必须是「无尾斜杠的绝对路径」；prefix 语义自动覆盖
    // /voice-ayuan/bridge/<subpath>。
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: handleRequest,
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    log('register bridge routes failed:', String(error && error.message || error))
    throw error
  }

  heartbeatTimer = setInterval(() => {
    for (const task of tasks.values()) {
      for (const subscriber of task.subscribers) {
        try {
          if (subscriber.writableEnded || subscriber.destroyed) continue
          subscriber.write(': heartbeat\n\n')
        } catch {}
      }
    }
  }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  // 启动时把当前 live root 列进活动表，便于跨会话排序。
  try {
    for (const agent of liveRoots()) {
      const sessionId = String(agent.id)
      if (activity.has(sessionId)) continue
      activity.set(sessionId, {
        lastEventAt: sessionLastEventTime(agent.session),
        lastUserAt: 0,
      })
    }
  } catch (error) {
    log('bridge baseline scan failed:', String(error && error.message || error))
  }

  // 尽量在插件加载时就把 {url, token} 写到本机诊断文件（webServer 已绑定时可用），
  // 供 test/bridge-e2e.mjs 与运维脚本直连验证；失败不阻塞插件。
  try { bridgeUrl() } catch (error) {
    log('bridge url not ready at startup:', String(error && error.message || error))
  }

  return {
    token,
    url: bridgeUrl,
    tokenFile,
    status: () => ({
      phase: closed ? 'closed' : 'ready',
      version: BRIDGE_VERSION,
      targets: summarizeTargets(),
      resolution: lastResolution,
      session: { title: sessionTitle, autoCreate: autoCreateSession, stateFile: sessionStateFile },
      activeTask: activeTask && !isTerminal(activeTask.state)
        ? { bridgeTaskId: activeTask.bridgeTaskId, state: activeTask.state, turn: activeTask.turn }
        : null,
    }),
    close() {
      if (closed) return
      closed = true
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
      if (activeTask && !isTerminal(activeTask.state)) {
        cancelTask(activeTask, '插件热重载/退出，任务已中断。')
      }
      for (const task of tasks.values()) {
        for (const subscriber of task.subscribers) {
          try { subscriber.end?.() } catch {}
        }
        task.subscribers.clear()
        clearTaskTimers(task)
      }
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch {}
      }
      try { fs.rmSync(tokenFile, { force: true }) } catch {}
    },
  }
}
