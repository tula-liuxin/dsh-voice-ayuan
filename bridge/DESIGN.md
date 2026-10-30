# 语音通话接入阿源本体（voice-bridge）设计

> 目标：用户对着麦克风说「阿源，帮我把 XXX 做了」→ 阿源在**用户当前正在聊的那个 DSH 会话**里真的执行
> （用它自己的工具/记忆/上下文）→ 执行进展和结果能通过语音说出来。

状态：代码已实现（`bridge/`、`lib/bridge.js`、`prompt/`、`test/`），宿主接线见 `bridge/WIRING.md`，
需要一次插件热重载生效；真实 E2E 脚本 `test/bridge-e2e.mjs` 待重载后运行。

---

## 1. 为什么这样接（选型过程）

qwen-audio-agent 2.0.1 的「后台 Agent」走一个协议无关的 `BackendPort`：

```js
{ describe, start, health, submit, status, cancel,
  respondAuthorization, respondInput, subscribe, close }
```

- 官方 Gateway 入口 `server/src/app/bootstrap.mjs` 只有 9 行：`createGatewayApplication()`。
- `createGatewayApplication({ agent })` 接受任意 BackendPort，`createBackendAgentHost(adapter)` 把它
  包装成网关需要的 agent 门面（`qwen-audio-agent/backend-adapter-sdk`、`/gateway-application` 都是
  包 exports 的公开子路径）。
- 因此不需要 fork/魔改 vendor：新写 `bridge/gateway-host.mjs` 作为网关子进程入口，把 BackendPort 换成
  「DSH 当前会话桥」的客户端（`bridge/backend-adapter.mjs`）。网关的任务队列、权限中转、结果公告、
  HTTP/WS 服务全部保持官方实现。

DSH 侧（插件宿主进程）能拿到的东西（读自可读安装的 `*.d.ts` + `dsh-base` 组合）：

- `ctx.agents`（dsh-agent）：`roots()/list()/get()` 返回 live Agent；Agent 有
  `session`、`inbox`、`status`、`followup(UserMessage)`、`steer`、`inject`、`cancel`、`whenIdle()`。
  `dsh-agent/lib/types/runtime-types.d.ts` 明确写着「插件/UI/hooks/orchestrator 用 followup 投递用户消息」。
- dsh-session 的会话事件表：`turn/start`、`user/message`、`assistant/message`、`tool/call`、
  `tool/result`、`turn/end`（都带 turn 号），以及 `agent/inbox/claimed|discarded`、
  `agent/assistant-stream`、`agent/status`、`agent/error`、`agent/disposed`。
- `ctx.approval`（dsh-user-approval）的 `approval/request` waterfall 与
  `ctx.userQuestions` 的 `user-questions/request` waterfall。
- DSH GUI 自己发消息也是 `createUserMessage(...)` + `agent.followup(message)`
  （`dsh-api-session-controller/lib/index.js` L943-950），我们走同一条路。

结论：**不需要新建第二个会话**。插件对「当前 live root 会话」的 Agent 直接 `followup` 一条 user 消息，
就是用户"在手机/耳机里说话，阿源在电脑上的会话里干活"。

---

## 2. 全链路

```
 用户语音
   │  (16k PCM ↑ / audio.delta ↓，已有链路，不属于本设计)
   ▼
 语音前台模型（快模型；只负责口语回应/确认/澄清/播报）
   │  工具选择：spawn_thinking（唯一执行入口）、get_agent_task_status、cancel_agent_task、
   │           respond_permission、respond_agent_input（后两个仅在 Gateway 有 pending 时出现）
   ▼
 qwen-audio-agent Gateway（与现在同一套 TaskManager/权限/公告实现）
   │  BackendWorkRuntime.run(task) → BackendPort
   ▼
 bridge/backend-adapter.mjs（网关子进程内）
   │  POST {bridge}/tasks + GET {bridge}/tasks/:id/events (SSE)  ← 127.0.0.1 + bearer token
   ▼
 lib/bridge.js（DSH 插件宿主进程）
   │  1) 选目标会话（sessionId 覆盖 → 工作区 live 会话 → 自动新建「语音通话」 → 最近活跃 root）
   │  2) agent.followup(createUserMessage(instruction))   ← 真正的当前会话
   │  3) 订阅 session/event + agent/*，把这一轮映射成进度事件
   │  4) turn/end 后取这一轮最后的 assistant/message 文本（≤600 字）
   ▼
 当前 DSH 会话（阿源本体：全部工具/记忆/上下文，UI 里能看到这一轮）
```

