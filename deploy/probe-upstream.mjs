// Probe upstream realtime WS endpoint through the ssh tunnel (read-only diagnostics).
// Usage: node deploy/probe-upstream.mjs [wsUrl]
import http from 'node:http'
import { WebSocket } from 'ws'

const url = process.argv[2] || 'ws://127.0.0.1:18765/v1/realtime'
const httpUrl = new URL(url)
httpUrl.protocol = 'http:'

function httpGet(u) {
  return new Promise((resolve) => {
    const req = http.get(u, { timeout: 8000 }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d.toString() })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body.slice(0, 800) }))
    })
    req.on('timeout', () => { req.destroy(new Error('http timeout')) })
    req.on('error', (e) => resolve({ error: String(e) }))
  })
}

console.log('HTTP GET', httpUrl.toString())
console.log(JSON.stringify(await httpGet(httpUrl), null, 2))

console.log('\nWS upgrade', url)
const started = Date.now()
const ws = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1:4273' }, handshakeTimeout: 8000 })
ws.on('upgrade', (res) => console.log('UPGRADE status=' + res.statusCode, 'ms=' + (Date.now() - started)))
ws.on('open', () => { console.log('OPEN ms=' + (Date.now() - started)); ws.close() })
ws.on('unexpected-response', (_req, res) => {
  let body = ''
  res.on('data', (d) => { body += d.toString() })
  res.on('end', () => {
    console.log('UNEXPECTED status=' + res.statusCode, 'ms=' + (Date.now() - started))
    console.log('headers=' + JSON.stringify(res.headers))
    console.log('body=' + body.slice(0, 1200))
    process.exit(0)
  })
})
ws.on('error', (e) => { console.log('ERROR ms=' + (Date.now() - started), String(e)); process.exit(0) })
ws.on('close', (code, reason) => { console.log('CLOSE code=' + code, 'reason=' + String(reason)); process.exit(0) })
setTimeout(() => { console.log('TIMEOUT 10s'); process.exit(0) }, 10000)
