/**
 * gateway-host — voice-ayuan 专用的 qwen-audio-agent Gateway 入口（供 lib/gateway.js fork）。
 *
 * 与官方 server/src/app/bootstrap.mjs 的唯一区别：把 BackendPort 换成
 * BridgeSessionBackend，让网关的「后台 Agent」实际是「阿源当前 DSH 会话」。
 * 其余（realtime provider、任务队列、公告/通知、HTTP/WS 服务、IPC ready 消息）
 * 全部由 createGatewayApplication 按环境变量组装，与官方启动路径完全一致。
 *
 * 环境变量（由 lib/gateway.js 设置）：
 *   VOICE_AYUAN_BRIDGE_URL    插件宿主的回环 bridge 根地址
 *   VOICE_AYUAN_BRIDGE_TOKEN  宿主生成的一次性 token
 *
 * 官方 bootstrap 同款导出（app/server/services/start/close），并保持
 * process.send('qwen-audio-agent:gateway-ready') 就绪通知。
 */
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import { createBackendAgentHost } from 'qwen-audio-agent/backend-adapter-sdk'
import { createBridgeSessionBackend } from './backend-adapter.mjs'

const log = (...args) => {
  console.error('[voice-ayuan-gateway-host]', ...args)
}

const bridgeUrl = String(process.env.VOICE_AYUAN_BRIDGE_URL || '').trim()
const bridgeToken = String(process.env.VOICE_AYUAN_BRIDGE_TOKEN || '').trim()

if (!bridgeUrl) {
  log('VOICE_AYUAN_BRIDGE_URL 未设置：不能在没有 DSH 会话桥的情况下启动语音网关')
  process.exit(78)
}

const backend = createBridgeSessionBackend({
  bridgeUrl,
  token: bridgeToken,
  label: '阿源（当前 DSH 会话）',
  log,
})

let application
try {
  application = createGatewayApplication({
    agent: createBackendAgentHost(backend, { name: 'voice-ayuan DSH session bridge' }),
    // 前台模型（快模型）只需要一个很短的转交工具描述；真正的行为规则在
    // prompt/PROMPT.md 里（QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR 指过去）。
    spawnThinkingDescription: '把需要实际动手的事（读写文件、命令、代码、查询、操作电脑、定时提醒、继续已有工作）转交给阿源本体，在用户当前 DSH 会话里执行并回传结果。objective 必须忠实、完整、自包含。',
  })
} catch (error) {
  log('createGatewayApplication failed:', error?.stack || error)
  process.exit(70)
}

let closing = false
async function shutdown(reason) {
  if (closing) return
  closing = true
  log('shutting down:', reason)
  try {
    await application.close()
  } catch (error) {
    log('close failed:', error?.stack || error)
  }
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGHUP', () => { void shutdown('SIGHUP') })
process.once('disconnect', () => { void shutdown('parent disconnect') })
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection:', reason?.stack || String(reason))
})
process.on('uncaughtException', (error) => {
  log('uncaughtException:', error?.stack || String(error))
})

export const app = application.app
export const server = application.server
export const services = application.services
export const start = application.start
export const close = application.close