结果回流：
1. `submit` 的最终 `{ content, artifacts: [] }` 交给 Gateway TaskManager；
2. qwen-audio-agent 的既有机制 `recordTaskResult` 把结果写进前台会话历史（`conversation.history` 可见），
   并按 `notificationStatus` 进入"待公告"队列；下一次实时会话轮转时由 `AnnouncementManager` 注入给前台模型，
   由它用语音自然播报（它的 instructions 已内置"这是结果材料，不是新请求；口语化、不念路径/ID/长内容"）。
3. 进度同理走 `backend.activity`（卡片/状态）+ `backend.message`（最新进展文本），用户问"做到哪了"时模型调用
   `get_agent_task_status` 就能拿到 `latest_update`。

---

## 3. 协议（本机回环 HTTP + SSE）

网关子进程 → 插件宿主。所有请求带 `Authorization: Bearer <token>`（token 由插件宿主每次加载随机生成，
只经子进程环境变量传给网关；同时以 0600 写到 `~/.dsh/voice-ayuan-bridge.json` 供本机验证脚本使用）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 桥存活 + 当前目标会话（`{ok, phase, target:{sessionId,cwd,label}, resolution:{mode,sessionId,cwd?,created?}, autoCreateSession, sessionTitle, warning?, activeTask}`）；只探测、不新建会话 |
| GET | `/status` | 诊断：所有 live root 候选（含 lastUserAt/lastEventAt）、当前任务、最近 5 个任务 |
| POST | `/tasks` | `{taskId, ownerId, instruction}` → `202 {bridgeTaskId, acceptedAt, target}`；忙/无会话 → 409 带明确错误码 |
| GET | `/tasks/:id/events?since=N` | SSE，先回放 `seq>since` 的事件再持续推送；终态后关闭 |
| POST | `/tasks/:id/cancel` | 取消（队列内直接移出；已开始的只打断"我们自己那一轮"）→ `{ok, state}` |
| POST | `/tasks/:id/permission` | `{permissionId, decision:'allow'|'reject'}` → 回填 DSH 审批结果 |
| POST | `/tasks/:id/input` | `{inputRequestId, action:'accept'|'decline'|'cancel', text, values?}` → 回答阿源的提问 |

SSE 事件（宿主语义；适配器再翻译成 `backend.*`）：

```jsonc
{ "seq": 1, "time": 169..., "type": "accepted", "target": { "sessionId": "...", "label": "..." } }
{ "seq": 2, "type": "activity", "activity": { "id": "tool:call-1", "kind": "tool",
    "status": "running", "tool": "pwsh", "title": "执行 PowerShell 命令", "detail": "Get-Date" } }
{ "seq": 3, "type": "message", "message": "…最新进展…" }
{ "seq": 4, "type": "permission.requested",
  "permission": { "id": "dshperm_…", "status": "pending", "category": "tool",
                  "summary": "阿源想执行「修改文件」：…", "approvalScope": "session",
                  "operation": { "title": "edit", "kind": "tool", "description": "…" } } }
{ "seq": 5, "type": "permission.resolved", "permission": { "id": "…", "status": "approved" } }
{ "seq": 6, "type": "input.requested",
  "input": { "id": "dshinput_…", "status": "pending", "kind": "input", "mode": "text", "prompt": "…" } }
{ "seq": 7, "type": "input.resolved", "input": { "id": "…", "status": "accepted" } }
{ "seq": 8, "type": "result", "result": { "content": "…≤600字…", "turn": 12, "sessionId": "…" } }
{ "seq": 9, "type": "error", "error": { "code": "AGENT_TURN_FAILED", "message": "…可播报…" } }
{ "seq": 10, "type": "cancelled", "reason": { "message": "已按你的要求取消当前任务。" } }
```

Adapter 侧事件映射（`bridge/backend-adapter.mjs`）：

| 宿主事件 | BackendPort 事件 |
| --- | --- |
| `accepted` / `activity` | `backend.activity`（含 `id` 的观察项，复 id 即更新，前端卡片据此显示状态）|
| `message` | `backend.message`（TaskManager 的 `task.message` = 最新进展）|
| `permission.requested/resolved` | `backend.permission.requested/resolved`（→ 前端 `respond_permission`）|
| `input.requested/resolved` | `backend.input.requested/resolved`（→ 前端 `respond_agent_input`）|
| `result` | `submit` resolve `{ content, artifacts: [] }` |
| `error` | `submit` reject（错误文本原样交给语音播报）|
| `cancelled` | `submit` reject `WORK_CANCELLED` |

