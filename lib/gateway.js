import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_ENTRY = new URL('../node_modules/qwen-audio-agent/server/src/app/bootstrap.mjs', import.meta.url)

/**
 * 管理 qwen-audio-agent Gateway 子进程。
 * - fork 而非 spawn：就绪消息走 IPC（process.send）。
 * - PORT=0：由子进程选端口，父进程从 ready 消息里拿 origin。
 * - 崩溃自动重启（最多 3 次，递增退避），避免一次 OOM 就把通话永久废掉。
 *
 * 注意 realtime provider 的环境变量名：speech-to-speech provider 认的是
 * SPEECH_TO_SPEECH_REALTIME_URL / S2S_REALTIME_URL（见
 * qwen-audio-agent/shared/realtime-provider-definitions.mjs），
 * QWEN_AUDIO_REALTIME_URL 只对 qwen-audio-realtime provider 生效。
 *
 * 可选 bridge 模式（voice-ayuan 的语音任务接入 DSH 当前会话）：
 * - entry 默认 null → fork 官方 bootstrap.mjs，行为与加 bridge 前完全一致；
 * - 传了 entry + bridgeUrl 才换成 bridge/gateway-host.mjs，并把 VOICE_AYUAN_BRIDGE_*
 *   和 extraEnv 注入子进程；其余生命周期逻辑不变。
 */
export class GatewayProcess {
  constructor({
    tunnelUrl,
    allowedOrigin,
    log = () => {},
    entry = null,
    bridgeUrl = null,
    bridgeToken = '',
    extraEnv = null,
  } = {}) {
    this.tunnelUrl = tunnelUrl
    this.allowedOrigin = allowedOrigin
    this.log = log
    this.entry = entry
    this.bridgeUrl = bridgeUrl
    this.bridgeToken = bridgeToken
    this.extraEnv = extraEnv
    this.child = null
    this.origin = null
    this.phase = 'stopped'
    this.lastError = null
    this.starting = null
    this.stopping = false
    this.restartAttempts = 0
  }

  get ready() { return this.phase === 'ready' }

  resolveAllowedOrigin() {
    const value = this.allowedOrigin
    if (typeof value === 'function') {
      try { return String(value() || '') } catch { return '' }
    }
    return String(value || '')
  }

  resolveBridgeUrl() {
    const value = this.bridgeUrl
    if (typeof value === 'function') {
      try { return String(value() || '') } catch { return '' }
    }
    return String(value || '')
  }

  resolveExtraEnv() {
    const value = this.extraEnv
    if (typeof value === 'function') {
      try { return { ...(value() || {}) } } catch { return {} }
    }
    return { ...(value || {}) }
  }

  scheduleRestart() {
    if (this.stopping || this.restartAttempts >= 3) return
    this.restartAttempts += 1
    const delay = 1500 * this.restartAttempts
    const timer = setTimeout(() => {
      if (this.stopping) return
      this.phase = 'stopped'
      this.starting = null
      this.log('gateway restart attempt', this.restartAttempts)
      this.start().catch(() => {})
    }, delay)
    timer.unref?.()
  }

  async start() {
    if (this.phase === 'ready') return this.origin
    if (this.starting) return this.starting
    this.stopping = false
    this.phase = 'starting'
    this.starting = new Promise((resolve, reject) => {
      const bridgeUrl = this.resolveBridgeUrl()
      const entry = this.entry || DEFAULT_ENTRY
      const child = fork(fileURLToPath(entry), [], {
        env: {
          ...process.env,
          PORT: '0',
          QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
          SPEECH_TO_SPEECH_REALTIME_URL: this.tunnelUrl,
          S2S_REALTIME_URL: this.tunnelUrl,
          QWEN_AUDIO_REALTIME_URL: this.tunnelUrl,
          QWEN_AUDIO_AGENT_BACKEND: 'none',
          QWEN_AUDIO_AGENT_ALLOWED_ORIGINS: this.resolveAllowedOrigin(),
          ...(bridgeUrl
            ? {
                VOICE_AYUAN_BRIDGE_URL: bridgeUrl,
                VOICE_AYUAN_BRIDGE_TOKEN: String(this.bridgeToken || ''),
                ...this.resolveExtraEnv(),
              }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child = child
      const timer = setTimeout(() => {
        this.phase = 'error'
        this.lastError = 'gateway start timeout'
        this.starting = null
        reject(new Error('gateway start timeout'))
      }, 45_000)

      child.on('message', (msg) => {
        if (msg && msg.type === 'qwen-audio-agent:gateway-ready') {
          clearTimeout(timer)
          this.origin = msg.origin
          this.phase = 'ready'
          this.starting = null
          this.restartAttempts = 0
          this.log('gateway ready at', msg.origin)
          resolve(msg.origin)
        }
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.child = null
        this.origin = null
        this.starting = null
        if (this.stopping) {
          this.phase = 'stopped'
          return
        }
        this.phase = 'error'
        this.lastError = 'gateway exited code=' + code + ' signal=' + signal
        this.log('[gateway] exited', this.lastError)
        try { reject(new Error(this.lastError)) } catch {}
        this.scheduleRestart()
      })
      child.stdout.on('data', (d) => this.log('[gateway]', String(d).slice(0, 400)))
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
    this.stopping = true
    if (!this.child) { this.phase = 'stopped'; return }
    this.phase = 'stopping'
    const child = this.child
    child.kill()
    this.child = null
    this.origin = null
    this.phase = 'stopped'
    this.starting = null
  }

  status() {
    return {
      phase: this.phase,
      origin: this.origin,
      lastError: this.lastError,
      pid: this.child?.pid ?? null,
      restartAttempts: this.restartAttempts,
      entry: this.entry ? 'bridge' : 'bootstrap',
      bridge: Boolean(this.resolveBridgeUrl()),
    }
  }
}
