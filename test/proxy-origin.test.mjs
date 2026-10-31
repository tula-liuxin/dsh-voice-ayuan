import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { proxyRealtimeUpgrade } from '../lib/ws-proxy.js'

// Only ephemeral, in-process peers: ordinary tests never connect to a user's
// gateway or negotiate a real audio session.
for (const origin of [null, 'null', 'http://dsh-app://x', 'http://127.0.0.1:9999', 'http://example.test']) {
  test(`proxy rewrites Host/Origin and preserves frames: ${origin ?? '(absent)'}`, { timeout: 5000 }, async (t) => {
    const received = []
    const events = []
    const upstream = http.createServer()
    const peers = new WebSocketServer({ server: upstream })
    peers.on('connection', (socket, request) => {
      received.push({ url: request.url, origin: request.headers.origin, host: request.headers.host })
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = upstream.address().port
    const expectedHost = `127.0.0.1:${upstreamPort}`
    const proxy = http.createServer()
    proxy.on('upgrade', (request, socket, head) => proxyRealtimeUpgrade(
      request, socket, head, { host: '127.0.0.1', port: upstreamPort },
      { rewriteOrigin: `http://${expectedHost}`, rewriteHost: expectedHost, onEvent: event => events.push(event) },
    ))
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const client = new WebSocket(`ws://127.0.0.1:${proxy.address().port}/voice-ayuan/rt`, {
      headers: origin === null ? {} : { Origin: origin },
    })
    t.after(async () => {
      client.terminate()
      for (const socket of peers.clients) socket.terminate()
      await Promise.all([
        new Promise(resolve => peers.close(resolve)),
        new Promise(resolve => proxy.close(resolve)),
        new Promise(resolve => upstream.close(resolve)),
      ])
    })
    await once(client, 'open')
    const reply = once(client, 'message')
    client.send('isolated-proxy-check')
    const [data, isBinary] = await reply
    assert.equal(data.toString(), 'isolated-proxy-check')
    assert.equal(isBinary, false)
    assert.deepEqual(received, [{ url: '/api/realtime', origin: `http://${expectedHost}`, host: expectedHost }])
    assert.equal(events[0].outcome, 'upgraded')
    assert.equal(events[0].originalOrigin, origin)
  })
}
