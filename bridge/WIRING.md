# 宿主接线（已落盘 2026-10-29 23:44，Lead 确认无冲突）

> 状态：`lib/gateway.js`（6135B）与 `index.js`（9680B）已按本文件落盘；
> 另在 `/voice-ayuan/status` 与 `provide('voiceCall')` 各加 `bridge` 字段（便于远程判断重载成功）。
> 2026-10-29 23:48（Lead 触发重挂）已生效：`/voice-ayuan/status` 显示 `gateway.entry='bridge'`、
> `gateway.bridge=true`、`bridge.phase='ready'`、`body.backend.protocol='dsh-session'`。
> 重挂后又修了两处**需要再重挂一次才进宿主**的代码（当前语音链路不受影响）：
> 1) `lib/bridge.js`：activity.updatedAt 改用 ISO 字符串（Gateway 协议要求；数字会让外部客户端
>    的 task.* 响应被 zod 丢弃）；`cancelTask` 取消时立即释放串行锁（避免长工具期间 BRIDGE_BUSY 假死）。
> 2) `bridge/backend-adapter.mjs`：`normalizeActivity()` 兜底（新 fork 的网关子进程已用新代码）。
> 另外 16:14 又加固了「取消后立刻派新任务」竞态：
> - 宿主 `lib/bridge.js`：turn 已知时 cancel 立即终结并释放锁；/cancel 等锁释放后才响应；
> - 适配器 `bridge/backend-adapter.mjs`：cancel 后等宿主 activeTask 释放（≤2s）再返回。
> E2E（新适配器）已证明 attempts=1 无 BRIDGE_BUSY；正在运行的网关子进程/宿主是加固前版本，
> 想彻底装进生产需再重挂一次（可选，不阻塞验收）。

本文件记录 index.js / lib/gateway.js 的接线改动（已落盘）。宿主插件**没有源码级自动 HMR**，
落盘后需要触发一次 profile recomposition（推荐 `remote.pluginManager.setPluginEnabled` 重挂插件行，
或重启应用）才能让插件重新 import 最新文件。

放行后的动作：
1. 按下面 diff 修改 `lib/gateway.js` 与 `index.js`；
2. `node --check lib/gateway.js && node --check index.js`；
3. 运行 `node --test test/bridge-gateway-process.test.mjs`（验证 `lib/gateway.js` 的 bridge/legacy 两条路径）；
4. 触发插件热重载（Plugins 页面关/开 voice-ayuan）。**会中断用户当前通话，需重连面板**；
5. 运行 `node test/bridge-e2e.mjs` 出真实 E2E 证据。

---

## 1. `lib/gateway.js`

改动点（向后兼容：不传新参数时行为与现在完全一致）：

```diff
-const ENTRY = new URL('../node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs', import.meta.url)
+const DEFAULT_ENTRY = new URL('../node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs', import.meta.url)

 export class GatewayProcess {
-  constructor({ tunnelUrl, allowedOrigin, log = () => {} } = {}) {
+  constructor({
+    tunnelUrl,
+    allowedOrigin,
+    log = () => {},
+    // 可选：自定义网关入口（bridge/gateway-host.mjs）。缺省 = 官方 bootstrap.mjs。
+    entry = null,
+    // 可选：插件宿主 bridge 地址（字符串或返回字符串的函数）。缺省 = 不启用 bridge。
+    bridgeUrl = null,
+    bridgeToken = '',
+    // 可选：仅在配置了 bridge 时追加的子进程环境变量（对象或返回对象的函数）。
+    extraEnv = null,
+  } = {}) {
     this.tunnelUrl = tunnelUrl
     this.allowedOrigin = allowedOrigin
     this.log = log
+    this.entry = entry
+    this.bridgeUrl = bridgeUrl
+    this.bridgeToken = bridgeToken
+    this.extraEnv = extraEnv
     this.child = null
     ...
   }
+
+  resolveBridgeUrl() {
+    const value = this.bridgeUrl
+    if (typeof value === 'function') {
+      try { return String(value() || '') } catch { return '' }
+    }
+    return String(value || '')
+  }
+
+  resolveExtraEnv() {
+    const value = this.extraEnv
+    if (typeof value === 'function') {
+      try { return { ...(value() || {}) } } catch { return {} }
+    }
+    return { ...(value || {}) }
+  }
@@
       const child = fork(fileURLToPath(ENTRY), [], {
+      const bridgeUrl = this.resolveBridgeUrl()
+      const child = fork(fileURLToPath(this.entry || DEFAULT_ENTRY), [], {
         env: {
           ...process.env,
           PORT: '0',
           QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
           SPEECH_TO_SPEECH_REALTIME_URL: this.tunnelUrl,
           S2S_REALTIME_URL: this.tunnelUrl,
           QWEN_AUDIO_REALTIME_URL: this.tunnelUrl,
           QWEN_AUDIO_AGENT_BACKEND: 'none',
           QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: this.resolveAllowedOrigin(),
+          ...(bridgeUrl
+            ? {
+                VOICE_AYUAN_BRIDGE_URL: bridgeUrl,
+                VOICE_AYUAN_BRIDGE_TOKEN: String(this.bridgeToken || ''),
+                ...this.resolveExtraEnv(),
+              }
+            : {}),
         },
@@
   status() {
     return {
       phase: this.phase,
       origin: this.origin,
       lastError: this.lastError,
       pid: this.child?.pid ?? null,
       restartAttempts: this.restartAttempts,
+      entry: this.entry ? 'bridge' : 'bootstrap',
+      bridge: Boolean(this.resolveBridgeUrl()),
     }
   }
```