事件都带 adapter 侧补的 `taskId/ownerId`；不把 DSH 的 session id、turn、原始消息对象放进模型可见文本。

---

## 4. 会话选择与并发

- 候选 = `ctx.agents.roots()` 里过滤掉 `header.origin==='subagent'`/`delegationDepth>0` 之后的 **live root agent**，
  同一组候选内按「最近一次 user/message 时间 → 最近事件时间 → 会话末事件时间 → 注册顺序」取第一。
  插件加载时对已有 live root 做一次基线扫描。
- **目标解析顺序（v0.2.4）**：
  1. `config.bridge.sessionId`：只用它（不在 live 就按 id 恢复）；
  2. `config.bridge.cwdPrefix`（也接受 `preferCwd`）：只投该工作区里的 live 会话；一个都没有时
     **自动新建一张「专用语音会话」**（默认标题「语音通话」，`sessionTitle` 可改），把 id 记进
     `~/.dsh/voice-ayuan-session.json`；下次优先复用，重启后再来按 id 恢复（不是新建）。
     `autoCreateSession: false` 退回旧行为（最近活跃 root）；
  3. 都没配：退回「最近活跃 live root」；一个 live root 都没有时 409 `NO_LIVE_SESSION` 明确失败。
- 配了 `cwdPrefix` 后，语音任务**不会**落进用户正在长聊的主会话；工作区没开会话时也不报错，而是新建专用会话。
- 新建/恢复走宿主的 `ctx.get('sessionController')`（GUI「新建会话」同一条业务路径，含默认模型与 preset 合成），
  会话所有权在宿主侧，插件热重载不会连带销毁它。
- v1 全局串行：宿主同一时刻只跑一个语音任务，第二个直接 409 `BRIDGE_BUSY`（"上一项还没结束，先等或取消"）。
  Gateway 侧 TaskManager 本身也按 `owner` 串行（`laneKey: backend:<ownerId>`）。
- 用户手打的消息与语音任务共用同一个 Agent：语音任务在队列里排队（`followup` = next-turn），
  不会打断用户正在跑的一轮；取消时只移除/打断**我们这条指令对应的 turn**，不会误伤用户手打的那轮。

限制（v1）：
- 没配 `cwdPrefix`/`sessionId` 时，同一进程里如果用户同时打开多个 DSH 会话窗口，无法从宿主侧知道
  "哪个窗口在最前面"，只能近似为"最近有用户消息的会话"（配了 `cwdPrefix` 后不存在这个问题）。
- 一次只能有一个语音任务；"两件事同时办"需后续版本。
- 若用户正处在一个需要交互审批的会话策略（`ask`），语音确认会接管该权限请求（GUI 不再弹窗）；
  若策略是 `never`（当前桌面是 danger-full-access），则没有审批请求可中转。
- `sessionLastEventTime` 用了 DSH 标记 deprecated 的 `Session.eventAt()` 读末事件时间（插件侧没有等价的
  公开跨会话时间读取面）；只用于排序兜底，失败会静默回退，不影响任务正确性。

---

## 5. 进度 / 权限 / 提问 / 取消 / 失败

**进度**（用户能听到/看到"在做"）：
- turn 被认领 → `activity {id:'turn-started', status:'running'}`；
- 每次工具调用 → `activity {id:'tool:<callId>', kind:'tool', title:'执行 PowerShell 命令', detail:参数摘要}`，
  对应 `tool/result` 更新为 completed/failed（失败带原因）；
- 助手流式文本 → 1.2s 节流一条 `activity {id:'assistant', kind:'thinking', detail:最近200字}`；
- 每步 assistant/message → `activity {id:'assistant-message'}`；`turn/end` → "正在整理结果"。
- 前端模型在用户问进度时用 `get_agent_task_status` 拿到的 `latest_update` 就是这些事件的最近一条。

**权限**：在 `approval/request` waterfall 上 `prepend` 一个监听器——只拦截「目标会话 + 我们这一轮已开始」
的请求，其他一律 `next()` 交还 GUI（不会干扰用户自己的审批）。拦截后发 `permission.requested`，
等用户语音回答 → 前端调用 `respond_permission` → `respondAuthorization('once'|'reject')` → 回填
`allowed-once`/`rejected`。120s 无回答按 `rejected` 失败关闭并明确告知。

