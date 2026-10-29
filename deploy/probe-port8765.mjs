// Diagnostic: listen on 127.0.0.1:8765 and log any TCP/HTTP connection.
// Proves whether the Gateway targets the untunneled default endpoint.
import net from 'node:net'
const server = net.createServer((socket) => {
  let data = ''
  const peer = socket.remoteAddress + ':' + socket.remotePort
  console.log(new Date().toISOString(), 'CONNECT from', peer)
  socket.on('data', (chunk) => {
    data += chunk.toString('latin1')
    if (data.includes('\r\n\r\n')) {
      console.log(new Date().toISOString(), 'REQUEST from', peer)
      console.log(data.split('\r\n').slice(0, 12).join('\n'))
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n\r\n')
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => console.log(new Date().toISOString(), 'CLOSE', peer))
})
server.listen(8765, '127.0.0.1', () => console.log('listening 127.0.0.1:8765'))
setTimeout(() => { console.log('timeout'); process.exit(0) }, 25000)
