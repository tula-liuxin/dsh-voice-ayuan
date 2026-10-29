import http from 'node:http'

/**
 * 把 DSH webServer 上的 WS 升级请求转发给 Gateway 的 /api/realtime。
 * 让页面与 Gateway 变成同源，绕开跨端口的 origin 校验。
 */
export function proxyRealtimeUpgrade(req, socket, head, target) {
  const headers = { ...req.headers }
  // 保留原始 Host：Gateway 用 Origin 的 host 与请求 Host 比对做同源校验。
  headers.host = req.headers.host

  const upstream = http.request({
    host: target.host,
    port: target.port,
    path: '/api/realtime',
    method: 'GET',
    headers,
  })

  upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 ${res.statusMessage || 'Switching Protocols'}`]
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
    if (head && head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const destroy = () => { upstreamSocket.destroy(); socket.destroy() }
    upstreamSocket.on('error', destroy)
    socket.on('error', destroy)
    upstreamSocket.on('close', destroy)
    socket.on('close', destroy)
  })

  upstream.on('response', (res) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`]
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    res.pipe(socket)
  })

  upstream.on('error', () => socket.destroy())
  upstream.end()
}