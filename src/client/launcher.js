// 电话悬浮按钮 + 通话面板（视图层）。
// 连接/音频全部通过 session.js 的 createVoiceSession 驱动；这里只负责几何、样式与呈现。
//
// 几何与外观真值（详见 design/launcher-spec.md）：
//   - 闪电按钮 = leo-quick-launcher 的 .lq-ball：42x42、border 1px border-l2、radius 50%、
//     bg-base、box-shadow 0 3px 14px #00000019、hover/[aria-expanded=true] 换 bg-layer-2、
//     focus-visible outline 2px brand-primary、pointer:coarse 44。
//   - 鲸鱼按钮 = ayuan .ay-yuan-bubble：42x42、同 border、radius 50%、shadow 0 3px 14px #00000014。
//   - 电话按钮 = 这排按钮的第二个槽位：放在闪电左边 gap=8、同垂直中线；没有闪电时放鲸鱼左边。
//   - open 态绝不加描边/黑圈（brand-primary 近黑，会变成用户说的「黑边」），只沿用 [aria-expanded] 换底色。
import { createVoiceSession } from './session.js'

// ---------------------------------------------------------------------------
// 常量（来自 .lq-ball / anchorPosition，见 design/launcher-spec.md §1.1）
// ---------------------------------------------------------------------------
const DEFAULT_BALL = 42
const COARSE_BALL = 44
const DEFAULT_GAP = 8
const PAD = 8
const PANEL_MAX_WIDTH = 360
const PANEL_GAP = 10
const PANEL_MARGIN = 12
const PANEL_Z = 120
const BUTTON_Z = 121
const REPORT_URL = '/voice-ayuan/report'
const BUBBLE_KEY = 'ayuan.bubble-position.v2'
const PHONE_PATH = 'M4 5.5C4 4.7 4.7 4 5.5 4h2.2c.7 0 1.3.5 1.5 1.2l.7 2.6c.1.6-.1 1.2-.6 1.5l-1.3.8a12 12 0 0 0 5.6 5.6l.8-1.3c.3-.5.9-.7 1.5-.6l2.6.7c.7.2 1.2.8 1.2 1.5v2.2c0 .8-.7 1.5-1.5 1.5C10.6 19.7 4.3 13.4 4 5.5Z'

const CSS = [
  // --- 电话按钮：逐条抄 .lq-ball，不另造数值 ---
  '.va-phone{position:fixed;box-sizing:border-box;display:grid;place-items:center;width:42px;height:42px;padding:0;border:1px solid var(--dsw-alias-border-l2,#dedfe4);border-radius:50%;color:var(--dsw-alias-brand-primary,#506be2);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 3px 14px #00000019;cursor:grab;touch-action:none;user-select:none;line-height:1;z-index:' + BUTTON_Z + ';pointer-events:auto;font:inherit}',
  '.va-phone:active{cursor:grabbing}',
  '.va-phone:hover,.va-phone[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2,#f3f5fa)}',
  '.va-phone:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#506be2);outline-offset:2px}',
  '@media (pointer:coarse){.va-phone{width:44px;height:44px}}',
  // --- 面板：豆包式三段（状态/波形/字幕/麦克风），主题 token，禁止黑底黑字 ---
  '.va-panel{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:14px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 12px 40px #0002;font-size:13px;line-height:1.5;z-index:' + PANEL_Z + ';pointer-events:auto;overflow-y:auto;overflow-x:hidden}',
  '.va-panel__head{display:flex;align-items:center;gap:8px;flex:none;min-width:0}',
  '.va-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary,#d29922)}',
  '.va-panel[data-state=live] .va-dot{background:var(--dsw-alias-state-success-primary,#2ea043);animation:va-breathe 1.8s ease-in-out infinite}',
  '.va-panel[data-state=error] .va-dot{background:var(--dsw-alias-state-error-primary,#f85149)}',
  '.va-panel[data-state=ready] .va-dot{background:var(--dsw-alias-state-business-primary,#4176e6)}',
  '.va-panel[data-state=reconnecting] .va-dot{animation:va-breathe 1.2s ease-in-out infinite}',
  '@keyframes va-breathe{0%,100%{opacity:.5;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}',
  '.va-panel__title{display:flex;flex-direction:column;min-width:0;gap:1px;flex:1 1 auto}',
  '.va-panel__title strong{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.va-panel__title span{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.va-close{margin-left:auto;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;font:inherit;font-size:14px;line-height:1;flex:none}',
  '.va-close:hover{background:var(--dsw-alias-bg-layer-2,#f3f5fa);color:var(--dsw-alias-label-primary,#0f1115)}',
  '.va-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:2px}',
  '.va-wave{display:flex;align-items:center;justify-content:center;gap:3px;height:26px;flex:none;color:var(--dsw-alias-brand-primary,#0f1115);opacity:.5}',
  '.va-wave span{width:3px;height:8px;border-radius:2px;background:currentColor;transform-origin:center;animation:va-wave 1.1s ease-in-out infinite}',
  '.va-wave span:nth-child(2){animation-delay:.12s}.va-wave span:nth-child(3){animation-delay:.24s}.va-wave span:nth-child(4){animation-delay:.36s}.va-wave span:nth-child(5){animation-delay:.48s}',
  '.va-panel[data-state=live] .va-wave{opacity:1}',
  '.va-panel[data-state=error] .va-wave{opacity:.35}.va-panel[data-state=error] .va-wave span{animation:none;height:6px}',
  '.va-panel[data-state=ready] .va-wave{opacity:.7}',
  '@keyframes va-wave{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(2.2)}}',
  '.va-caption{flex:1 1 auto;min-height:40px;max-height:132px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere}',
  '.va-caption[data-empty=true]{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}',
  '.va-foot{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}',
  '.va-mic{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;line-height:18px;white-space:nowrap}',
  '.va-mic[data-mic=on]{color:var(--dsw-alias-state-success-primary,#2ea043)}',
  '.va-mic[data-mic=error]{color:var(--dsw-alias-state-error-primary,#f85149)}',
  '.va-retry{display:inline-flex;align-items:center;justify-content:center;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:11px;line-height:18px;cursor:pointer}',
  '.va-retry:hover{background:var(--dsw-alias-bg-layer-2,#f3f5fa)}',
  '.va-retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:2px}',
  '.va-hint{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
  '.va-diag{flex:none;border-top:1px solid var(--dsw-alias-border-l2,#0000001a);padding-top:8px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;line-height:1.55}',
  '.va-diag summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#61666b);font-size:11px;outline:none}',
  '.va-diag summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:2px;border-radius:4px}',
  '.va-metric{margin-top:4px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;word-break:break-all}',
  '.va-metric[data-pass=false]{color:var(--dsw-alias-state-error-primary,#f85149)}',
  '.va-metric[data-pass=true]{color:var(--dsw-alias-state-success-primary,#2ea043)}',
  '.va-diag__line{word-break:break-all;margin-top:2px}',
  '.va-diag__error{color:var(--dsw-alias-state-error-primary,#f85149);word-break:break-all;margin-top:2px}',
  '@media (prefers-reduced-motion:reduce){.va-wave span,.va-panel[data-state=live] .va-dot{animation:none}}',
].join('\n')

