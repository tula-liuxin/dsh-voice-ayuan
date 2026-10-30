// 电话按钮几何/不变量 + 分角色字幕的纯函数测试（T6 第二步：四边 dock 跟随 + STT 双栏）。
//
// 实机背景（~/.dsh/voice-ayuan-report.jsonl，2026-10-29 15:19~15:33）：
// 旧实现靠 elementFromPoint + useRow 快照，哥们按钮落在宿主侧栏上方 / 阿源浮层打开 / 快照过期时，
// 电话被推到 (vw-24-size, vh-24-size) 兜底角（用户：「某些位置只剩两个按钮」「话筒 icon 消失」）。
// 现在位置只由 anchor 派生：dock 四边时与鲸鱼贴同一列/行并允许半出屏，非 dock 时占闪电左边一格；
// 读不到 anchor 时保持上一次有效位置，从未拿到过才允许兜底（并计入 fallbackCount 上报）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorFromNeighbors, anchorRect, computeMetrics, computePhoneSpot, createLauncher,
  detachDistance, expectedLightningRect, formatMetricsLine, gapTolerance, intersectArea,
  placePanel, readAnchorFromEvent, readNeighbors, reduceTranscript, settleSpot,
  sameRowState, TRANSCRIPT_LIMIT,
} from '../src/client/launcher.js'

const VIEW = { width: 2048, height: 1104 }
const SIZE = 42
const GAP = 8
const STEP = 50
const PAD = 8

function rect(left, top, width = SIZE, height = SIZE) {
  return { left, top, right: left + width, bottom: top + height, width, height, cx: left + width / 2, cy: top + height / 2 }
}
function el(r) { return { getBoundingClientRect: () => ({ ...r }) } }
function fakeDoc({ ball = null, bubble = null } = {}) {
  return {
    querySelector(selector) {
      if (selector === '.lq-root .lq-ball' || selector === '.lq-ball') return ball ? el(ball) : null
      if (selector === '.lq-root') return ball ? el(ball) : null
      if (selector === '.ay-yuan-bubble') return bubble ? el(bubble) : null
      return null
    },
  }
}
const WIN = { innerWidth: VIEW.width, innerHeight: VIEW.height, matchMedia: () => ({ matches: false }) }
const STYLE = {
  borderRadius: '50%', borderWidth: '0.8px', borderColor: 'rgba(0, 0, 0, 0.1)',
  boxShadow: 'rgba(0, 0, 0, 0.098) 0px 3px 14px 0px', background: 'rgb(255, 255, 255)', color: 'rgb(15, 17, 21)',
}
const anchorOf = (x, y, dock = null, extra = {}) => ({ visible: true, x, y, width: SIZE, height: SIZE, dock, expanded: false, panelOpen: false, ...extra })
const readRow = (doc) => readNeighbors(doc, WIN)

test('readAnchorFromEvent：只接受 visible + 有限坐标；dock 非法值按 null 处理', () => {
  const a = readAnchorFromEvent({ visible: true, x: 2027, y: 725.99, width: 42, height: 42, dock: 'right', expanded: true })
  assert.deepEqual(a, { visible: true, x: 2027, y: 725.99, width: 42, height: 42, dock: 'right', expanded: true, panelOpen: false })
  assert.equal(readAnchorFromEvent({ visible: false, x: 1, y: 2, width: 42, height: 42 }), null)
  assert.equal(readAnchorFromEvent({ visible: true, x: NaN, y: 2, width: 42, height: 42 }), null)
  assert.equal(readAnchorFromEvent({ visible: true, x: 1, y: 2, width: 0, height: 42 }), null)
  assert.equal(readAnchorFromEvent(null), null)
  assert.equal(readAnchorFromEvent({ visible: true, x: 1, y: 2, width: 42, height: 42, dock: 'diagonal' }).dock, null)
})