要点：
- `entry` 默认 null → fork 仍用官方 `bootstrap.mjs`，env 不新增任何键；
- 只有传入 `bridgeUrl`（且非空）时才加 `VOICE_AYUAN_BRIDGE_*` 与 `extraEnv`；
- 崩溃重启/超时/健康检查逻辑不动。

## 2. `index.js`

```diff
 import { GatewayProcess } from './lib/gateway.js'
 import { SshTunnel } from './lib/tunnel.js'
 import { proxyRealtimeUpgrade } from './lib/ws-proxy.js'
+import { createVoiceBridge } from './lib/bridge.js'
 import { appendReport, diag, diagPaths, tailLog, writeReport } from './lib/diag.js'
+import { fileURLToPath } from 'node:url'

 export const name = 'voice-ayuan'
-export const inject = ['webServer']
+// agents：把语音任务投递进用户当前正在聊的 live DSH 会话（dsh-base 的 agent/agent-loop）。
+export const inject = ['webServer', 'agents']
@@ export function apply(ctx, config = {}) {
   const log = (...args) => ctx.logger?.info?.('[voice-ayuan]', ...args)
   ...
+  const bridgeConfig = config.bridge ?? {}
+  const bridgeEnabled = bridgeConfig.enabled !== false
+  let bridge = null
+  if (bridgeEnabled) {
+    bridge = createVoiceBridge({
+      ctx,
+      webServer: ctx.webServer,
+      config: bridgeConfig,
+      log,
+    })
+    ctx.effect(() => () => bridge.close(), 'voice-ayuan: dsh session bridge')
+  }
   const tunnel = new SshTunnel({...})
   const gateway = new GatewayProcess({
     tunnelUrl: `ws://127.0.0.1:${remote.tunnelLocalPort}/v1/realtime`,
     allowedOrigin,
     log,
+    ...(bridge ? {
+      // 网关子进程入口换成 bridge/gateway-host.mjs：BackendPort 指向「阿源当前会话」。
+      entry: new URL('./bridge/gateway-host.mjs', import.meta.url),
+      bridgeUrl: () => bridge.url(),
+      bridgeToken: bridge.token,
+      // 仅启用 bridge 时生效：前台提示词/工具面/后端选择。
+      extraEnv: () => ({
+        AGENT_PROTOCOL: '',
+        QWEN_AUDIO_AGENT_BACKEND: 'none',
+        QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR: fileURLToPath(new URL('./prompt', import.meta.url)),
+        QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH: fileURLToPath(new URL('./prompt/ASSISTANT.md', import.meta.url)),
+        // 快模型只保留「转交给阿源」相关工具。
+        QWEN_AUDIO_SCHEDULE_TOOL_ENABLED: '0',
+        QWEN_AUDIO_WEB_TOOLS_ENABLED: '0',
+        QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED: '0',
+        QWEN_AUDIO_NOTES_TOOL_ENABLED: '0',
+        QWEN_AUDIO_RECALL_TOOL_ENABLED: '0',
+      }),
+    } : {}),
   })
   const boot = (async () => {
     try {
       diag({ kind: 'boot-start' })
       await tunnel.start()
       await gateway.start()
-      diag({ kind: 'boot-ready', gateway: gateway.status() })
+      diag({ kind: 'boot-ready', gateway: gateway.status(), bridge: bridge?.status?.() ?? null })
@@ /voice-ayuan/status route 返回值加：
+        bridge: bridge ? bridge.status() : null,
@@ ctx.provide('voiceCall', {...}) 里加：
+      bridge: () => bridge?.status?.() ?? null,
```

要点：
- 默认启用（`config.bridge.enabled: false` 可关）；bridge 创建失败会抛错让插件加载失败（不静默降级成"只能聊天"）。
- 用户 profile 的 `cordis.patch.yml` 推荐配 `bridge.cwdPrefix: <阿源工作区>`：语音任务只进该工作区的
  live 会话；一个都没有时自动在工作区新建一张「语音通话」（`bridge.autoCreateSession: false` 关闭该行为，
  `bridge.sessionId` 则完全钉死目标会话）。
- 网关子进程新增 env 只在 bridge 启用时出现。

## 3. 新增依赖注入说明

`inject` 增加 `agents`：桌面/Web profile 由 `dsh-base` 挂载 `@deepseek-ai/dsh-agent` + `dsh-agent-loop`
（`dsh-base/cordis.patch.yml` 的 `agent`、`agent-loop` 行），因此可用。若某个 profile 没挂，
插件会等待该服务而非报错；不支持该服务的 profile 需要把本插件禁用。

## 4. 重载与回滚

- 重载：客户端通过 `remote.pluginManager.setPluginEnabled(entryId, false)` → 等待 → `setPluginEnabled(entryId, true)`
  触发 profile recomposition（Plugins 页面关/开同理）；重挂后 Loader 重新 import 链接包最新文件，插件 apply
  重跑、effect teardown 旧网关/隧道再重建。宿主无源码级自动 HMR，不重挂就不会生效。
- 重载后自检：`GET /voice-ayuan/status` 里 `bridge.phase === 'ready'`、`gateway.entry === 'bridge'`；
  `GET /voice-ayuan/bridge/health`（带 `~/.dsh/voice-ayuan-bridge.json` 的 token）返回目标会话。
- 回滚：把 `lib/gateway.js`/`index.js` 改回原版并重载；`bridge/`、`lib/bridge.js`、`prompt/`、`test/` 留着不影响。
  或在 profile 配置 `bridge: { enabled: false }`（但用户要求语音必须能做事，不建议长期关闭）。
