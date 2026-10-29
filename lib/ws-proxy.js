import http from 'node:http'

/**
 * 把 DSH webServer 上的 WS 升级请求转发给 Gateway 的 /api/realtime。
 * 让页面与 Gateway 变成同源，绕开跨端口的 origin 校验。
 *
 * options.rewriteOrigin：把浏览器发来的 Origin 强制改写为
 * "<scheme>://<请求 Host>"，这样即使渲染器发来的是 null / 自定义 scheme /
 * 其他端口，Gateway 的 isAllowedOrigin 也能落到「loopback 同源」分支。
 */
export function proxyRealtimeUpgrade(req, socket, head, target, options = {}) {
  const { rewriteOrigin = '', rewriteHost = '', onEvent = () => {} } = options
  const headers = { ...req.headers }
  headers.host = rewriteHost || req.headers.host
  const originalOrigin = req.headers.origin ?? null
  if (rewriteOrigin) headers.origin = rewriteOrigin

  const upstream = http.request({
    host: target.host,
    port: target.port,
    path: '/api/realtime',
    method: 'GET',
    headers,
  })

  let settled = false
  const note = (event) => {
    if (settled && event.outcome === 'upgraded') return
    try { onEvent(event) } catch {}
  }

  upstream.setTimeout(20000, () => {
    note({ outcome: 'upstream-timeout', originalOrigin, sentOrigin: headers.origin })
    try { upstream.destroy() } catch {}
    try { socket.destroy() } catch {}
  })

  upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    note({ outcome: 'upgraded', status: res.statusCode, originalOrigin, sentOrigin: headers.origin })
    settled = true
    const lines = [`HTTP/1.1 101 ${res.statusMessage || 'Switching Protocols'}`]
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
    }
    try {
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
      if (head && head.length) upstreamSocket.write(head)
    } catch {}
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const destroy = () => { upstreamSocket.destroy(); socket.destroy() }
    upstreamSocket.on('error', destroy)
    socket.on('error', destroy)
    upstreamSocket.on('close', destroy)
    socket.on('close', destroy)
  })

  upstream.on('response', (res) => {
    settled = true
    let body = ''
    res.on('data', (chunk) => { if (body.length < 400) body += chunk.toString().slice(0, 200) })
    res.on('end', () => {
      note({
        outcome: 'rejected',
        status: res.statusCode,
        body: body.slice(0, 200),
        originalOrigin,
        sentOrigin: headers.origin,
      })
    })
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`]
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
    }
    try { socket.write(lines.join('\r\n') + '\r\n\r\n') } catch {}
    res.pipe(socket)
  })

  upstream.on('error', (error) => {
    settled = true
    note({ outcome: 'upstream-error', message: String(error && error.message || error).slice(0, 200) })
    try { socket.destroy() } catch {}
  })
  upstream.end()
}
