/**
 * lib/gateway.js 接线验证（需要先按 bridge/WIRING.md 改 lib/gateway.js；
 * 未接线时本文件自动 skip，不会误报）。
 *
 * 覆盖：
 *   1) 旧路径向后兼容：不传 entry/bridgeUrl 时仍然 fork 官方 bootstrap.mjs，
 *      行为与现状一致（PORT=0、IPC ready、/api/health 可用）。
 *   2) bridge 路径：fork bridge/gateway-host.mjs，bridgeUrl/token/extraEnv 正确注入，
 *      /api/health 报告 backend.protocol = dsh-session，且 mock 宿主桥确实被访问。
 *
 * 运行：node --test test/bridge-gateway-process.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-gwproc-'))
process.env.QWEN_AUDIO_REALTIME_PROVIDER = 'speech-to-speech'
process.env.SPEECH_TO_SPEECH_REALTIME_URL = 'ws://127.0.0.1:1/v1/realtime'
process.env.S2S_REALTIME_URL = 'ws://127.0.0.1:1/v1/realtime'
process.env.QWEN_AUDIO_AGENT_ALLOWED_ORIGINS = ''
process.env.QWEN_AUDIO_AGENT_IDENTITY_MODE = 'personal'
process.env.QWEN_AUDIO_LOG_LEVEL = 'warn'
process.env.QWAUDIO_CONFIG_DIR = path.join(STATE_ROOT, 'config')
process.env.QWAUDIO_DATA_DIR = path.join(STATE_ROOT, 'data')
process.env.QWAUDIO_STATE_DIR = path.join(STATE_ROOT, 'state')
process.env.QWAUDIO_CACHE_DIR = path.join(STATE_ROOT, 'cache')

const { GatewayProcess } = await import('../lib/gateway.js')
const { createMockBridge } = await import('./helpers/mock-bridge.mjs')

const WIRED = typeof GatewayProcess.prototype.resolveBridgeUrl === 'function'
const SKIP = WIRED ? false : 'lib/gateway.js 尚未接线（见 bridge/WIRING.md）'

test.after(() => {
  try { fs.rmSync(STATE_ROOT, { recursive: true, force: true }) } catch {}
})

test('旧路径向后兼容：未配置 bridge 时仍用官方 bootstrap 入口', { skip: SKIP }, async () => {
  const gateway = new GatewayProcess({
    tunnelUrl: 'ws://127.0.0.1:1/v1/realtime',
    allowedOrigin: '',
    log: () => {},
  })
  assert.equal(gateway.status().entry, 'bootstrap')
  assert.equal(gateway.status().bridge, false)
  try {
    const origin = await gateway.start()
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const health = await (await fetch(origin + '/api/health')).json()
    assert.equal(health.ok, true)
    // 没有 bridge 时后台是「未配置」而不是 dsh-session
    assert.notEqual(health.backend?.protocol, 'dsh-session')
  } finally {
    await gateway.stop()
  }
})

test('bridge 路径：自定义入口 + bridge env 注入 + dsh-session 后端', { skip: SKIP }, async () => {
  const mock = await createMockBridge()
  const gateway = new GatewayProcess({
    tunnelUrl: 'ws://127.0.0.1:1/v1/realtime',
    allowedOrigin: '',
    log: () => {},
    entry: new URL('../bridge/gateway-host.mjs', import.meta.url),
    bridgeUrl: mock.url,
    bridgeToken: mock.token,
    extraEnv: () => ({
      QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR: path.join(PLUGIN_ROOT, 'prompt'),
      QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH: path.join(PLUGIN_ROOT, 'prompt', 'ASSISTANT.md'),
      QWEN_AUDIO_SCHEDULE_TOOL_ENABLED: '0',
      QWEN_AUDIO_WEB_TOOLS_ENABLED: '0',
    }),
  })
  assert.equal(gateway.status().entry, 'bridge')
  assert.equal(gateway.status().bridge, true)
  try {
    const origin = await gateway.start()
    const health = await (await fetch(origin + '/api/health')).json()
    assert.equal(health.ok, true)
    assert.equal(health.backend?.protocol, 'dsh-session')
    assert.equal(health.backend?.enabled, true)
    // 子进程确实拿着 bridgeUrl/token 访问了宿主桥（health probe）。
    // Gateway readiness precedes the asynchronous backend health probe.
    const healthDeadline = Date.now() + 5000
    while (!mock.requests.some(item => item.type === 'health') && Date.now() < healthDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(mock.requests.some(item => item.type === 'health'), 'gateway 子进程应访问 mock 宿主桥 health')
  } finally {
    await gateway.stop()
    await mock.close()
  }
})
