// 验证 Origin 重写假设：代理把任何 Origin 改写为 http://<请求 Host>，
// 用官方 SDK（真实 hello 会话）逐种请求头验证是否能 session.ready。
import http from 'node:http'
import { WebSocket } from 'ws'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { proxyRealtimeUpgrade } from '../lib/ws-proxy.js'

const logs = []
const server = http.createServer((req, res) => { res.writeHead(404); res.end('no') })
server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host || '127.0.0.1'
  proxyRealtimeUpgrade(req, socket, head, { host: '127.0.0.1', port: 11490 }, {
    rewriteOrigin: 'http://' + host,
    onEvent: (event) => logs.push(event),
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = 'ws://127.0.0.1:' + port + '/voice-ayuan/rt'

function attempt(label, headers) {
  return new Promise((resolve) => {
    const observed = { connected: false, ready: false, closed: null }
    const client = new GatewayClient({
      url,
      createSocket: (target) => new WebSocket(target, { headers }),
      clientType: 'web',
      clientVersion: 'probe',
      clientInstanceId: 'probe-' + Math.random().toString(36).slice(2),
      timeZone: 'Asia/Shanghai',
      capabilities: ['input.audio'],
      reconnect: false,
      onStatus: (s) => {
        if (s.state === 'connected') observed.connected = true
        if (s.state === 'ready') { observed.ready = true; done() }
        if (s.state === 'closed' || s.state === 'error') observed.closed = s.state
      },
      onEvent: () => {},
    })
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      try { client.stop() } catch {}
      console.log(label + ' => ' + JSON.stringify(observed))
      setTimeout(resolve, 150)
    }
    client.start()
    setTimeout(done, 6000)
  })
}

const chrome = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Cookie: 'dsh_session=dummy',
  'Sec-Fetch-Dest': 'websocket',
  'Sec-Fetch-Mode': 'websocket',
  'Sec-Fetch-Site': 'same-origin',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}

await attempt('A origin=null          ', { ...chrome, Origin: 'null' })
await attempt('B origin=custom-scheme ', { ...chrome, Origin: 'http://dsh-app://x' })
await attempt('C origin=wrong-port    ', { ...chrome, Origin: 'http://127.0.0.1:9999' })
await attempt('D origin=none          ', { ...chrome })
await attempt('E origin=real-port     ', { ...chrome, Origin: 'http://127.0.0.1:' + port })

console.log('--- proxy events ---')
for (const entry of logs) console.log(JSON.stringify(entry))
server.close()
setTimeout(() => process.exit(0), 100)
