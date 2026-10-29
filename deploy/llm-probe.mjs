// DeepSeek Responses API probe (no s2s/GPU model involvement).
// Verifies: streaming text, disable-thinking parameter compatibility, tool calls,
// Chinese output, TTFT. Mirrors what speech_to_speech ResponsesApiModelHandler sends.
//
// Usage: node deploy/llm-probe.mjs
// Key: DEEPSEEK_API_KEY env, else read from %USERPROFILE%\.dsh\.credentials.yaml

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const text = readFileSync(homedir() + '/.dsh/.credentials.yaml', 'utf8')
  const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
  if (!m) throw new Error('DEEPSEEK_API_KEY not found')
  return m[1]
}
const KEY = loadKey()
const log = (...a) => console.log('[llm-probe]', ...a)

async function post(payload, { stream = false } = {}) {
  const started = Date.now()
  const res = await fetch(BASE + '/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { res, started }
}

function textOf(response) {
  const parts = []
  for (const item of response.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) if (c.type === 'output_text' && c.text) parts.push(c.text)
    }
  }
  return parts.join('')
}

// ---------- 1) non-stream: parameter variants for disabling thinking ----------
const baseInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '用中文回答：你好，请只回复一句话。' }] }]
const variants = [
  { name: 'plain (no reasoning param)', body: {} },
  { name: 'reasoning.effort=off', body: { reasoning: { effort: 'off' } } },
  { name: 'reasoning.effort=none', body: { reasoning: { effort: 'none' } } },
  { name: 'reasoning.effort=minimal', body: { reasoning: { effort: 'minimal' } } },
  { name: 'reasoning.effort=low', body: { reasoning: { effort: 'low' } } },
  { name: 'reasoning.effort=high', body: { reasoning: { effort: 'high' } } },
  { name: 'reasoning.effort=max', body: { reasoning: { effort: 'max' } } },
  { name: 'reasoning.enabled=false', body: { reasoning: { enabled: false } } },
  { name: 'chat_template_kwargs(enable_thinking=false) [what handler sends]', body: { chat_template_kwargs: { enable_thinking: false } } },
  { name: 'thinking.type=disabled', body: { thinking: { type: 'disabled' } } },
]

for (const v of variants) {
  const payload = { model: MODEL, input: baseInput, max_output_tokens: 300, ...v.body }
  try {
    const { res, started } = await post(payload)
    const elapsed = Date.now() - started
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      log('variant', JSON.stringify(v.name), '-> HTTP', res.status, elapsed + 'ms', 'error=', JSON.stringify(body).slice(0, 400))
      continue
    }
    const types = (body.output || []).map((i) => i.type).join(',')
    const usage = body.usage || {}
    log('variant', JSON.stringify(v.name), '-> 200', elapsed + 'ms',
      '| items=[' + types + ']',
      '| text=' + JSON.stringify(textOf(body)).slice(0, 120),
      '| reasoning_tokens=' + (usage.output_tokens_details?.reasoning_tokens ?? 'n/a'),
      '| output_tokens=' + usage.output_tokens)
  } catch (e) {
    log('variant', JSON.stringify(v.name), '-> EXC', String(e))
  }
}