**提问**：`user-questions/request` 同理，转成 `input.requested`；用户语音回答经 `respond_agent_input`
回来，按问题 id 组装 `{answers:[{id, selected, custom}]}`（有选项时按标签匹配，否则 custom=用户原话）。
action=decline/cancel 时取消这一轮。180s 无回答取消这一轮（避免阿源一直挂起）。

**取消**（用户打断/说"停下"）：`cancel_agent_task` → adapter.cancel → 宿主：
1) 指令还在 inbox → `agent.inbox.remove(messageId)`，直接终态；
2) 指令已被认领 → 等 claim 事件确认 turn 后 `agent.cancel({kind:'user'})`（只打断这一轮），
   `turn/end.reason.kind==='aborted'` → 发 `cancelled`。
取消后 8s 兜底终结，绝不静默挂住。

**失败**：`agent/error`、`turn/end.reason.kind==='error'`、`agent/disposed`（会话被关）、
`NO_ANSWER`（turn 结束但无文本）、`TASK_TIMEOUT`（45min 硬上限）都会变成 `error` 事件，
	extbf{错误文本是给语音播报的自然中文}，不是堆栈。

---

## 6. 前台提示词 / 工具选择（快模型适配）

实时层 LLM 换 DeepSeek V4.1 Flash（关思考）后，前台要"少而快"：

- `prompt/PROMPT.md`（1575 字）：身份=阿源的声音前台；只做即时口语回应/确认/澄清/转达；
  **任何实际工作必须调用 `spawn_thinking` 交给阿源本体**；不编造执行结果；短句；不念路径/ID/URL/代码；
  权限先问再 `respond_permission`；追问转达后 `respond_agent_input`；"停"就 `cancel_agent_task`。
- `prompt/ASSISTANT.md`（356 字）：人设（自然、干脆、不谄媚、简短）。
- 接线环境变量（`lib/gateway.js` 仅在启用 bridge 时加）：
  `QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR=<plugin>/prompt`、
  `QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH=<plugin>/prompt/ASSISTANT.md`。
- 工具面收敛：`QWEN_AUDIO_SCHEDULE_TOOL_ENABLED=0`、`QWEN_AUDIO_WEB_TOOLS_ENABLED=0`、
  `QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED=0`、`QWEN_AUDIO_NOTES_TOOL_ENABLED=0`、
  `QWEN_AUDIO_RECALL_TOOL_ENABLED=0`。结果：基础只有 `spawn_thinking` / `get_agent_task_status` /
  `cancel_agent_task`（+`get_current_time`）；`respond_permission`/`respond_agent_input` 只在 Gateway
  有 pending 时由 capability 动态出现（qwen-audio-agent 自带机制，见 `frontend-tool-context.mjs`）。
- `spawn_thinking` 描述用 `createGatewayApplication({ spawnThinkingDescription })` 换成一句短描述
  （`bridge/gateway-host.mjs`），参数 schema 保持官方（`objective` + `input_refs`）。
- 结果/进度播报的措辞由 qwen-audio-agent 的 `resultResponseInstructions` / `progressResponseInstructions`
  约束（固有机制），我们的 `content` 只提供事实文本（≤600 字）。

---

## 7. 文件清单

