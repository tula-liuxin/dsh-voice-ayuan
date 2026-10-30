// 麦克风开关（通话中静音/恢复）的单元测试。
// 覆盖两层：
//   1. 采集引擎 createBrowserAudioEngine：静音后不再上行真实人声（发等长零样本保活）、
//      采集轨道被禁用、本端打断检测关闭；恢复后立即回到真实人声。
//   2. 状态派生 deriveVoiceStatus + 会话对象 createVoiceSession 的 setMuted 接口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserAudioEngine, createVoiceSession } from '../src/client/session.js'
import { deriveVoiceStatus, deriveMicControl } from '../src/client/launcher.js'

const FRAME = 128 // AudioWorklet 每次 128 样本（48kHz ≈ 2.67ms）
const BATCH = 2048

function makeGlobals() {
  const tracks = []
  const stream = { getAudioTracks: () => tracks, getTracks: () => tracks }
  const state = { workletNode: null, ctx: null }
  class FakeCtx {
    constructor() {
      this.sampleRate = 48000
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
      this.audioWorklet = { addModule: async () => {} }
      state.ctx = this
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createBuffer(channels, length, rate) { return { length, duration: length / rate, copyToChannel() {} } }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, onended: null }
    }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null }
      state.workletNode = this
    }
    connect() {}
    disconnect() {}
  }
  const globals = {
    AudioContext: FakeCtx,
    AudioWorkletNode: FakeWorkletNode,
    Blob,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = { enabled: true, stopped: false, stop() { this.stopped = true } }
          tracks.push(track)
          return stream
        },
      },
    },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  }
  return { globals, tracks, state, stream }
}

const frame = (value) => Float32Array.from({ length: FRAME }, () => value)

async function pushFrames(state, count, value) {
  for (let i = 0; i < count; i += 1) state.workletNode.port.onmessage({ data: frame(value) })
}

test('引擎静音：轨道禁用 + 上行零样本，恢复后回到真实人声', async () => {
  const { globals, tracks, state } = makeGlobals()
  const frames = []
  const engine = createBrowserAudioEngine({ globals, onFrame: (batch) => frames.push(batch) })
  assert.equal(engine.muted, false)

  await engine.start()
  assert.ok(state.workletNode, 'AudioWorklet 采集节点应已建立')

  // 未静音：批次里是采集到的真实人声。
  await pushFrames(state, BATCH / FRAME, 0.5)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].length, BATCH)
  assert.ok(frames[0].every((sample) => sample === 0.5))

  // 关麦：轨道 enabled=false；上游收到等长零样本（连接保活，VAD 听不到人声）。
  assert.equal(engine.setMuted(true), true)
  assert.equal(engine.muted, true)
  assert.equal(tracks[0].enabled, false)
  await pushFrames(state, BATCH / FRAME, 0.5)
  assert.equal(frames.length, 2)
  assert.ok(frames[1].every((sample) => sample === 0), '静音期间必须是全零样本')
  assert.equal(tracks[0].enabled, false, '静音期间轨道保持禁用')

  // 开麦：轨道恢复，下一批重新是真实人声。
  assert.equal(engine.toggleMuted(), false)
  assert.equal(tracks[0].enabled, true)
  await pushFrames(state, BATCH / FRAME, 0.5)
  assert.equal(frames.length, 3)
  assert.ok(frames[2].every((sample) => sample === 0.5))

  engine.stop()
})

