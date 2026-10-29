import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs', import.meta.url))
const child = fork(entry, [], {
  env: {
    ...process.env,
    PORT: '0',
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
    QWEN_AUDIO_REALTIME_URL: 'ws://127.0.0.1:18765/v1/realtime',
    QWEN_AUDIO_AGENT_BACKEND: 'none',
    QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: 'http://127.0.0.1:7969',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
let done = false
child.on('message', async (m) => {
  console.log('MSG', JSON.stringify(m).slice(0, 300))
  if (m && m.type === 'qwen-audio-agent:gateway-ready') {
    try {
      const r = await fetch(m.origin + '/api/health')
      const j = await r.json()
      console.log('HEALTH', r.status, JSON.stringify(j).slice(0, 400))
    } catch (e) { console.log('HEALTH_ERR', String(e).slice(0, 200)) }
    done = true
    setTimeout(() => { child.kill(); process.exit(0) }, 1500)
  }
})
child.stdout.on('data', d => process.stdout.write('[out] ' + String(d).slice(0, 300)))
child.stderr.on('data', d => process.stdout.write('[err] ' + String(d).slice(0, 400)))
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1) }, 60000)
