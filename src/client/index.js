import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'

function b64encode(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function b64decodeToFloat32(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768
  return out
}

function downmixTo16k(samples, inputRate) {
  if (inputRate === 16000) {
    const out = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.max(-1, Math.min(1, samples[i]))
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    return out
  }
  const ratio = inputRate / 16000
  const outLength = Math.floor(samples.length / ratio)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += samples[j]
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return out
}

const WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('voice-ayuan-capture', CaptureProcessor)
`

const BUBBLE_KEY = 'ayuan.bubble-position.v2'

function bubbleFallback() {
  try {
    const raw = localStorage.getItem(BUBBLE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!Number.isFinite(p && p.rx) || !Number.isFinite(p && p.ry)) return null
    const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0))
    const size = window.matchMedia && window.matchMedia('(pointer:coarse)').matches ? 44 : 42
    const y = Math.max(40, Math.min(innerHeight - size - 8, 40 + clamp(p.ry) * Math.max(1, innerHeight - size - 48)))
    const dock = ['left', 'right'].includes(p.dock) ? p.dock : null
    const x = dock === 'left' ? -size / 2 : dock === 'right' ? innerWidth - size / 2 : 8 + clamp(p.rx) * Math.max(0, innerWidth - size - 16)
    return { x, y, size }
  } catch {
    return null
  }
}

function forwardPointer(type, source, target, buttons) {
  if (!target) return
  try {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: source.pointerId, pointerType: source.pointerType || 'mouse',
      isPrimary: true, clientX: source.clientX, clientY: source.clientY,
      button: type === 'pointermove' ? -1 : 0, buttons: buttons ?? (type === 'pointerup' ? 0 : 1),
    }))
  } catch {}
}

function VoicePanel({ onClose, React, h, anchor }) {
  const { useEffect, useRef } = React
  const [state, setState] = React.useState('connecting')
  const [mic, setMic] = React.useState('opening')
  const [diag, setDiag] = React.useState('')
  const [detail, setDetail] = React.useState('')
  const [caption, setCaption] = React.useState('')
  const clientRef = useRef(null)
  const audioRef = useRef({ ctx: null, rate: 24000 })
  const streamRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let disposed = false
    const audio = audioRef.current

    const playPcm = (float32) => {
      const ctx = audio.ctx
      if (!ctx) return
      const buffer = ctx.createBuffer(1, float32.length, audio.rate)
      buffer.copyToChannel(float32, 0)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()
    }

    const startMic = async (client) => {
      const ctx = new AudioContext()
      audio.ctx = ctx
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const send = (float32) => {
        const pcm = downmixTo16k(float32, ctx.sampleRate)
        client.send({ type: 'input_audio_buffer.append', audio: b64encode(pcm) })
      }
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch {} }
      const source = ctx.createMediaStreamSource(stream)
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
        await ctx.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        const node = new AudioWorkletNode(ctx, 'voice-ayuan-capture')
        node.port.onmessage = (event) => send(event.data)
        source.connect(node)
      } catch {
        const node = ctx.createScriptProcessor(4096, 1, 1)
        const mute = ctx.createGain()
        mute.gain.value = 0
        node.onaudioprocess = (event) => send(event.inputBuffer.getChannelData(0))
        source.connect(node)
        node.connect(mute)
        mute.connect(ctx.destination)
      }
    }

    const start = async () => {
      let perm = 'unknown'
      try { perm = (await navigator.permissions.query({ name: 'microphone' })).state } catch {}
      const hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      setDiag('媒体接口 ' + (hasMedia ? '可用' : '缺失') + ' · 麦克风权限 ' + perm + ' · 安全上下文 ' + (window.isSecureContext ? '是' : '否'))
      const res = await fetch('/voice-ayuan/status', { cache: 'no-store' })
      const text = await res.text()
      let status = {}
      try { status = text ? JSON.parse(text) : {} } catch { status = {} }
      if (!res.ok || !status.ok || !status.origin) {
        setState('error')
        setDetail(status.error || (res.ok ? '语音服务未就绪，先在插件里启动服务' : '宿主插件未加载（重启 DSH 后再试）'))
        return
      }
      const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/voice-ayuan/rt'
      const client = new GatewayClient({
        url: wsUrl,
        createSocket: (url) => new WebSocket(url),
        clientType: 'web',
        clientVersion: '0.1.2',
        clientInstanceId: 'voice-ayuan-' + Math.random().toString(36).slice(2),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        capabilities: ['input.audio', 'session.output_voice'],
        onStatus: (s) => { if (disposed) return; const st = (s && s.state) || 'connecting'; if (st === 'ready') setState('ready'); else if (st === 'closed' || st === 'error') setState('error'); else if (st === 'connecting') setState('connecting') },
        onEvent: (event) => {
          if (disposed || !event) return
          if (event.type === 'response.output_audio.delta' && event.delta) {
            playPcm(b64decodeToFloat32(event.delta))
          } else if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
            setCaption((c) => (c + event.delta).slice(-120))
          } else if (event.type === 'error') {
            setDetail(JSON.stringify(event).slice(0, 200))
          }
        },
      })
      clientRef.current = client
      client.start()
      try {
        await startMic(client)
        if (!disposed) { setMic('on'); setState('live') }
      } catch (error) {
        if (!disposed) { setMic('error'); setState('error') }
        setDetail('麦克风不可用：' + (error && error.name ? error.name + ' ' : '') + String(error && error.message ? error.message : error).slice(0, 140))
      }
    }

    start().catch((error) => {
      setState('error')
      setDetail(String(error).slice(0, 200))
    })

    return () => {
      disposed = true
      try { clientRef.current && clientRef.current.stop && clientRef.current.stop() } catch {}
      try { streamRef.current && streamRef.current.getTracks && streamRef.current.getTracks().forEach((t) => t.stop()) } catch {}
      try { audio.ctx && audio.ctx.close && audio.ctx.close() } catch {}
    }
  }, [])

  const dot = state === 'live' ? '#2ea043' : state === 'error' ? '#f85149' : '#d29922'
  const label = state === 'live' ? '通话中' : state === 'error' ? '连接失败' : state === 'ready' ? '已连接，等待麦克风…' : '连接中…'
  const style = {
    position: 'fixed', width: 320, zIndex: 10000, pointerEvents: 'auto',
    background: 'var(--dsw-alias-bg-layer-2, #2a2e35)',
    color: 'var(--dsw-alias-label-primary, #e6edf3)',
    border: '1px solid var(--dsw-alias-border-l2, #3a3f45)', borderRadius: 14,
    boxShadow: '0 12px 32px rgba(0,0,0,.45)', padding: 16, fontSize: 13,
  }
  if (anchor) {
    style.left = Math.min(Math.max(8, anchor.left + anchor.size - 320), Math.max(8, innerWidth - 328))
    style.top = Math.max(8, anchor.top - 12)
    style.transform = 'translateY(-100%)'
  } else {
    style.right = 20
    style.bottom = 96
  }
  return h('div', { style },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      h('span', { style: { width: 8, height: 8, borderRadius: 4, background: dot, flex: 'none' } }),
      h('strong', { style: { color: 'var(--dsw-alias-label-primary, #e6edf3)' } }, label),
      h('button', {
        type: 'button', 'aria-label': '关闭通话',
        onPointerDown: (e) => { e.stopPropagation() },
        onClick: onClose,
        style: {
          marginLeft: 'auto', width: 24, height: 24, borderRadius: 12, lineHeight: '20px',
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #3a3f45)',
          color: 'var(--dsw-alias-label-secondary, #9aa4af)', cursor: 'pointer', fontSize: 14,
        },
      }, '×'),
    ),
    caption ? h('div', { style: { opacity: 0.9, marginBottom: 6, minHeight: 18 } }, caption) : null,
    detail ? h('div', { style: { color: '#f85149', fontSize: 12, marginBottom: 6 } }, detail) : null,
    h('div', { style: { opacity: 0.65, fontSize: 12 } }, '说话即可，随时打断；Esc 关闭。'),
    diag ? h('div', { style: { opacity: 0.45, fontSize: 11, marginTop: 6, wordBreak: 'break-all' } }, diag) : null,
  )
}

window.__ModuleLoader__.load({
  id: '@local/voice-ayuan',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function useBubbleRect() {
      const [rect, setRect] = React.useState(null)
      React.useEffect(() => {
        let raf = 0
        let last = null
        const tick = () => {
          let next = null
          const el = document.querySelector('.ay-yuan-bubble')
          if (el) {
            const r = el.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) next = { x: r.left, y: r.top, size: r.width }
          }
          if (!next) {
            const fb = bubbleFallback()
            if (fb) next = { x: fb.x, y: fb.y, size: fb.size }
          }
          if (next && (!last || Math.abs(next.x - last.x) > 0.25 || Math.abs(next.y - last.y) > 0.25 || Math.abs(next.size - last.size) > 0.25)) {
            last = next
            setRect(next)
          }
          raf = requestAnimationFrame(tick)
        }
        tick()
        return () => cancelAnimationFrame(raf)
      }, [])
      return rect
    }

    function VoiceLauncher() {
      const size = 42
      const [open, setOpen] = React.useState(false)
      const rect = useBubbleRect()
      const dragState = React.useRef(null)
      const [offset, setOffset] = React.useState({ dx: 0, dy: 0 })
      const moved = React.useRef(false)

      const btnRef = React.useRef(null)
      const spot = React.useMemo(() => {
        if (!rect) return { left: innerWidth - size - 24, top: innerHeight - size - 96 }
        const candidates = [
          { dx: -96, dy: 0 }, { dx: -144, dy: 0 }, { dx: -48, dy: 0 }, { dx: 0, dy: -56 },
        ]
        const free = (left, top) => {
          if (left < 4 || top < 4) return false
          if (typeof document.elementFromPoint !== 'function') return true
          const el = document.elementFromPoint(left + size / 2, top + size / 2)
          if (!el || el === document.body || el === document.documentElement) return true
          if (btnRef.current && (el === btnRef.current || btnRef.current.contains(el))) return true
          return false
        }
        for (const c of candidates) {
          const left = rect.x + c.dx
          const top = rect.y + c.dy
          if (free(left, top)) return { left, top }
        }
        return { left: rect.x, top: Math.max(4, rect.y - size - 8) }
      }, [rect && rect.x, rect && rect.y])
      const left = Math.min(Math.max(4, spot.left + offset.dx), innerWidth - size - 4)
      const top = Math.min(Math.max(4, spot.top + offset.dy), innerHeight - size - 4)

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const bubble = document.querySelector('.ay-yuan-bubble')
        dragState.current = {
          startX: event.clientX, startY: event.clientY,
          baseDx: offset.dx, baseDy: offset.dy,
          bubble, forwarded: false,
        }
        moved.current = false
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
      }

      const onPointerMove = (event) => {
        const d = dragState.current
        if (!d) return
        const dx = event.clientX - d.startX
        const dy = event.clientY - d.startY
        if (!moved.current && Math.hypot(dx, dy) < 4) return
        moved.current = true
        if (d.bubble) {
          if (!d.forwarded) {
            forwardPointer('pointerdown', { ...event, clientX: event.clientX, clientY: event.clientY }, d.bubble)
            d.forwarded = true
          }
          forwardPointer('pointermove', event, d.bubble, 1)
        } else {
          setOffset({ dx: d.baseDx + dx, dy: d.baseDy + dy })
        }
      }

      const onPointerUp = (event) => {
        const d = dragState.current
        dragState.current = null
        if (!d) return
        if (d.bubble && d.forwarded) forwardPointer('pointerup', event, d.bubble, 0)
        if (d.bubble && moved.current) {
          d.bubble.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        }
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
      }

      const onClick = () => {
        if (moved.current) { moved.current = false; return }
        setOpen((v) => !v)
      }

      return h(React.Fragment, null,
        h('button', {
          ref: btnRef,
          type: 'button', title: '阿源语音通话（可拖动）', 'aria-label': '阿源语音通话',
          onPointerDown, onPointerMove, onPointerUp, onClick,
          style: {
            position: 'fixed', left, top, width: size, height: size, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '50%', border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
            boxShadow: open ? '0 0 0 2px var(--dsw-alias-brand-primary), 0 3px 14px #00000014' : '0 3px 14px #00000014',
            cursor: 'grab', zIndex: 10001, lineHeight: 1, pointerEvents: 'auto', touchAction: 'none',
          },
        }, h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M4 5.5C4 4.7 4.7 4 5.5 4h2.2c.7 0 1.3.5 1.5 1.2l.7 2.6c.1.6-.1 1.2-.6 1.5l-1.3.8a12 12 0 0 0 5.6 5.6l.8-1.3c.3-.5.9-.7 1.5-.6l2.6.7c.7.2 1.2.8 1.2 1.5v2.2c0 .8-.7 1.5-1.5 1.5C10.6 19.7 4.3 13.4 4 5.5Z',
            stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round',
          }))),
        open ? h(VoicePanel, { onClose: () => setOpen(false), React, h, anchor: { left, top, size } }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'voice-ayuan-launcher', order: 60,
        }, VoiceLauncher))
      },
    }
  },
})