test('引擎静音：本端打断检测关闭（静音时阿源说话不会被自己的回声/噪声打断）', async () => {
  const { globals, state } = makeGlobals()
  let bargeIns = 0
  const engine = createBrowserAudioEngine({ globals, onFrame: () => {}, onBargeIn: () => { bargeIns += 1 } })
  await engine.start()

  // 播放中 + 静音 + 持续大声：不触发打断（引擎本应把输入当静音）。
  engine.setMuted(true)
  engine.play(Float32Array.from({ length: 4800 }, () => 0.1))
  await pushFrames(state, 40, 0.5) // 40×2.67ms ≈ 107ms，超过 80ms 持续时间阈值
  assert.equal(bargeIns, 0)
  engine.flush()

  // 恢复后同样的声音立刻能触发打断（冷却 600ms 从上次打断算，这里从未打断过）。
  engine.setMuted(false)
  engine.play(Float32Array.from({ length: 4800 }, () => 0.1))
  await pushFrames(state, 40, 0.5)
  assert.equal(bargeIns, 1)

  engine.stop()
})

test('状态派生：静音优先于「通话中」，错误态仍然优先', () => {
  const liveWithCaption = { state: 'live', step: 'voice connected · speech-to-speech', caption: '你说的话' }
  assert.equal(deriveVoiceStatus({ ...liveWithCaption, mic: 'on' }).title, '通话中')

  const muted = deriveVoiceStatus({ ...liveWithCaption, mic: 'on', muted: true })
  assert.equal(muted.title, '麦克风已静音')
  assert.equal(muted.tone, 'muted')
  assert.match(muted.sub, /麦克风/)

  // 连接失败 > 静音：失败必须还能点重试。
  const failed = deriveVoiceStatus({ state: 'error', detail: '突然断开', mic: 'on', muted: true })
  assert.equal(failed.title, '连接失败')
  assert.equal(failed.retry, true)

  // 未静音时保持原有「等待语音服务」文案。
  assert.equal(deriveVoiceStatus({ state: 'live', mic: 'on' }).title, '麦克风已开启，等待语音服务…')
})

test('麦克风胶囊：就绪后可点、静音切换文案/图标/颜色状态，未就绪不可点', () => {
  const opening = deriveMicControl({ mic: 'opening', muted: false })
  assert.equal(opening.disabled, true)
  assert.equal(opening.dataMic, 'opening')
  assert.equal(opening.label, '正在打开麦克风')

  const on = deriveMicControl({ mic: 'on', muted: false })
  assert.equal(on.disabled, false)
  assert.equal(on.dataMic, 'on')
  assert.equal(on.label, '麦克风已开启')
  assert.equal(on.icon, '🎙')
  assert.equal(on.ariaPressed, 'false')
  assert.match(on.hint, /说话即可/)

  // 静音：同一个按钮变成「已关闭 / 🔇 / off / aria-pressed=true / 提示恢复」。
  const off = deriveMicControl({ mic: 'on', muted: true })
  assert.equal(off.disabled, false, '静音状态下仍要能点回来')
  assert.equal(off.dataMic, 'off')
  assert.equal(off.label, '麦克风已关闭')
  assert.equal(off.icon, '🔇')
  assert.equal(off.ariaPressed, 'true')
  assert.match(off.hint, /点麦克风恢复/)

  const failed = deriveMicControl({ mic: 'error', muted: false })
  assert.equal(failed.disabled, true)
  assert.equal(failed.dataMic, 'error')
  assert.equal(failed.label, '麦克风不可用')
})

test('会话接口：setMuted 通知视图侧，并在停止后不再变更', () => {
  const mutedEvents = []
  const session = createVoiceSession({
    report: false,
    onMuted: (value) => mutedEvents.push(value),
  })
  assert.equal(session.muted, false)
  assert.equal(session.setMuted(true), true)
  assert.equal(session.muted, true)
  assert.deepEqual(mutedEvents, [true])
  // 幂等：重复设置不重复通知。
  session.setMuted(true)
  assert.deepEqual(mutedEvents, [true])
  assert.equal(session.toggleMuted(), false)
  assert.equal(session.muted, false)
  assert.deepEqual(mutedEvents, [true, false])

  session.stop()
  assert.equal(session.muted, false)
  assert.equal(session.setMuted(true), false, '已停止的会话不再响应开关')
  assert.deepEqual(mutedEvents, [true, false])
})
