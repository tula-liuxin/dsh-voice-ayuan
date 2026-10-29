// 音频编解码与采集 Worklet：16 kHz / Int16 / base64，供实时语音链路使用。

export function b64encode(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function b64decodeToFloat32(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768
  return out
}

export function downmixTo16k(samples, inputRate) {
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

export const WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('voice-ayuan-capture', CaptureProcessor)
`
