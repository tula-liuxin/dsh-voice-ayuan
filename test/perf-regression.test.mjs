// 拖动卡顿（通话面板打开时拖动三个悬浮按钮）的性能回归测试。
// 只测纯函数/常量：真正的帧率在实机上报（kind=drag-perf），这里锁住两条结构性优化不被改回去：
//   1. 锚点事件合并：值没变的连续广播不再触发 React 重渲染；
//   2. 采集 Worklet 攒批：每 2048 样本才 postMessage 一次（而不是每 128 样本 ≈ 375 次/秒）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameAnchorSnapshot, readAnchorFromEvent } from '../src/client/launcher.js'
import { WORKLET, MIC_BATCH_SAMPLES } from '../src/client/pcm.js'

const detail = { visible: true, x: 100, y: 200, width: 42, height: 42, dock: null, expanded: false, panelOpen: false }

test('锚点快照：相同广播不触发重渲染，任何几何/状态变化都要触发', () => {
  const a = readAnchorFromEvent(detail)
  const b = readAnchorFromEvent({ ...detail })
  assert.equal(sameAnchorSnapshot(a, b), true)
  assert.equal(sameAnchorSnapshot(null, null), true)
  assert.equal(sameAnchorSnapshot(a, null), false)

  // 拖动中最常见的 1px 位置变化必须被识别（不能把电话冻住）。
  assert.equal(sameAnchorSnapshot(a, readAnchorFromEvent({ ...detail, x: 101 })), false)
  assert.equal(sameAnchorSnapshot(a, readAnchorFromEvent({ ...detail, y: 199 })), false)
  assert.equal(sameAnchorSnapshot(a, readAnchorFromEvent({ ...detail, width: 44 })), false)
  // dock/展开状态变化也必须重算（决定贴边竖排/横排的槽位公式）。
  assert.equal(sameAnchorSnapshot(a, readAnchorFromEvent({ ...detail, dock: 'left' })), false)
  assert.equal(sameAnchorSnapshot(a, readAnchorFromEvent({ ...detail, expanded: true })), false)
  // 非法事件不会产出锚点。
  assert.equal(readAnchorFromEvent({ visible: true, x: 1, y: 2, width: 0, height: 42 }), null)
  assert.equal(readAnchorFromEvent({ visible: false }), null)
})

test('采集 Worklet：攒到 2048 样本才发一次消息（不再是每 128 样本一条）', () => {
  assert.equal(MIC_BATCH_SAMPLES, 2048)
  assert.match(WORKLET, new RegExp('new Float32Array\\(2048\\)'))
  const posts = WORKLET.match(/postMessage\(/g) || []
  assert.equal(posts.length, 1, '每个 process 最多只在攒满时 post 一次')
  assert.doesNotMatch(WORKLET, /postMessage\(channel\.slice/, '不能退回每个渲染量子都 post 的旧写法')
  // 攒批必须真的按采样数累计，而不是只发第一块。
  assert.match(WORKLET, /this\._len \+= n/)
  assert.match(WORKLET, /this\._len === this\._buf\.length/)
})
