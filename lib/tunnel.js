import { spawn } from 'node:child_process'
import net from 'node:net'

/** 等待本地端口可连接。 */
function waitPort(port, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) reject(new Error('tunnel timeout'))
        else setTimeout(attempt, 400)
      })
    }
    attempt()
  })
}

/** 管理到术影服务器的 SSH 隧道（本地端口 → 远端 8765）。 */
export class SshTunnel {
  constructor({ host, port, user, localPort, remotePort, log = () => {} }) {
    Object.assign(this, { host, port, user, localPort, remotePort, log })
    this.child = null
    this.phase = 'stopped'
  }

  async start() {
    if (this.phase === 'ready') return
    this.phase = 'starting'
    const args = [
      '-N', '-p', String(this.port),
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${this.localPort}:127.0.0.1:${this.remotePort}`,
      `${this.user}@${this.host}`,
    ]
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    child.stderr.on('data', (d) => this.log('[tunnel]', String(d).slice(0, 300)))
    child.on('exit', () => { if (this.phase !== 'stopping') this.phase = 'error' })
    await waitPort(this.localPort)
    this.phase = 'ready'
  }

  stop() {
    this.phase = 'stopping'
    try { this.child?.kill() } catch {}
    this.child = null
    this.phase = 'stopped'
  }

  status() {
    return { phase: this.phase, localPort: this.localPort }
  }
}