| 文件 | 角色 |
| --- | --- |
| `bridge/gateway-host.mjs` | 网关子进程入口：`createGatewayApplication({ agent: createBackendAgentHost(...), spawnThinkingDescription })`；保持官方 IPC ready 与导出 |
| `bridge/backend-adapter.mjs` | 子进程侧 BackendPort 实现（HTTP+SSE 客户端、事件/权限/输入/cancel 映射、conformance 兼容）|
| `lib/bridge.js` | 宿主侧桥：目标会话、followup、turn 事件跟踪、SSE 总线、权限/提问中转、取消、token 文件、HTTP 路由 |
| `prompt/PROMPT.md` `prompt/ASSISTANT.md` | 前台行为提示词与声音人设 |
| `lib/gateway.js`（待接线） | 增加可选 `entry`/`bridgeUrl`/`bridgeToken`/`extraEnv`；未配置时行为与现状完全一致 |
| `index.js`（待接线） | `inject` 加 `agents`；创建 bridge、注册路由、启动网关时传入 bridge 参数与提示词/工具环境变量；状态接口暴露 `bridge` |
| `test/bridge-adapter.test.mjs` | 官方 conformance + 事件/取消/权限/输入/失败/不可达 |
| `test/bridge-gateway-composition.mjs` | 真实 gateway-host 子进程 + 官方客户端协议 task.create/get/cancel/permission/input（mock 宿主桥）|
| `test/bridge-host.test.mjs` | 模拟 DSH 宿主接口驱动真实 `lib/bridge.js`（会话选择/事件映射/取消/权限/提问/并发/鉴权）|
| `test/bridge-gateway-process.test.mjs` | `lib/gateway.js` 接线验证（旧路径兼容 + bridge 路径），接线后运行 |
| `test/bridge-prompt.test.mjs` | 提示词真实加载 + 工具面收敛 + spawn 描述覆盖 |
| `test/bridge-e2e.mjs` | 真实端到端：协议层任务 → 当前 DSH 会话真实执行 pwsh → 结果/取消（报告 `test/.out/bridge-e2e-report.json`）|
| `test/bridge-voice-e2e.mjs` | 语音播报端到端：真实 s2s 上游，任务完成→公告→模型语音回应（audio.delta + transcript，报告 `test/.out/bridge-voice-e2e-report.json`）|

---

## 8. 如何验证（客观证据）

1. `node --test test/bridge-adapter.test.mjs` — 8/8，含官方 `verifyBackendAdapterConformance`。
2. `node --test test/bridge-gateway-composition.mjs` — 通过：真实网关子进程 + 客户端协议全链路。
3. `node --test test/bridge-host.test.mjs` — 6/6：用模拟的 DSH 宿主接口驱动真实 `lib/bridge.js`
   （目标会话选择/覆盖、followup、turn/工具/assistant 事件→SSE、取消两种路径、权限/提问中转、并发与鉴权）。
   注意：这一层是宿主接口的**模拟**（用于热重载前抓缺陷）；真实 DSH 链路由第 5 项 E2E 证明。
4. `node --test test/bridge-prompt.test.mjs` — 4/4：`buildFrontendInstructions()` 用上我们的 PROMPT/ASSISTANT，
   工具面只剩最小集合。
5. 接线 + 热重载后：`node test/bridge-e2e.mjs`
   - 读 `~/.dsh/voice-ayuan-bridge.json`，`GET /health` 拿到用户当前会话；
   - 起隔离测试网关（`PORT=0` + 临时 `QWAUDIO_*`，不碰用户通话中的网关）；
   - `task.create` 让当前会话真实调用 pwsh 输出随机 marker → `task.get` 的 `result` 必须含该 marker；
   - `conversation.history` 必须包含这条结果（语音模型播报的数据源）；
   - 长任务 `task.cancel` 必须得到 `cancelled` 终态（不是静默消失）；
   - 报告写到 `test/.out/bridge-e2e-report.json`。
6. `node --test test/bridge-gateway-process.test.mjs`（接线后）— 证明 `lib/gateway.js` 旧路径（官方
   bootstrap）向后兼容 + bridge 路径（自定义入口/env/dsh-session 后端）两条都过。
7. **实测结果（2026-10-29 23:48~00:12）**：
   - 宿主重载成功：`/voice-ayuan/status` → `gateway.entry='bridge'`、`gateway.bridge=true`、
     `bridge.phase='ready'`、`body.backend.protocol='dsh-session'`。
   - `test/bridge-e2e.mjs` PASS（第二次重挂后复跑）：目标会话 `session-94d8b89b…`（用户当前会话，cwd Downloads）→
     task `task_1` → 当前会话真实执行 `pwsh Write-Output VOICE_BRIDGE_E2E_OK_qdx1f2ck` →
     `result` 含 marker；客户端收到 `task.completed` 推送；`notificationStatus='pending'`（待播报队列）；
     长任务 `task.cancel` → `cancelled` 终态；**取消后立刻派新任务（attempts=1，无 BRIDGE_BUSY）** →
     结果 `VOICE_BRIDGE_E2E_AFTER_CANCEL_OK_hwykwq`（验证串行锁已释放）。报告 `test/.out/bridge-e2e-report.json`。
   - `test/bridge-voice-e2e.mjs` PASS（第二次重挂后复跑，真实 s2s 上游）：任务完成 → `task.notification.delivered` →
     实时模型收到公告并回应：assistant transcript = `验证结果就是这一行VOICE_SPEAK_E2E_h2a0ie`，
     `audio.delta` 18432 bytes / 0.38s。
     即「结果回流语音模型并说出来」已用音频字节 + 转写作证。报告 `test/.out/bridge-voice-e2e-report.json`。
   - 另：Host bridge 日志显示用户实际用语音派过一条任务（"查一下当前语音前台背后实际使用的是什么大模型…"），
     `bridge-task-terminal`：turn 50、result 含 deepseek-flash 结论（即真实用户链路已跑通）。
