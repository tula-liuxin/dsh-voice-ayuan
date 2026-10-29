import { spawn } from 'node:child_process'
import net from 'node:net'

/** 等待本地端口可连接。 */
function waitPort(port, timeoutMs = 20000) {
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

/**
 * 管理到服务器的 SSH 隧道（本地端口 → 远端真实语音服务端口）。
 * ssh 非正常退出时按 2s/4s/6s 退避自动重连（最多 3 次），避免网络抖一下就把通话永久废掉。
 */
export class SshTunnel {
  constructor({ host, port, user, localPort, remotePort, log = () => {} }) {
    Object.assign(this, { host, port, user, localPort, remotePort, log })
    this.child = null
    this.phase = 'stopped'
    this.stopping = false
    this.restartAttempts = 0
    this.starting = null
  }

  scheduleRestart() {
    if (this.stopping || this.restartAttempts >= 3) return
    this.restartAttempts += 1
    const timer = setTimeout(() => {
      if (this.stopping) return
      this.phase = 'stopped'
      this.log('tunnel restart attempt', this.restartAttempts)
      this.start().catch(() => {})
    }, 2000 * this.restartAttempts)
    timer.unref?.()
  }

  async start() {
    if (this.phase === 'ready') return
    if (this.starting) return this.starting
    this.stopping = false
    this.phase = 'starting'
    this.starting = (async () => {
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
      child.on('exit', (code) => {
        this.child = null
        this.starting = null
        if (this.stopping) { this.phase = 'stopped'; return }
        this.phase = 'error'
        this.log('[tunnel] exited code=' + code)
        this.scheduleRestart()
      })
      await waitPort(this.localPort)
      this.phase = 'ready'
      this.restartAttempts = 0
      this.starting = null
      this.log('tunnel ready on', this.localPort)
    })()
    try {
      await this.starting
    } catch (error) {
      this.phase = 'error'
      this.starting = null
      this.log('[tunnel] start failed', String(error).slice(0, 200))
      this.scheduleRestart()
      throw error
    }
  }

  stop() {
    this.stopping = true
    this.phase = 'stopping'
    try { this.child?.kill() } catch {}
    this.child = null
    this.starting = null
    this.phase = 'stopped'
  }

  status() {
    return { phase: this.phase, localPort: this.localPort, restartAttempts: this.restartAttempts }
  }
}