test('anchorFromNeighbors：DOM 半出屏几何反推 dock；只有闪电时也能反推', () => {
  assert.equal(anchorFromNeighbors(readRow(fakeDoc({ bubble: rect(1543.6, 701.58) }))).dock, null)
  const right = anchorFromNeighbors(readRow(fakeDoc({ bubble: rect(2027, 725.99) })))
  assert.equal(right.dock, 'right')
  assert.equal(right.x, 2027)
  const left = anchorFromNeighbors(readRow(fakeDoc({ bubble: rect(-21, 725.99) })))
  assert.equal(left.dock, 'left')
  const top = anchorFromNeighbors(readRow(fakeDoc({ bubble: rect(900, -21) })))
  assert.equal(top.dock, 'top')
  const onlyBall = anchorFromNeighbors(readRow(fakeDoc({ ball: rect(1493.6, 701.58) })))
  assert.equal(onlyBall.dock, null)
  assert.equal(onlyBall.x, 1543.6) // 闪电在 anchor 左边一格
  assert.equal(onlyBall.y, 701.58)
  const edgeBall = anchorFromNeighbors(readRow(fakeDoc({ ball: rect(2027, 675.99) })))
  assert.equal(edgeBall.dock, 'right')
  assert.equal(edgeBall.y, 725.99) // 闪电在 anchor 上方一格
  assert.equal(anchorFromNeighbors(readRow(fakeDoc({})), null), null)
})

test('computePhoneSpot：非 dock 一排（电话在闪电左边一格，同中线）', () => {
  const spot = computePhoneSpot({ anchor: anchorOf(1543.6, 701.58), view: VIEW })
  assert.equal(spot.mode, 'row')
  assert.equal(spot.side, 'left')
  assert.equal(spot.left, 1543.6 - 2 * STEP)
  assert.equal(spot.left, 1443.6)
  assert.equal(spot.top, 701.58)
  // 左槽出视口（鲸鱼贴左缘）→ 右侧槽位 anchor.x + width + gap + step
  const edge = computePhoneSpot({ anchor: anchorOf(8, 846.38), view: VIEW })
  assert.equal(edge.side, 'right')
  assert.equal(edge.left, 108)
  assert.equal(computePhoneSpot({ anchor: null, view: VIEW }), null)
  assert.equal(computePhoneSpot({ anchor: anchorOf(1, 1, null, { visible: false }), view: VIEW }), null)
})

test('computePhoneSpot：四边 dock —— 贴边那一维不 clamp（允许半出屏）', () => {
  const left = computePhoneSpot({ anchor: anchorOf(-21, 725.99, 'left'), view: VIEW })
  assert.equal(left.mode, 'dock-vertical')
  assert.equal(left.left, -21) // 半出屏
  assert.equal(left.top, 725.99 - 2 * STEP)
  const right = computePhoneSpot({ anchor: anchorOf(2027, 725.99, 'right'), view: VIEW })
  assert.equal(right.left, 2027)
  assert.equal(right.top, 625.99)
  const top = computePhoneSpot({ anchor: anchorOf(900, -21, 'top'), view: VIEW })
  assert.equal(top.mode, 'dock-horizontal')
  assert.equal(top.top, -21) // 半出屏
  assert.equal(top.left, 800)
  const bottom = computePhoneSpot({ anchor: anchorOf(900, 1083, 'bottom'), view: VIEW })
  assert.equal(bottom.top, 1083)
  assert.equal(bottom.left, 800)
  // 贴边方向外的另一维仍然 clamp 进视口（鲸鱼 y 贴顶时电话不能跑出屏幕外）
  const topStack = computePhoneSpot({ anchor: anchorOf(-21, 40, 'left'), view: VIEW })
  assert.equal(topStack.left, -21)
  assert.equal(topStack.top, PAD)
})

