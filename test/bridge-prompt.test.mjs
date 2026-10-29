/**
 * 前台提示词 / 工具面验证：
 * - 插件提供的 prompt/PROMPT.md + prompt/ASSISTANT.md 能通过环境变量被
 *   qwen-audio-agent 的 buildFrontendInstructions() 真正加载；
 * - 关闭非必要 frontend 工具后，快模型只看到「转交给阿源」相关的最小工具集；
 * - spawnThinkingDescription 生效（短描述）。
 *
 * 运行：node --test test/bridge-prompt.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROMPT_DIR = path.join(PLUGIN_ROOT, 'prompt')
const ASSISTANT_PATH = path.join(PROMPT_DIR, 'ASSISTANT.md')
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-prompt-'))

process.env.QWAUDIO_CONFIG_DIR = CONFIG_DIR
process.env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR = PROMPT_DIR
process.env.QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH = ASSISTANT_PATH
process.env.QWEN_AUDIO_SCHEDULE_TOOL_ENABLED = '0'
process.env.QWEN_AUDIO_WEB_TOOLS_ENABLED = '0'
process.env.QWEN_AUDIO_KNOWLEDGE_TOOL_ENABLED = '0'
process.env.QWEN_AUDIO_NOTES_TOOL_ENABLED = '0'
process.env.QWEN_AUDIO_RECALL_TOOL_ENABLED = '0'
process.env.QWEN_AUDIO_REALTIME_PROVIDER = 'speech-to-speech'
process.env.SPEECH_TO_SPEECH_REALTIME_URL = 'ws://127.0.0.1:1/v1/realtime'

// qwen-audio-agent 的 package exports 不暴露这些内部模块；测试直接按文件 URL 引用
// 安装包里的真实模块（不是复制品）。
const PACKAGE_ROOT = path.join(PLUGIN_ROOT, 'node_modules', 'qwen-audio-agent')
const { pathToFileURL } = await import('node:url')
const { config } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'server', 'src', 'core', 'config.mjs')).href)
const { buildFrontendInstructions, frontendTools } = await import(
  pathToFileURL(path.join(PACKAGE_ROOT, 'server', 'src', 'frontend', 'frontend-tools.mjs')).href
)

test.after(() => {
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }) } catch {}
})

test('插件 prompt 目录/人设路径被 config 正确解析', () => {
  assert.equal(path.resolve(config.frontendPromptDir), path.resolve(PROMPT_DIR))
  assert.equal(path.resolve(config.assistantProfilePath), path.resolve(ASSISTANT_PATH))
  assert.ok(fs.readFileSync(path.join(PROMPT_DIR, 'PROMPT.md'), 'utf8').includes('阿源的声音前台'))
})

test('buildFrontendInstructions 使用插件 PROMPT.md 与人设，并保留工具纪律', () => {
  const instructions = buildFrontendInstructions({
    client: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
  })
  assert.match(instructions, /阿源的声音前台/)
  assert.match(instructions, /你是阿源，用户身边的语音助手/)
  assert.match(instructions, /spawn_thinking/)
  // 默认包内 PROMPT.md 的标志句不应出现（说明真的换成我们的提示词了）
  assert.doesNotMatch(instructions, /统一助手/)
  assert.match(instructions, /channel=full_duplex_voice/)
})

test('工具面收敛为转交/任务/取消的最小集合，权限/输入工具按需出现', () => {
  // 与真实实时会话一致：getAgentContext 会把 config.frontendDisabledTools 放进上下文。
  assert.ok(config.frontendDisabledTools.includes('web_search'))
  assert.ok(config.frontendDisabledTools.includes('schedule_reminder'))
  const baseContext = { frontend: { disabledTools: config.frontendDisabledTools } }
  // 无待处理权限/输入时：只有转交 + 状态 + 取消 + 时间。
  const baseNames = frontendTools(baseContext).map(tool => tool.function.name)
  for (const required of ['spawn_thinking', 'get_agent_task_status', 'cancel_agent_task']) {
    assert.ok(baseNames.includes(required), `缺少必要工具 ${required}`)
  }
  // 权限/输入是动态工具：Gateway 在有 pending 时才把 capability 放进上下文。
  const withPending = frontendTools({
    frontend: {
      disabledTools: config.frontendDisabledTools,
      capabilities: ['permission.respond', 'backend.input.respond'],
    },
  }).map(tool => tool.function.name)
  assert.ok(withPending.includes('respond_permission'))
  assert.ok(withPending.includes('respond_agent_input'))
  for (const disabled of ['web_search', 'fetch_url', 'schedule_reminder', 'notes', 'recall', 'knowledge']) {
    assert.ok(!baseNames.includes(disabled), `不应暴露工具 ${disabled}`)
    assert.ok(!withPending.includes(disabled), `不应暴露工具 ${disabled}`)
  }
  assert.ok(baseNames.length <= 6, `基础工具数量应保持精简，实际 ${baseNames.length}: ${baseNames.join(',')}`)
})

test('spawnThinkingDescription 覆盖转交工具描述', () => {
  const [tool] = frontendTools({ frontend: { spawnThinkingDescription: '自定义转交描述' } })
    .filter(item => item.function.name === 'spawn_thinking')
  assert.equal(tool.function.description, '自定义转交描述')
})