8. 人工语音验收（用户开着通话面板）：说"帮我看一下现在几点/把桌面上的 X 整理一下" → 面板字幕出现任务
   回执 → 当前 DSH 会话里能看到阿源真的调工具 → 几秒后语音播报结果；中途说"停" → 语音确认已叫停，
   会话里那一轮被中断。

---

## 9. 生效方式（重要）

- 本次接线改 `index.js` 与 `lib/gateway.js`（diff 见 `bridge/WIRING.md`，已落盘）。
- **宿主插件没有源码级自动 HMR**（dsh-base 的 hmr 行是 `root: []`，只监听配置，不监听链接包源码；实测改文件后
  不会自动生效）。要让改动生效有两条路：
  1. **官方 RPC 重挂（推荐，无需重启应用）**：客户端（DSH 页面上下文）通过 `ctx.get('remote')` 的
     `pluginManager` 找到 voice-ayuan 的插件行，`setPluginEnabled(entryId, false)` → 等 1~2s →
     `setPluginEnabled(entryId, true)`（可重试）触发 profile recomposition；宿主的 Loader 会重新 import
     链接包 `C:\Users\23677\Desktop\dsh-plugins\voice-ayuan` 的最新文件，插件 apply 重新执行、
     `ctx.effect` 先 teardown 旧网关/隧道再重建。返回值里 `applied` / `restart-required` 可用于判断是否成功；
     远程判断可看 `/voice-ayuan/status` 是否出现 `bridge.phase === 'ready'` 与 `gateway.entry === 'bridge'`。
  2. 重启 DSH 桌面应用（最稳，但会中断所有会话；本次不采用）。
- 副作用：重挂会停掉语音网关+隧道子进程再重启（约 2-3s），**用户当前通话会断一次、需要在面板重新连接**；
  已在进行中的语音任务会以明确错误结束（不会假完成）。
- 首次加载新增 `agents` 依赖注入（dsh-base 必有）；若某个 profile 没有该服务，插件会等待/不激活。
- 回滚：把 `index.js`/`lib/gateway.js` 改回原版并重挂；`bridge/`、`lib/bridge.js`、`prompt/`、`test/` 留着不影响。

## 10. 已知限制 / 后续

- 多窗口/多会话的"当前"判定是启发式（最近用户活动），可用 `config.bridge.sessionId` 覆盖；后续可由前端把
  "当前会话 id"上报给插件（需要动 client 代码）做精确判定。
- v1 单任务串行；后续可放开并发但需要每个任务独立事件通道（宿主已按 bridgeTaskId 分流，适配器侧也已按
  任务隔离；限制只在宿主的"全局单活跃任务"开关）。
- GUI 与语音同时操作同一会话时，语音任务按队列排序；用户取消语义以"只中断语音任务那一轮"为准。
- 审批策略 `never` 的环境（当前 desktop danger-full-access）不会产生 approval 请求，权限中转只有单测覆盖。
- 结果文本上限 600 字，来自最后一条 assistant 文本；超长内容由前台模型概括，不在桥里伪造摘要。

### 协议兼容坑（已修，值得记住）
- Gateway 的 `GatewayActivitySchema` 要求 activity.`updatedAt` 是 **ISO 字符串**。宿主最初发数字
  `Date.now()`，导致 task.get/task.completed 等**整条响应在客户端 zod 校验时被丢弃**（表现为
  task.get 一直超时，但任务其实已经完成）。修法：宿主 pushActivity 用 ISO 字符串；适配器再
  `normalizeActivity()` 兜底（宿主发数字也转成 ISO），保证跨版本兼容。
- DSH 的 `agent.cancel()` 是协作式的：长工具可能几十秒后才触发 turn/end。桥在取消请求送达后
  **立即终结 bridge task 并释放串行锁**，避免后续语音任务被 `BRIDGE_BUSY` 卡住；晚到的 turn 事件被忽略。