test('expectedLightningRect：与 leo-quick anchorPosition 同一套公式（一致性校验用）', () => {
  const normal = expectedLightningRect({ anchor: anchorOf(1543.6, 701.58), view: VIEW })
  assert.equal(normal.left, 1493.6)
  assert.equal(normal.top, 701.58)
  const right = expectedLightningRect({ anchor: anchorOf(2027, 725.99, 'right'), view: VIEW })
  assert.equal(right.left, 2027)
  assert.equal(right.top, 675.99)
  const top = expectedLightningRect({ anchor: anchorOf(900, -21, 'top'), view: VIEW })
  assert.equal(top.left, 850)
  assert.equal(top.top, -21)
  // 真实实机 15:19 几何：鲸鱼(8,846.38)、闪电(58,846.38) 与公式吻合
  const real = expectedLightningRect({ anchor: anchorFromNeighbors(readRow(fakeDoc({ bubble: rect(8, 846.38) }))), view: VIEW })
  assert.equal(real.left, 58)
  assert.equal(real.top, 846.38)
})

test('settleSpot：live 优先；无 anchor 保持上次有效位置；从未测到才兜底', () => {
  const computed = { left: 2027, top: 625.99, mode: 'dock-vertical', side: 'above', dock: 'right' }
  const live = settleSpot(computed, null, VIEW)
  assert.equal(live.source, 'live')
  assert.equal(live.left, 2027)
  const last = { left: 2027, top: 625.99, mode: 'dock-vertical', side: 'above', dock: 'right' }
  const kept = settleSpot(null, last, VIEW)
  assert.equal(kept.source, 'last')
  assert.equal(kept.left, 2027)
  assert.equal(kept.top, 625.99)
  const fallback = settleSpot(null, null, VIEW)
  assert.equal(fallback.source, 'fallback')
  assert.equal(fallback.left, VIEW.width - 24 - SIZE)
  assert.equal(fallback.top, VIEW.height - 24 - SIZE)
})

test('detachDistance：兜底角离锚点 >200px 判掉队；正常槽位 ~100px 不算', () => {
  const anchor = anchorOf(2027, 725.99, 'right')
  const corner = rect(1982, 1038)
  const det = detachDistance(corner, anchorRect(anchor))
  assert.equal(det.detached, true)
  assert.ok(det.distance > 200)
  const spot = computePhoneSpot({ anchor, view: VIEW })
  assert.equal(detachDistance(rect(spot.left, spot.top), anchorRect(anchor)).detached, false)
  assert.equal(detachDistance(null, anchorRect(anchor)).detached, null)
})

test('reduceTranscript：「你说」/「阿源」分角色增量、整段替换、final 合并', () => {
  let state = { user: '', assistant: '', turnId: null, reason: '' }
  state = reduceTranscript(state, { kind: 'delta', role: 'user', content: '你好', turnId: 't1' })
  state = reduceTranscript(state, { kind: 'delta', role: 'user', content: '阿源', turnId: 't1' })
  assert.equal(state.user, '你好阿源')
  assert.equal(state.turnId, 't1')
  state = reduceTranscript(state, { kind: 'delta', role: 'assistant', content: '我在', turnId: 't1' })
  state = reduceTranscript(state, { kind: 'delta', role: 'assistant', content: '呢', turnId: 't1' })
  assert.equal(state.assistant, '我在呢')
  assert.equal(state.user, '你好阿源') // 同一轮两栏并存
  // replace=true：整段替换（上游纠错）
  state = reduceTranscript(state, { kind: 'delta', role: 'user', content: '你好呀', turnId: 't1', replace: true })
  assert.equal(state.user, '你好呀')
  // final 比现有更完整 → 用 final
  state = reduceTranscript(state, { kind: 'final', role: 'user', content: '你好呀，阿源', turnId: 't1' })
  assert.equal(state.user, '你好呀，阿源')
  // final 更短（不完整） → 保留已显示内容，避免闪烁回退
  const keep = reduceTranscript(state, { kind: 'final', role: 'user', content: '你好', turnId: 't1' })
  assert.equal(keep.user, '你好呀，阿源')
})

