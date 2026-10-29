import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENTRY = new URL('../node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs', import.meta.url)

/**
 * 管理 qwen-audio-agent Gateway 子进程。
 * - fork 而非 spawn：就绪消息走 IPC（process.send）。
 * - PORT=0：由子进程选端口，父进程从 ready 消息里拿 origin。
 */
export class GatewayProcess {
  constructor({ tunnelUrl, allowedOrigin, log = () => {} } = {}) {
    this.tunnelUrl = tunnelUrl
    this.allowedOrigin = allowedOrigin
    this.log = log
    this.child = null
    this.origin = null
    this.phase = 'stopped'
    this.lastError = null
    this.starting = null
  }

  get ready() { return this.phase === 'ready' }

  resolveAllowedOrigin() {
    const value = this.allowedOrigin
    if (typeof value === 'function') {
      try { return String(value() || '') } catch { return '' }
    }
    return String(value || '')
  }

  async start() {
    if (this.phase === 'ready') return this.origin
    if (this.starting) return this.starting
    this.phase = 'starting'
    this.starting = new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(ENTRY), [], {
        env: {
          ...process.env,
          PORT: '0',
          QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
          QWEN_AUDIO_REALTIME_URL: this.tunnelUrl,
          QWEN_AUDIO_AGENT_BACKEND: 'none',
          QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: this.resolveAllowedOrigin(),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child = child
      const timer = setTimeout(() => {
        this.phase = 'error'
        this.lastError = 'gateway start timeout'
        reject(new Error('gateway start timeout'))
      }, 45_000)

      child.on('message', (msg) => {
        if (msg && msg.type === 'qwen-audio-agent:gateway-ready') {
          clearTimeout(timer)
          this.origin = msg.origin
          this.phase = 'ready'
          this.starting = null
          this.log('gateway ready at', msg.origin)
          resolve(msg.origin)
        }
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.child = null
        this.origin = null
        if (this.phase !== 'stopping') {
          this.phase = 'error'
          this.lastError = 'gateway exited code=' + code + ' signal=' + signal
          reject(new Error(this.lastError))
        }
      })
      child.stderr.on('data', (d) => this.log('[gateway]', String(d).slice(0, 400)))
    })
    return this.starting
  }

  async health() {
    if (!this.origin) return { ok: false, phase: this.phase }
    try {
      const res = await fetch(this.origin + '/api/health')
      const body = await res.json()
      return { ok: res.ok, phase: this.phase, origin: this.origin, body }
    } catch (error) {
      return { ok: false, phase: this.phase, error: String(error).slice(0, 200) }
    }
  }

  async stop() {
    if (!this.child) { this.phase = 'stopped'; return }
    this.phase = 'stopping'
    const child = this.child
    child.kill()
    this.child = null
    this.origin = null
    this.phase = 'stopped'
  }

  status() {
    return { phase: this.phase, origin: this.origin, lastError: this.lastError, pid: this.child?.pid ?? null }
  }
}