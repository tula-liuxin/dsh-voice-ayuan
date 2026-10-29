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

function b64decodeToFloat32(b64, sampleRate = 24000) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768
  return out
}

function downmixTo16k(samples, inputRate) {
  if (inputRate === 16000) return samples
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

function VoicePanel({ onClose, React, h, anchor }) {
  const { useEffect, useRef, useState } = React
  const [state, setState] = useState('connecting')
  const [detail, setDetail] = useState('')
  const [caption, setCaption] = useState('')
  const clientRef = useRef(null)
  const audioRef = useRef({ ctx: null, queue: [], playing: false, rate: 24000 })
  const streamRef = useRef(null)

  useEffect(() => {
    let disposed = false
    const audio = audioRef.current

    async function start() {
      const res = await fetch('/voice-ayuan/status', { cache: 'no-store' })
      const text = await res.text()
      let status = {}
      try { status = text ? JSON.parse(text) : {} } catch { status = {} }
      if (!res.ok || !status.ok || !status.origin) {
        setState('error')
        setDetail(status.error || (res.ok ? 'Gateway 未就绪，请先启动语音服务' : '宿主插件未加载（重启 DSH 后再试）'))
        return
      }
      const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/voice-ayuan/rt'
      const client = new GatewayClient({
        url: wsUrl,
        createSocket: (url) => new WebSocket(url),
        clientType: 'web',
        clientVersion: '0.1.0',
        clientInstanceId: 'voice-ayuan-' + Math.random().toString(36).slice(2),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        capabilities: ['input.audio', 'session.output_voice'],
        onStatus: (s) => { if (!disposed) setState(s?.state || 'connecting') },
        onEvent: (event) => {
          if (disposed || !event) return
          if (event.type === 'response.output_audio.delta' && event.delta) {
            playPcm(b64decodeToFloat32(event.delta, audio.rate))
          } else if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
            setCaption((c) => (c + event.delta).slice(-120))
          } else if (event.type === 'error') {
            setDetail(JSON.stringify(event).slice(0, 200))
          }
        },
      })
      clientRef.current = client
      client.start()
      await startMic(client)
      if (!disposed) setState('live')
    }

    async function startMic(client) {
      const ctx = new AudioContext()
      audio.ctx = ctx
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const blob = new Blob([WORKLET], { type: 'application/javascript' })
      await ctx.audioWorklet.addModule(URL.createObjectURL(blob))
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'voice-ayuan-capture')
      node.port.onmessage = (event) => {
        const pcm = downmixTo16k(event.data, ctx.sampleRate)
        client.send({ type: 'input_audio_buffer.append', audio: b64encode(pcm) })
      }
      source.connect(node)
    }

    function playPcm(float32) {
      const ctx = audio.ctx
      if (!ctx) return
      const buffer = ctx.createBuffer(1, float32.length, audio.rate)
      buffer.copyToChannel(float32, 0)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()
    }

    start().catch((error) => {
      setState('error')
      setDetail(String(error).slice(0, 200))
    })

    return () => {
      disposed = true
      try { clientRef.current?.stop?.() } catch {}
      try { streamRef.current?.getTracks?.().forEach((t) => t.stop()) } catch {}
      try { audio.ctx?.close?.() } catch {}
    }
  }, [])

  const dot = state === 'live' ? '#2ea043' : state === 'error' ? '#d1242f' : '#bf8700'
  const panelStyle = {
    position: 'fixed', width: 320, zIndex: 9999,
    background: 'var(--dsw-alias-bg-layer-2, #2a2e35)',
    color: 'var(--dsw-alias-label-primary, #e6edf3)',
    border: '1px solid var(--dsw-alias-border-l2, #3a3f45)', borderRadius: 14,
    boxShadow: '0 12px 32px rgba(0,0,0,.45)', padding: 16, fontSize: 13,
    backdropFilter: 'blur(10px)',
  }
  if (anchor) {
    panelStyle.left = Math.min(Math.max(8, anchor.left + anchor.size - 320), Math.max(8, innerWidth - 328))
    panelStyle.top = Math.max(8, anchor.top - 12)
    panelStyle.transform = 'translateY(-100%)'
  } else {
    panelStyle.right = 20
    panelStyle.bottom = 96
  }
  return h('div', { style: panelStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
      h('span', { style: { width: 8, height: 8, borderRadius: 4, background: dot } }),
      h('strong', null, state === 'live' ? '通话中' : state === 'error' ? '连接失败' : '连接中…'),
      h('button', {
        onClick: onClose,
        style: { marginLeft: 'auto', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16 },
      }, '×'),
    ),
    caption ? h('div', { style: { opacity: .85, marginBottom: 6, minHeight: 18 } }, caption) : null,
    detail ? h('div', { style: { color: '#d1242f', fontSize: 12, marginBottom: 6 } }, detail) : null,
    h('div', { style: { opacity: .6, fontSize: 12 } }, '说话即可，支持随时打断。')
  )
}