test('reduceTranscript：新一轮开始清空上一轮（只保留最近一轮）；打断 reset 双栏清空', () => {
  let state = { user: '', assistant: '', turnId: null, reason: '' }
  state = reduceTranscript(state, { kind: 'delta', role: 'user', content: '第一轮问题', turnId: 't1' })
  state = reduceTranscript(state, { kind: 'delta', role: 'assistant', content: '第一轮回答', turnId: 't1' })
  state = reduceTranscript(state, { kind: 'delta', role: 'user', content: '第二轮问题', turnId: 't2' })
  assert.equal(state.user, '第二轮问题')
  assert.equal(state.assistant, '')
  assert.equal(state.turnId, 't2')
  const reset = reduceTranscript(state, { kind: 'reset', reason: 'barge-in' })
  assert.equal(reset.user, '')
  assert.equal(reset.assistant, '')
  assert.equal(reset.reason, 'barge-in')
  const discarded = reduceTranscript({ ...state, assistant: '答案' }, { kind: 'discard', role: 'user', turnId: 't2' })
  assert.equal(discarded.user, '')
  assert.equal(discarded.assistant, '答案')
  // 超长文本只保留尾巴
  const long = reduceTranscript({ user: '', assistant: '', turnId: 't9' }, { kind: 'delta', role: 'assistant', content: 'x'.repeat(TRANSCRIPT_LIMIT.assistant + 100), turnId: 't9' })
  assert.equal(long.assistant.length, TRANSCRIPT_LIMIT.assistant)
})

test('computeMetrics：实机 15:19 几何（鲸鱼 8/闪电 58）按契约恢复成右侧槽位且 PASS', () => {
  const row = readRow(fakeDoc({ ball: rect(58, 846.38), bubble: rect(8, 846.38) }))
  const anchor = anchorFromNeighbors(row)
  const spot = computePhoneSpot({ anchor, view: VIEW })
  assert.equal(spot.side, 'right')
  assert.equal(spot.left, 108)
  const metrics = computeMetrics({
    view: VIEW,
    phone: rect(spot.left, spot.top),
    phoneStyle: STYLE,
    ball: row.ball,
    ballStyle: STYLE,
    bubble: row.bubble,
    bubbleStyle: STYLE,
    bubbleVisible: true,
    gap: row.gap,
    anchor,
    anchorSource: 'derived',
  })
  assert.equal(metrics.mode, 'row')
  assert.equal(metrics.invariants.expectedSlot, true, JSON.stringify(metrics.invariants))
  assert.equal(metrics.invariants.sameBaseline, true)
  assert.equal(metrics.invariants.stackGap, true)
  assert.equal(metrics.invariants.anchorNearby, true)
  assert.equal(metrics.pass, true, formatMetricsLine(metrics))
})

test('computeMetrics：dock right 半出屏竖排 —— 与鲸鱼同 x ≠ clamp，不变量 PASS', () => {
  const anchor = anchorOf(2027, 725.99, 'right')
  const spot = computePhoneSpot({ anchor, view: VIEW })
  const lightning = expectedLightningRect({ anchor, view: VIEW })
  const metrics = computeMetrics({
    view: VIEW,
    phone: rect(spot.left, spot.top),
    phoneStyle: STYLE,
    ball: lightning,
    ballStyle: STYLE,
    bubble: rect(2027, 725.99),
    bubbleStyle: STYLE,
    bubbleVisible: true,
    anchor,
    anchorSource: 'event',
  })
  assert.equal(metrics.mode, 'dock-vertical')
  assert.equal(metrics.dock, 'right')
  assert.equal(metrics.dockFixedX, 0) // 电话.x == 鲸鱼.x（旧的 clamp 到 1998 会在这里 FAIL）
  assert.equal(metrics.invariants.dockFixedX, true)
  assert.equal(metrics.invariants.lightningStep, true)
  assert.equal(metrics.invariants.inViewport, true) // 允许沿贴边方向半出屏
  assert.equal(metrics.pass, true, formatMetricsLine(metrics))
  assert.match(formatMetricsLine(metrics), /贴边竖排/)
})

