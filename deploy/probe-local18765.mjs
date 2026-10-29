import { WebSocket } from 'ws'

const variants = [
  ['plain /v1/realtime', 'ws://127.0.0.1:18765/v1/realtime'],
  ['model query', 'ws://127.0.0.1:18765/v1/realtime?model=default'],
  ['OpenAI-Beta hdr', 'ws://127.0.0.1:18765/v1/realtime', { 'OpenAI-Beta': 'realtime=v1' }],
]

for (const [label, url, headers = {}] of variants) {
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    const timer = setTimeout(() => { try { ws.terminate() } catch {}; resolve('TIMEOUT') }, 7000)
    ws.on('open', () => { clearTimeout(timer); setTimeout(() => { try { ws.close() } catch {}; resolve('OPEN(101)') }, 400) })
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve('HTTP ' + res.statusCode) })
    ws.on('error', (e) => { clearTimeout(timer); resolve('ERR ' + String(e.message).slice(0, 90)) })
  })
  console.log(label, '=>', result)
}
process.exit(0)