// ---------------------------------------------------------------------------
// 小工具（纯函数，无 DOM 依赖的放在前面，便于 Node 单测）
// ---------------------------------------------------------------------------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round2 = (n) => Math.round(n * 100) / 100
const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export function intersectArea(a, b) {
  if (!a || !b) return 0
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

function insideViewport(rect, view, margin = 0) {
  if (!rect) return null
  return rect.left >= margin - 0.01 && rect.top >= margin - 0.01 &&
    rect.right <= view.width - margin + 0.01 && rect.bottom <= view.height - margin + 0.01
}

export function bubbleFallback() {
  try {
    const raw = localStorage.getItem(BUBBLE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!Number.isFinite(p && p.rx) || !Number.isFinite(p && p.ry)) return null
    const unit = (n) => Math.max(0, Math.min(1, Number(n) || 0))
    const size = window.matchMedia && window.matchMedia('(pointer:coarse)').matches ? COARSE_BALL : DEFAULT_BALL
    const y = Math.max(40, Math.min(innerHeight - size - 8, 40 + unit(p.ry) * Math.max(1, innerHeight - size - 48)))
    const dock = ['left', 'right'].includes(p.dock) ? p.dock : null
    const x = dock === 'left' ? -size / 2 : dock === 'right' ? innerWidth - size / 2 : 8 + unit(p.rx) * Math.max(0, innerWidth - size - 16)
    return { left: x, top: y, right: x + size, bottom: y + size, width: size, height: size, cx: x + size / 2, cy: y + size / 2 }
  } catch {
    return null
  }
}

function defaultBallSize(win) {
  try {
    return win.matchMedia && win.matchMedia('(pointer:coarse)').matches ? COARSE_BALL : DEFAULT_BALL
  } catch {
    return DEFAULT_BALL
  }
}

// 读邻居按钮真值：闪电优先（电话就在它左边一格），其次鲸鱼，再次 localStorage 复算。
export function readNeighbors(doc, win) {
  const q = (selector) => (doc && typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null)
  const ballEl = q('.lq-root .lq-ball') || q('.lq-ball') || q('.lq-root')
  const bubbleEl = q('.ay-yuan-bubble')
  const ball = rectFromElement(ballEl)
  const bubble = rectFromElement(bubbleEl)
  const view = { width: win.innerWidth, height: win.innerHeight }
  // 布局模式：闪电与鲸鱼中线差 > 20px 视为 column（阿源 dock 分支把闪电排到鲸鱼上方/下方），
  // 否则视为 row（同一排，电话占闪电左边一格）。
  const sameRow = ball && bubble ? Math.abs(ball.cy - bubble.cy) <= 20 : false
  let gap = DEFAULT_GAP
  if (ball && bubble && sameRow) {
    const measured = bubble.left - ball.right
    if (measured >= -0.5 && measured <= 40) gap = Math.round(measured * 2) / 2
  }
  const fallback = !ball && !bubble ? bubbleFallback() : null
  return { ball, bubble, sameRow, gap, view, fallback, ballEl, bubbleEl }
}

function sameRect(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(a.left - b.left) <= 0.25 && Math.abs(a.top - b.top) <= 0.25 &&
    Math.abs(a.width - b.width) <= 0.25 && Math.abs(a.height - b.height) <= 0.25
}

export function sameRowState(a, b) {
  if (!a || !b) return false
  return a.gap === b.gap && a.view.width === b.view.width && a.view.height === b.view.height &&
    sameRect(a.ball, b.ball) && sameRect(a.bubble, b.bubble) && sameRect(a.fallback, b.fallback)
}

// ---------------------------------------------------------------------------
// 槽位算法（可单测）：phone.left = anchor.left - gap - size，同垂直中线
// ---------------------------------------------------------------------------
export function computeSpot({ anchor = null, phoneSize = DEFAULT_BALL, gap = DEFAULT_GAP, mode = 'row', view, free = null }) {
  const pad = PAD
  const maxLeft = Math.max(pad, view.width - phoneSize - pad)
  const maxTop = Math.max(pad, view.height - phoneSize - pad)
  const candidates = []
  const strict = (left, top, m, s) => candidates.push({ left, top, mode: m, side: s, strict: true })
  if (anchor) {
    if (mode === 'column') {
      // column（阿源 dock）：电话直接叠在闪电同一 x、上方一格；上方出界 → 下方一格；再不行才 clamp。
      strict(anchor.left, anchor.top - gap - phoneSize, 'column', 'above')
      strict(anchor.left, anchor.bottom + gap, 'column', 'below')
      candidates.push({
        left: clamp(anchor.left, pad, maxLeft),
        top: clamp(anchor.top - gap - phoneSize, pad, maxTop),
        mode: 'column',
        side: 'clamped',
        strict: false,
      })
    } else {
      // row：电话 = 闪电左边一格、同垂直中线。左边真的出界时保持同 gap 放右边；再不行才 dock 兜底。
      const top = anchor.top + (anchor.height - phoneSize) / 2
      strict(anchor.left - gap - phoneSize, top, 'row', 'left')
      strict(anchor.right + gap, top, 'row', 'right')
    }
  }
  candidates.push({ left: view.width - 24 - phoneSize, top: view.height - 24 - phoneSize, mode: 'row', side: 'dock', strict: false })
  for (const candidate of candidates) {
    const left = clamp(candidate.left, pad, maxLeft)
    const top = clamp(candidate.top, pad, maxTop)
    const clamped = Math.abs(left - candidate.left) > 0.01 || Math.abs(top - candidate.top) > 0.01
    if (candidate.strict && clamped) continue
    if (free && !free(left, top, phoneSize)) continue
    return { left, top, mode: candidate.mode, side: candidate.side, clamped }
  }
  return { left: maxLeft, top: maxTop, mode: 'row', side: 'dock', clamped: true }
}

// ---------------------------------------------------------------------------
// 面板避让算法（可单测）：优先按钮排上方、右缘对齐鲸鱼右缘；被阿源浮层/闪电菜单挡住就换位。
// ---------------------------------------------------------------------------
export function placePanel({ row = null, view, width = PANEL_MAX_WIDTH, height = 280, avoidRects = [], rowRects = [] }) {
  const margin = PANEL_MARGIN
  const gap = PANEL_GAP
  const panelWidth = Math.max(220, Math.min(width, view.width - margin * 2))
  // 边界 = 闪电 + 鲸鱼 + 电话（rowRects 传入）的并集：column 模式下电话在闪电上方，面板必须让开电话。
  const rowPair = [...(row ? [row.ball, row.bubble] : []), ...rowRects].filter(Boolean)
  const rowRight = rowPair.length ? Math.max(...rowPair.map((r) => r.right)) : view.width - 24
  const rowTop = rowPair.length ? Math.min(...rowPair.map((r) => r.top)) : view.height - 24
  const rowBottom = rowPair.length ? Math.max(...rowPair.map((r) => r.bottom)) : view.height - 24
  const right = Math.min(rowRight, view.width - margin)
  const aboveMaxH = Math.max(80, rowTop - gap - margin)
  const belowMaxH = Math.max(80, view.height - margin - (rowBottom + gap))
  const sideMaxH = Math.max(80, view.height - margin * 2)
  const candidates = []
  const push = (mode, left, bottomEdge, maxHeight) => {
    const h = Math.min(height, maxHeight)
    candidates.push({ mode, left, top: bottomEdge - h, h, maxHeight })
  }
  push('above-row', right - panelWidth, rowTop - gap, aboveMaxH)
  for (let shift = 48; shift <= panelWidth - 48; shift += 48) {
    push('above-row-shift', right - panelWidth - shift, rowTop - gap, aboveMaxH)
  }
  for (const item of avoidRects) {
    const a = item && item.rect ? item.rect : item
    if (!a) continue
    push('above-avoid', Math.min(right - panelWidth, a.right - panelWidth), a.top - gap, aboveMaxH)
    candidates.push({ mode: 'left-of-avoid', left: a.left - gap - panelWidth, top: Math.min(rowTop - gap, a.bottom) - Math.min(height, sideMaxH), h: Math.min(height, sideMaxH), maxHeight: sideMaxH })
    candidates.push({ mode: 'beside-avoid', left: a.left - gap - panelWidth, top: a.top, h: Math.min(height, sideMaxH), maxHeight: sideMaxH })
  }
  push('above-row-left', margin, rowTop - gap, aboveMaxH)
  candidates.push({ mode: 'below-row', left: right - panelWidth, top: rowBottom + gap, h: Math.min(height, belowMaxH), maxHeight: belowMaxH })
  const blockers = [...avoidRects.map((item) => (item && item.rect ? item.rect : item)), ...rowRects].filter(Boolean)
  const modeCost = {
    'above-row': 0, 'above-row-shift': 1, 'above-avoid': 2, 'left-of-avoid': 3,
    'beside-avoid': 4, 'above-row-left': 5, 'below-row': 6,
  }
  let best = null
  for (const c of candidates) {
    const effH = c.h
    const left = clamp(c.left, margin, Math.max(margin, view.width - margin - panelWidth))
    const top = clamp(c.top, margin, Math.max(margin, view.height - margin - effH))
    const rect = { left, top, right: left + panelWidth, bottom: top + effH, width: panelWidth, height: effH }
    let overlap = 0
    for (const blocker of blockers) overlap += intersectArea(rect, blocker)
    const crampedAbove = aboveMaxH < 160 && String(c.mode).indexOf('above') === 0
    const score = overlap * 1000 + (modeCost[c.mode] ?? 9) + (crampedAbove ? 8 : 0) + (Math.abs(left - (right - panelWidth)) <= 0.5 ? 0 : 0.4)
    if (!best || score < best.score) {
      best = Object.assign({}, c, rect, { score, maxHeight: Math.max(80, Math.min(c.maxHeight, view.height - margin * 2)) })
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 样式/指标
// ---------------------------------------------------------------------------
export function readBoxStyle(win, el) {
  if (!el || !win || typeof win.getComputedStyle !== 'function') return null
  try {
    const s = win.getComputedStyle(el)
    return {
      borderRadius: s.borderTopLeftRadius || s.borderRadius || '',
      borderWidth: s.borderTopWidth || s.borderWidth || '',
      borderStyle: s.borderTopStyle || '',
      borderColor: s.borderTopColor || '',
      boxShadow: s.boxShadow || 'none',
      background: s.backgroundColor || '',
      color: s.color || '',
      width: num(s.width),
      height: num(s.height),
      maxHeight: s.maxHeight || '',
    }
  } catch {
    return null
  }
}

function compactStyle(style) {
  if (!style) return null
  return {
    border: [style.borderWidth, style.borderStyle, style.borderColor].filter(Boolean).join(' '),
    borderWidth: style.borderWidth,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    boxShadow: style.boxShadow,
    background: style.background,
    color: style.color,
  }
}

const normalizeCss = (value) => String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase()
const cssEqual = (a, b) => normalizeCss(a) === normalizeCss(b)

// 不变量：三按钮同尺寸/同基线/同 gap/同边框观感 + 不遮挡 + 面板在视口内
export function computeMetrics({
  view, phone = null, phoneStyle = null, ball = null, ballStyle = null,
  bubble = null, bubbleStyle = null, bubbleVisible = true, avoidRects = [], panel = null, panelStyle = null,
  gap = DEFAULT_GAP,
}) {
  const bubbleRect = bubbleVisible ? bubble : null
  const anchor = ball || bubbleRect
  const anchorStyle = ball ? ballStyle : bubbleRect ? bubbleStyle : null
  const toRect = (r) => (r ? { x: round2(r.left), y: round2(r.top), w: round2(r.width), h: round2(r.height), cx: round2(r.cx), cy: round2(r.cy) } : null)
  // 布局模式：闪电与鲸鱼中线差 > 20px = column（阿源 dock 分支），否则 row。
  const mode = ball && bubbleRect ? (Math.abs(ball.cy - bubbleRect.cy) > 20 ? 'column' : 'row') : 'row'
  const sameRow = mode === 'row' && ball && bubbleRect ? true : ball && bubbleRect ? false : null
  const gapNeighbor = mode === 'row' && ball && bubbleRect ? round2(bubbleRect.left - ball.right) : null
  const gapLeft = anchor && phone ? round2(anchor.left - phone.right) : null
  const centerDeltaY = anchor && phone ? round2(phone.cy - anchor.cy) : null
  const centerDeltaX = anchor && phone ? round2(phone.cx - anchor.cx) : null
  let side = null
  let sideGap = null
  let columnGap = null
  if (anchor && phone) {
    if (mode === 'row') {
      if (phone.right <= anchor.left + 0.5) side = 'left'
      else if (phone.left >= anchor.right - 0.5) side = 'right'
      else side = 'overlap'
      sideGap = side === 'left' ? round2(anchor.left - phone.right) : side === 'right' ? round2(phone.left - anchor.right) : null
    } else {
      if (phone.bottom <= anchor.top + 0.5) side = 'above'
      else if (phone.top >= anchor.bottom - 0.5) side = 'below'
      else side = 'overlap'
      columnGap = side === 'above' ? round2(anchor.top - phone.bottom) : side === 'below' ? round2(phone.top - anchor.bottom) : null
    }
  }
  const sizeDelta = anchor && phone ? { w: round2(phone.width - anchor.width), h: round2(phone.height - anchor.height) } : null
  const styleParity = phoneStyle && anchorStyle ? {
    borderRadius: cssEqual(phoneStyle.borderRadius, anchorStyle.borderRadius),
    borderWidth: cssEqual(phoneStyle.borderWidth, anchorStyle.borderWidth),
    borderColor: cssEqual(phoneStyle.borderColor, anchorStyle.borderColor),
    boxShadow: cssEqual(phoneStyle.boxShadow, anchorStyle.boxShadow),
  } : null
  const phoneOverlaps = {}
  for (const item of avoidRects) {
    const kind = item && item.kind ? item.kind : 'avoid'
    phoneOverlaps[kind] = phone ? round2(intersectArea(phone, item.rect || item)) : 0
  }
  const panelOverlaps = {}
  for (const item of avoidRects) {
    const kind = item && item.kind ? item.kind : 'avoid'
    panelOverlaps[kind] = panel ? round2(intersectArea(panel, item.rect || item)) : 0
  }
  const overlapAnchor = anchor && phone ? intersectArea(phone, anchor) : null
  const overlapBubble = bubbleRect && phone && anchor !== bubbleRect ? intersectArea(phone, bubbleRect) : 0
  const overflow = phone ? !insideViewport(phone, view) : null
  const panelOverflow = panel ? !insideViewport(panel, view) : null
  const gapConsistent = (() => {
    if (!phone || !anchor) return null
    if (mode === 'row') {
      if (sideGap == null) return false
      const expected = sameRow && gapNeighbor != null && side === 'left' ? gapNeighbor : gap
      return Math.abs(sideGap - expected) <= 0.5
    }
    if (columnGap == null) return false
    return Math.abs(columnGap - gap) <= 0.5
  })()
  const invariants = {
    sameSize: sizeDelta ? Math.abs(sizeDelta.w) <= 0.5 && Math.abs(sizeDelta.h) <= 0.5 : null,
    sameBaseline: mode === 'row' && centerDeltaY != null ? Math.abs(centerDeltaY) <= 0.5 : null,
    sameCenterX: mode === 'column' && centerDeltaX != null ? Math.abs(centerDeltaX) <= 0.5 : null,
    gapConsistent,
    styleParity: styleParity ? Object.values(styleParity).every(Boolean) : null,
    noOverlap: anchor && phone ? overlapAnchor <= 0.5 && overlapBubble <= 0.5 : null,
    inViewport: overflow == null ? null : !overflow,
    panelNoOverlapFloat: panel ? (panelOverlaps.float || 0) <= 0.5 : null,
    panelNoOverlapMenu: panel ? (panelOverlaps.menu || 0) <= 0.5 : null,
    panelInViewport: panelOverflow == null ? null : !panelOverflow,
  }
  const required = Object.keys(invariants).filter((key) => invariants[key] !== null)
  const pass = required.every((key) => invariants[key] === true)
  return {
    at: Date.now(),
    viewport: { width: round2(view.width), height: round2(view.height) },
    mode,
    side,
    sameRow,
    bubbleVisible,
    phone: phone ? { rect: toRect(phone), style: compactStyle(phoneStyle) } : null,
    lightning: ball ? { rect: toRect(ball), style: compactStyle(ballStyle) } : null,
    bubble: bubble ? { rect: toRect(bubble), style: compactStyle(bubbleStyle), visible: bubbleVisible } : null,
    gap: round2(gap),
    gapLeft,
    gapNeighbor,
    sideGap,
    columnGap,
    centerDeltaY,
    centerDeltaX,
    sizeDelta,
    styleParity,
    phoneOverlaps,
    panel: panel ? { rect: toRect(panel), style: compactStyle(panelStyle), overlaps: panelOverlaps, maxHeight: panelStyle ? panelStyle.maxHeight : null } : null,
    overflow: overflow == null ? null : overflow,
    invariants,
    pass,
  }
}

// ---------------------------------------------------------------------------
// DOM 测量
// ---------------------------------------------------------------------------
function rectFromElement(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null
  const r = el.getBoundingClientRect()
  if (!r || !(r.width > 0) || !(r.height > 0)) return null
  return {
    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    width: r.width, height: r.height,
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
  }
}

function readAvoidRects(doc, win) {
  const out = []
  const push = (el, kind) => {
    const rect = rectFromElement(el)
    if (rect) out.push({ kind, rect })
  }
  const floatEl = doc.querySelector('.ay-yuan-float')
  if (floatEl) {
    let visible = true
    try {
      const style = win.getComputedStyle(floatEl)
      visible = style.display !== 'none' && style.visibility !== 'hidden'
    } catch {}
    if (visible) push(floatEl, 'float')
  }
  push(doc.querySelector('.lq-menu'), 'menu')
  return out
}

// 候选位置碰撞检测：用 elementFromPoint 扫五个点；命中别的按钮/阿源浮层/闪电菜单视为占用。
function freeAt(doc, left, top, size, selfEl) {
  if (typeof doc.elementFromPoint !== 'function') return true
  const points = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]
  for (const [fx, fy] of points) {
    let el = null
    try {
      el = doc.elementFromPoint(left + size * fx, top + size * fy)
    } catch {
      continue
    }
    if (!el) continue
    if (selfEl && (el === selfEl || selfEl.contains(el))) continue
    const closest = el.closest ? el.closest.bind(el) : null
    if (!closest) continue
    if (closest('.va-phone, .va-panel')) continue
    if (closest('button, [role="button"], .ay-yuan-float, .lq-menu, .lq-root')) return false
  }
  return true
}

function reportMetrics(payload) {
  try {
    fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }).catch(() => {})
  } catch {}
}

const fmt = (value) => (value == null || !Number.isFinite(Number(value)) ? '—' : (Math.round(Number(value) * 10) / 10).toFixed(1))

// 指标行：按 row / column 输出人类可读语义；FAIL 直接指出哪一项不满足（用户截图能读懂）。
export function formatMetricsLine(metrics) {
  if (!metrics) return '测量中…'
  const inv = metrics.invariants || {}
  const sizeText = fmt(metrics.sizeDelta && metrics.sizeDelta.w) + '×' + fmt(metrics.sizeDelta && metrics.sizeDelta.h)
  const mode = metrics.mode === 'column' ? 'column' : 'row'
  const problems = []
  let base
  if (mode === 'column') {
    base = '竖排 · X 偏差 ' + fmt(metrics.centerDeltaX) + 'px · 竖间距 ' + fmt(metrics.columnGap) + 'px · 尺寸差 ' + sizeText
    if (inv.sameCenterX === false) problems.push('X 偏差 ' + fmt(metrics.centerDeltaX) + 'px 超差')
    if (inv.gapConsistent === false) problems.push('竖间距 ' + fmt(metrics.columnGap) + 'px ≠ ' + fmt(metrics.gap) + 'px')
  } else {
    base = '对齐 ΔY ' + fmt(metrics.centerDeltaY) + 'px · 间距 ' + fmt(metrics.sideGap) + '/' + fmt(metrics.gapNeighbor) + ' · 尺寸差 ' + sizeText
    if (inv.sameBaseline === false) problems.push('对齐 ΔY ' + fmt(metrics.centerDeltaY) + 'px 超差')
    if (inv.gapConsistent === false) problems.push('间距 ' + fmt(metrics.sideGap) + 'px ≠ ' + fmt(metrics.gapNeighbor != null ? metrics.gapNeighbor : metrics.gap) + 'px')
  }
  if (inv.sameSize === false) problems.push('尺寸差 ' + sizeText + 'px')
  if (inv.styleParity === false) problems.push('边框/阴影与闪电不一致')
  if (inv.noOverlap === false) problems.push('按钮互相压叠')
  if (inv.inViewport === false) problems.push('按钮超出视口')
  if (inv.panelNoOverlapFloat === false) problems.push('面板压住阿源浮层')
  if (inv.panelNoOverlapMenu === false) problems.push('面板压住闪电菜单')
  if (inv.panelInViewport === false) problems.push('面板超出视口')
  if (!problems.length && metrics.pass !== true) problems.push('存在未通过项')
  return problems.length ? base + ' · ' + problems.join(' · ') + ' · FAIL' : base + ' · PASS'
}

// 诚实标题：上游 speech-to-speech 没就绪 ≠ 通话中，也不是错误；有 voice connected/转写证据才算通话中。
export function deriveVoiceStatus({ state, step = '', detail = '', mic = 'opening', caption = '' }) {
  const stepText = String(step || '')
  const detailText = String(detail || '')
  const upstreamDown = /voice\s*unavailable|unavailable/i.test(stepText) || /unavailable|不可用/i.test(detailText)
  const voiceConnected = /voice\s*connected/i.test(stepText) || String(caption || '').length > 0
  const micReady = mic === 'on'
  if (state === 'error') {
    return { title: '连接失败', sub: detailText || '语音链路建立失败', tone: 'error', retry: true }
  }
  if (state === 'live' && voiceConnected) {
    return { title: '通话中', sub: '实时语音 · 随时打断', tone: 'live', retry: false }
  }
  if (upstreamDown) {
    return {
      title: '正在连接语音服务…',
      sub: micReady ? '本端麦克风已就绪，等服务端就绪后直接说话即可' : '正在准备本端麦克风，服务端就绪后直接说话即可',
      tone: 'connecting',
      retry: false,
    }
  }
  if (state === 'reconnecting') {
    return { title: '正在重连…', sub: '语音链路断开，自动重试中', tone: 'reconnecting', retry: false }
  }
  if (state === 'live') {
    return { title: '麦克风已开启，等待语音服务…', sub: '说话即可；服务端就绪后会实时回应', tone: 'connecting', retry: false }
  }
  if (state === 'ready') {
    return { title: '已连接，等待麦克风…', sub: '正在打开麦克风', tone: 'ready', retry: false }
  }
  return { title: '连接中…', sub: '正在建立语音链路', tone: 'connecting', retry: false }
}

// ---------------------------------------------------------------------------
// React 组件
// ---------------------------------------------------------------------------
export function createLauncher({ React, h }) {
  const { useCallback, useEffect, useRef, useState } = React

  function useRow() {
    const [row, setRow] = useState(() => readNeighbors(document, window))
    useEffect(() => {
      let raf = 0
      let last = null
      const tick = () => {
        const next = readNeighbors(document, window)
        if (!last || !sameRowState(next, last)) {
          last = next
          setRow(next)
        }
        raf = requestAnimationFrame(tick)
      }
      tick()
      return () => cancelAnimationFrame(raf)
    }, [])
    return row
  }

  function VoicePanel({ onClose, row, metrics, bubbleVisible }) {
    const [state, setState] = useState('connecting')
    const [mic, setMic] = useState('opening')
    const [step, setStep] = useState('init')
    const [detail, setDetail] = useState('')
    const [diag, setDiag] = useState('')
    const [caption, setCaption] = useState('')
    const [box, setBox] = useState(null)
    const panelRef = useRef(null)
    const sessionRef = useRef(null)
    const rowRef = useRef(row)
    const bubbleVisibleRef = useRef(bubbleVisible)
    const placeRef = useRef(null)
    rowRef.current = row
    bubbleVisibleRef.current = bubbleVisible

    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape') onClose() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    useEffect(() => {
      const session = createVoiceSession({
        onState: setState,
        onStep: setStep,
        onDetail: setDetail,
        onCaption: (delta) => setCaption((prev) => (prev + delta).slice(-240)),
        onMic: setMic,
        onDiag: setDiag,
      })
      sessionRef.current = session
      session.start().catch((error) => {
        setState('error')
        setDetail(String(error).slice(0, 200))
      })
      return () => session.stop()
    }, [])

    placeRef.current = () => {
      const el = panelRef.current
      if (!el) return
      const view = { width: innerWidth, height: innerHeight }
      const rawRow = rowRef.current || readNeighbors(document, window)
      const rowNow = bubbleVisibleRef.current === false ? Object.assign({}, rawRow, { bubble: null, sameRow: false }) : rawRow
      const avoid = readAvoidRects(document, window)
      const phoneRect = rectFromElement(document.querySelector('.va-phone'))
      const rowRects = [rowNow.ball, rowNow.bubble, phoneRect].filter(Boolean)
      const height = el.getBoundingClientRect().height || 280
      const next = placePanel({
        row: rowNow, view, width: PANEL_MAX_WIDTH, height, avoidRects: avoid, rowRects,
      })
      if (!next) return
      setBox((prev) => {
        if (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5 &&
          Math.abs(prev.width - next.width) < 0.5 && Math.abs(prev.maxHeight - next.maxHeight) < 0.5) {
          return prev
        }
        return { left: next.left, top: next.top, width: next.width, maxHeight: next.maxHeight }
      })
    }

    useEffect(() => {
      let raf = 0
      const loop = () => {
        if (placeRef.current && document.visibilityState !== 'hidden') placeRef.current()
        raf = requestAnimationFrame(loop)
      }
      loop()
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (placeRef.current) placeRef.current() }) : null
      if (ro && panelRef.current) ro.observe(panelRef.current)
      window.addEventListener('resize', loop)
      return () => {
        cancelAnimationFrame(raf)
        if (ro) ro.disconnect()
        window.removeEventListener('resize', loop)
      }
    }, [])

    // 诚实标题：上游未就绪时显示「正在连接语音服务…」，不再把「等上游」显示成「通话中」。
    const voiceStatus = deriveVoiceStatus({ state, step, detail, mic, caption })
    const dotLabel = voiceStatus.title
    const subLabel = voiceStatus.sub
    const displayState = voiceStatus.tone
    const retry = () => {
      try { sessionRef.current && sessionRef.current.retry && sessionRef.current.retry() } catch {}
    }
    const micLabel = mic === 'on' ? '麦克风已开启' : mic === 'error' ? '麦克风不可用' : '正在打开麦克风'
    const pass = metrics ? metrics.pass : null
    const metricLine = formatMetricsLine(metrics)
    const panelStyle = {
      left: box ? box.left : 0,
      top: box ? box.top : 0,
      width: box ? box.width : Math.min(PANEL_MAX_WIDTH, innerWidth - 24),
      maxHeight: box ? box.maxHeight : undefined,
      visibility: box ? 'visible' : 'hidden',
    }
    return h('section', {
      ref: panelRef,
      className: 'va-panel',
      role: 'dialog',
      'aria-label': '阿源语音通话',
      'aria-modal': false,
      'data-state': displayState,
      'data-ayuan-ignore-origin': '',
      style: panelStyle,
    },
    h('header', { className: 'va-panel__head' },
      h('span', { className: 'va-dot', 'aria-hidden': true }),
      h('div', { className: 'va-panel__title' },
        h('strong', null, dotLabel),
        h('span', null, subLabel)),
      h('button', {
        type: 'button',
        className: 'va-close',
        'aria-label': '关闭通话',
        onPointerDown: (event) => event.stopPropagation(),
        onClick: onClose,
      }, '×')),
    h('div', { className: 'va-wave', 'aria-hidden': true },
      h('span', null), h('span', null), h('span', null), h('span', null), h('span', null)),
    h('div', { className: 'va-caption', 'data-empty': caption ? 'false' : 'true' },
      caption || '对着电脑说话，阿源会实时回应。'),
    h('div', { className: 'va-foot' },
      h('span', { className: 'va-mic', 'data-mic': mic }, '🎙 ' + micLabel),
      voiceStatus.retry ? h('button', {
        type: 'button', className: 'va-retry', onClick: retry,
      }, '重试') : null,
      h('span', { className: 'va-hint' }, '说话即可，随时打断 · Esc 关闭')),
    h('div', { className: 'va-metric', 'data-pass': pass == null ? undefined : String(pass) }, metricLine),
    h('details', { className: 'va-diag', open: true },
      h('summary', null, '诊断' + (pass === false ? '（不变量 FAIL）' : pass === true ? '（PASS）' : '')),
      h('div', { className: 'va-diag__line' }, 'step: ' + step),
      detail ? h('div', { className: 'va-diag__error' }, detail) : null,
      diag ? h('div', { className: 'va-diag__line' }, diag) : null))
  }

  function VoiceLauncher() {
    const [open, setOpen] = useState(false)
    const [offset, setOffset] = useState({ dx: 0, dy: 0 })
    const [metrics, setMetrics] = useState(null)
    const [stylePatch, setStylePatch] = useState(null)
    const phoneRef = useRef(null)
    const dragRef = useRef(null)
    const movedRef = useRef(false)
    const lastReportRef = useRef({ at: 0, key: '' })
    const failStreakRef = useRef({ key: '', count: 0, firstAt: 0 })
    const row = useRow()
    // 阿源广播 visible：鲸鱼卸载/隐藏时退到底部右侧 row 兜底（协议 ayuan:launcher-anchor-v1）。
    const [bubbleVisible, setBubbleVisible] = useState(true)
    useEffect(() => {
      const onAnchor = (event) => {
        const detail = event && event.detail
        if (!detail || typeof detail.visible !== 'boolean') return
        setBubbleVisible(detail.visible !== false)
      }
      window.addEventListener('ayuan:launcher-anchor-v1', onAnchor)
      try { window.dispatchEvent(new Event('leo-quick:anchor-request-v1')) } catch {}
      return () => window.removeEventListener('ayuan:launcher-anchor-v1', onAnchor)
    }, [])
    const coarse = (() => {
      try { return window.matchMedia('(pointer:coarse)').matches } catch { return false }
    })()
    const phoneSize = row.ball ? Math.max(28, Math.round(row.ball.width)) : (coarse ? COARSE_BALL : DEFAULT_BALL)
    const bubbleRect = bubbleVisible ? row.bubble : null
    // row = 闪电与鲸鱼同排（电话占闪电左边一格）；column = 闪电在鲸鱼上方/下方（阿源 dock 分支，电话叠在闪电正上方）。
    const layoutMode = row.ball && bubbleRect ? (row.sameRow ? 'row' : 'column') : 'row'
    const anchorRect = row.ball || bubbleRect || row.fallback

    const spot = computeSpot({
      anchor: anchorRect,
      phoneSize,
      gap: row.gap,
      mode: layoutMode,
      view: row.view,
      free: (left, top, size) => freeAt(document, left, top, size, phoneRef.current),
    })
    const left = clamp(spot.left + offset.dx, 4, Math.max(4, row.view.width - phoneSize - 4))
    const top = clamp(spot.top + offset.dy, 4, Math.max(4, row.view.height - phoneSize - 4))

    // 有鲸鱼时拖动交给 leo-quick 协议（阿源会移动鲸鱼，整排跟着走）；没有鲸鱼时允许本地拖动兜底。
    const hasBubble = !!bubbleRect
    useEffect(() => { if (hasBubble && (offset.dx || offset.dy)) setOffset({ dx: 0, dy: 0 }) }, [hasBubble, offset.dx, offset.dy])

    const onPointerDown = (event) => {
      if (event.button !== 0) return
      const bubble = bubbleRect || (bubbleVisible ? rectFromElement(document.querySelector('.ay-yuan-bubble')) : null)
      dragRef.current = {
        startX: event.clientX, startY: event.clientY,
        anchorX: bubble ? bubble.left : 0, anchorY: bubble ? bubble.top : 0,
        hasAnchor: !!bubble, baseDx: offset.dx, baseDy: offset.dy,
        moved: false, last: null,
      }
      movedRef.current = false
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    }
    const onPointerMove = (event) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      movedRef.current = true
      if (drag.hasAnchor) {
        const x = drag.anchorX + dx
        const y = drag.anchorY + dy
        drag.last = { x, y }
        window.dispatchEvent(new CustomEvent('leo-quick:launcher-move-v1', { detail: { x, y } }))
      } else {
        setOffset({ dx: drag.baseDx + dx, dy: drag.baseDy + dy })
      }
    }
    const onPointerUp = (event) => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return
      if (drag.moved && drag.hasAnchor && drag.last) {
        window.dispatchEvent(new CustomEvent('leo-quick:launcher-move-v1', { detail: { x: drag.last.x, y: drag.last.y, end: true } }))
        setTimeout(() => { movedRef.current = false }, 0)
      }
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    }
    const onPointerCancel = () => { dragRef.current = null }
    const onClick = () => {
      if (movedRef.current) { movedRef.current = false; return }
      setOpen((value) => !value)
    }

    // 外貌兜底：万一邻居版本改了样式，就抄它渲染后的 computedStyle（正常情况与 CSS 完全一致）。
    useEffect(() => {
      let timer = 0
      const apply = () => {
        const ballEl = document.querySelector('.lq-root .lq-ball') || document.querySelector('.lq-ball')
        const phoneEl = phoneRef.current
        if (!ballEl || !phoneEl) return
        const anchorStyle = readBoxStyle(window, ballEl)
        const ownStyle = readBoxStyle(window, phoneEl)
        if (!anchorStyle || !ownStyle) return
        const patch = {}
        if (!cssEqual(anchorStyle.borderRadius, ownStyle.borderRadius)) patch.borderRadius = anchorStyle.borderRadius
        if (!cssEqual(anchorStyle.borderWidth, ownStyle.borderWidth)) patch.borderWidth = anchorStyle.borderWidth
        if (!cssEqual(anchorStyle.borderColor, ownStyle.borderColor)) patch.borderColor = anchorStyle.borderColor
        if (!cssEqual(anchorStyle.boxShadow, ownStyle.boxShadow)) patch.boxShadow = anchorStyle.boxShadow
        if (!cssEqual(anchorStyle.color, ownStyle.color)) patch.color = anchorStyle.color
        setStylePatch((prev) => {
          const next = Object.keys(patch).length ? patch : null
          if (!prev && !next) return prev
          if (prev && next && JSON.stringify(prev) === JSON.stringify(next)) return prev
          return next
        })
      }
      apply()
      const interval = setInterval(apply, 3000)
      let observer = null
      try {
        observer = new MutationObserver(apply)
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'style'] })
      } catch {}
      return () => { clearInterval(interval); if (observer) observer.disconnect() }
    }, [])

    // 实机指标：不变量 + 面板几何；暴露 window.__voiceAyuanMetrics 并上报宿主 /voice-ayuan/report。
    const measure = useCallback(() => {
      const doc = document
      const ballEl = doc.querySelector('.lq-root .lq-ball') || doc.querySelector('.lq-ball') || doc.querySelector('.lq-root')
      const bubbleEl = doc.querySelector('.ay-yuan-bubble')
      const panelEl = doc.querySelector('.va-panel')
      const view = { width: innerWidth, height: innerHeight }
      const next = computeMetrics({
        view,
        phone: rectFromElement(phoneRef.current),
        phoneStyle: readBoxStyle(window, phoneRef.current),
        ball: rectFromElement(ballEl),
        ballStyle: readBoxStyle(window, ballEl),
        bubble: rectFromElement(bubbleEl),
        bubbleStyle: readBoxStyle(window, bubbleEl),
        bubbleVisible,
        avoidRects: readAvoidRects(doc, window),
        panel: rectFromElement(panelEl),
        panelStyle: readBoxStyle(window, panelEl),
        gap: row.gap,
      })
      try {
        window.__voiceAyuanMetrics = next
        window.__voiceAyuanMeasure = measure
      } catch {}
      setMetrics(next)
      return next
    }, [row.gap, bubbleVisible])

    useEffect(() => {
      const tick = () => { measure() }
      const interval = setInterval(tick, 320)
      const immediate = setTimeout(tick, 900)
      window.addEventListener('resize', tick)
      return () => { clearInterval(interval); clearTimeout(immediate); window.removeEventListener('resize', tick) }
    }, [measure])

    const report = useCallback((reason, snapshot) => {
      const current = snapshot || measure()
      const now = Date.now()
      const key = current.pass ? 'pass:' + reason : 'fail:' + JSON.stringify(current.invariants)
      const last = lastReportRef.current
      if (now - last.at < 4000) return
      if (current.pass && last.key === key && now - last.at < 60000) return
      if (!current.pass && last.key === key && now - last.at < 15000) return
      lastReportRef.current = { at: now, key }
      reportMetrics({
        kind: 'launcher-metrics',
        source: 'voice-ayuan-launcher',
        reason,
        at: new Date().toISOString(),
        url: location.href,
        userAgent: navigator.userAgent,
        dpr: window.devicePixelRatio,
        coarse,
        metrics: current,
      })
    }, [measure])

    useEffect(() => {
      const boot = setTimeout(() => report('mount'), 2500)
      return () => clearTimeout(boot)
    }, [report])
    useEffect(() => {
      if (open) {
        const timer = setTimeout(() => report('panel-open'), 600)
        return () => clearTimeout(timer)
      }
      return undefined
    }, [open, report])
    // 过渡瞬间（拖拽/面板首帧）会短暂 FAIL；连续两次同因失败才上报，避免噪声淹没真实问题。
    useEffect(() => {
      if (!metrics) return
      if (metrics.pass !== false) { failStreakRef.current = { key: '', count: 0, firstAt: 0 }; return }
      const key = JSON.stringify(metrics.invariants)
      const now = Date.now()
      const streak = failStreakRef.current
      if (streak.key === key) streak.count += 1
      else failStreakRef.current = { key, count: 1, firstAt: now }
      const current = failStreakRef.current
      if (current.count >= 2 && now - current.firstAt >= 500) report('invariants-failed', metrics)
    }, [metrics, report])

    const phoneStyle = Object.assign({
      left, top, width: phoneSize, height: phoneSize, zIndex: BUTTON_Z,
    }, stylePatch || {})

    return h(React.Fragment, null,
      h('style', { key: 'va-style' }, CSS),
      h('button', {
        ref: phoneRef,
        type: 'button',
        className: 'va-phone',
        title: '阿源语音通话（可拖动）',
        'aria-label': '阿源语音通话',
        'aria-expanded': open,
        'data-ayuan-ignore-origin': '',
        onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
        onClick,
        style: phoneStyle,
      }, h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: PHONE_PATH }))),
      open ? h(VoicePanel, {
        key: 'panel',
        onClose: () => setOpen(false),
        row,
        metrics,
        bubbleVisible,
      }) : null)
  }

  return VoiceLauncher
}