test('computeMetrics：dock top 半出屏横排 —— 与鲸鱼同 y，不变量 PASS', () => {
  const anchor = anchorOf(900, -21, 'top')
  const spot = computePhoneSpot({ anchor, view: VIEW })
  const lightning = expectedLightningRect({ anchor, view: VIEW })
  const metrics = computeMetrics({
    view: VIEW,
    phone: rect(spot.left, spot.top),
    phoneStyle: STYLE,
    ball: lightning,
    ballStyle: STYLE,
    bubble: rect(900, -21),
    bubbleStyle: STYLE,
    bubbleVisible: true,
    anchor,
    anchorSource: 'event',
  })
  assert.equal(metrics.mode, 'dock-horizontal')
  assert.equal(metrics.dockFixedY, 0)
  assert.equal(metrics.invariants.dockFixedY, true)
  assert.equal(metrics.invariants.lightningStep, true)
  assert.equal(metrics.pass, true, formatMetricsLine(metrics))
  assert.match(formatMetricsLine(metrics), /贴边横排/)
})

test('computeMetrics：1 个物理像素的兄弟按钮取整噪声不再误报 FAIL（实机 7.2px 案例）', () => {
  // dpr 1.25 时一个物理像素 = 0.8 CSS px：闪电和电话是两个插件各自的 DOM 盒子，paint 吸附方向可能不同。
  assert.equal(gapTolerance(1), 1.25)
  assert.equal(gapTolerance(1.25), 1.05)
  assert.equal(gapTolerance(2), 0.75)
  assert.equal(gapTolerance(0), 1.25)
  assert.equal(gapTolerance(NaN), 1.25)

  const anchor = anchorOf(800, 500)
  const spot = computePhoneSpot({ anchor, view: VIEW })
  const expected = expectedLightningRect({ anchor, view: VIEW })
  const args = {
    view: VIEW,
    phone: rect(spot.left, spot.top),
    phoneStyle: STYLE,
    ball: rect(expected.left + 0.8, expected.top),
    ballStyle: STYLE,
    bubble: rect(anchor.x, anchor.y),
    bubbleStyle: STYLE,
    bubbleVisible: true,
    anchor,
    anchorSource: 'event',
  }
  const snapped = computeMetrics({ ...args, dpr: 1.25 })
  assert.equal(snapped.mode, 'row')
  assert.equal(snapped.stackGap, 8.8)
  assert.equal(snapped.gapTolerance, 1.05)
  assert.equal(snapped.invariants.stackGap, true)
  assert.equal(snapped.invariants.expectedSlot, true)
  assert.equal(snapped.pass, true, formatMetricsLine(snapped))
  assert.match(formatMetricsLine(snapped), /亚像素取整/)

  // 闪电压根没落位（2px 偏移）仍然要 FAIL，容差不能把真问题吃掉。
  const misaligned = computeMetrics({ ...args, ball: rect(expected.left + 2, expected.top), dpr: 1.25 })
  assert.equal(misaligned.invariants.stackGap, false)
  assert.equal(misaligned.pass, false)
})

test('computeMetrics：实机兜底态会被检出（anchorNearby=false、指标行含「掉队」）', () => {
  const anchor = anchorOf(2027, 725.99, 'right')
  const metrics = computeMetrics({
    view: VIEW,
    phone: rect(1982, 1038),
    phoneStyle: STYLE,
    ball: expectedLightningRect({ anchor, view: VIEW }),
    ballStyle: STYLE,
    bubble: rect(2027, 725.99),
    bubbleStyle: STYLE,
    bubbleVisible: true,
    anchor,
    anchorSource: 'fallback',
    fallbackCount: 2,
  })
  assert.ok(metrics.anchorDistance > 200)
  assert.equal(metrics.invariants.anchorNearby, false)
  assert.equal(metrics.pass, false)
  assert.match(formatMetricsLine(metrics), /掉队/)
  assert.equal(metrics.anchorSource, 'fallback')
  assert.equal(metrics.fallbackCount, 2)
})