window.__ModuleLoader__.load({
  id: '@local/voice-ayuan',
  factory(require) {
    const React = require('react')
    const h = React.createElement



    // 跟随阿源的浮动气泡：读它存在 localStorage 的位置，投影到视口后贴在其上方。
    // 读不到（未装阿源）时退回右下角默认位置。
    const BUBBLE_KEY = 'ayuan.bubble-position.v2'
    function bubbleAnchor() {
      try {
        const raw = localStorage.getItem(BUBBLE_KEY)
        if (!raw) return null
        const p = JSON.parse(raw)
        if (!Number.isFinite(p?.rx) || !Number.isFinite(p?.ry)) return null
        const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0))
        const size = window.matchMedia?.('(pointer:coarse)').matches ? 44 : 42
        const y = Math.max(40, Math.min(innerHeight - size - 8, 40 + clamp(p.ry) * Math.max(1, innerHeight - size - 48)))
        const dock = ['left', 'right'].includes(p.dock) ? p.dock : null
        const x = dock === 'left' ? -size / 2
          : dock === 'right' ? innerWidth - size / 2
          : 8 + clamp(p.rx) * Math.max(0, innerWidth - size - 16)
        return { x, y, size, dock }
      } catch { return null }
    }

    // 直接读阿源气泡的 DOM 位置，逐帧跟随：拖动时不再有 localStorage 的 250ms 延迟。
    function useAyuanAnchor() {
      const [rect, setRect] = React.useState(null)
      React.useEffect(() => {
        let raf = 0
        let last = null
        const tick = () => {
          let next = null
          const el = document.querySelector('.ay-yuan-bubble')
          if (el) {
            const r = el.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) next = { x: r.left, y: r.top, size: r.width, dock: null }
          }
          if (!next) next = bubbleAnchor()
          if (next && (!last
            || Math.abs(next.x - last.x) > 0.25
            || Math.abs(next.y - last.y) > 0.25
            || Math.abs(next.size - last.size) > 0.25)) {
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
      const [open, setOpen] = React.useState(false)
      const anchor = useAyuanAnchor()
      const size = 42
      let left = innerWidth - size - 24
      let top = innerHeight - size - 96
      if (anchor) {
        left = Math.min(Math.max(4, anchor.x), innerWidth - size - 4)
        top = anchor.y - size - 8
        if (top < 8) { top = anchor.y; left = Math.max(4, anchor.x - size - 8) }
      }
      return h(React.Fragment, null,
        h('button', {
          type: 'button', title: '阿源语音通话', 'aria-label': '阿源语音通话',
          onClick: () => setOpen((v) => !v),
          style: {
            position: 'fixed', left, top, width: size, height: size,
            padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '50%', border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
            boxShadow: open ? '0 0 0 2px var(--dsw-alias-brand-primary), 0 3px 14px #00000014' : '0 3px 14px #00000014',
            cursor: open ? 'grabbing' : 'grab', zIndex: 10001, lineHeight: 1,
          },
        }, h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M4 5.5C4 4.7 4.7 4 5.5 4h2.2c.7 0 1.3.5 1.5 1.2l.7 2.6c.1.6-.1 1.2-.6 1.5l-1.3.8a12 12 0 0 0 5.6 5.6l.8-1.3c.3-.5.9-.7 1.5-.6l2.6.7c.7.2 1.2.8 1.2 1.5v2.2c0 .8-.7 1.5-1.5 1.5C10.6 19.7 4.3 13.4 4 5.5Z',
            stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round',
          }))),
        open ? h(VoicePanel, { onClose: () => setOpen(false), React, h, anchor: { left, top, size } }) : null,
      )
    }

    function VoiceButton() {
      const [open, setOpen] = React.useState(false)
      return h(React.Fragment, null,
        h('button', {
          type: 'button', title: '阿源语音通话', 'aria-label': '阿源语音通话',
          onClick: () => setOpen((v) => !v),
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
            background: open ? 'var(--dsw-alias-bg-brand, #247bbf)' : 'transparent',
            color: open ? '#fff' : 'inherit', padding: 0,
          },
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M4 5.5C4 4.7 4.7 4 5.5 4h2.2c.7 0 1.3.5 1.5 1.2l.7 2.6c.1.6-.1 1.2-.6 1.5l-1.3.8a12 12 0 0 0 5.6 5.6l.8-1.3c.3-.5.9-.7 1.5-.6l2.6.7c.7.2 1.2.8 1.2 1.5v2.2c0 .8-.7 1.5-1.5 1.5C10.6 19.7 4.3 13.4 4 5.5Z',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
          }))),
        open ? h(VoicePanel, { onClose: () => setOpen(false), React, h }) : null,
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