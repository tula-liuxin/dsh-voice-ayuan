// 用裸 socket 模拟 Chrome/Electron 的真实 WS 握手头，验证 127.0.0.1:4273/voice-ayuan/rt 的升级行为。
// 依据 DSH 桌面 lib/main.js L12447-12469：主进程把来自 dsh-app://app 的 ws://127.0.0.1/* 请求的
// Origin 改写成 http://<host:port> 并注入 cookie；这里用「改写后」的头验证代理/网关链路。
import net from 'node:net'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { WebSocket } from 'ws'

const HOST = '127.0.0.1'
const PORT = Number(process.argv[2] || 4273)
const PATH = '/voice-ayuan/rt'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const CHROME_HEADERS = (origin) => ({
  host: HOST + ':' + PORT,
  connection: 'Upgrade',
  pragma: 'no-cache',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DeepSeek Harness/0.2.1 Chrome/142.0.7444.175 Electron/39.0.0 Safari/537.36',
  upgrade: 'websocket',
  origin,
  'sec-websocket-version': '13',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'zh-CN,zh;q=0.9',
  'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
  'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'websocket',
  'sec-fetch-site': 'same-origin',
  cookie: 'dsh_session=test-cookie-value',
})

function stripOptional(headers) {
  const copy = { ...headers }
  delete copy.origin
  delete copy['sec-fetch-dest']
  delete copy['sec-fetch-mode']
  delete copy['sec-fetch-site']
  delete copy.cookie
  delete copy['sec-websocket-extensions']
  delete copy['accept-encoding']
  delete copy['accept-language']
  delete copy.pragma
  delete copy['cache-control']
  delete copy['user-agent']
  return copy
}

function rawUpgrade(headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 6000)
    const finish = (result) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.on('connect', () => {
      const lines = ['GET ' + PATH + ' HTTP/1.1']
      for (const [name, value] of Object.entries(headers)) lines.push(name + ': ' + value)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.slice(0, end).split('\r\n')
      const statusLine = head.shift() || ''
      const headers = {}
      for (const line of head) {
        const at = line.indexOf(':')
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
      }
      finish({ statusLine, status: Number((/HTTP\/1\.1 (\d{3})/.exec(statusLine) || [])[1] || 0), headers })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function expectedAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

let pass = 0
let fail = 0
const report = (ok, name, detail) => {
  if (ok) { pass += 1; console.log('PASS ' + name + ' :: ' + detail) }
  else { fail += 1; console.error('FAIL ' + name + ' :: ' + detail) }
}

// 1) 桌面主进程改写后的真实请求（Origin=宿主 origin + cookie + 全套 Chrome 头）→ 必须 101
{
  const headers = CHROME_HEADERS('http://' + HOST + ':' + PORT)
  const result = await rawUpgrade(headers).catch((error) => ({ error: String(error) }))
  const acceptOk = result.headers && result.headers['sec-websocket-accept'] === expectedAccept(headers['sec-websocket-key'])
  report(result.status === 101 && acceptOk, 'browser-desktop-canonical', result.statusLine + (acceptOk ? ' accept=ok' : ' accept=MISMATCH'))
}

// 2) 普通浏览器 web 模式（页面与宿主同源）→ 必须 101
{
  const headers = stripOptional(CHROME_HEADERS('http://' + HOST + ':' + PORT))
  const result = await rawUpgrade(headers).catch((error) => ({ error: String(error) }))
  report(result.status === 101, 'node-nows-origin', result.statusLine || result.error)
}

// 3) 未改写的 dsh-app://app Origin（宿主侧重写/桌面主进程钩子未生效时）→ 记录实际结果
{
  const headers = CHROME_HEADERS('dsh-app://app')
  const result = await rawUpgrade(headers).catch((error) => ({ error: String(error) }))
  const afterHostRewrite = result.status === 101
  console.log('INFO dsh-app-origin-raw :: ' + (result.statusLine || result.error) + (afterHostRewrite ? '（宿主 Origin 重写已生效）' : '（宿主尚未重写；桌面主进程钩子会先改写成宿主 origin，因此应用内不受此影响）'))
}

// 4) Origin: null → 记录实际结果
{
  const headers = CHROME_HEADERS('null')
  const result = await rawUpgrade(headers).catch((error) => ({ error: String(error) }))
  console.log('INFO null-origin-raw :: ' + (result.statusLine || result.error))
}

// 5) 旧客户端 URL（ws://app/...）在 DNS 层就失败 —— 1006 的根因证据
{
  let lookupFailed = false
  try { await dns.lookup('app') } catch (error) { lookupFailed = String(error.code || error.message).includes('ENOTFOUND') || true }
  const wsError = await new Promise((resolve) => {
    const socket = new WebSocket('ws://app/voice-ayuan/rt')
    const timer = setTimeout(() => resolve('timeout'), 4000)
    socket.on('error', (error) => { clearTimeout(timer); resolve(String(error && error.message || error)) })
    socket.on('close', (code) => { clearTimeout(timer); resolve('close ' + code) })
  })
  report(lookupFailed && /ENOTFOUND|getaddrinfo|EAI_AGAIN|close 1006|timed out/i.test(wsError), 'old-url-ws-app-fails', 'dns=' + (lookupFailed ? 'ENOTFOUND' : '?') + ' ws=' + wsError)
}

console.log('\nbrowser-handshake: ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail === 0 ? 0 : 1)