test('computeMetrics：没有 anchor 时退化为按 DOM 邻居推导，不崩溃', () => {
  const row = readRow(fakeDoc({ ball: rect(1493.6, 701.58), bubble: rect(1543.6, 701.58) }))
  const spot = computePhoneSpot({ anchor: anchorFromNeighbors(row), view: VIEW })
  const metrics = computeMetrics({
    view: VIEW,
    phone: rect(spot.left, spot.top),
    phoneStyle: STYLE,
    ball: row.ball,
    ballStyle: STYLE,
    bubble: row.bubble,
    bubbleStyle: STYLE,
    bubbleVisible: true,
    gap: row.gap,
  })
  assert.equal(metrics.mode, 'row')
  assert.equal(metrics.anchorSource, 'derived')
  assert.equal(metrics.invariants.expectedSlot, true, JSON.stringify(metrics.invariants))
  assert.equal(metrics.pass, true, formatMetricsLine(metrics))
  const empty = computeMetrics({ view: VIEW, phone: rect(1982, 1038), phoneStyle: STYLE, bubbleVisible: false })
  assert.equal(empty.anchor, null)
  assert.equal(empty.invariants.expectedSlot, null)
})

test('面板避让：浮层打开时面板不压浮层、不出视口、在按钮排上方', () => {
  const anchor = anchorOf(1543.6, 701.58)
  const spot = computePhoneSpot({ anchor, view: VIEW })
  const phone = rect(spot.left, spot.top)
  const lightning = expectedLightningRect({ anchor, view: VIEW })
  const floatRect = rect(1404, 360, 620, 720)
  const box = placePanel({
    row: { ball: lightning, bubble: rect(1543.6, 701.58, 42, 42) },
    view: VIEW, width: 360, height: 280,
    avoidRects: [{ kind: 'float', rect: floatRect }],
    rowRects: [lightning, rect(1543.6, 701.58), phone],
  })
  assert.ok(box)
  assert.equal(intersectArea(box, floatRect), 0)
  assert.ok(box.left >= 12 - 0.01 && box.top >= 12 - 0.01)
  assert.ok(box.right <= VIEW.width - 12 + 0.01 && box.bottom <= VIEW.height - 12 + 0.01)
  assert.ok(box.bottom <= 701.58 - 10 + 0.01)
  const panel = { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
  const metrics = computeMetrics({
    view: VIEW, phone, phoneStyle: STYLE, ball: lightning, ballStyle: STYLE,
    bubble: rect(1543.6, 701.58), bubbleStyle: STYLE, bubbleVisible: true,
    avoidRects: [{ kind: 'float', rect: floatRect }],
    panel,
    panelStyle: { maxHeight: String(box.maxHeight) + 'px' },
    anchor,
    anchorSource: 'event',
  })
  assert.equal(metrics.invariants.panelNoOverlapFloat, true)
  assert.equal(metrics.invariants.panelInViewport, true)
  assert.equal(metrics.pass, true, formatMetricsLine(metrics))
})

test('readNeighbors / sameRowState 仍工作（假 DOM）', () => {
  const doc = fakeDoc({ ball: rect(1493.6, 701.58), bubble: rect(1543.6, 701.58) })
  const row = readRow(doc)
  assert.equal(row.sameRow, true)
  assert.equal(row.gap, GAP)
  assert.equal(sameRowState(row, readRow(doc)), true)
  assert.equal(sameRowState(row, readRow(fakeDoc({ ball: rect(1400, 700), bubble: rect(1543.6, 701.58) }))), false)
})

test('createLauncher 工厂可用（防打包后引用错误）', () => {
  const React = {
    createElement: () => null,
    Fragment: 'fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
  assert.equal(typeof createLauncher({ React, h: React.createElement }), 'function')
})
