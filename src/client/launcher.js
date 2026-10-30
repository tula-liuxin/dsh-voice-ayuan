// 电话悬浮按钮 + 通话面板（视图层）。
// 连接/音频全部通过 session.js 的 createVoiceSession 驱动；这里只负责几何、样式与呈现。
//
// 几何与外观真值（详见 design/launcher-spec.md）：
//   - 闪电按钮 = leo-quick-launcher 的 .lq-ball：42x42、border 1px border-l2、radius 50%、
//     bg-base、box-shadow 0 3px 14px #00000019、hover/[aria-expanded=true] 换 bg-layer-2、
//     focus-visible outline 2px brand-primary、pointer:coarse 44。
//   - 鲸鱼按钮 = ayuan .ay-yuan-bubble：42x42、同 border、radius 50%、shadow 0 3px 14px #00000014。
//   - 电话按钮 = 这排按钮的第二个槽位：由阿源鲸鱼广播的 anchor 派生（dock 四边 / 非 dock 一排）；
//     电话不再读页面 DOM 内容做碰撞，也不会因为读不到邻居掉到兜底角（详见 computePhoneSpot 注释）。
//   - open 态绝不加描边/黑圈（brand-primary 近黑，会变成用户说的「黑边」），只沿用 [aria-expanded] 换底色。
import { createVoiceSession } from './session.js'

// ---------------------------------------------------------------------------
// 常量（来自 .lq-ball / anchorPosition，见 design/launcher-spec.md §1.1）
// ---------------------------------------------------------------------------
const DEFAULT_BALL = 42
const COARSE_BALL = 44
const DEFAULT_GAP = 8
const STEP = 50 // 电话-闪电-鲸鱼 的槽距（= size42 + gap8；ayuan/leo-quick dock 契约 v2）
const PAD = 8
const PANEL_MAX_WIDTH = 360
const PANEL_GAP = 10
const PANEL_MARGIN = 12
const PANEL_Z = 120
const BUTTON_Z = 121
const REPORT_URL = '/voice-ayuan/report'
const BUBBLE_KEY = 'ayuan.bubble-position.v2'
// 拖动期间冻结面板重排：手指按住时的几何抖动不应触发每帧重新选位（手机端闪烁/难点按的另一来源）。
let launcherDragging = false
// 整排拖动（leo-quick 协议，任意一个按钮发起）：拖动期间降载（指标测量让路）+ 帧率取证。
let rowDragging = false
let rowDragTimer = null
// 面板重排的最小间隔（ms）。按帧重排会在手机低帧率下变成持续闪动。
const PLACE_MIN_INTERVAL_MS = 120
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
  // 主动静音：警示点（黄）+ 波形降透明并停动，一眼看出「无声可选」
  '.va-panel[data-state=muted] .va-dot{background:var(--dsw-alias-state-warn-primary,#d29922);animation:none}',
  '.va-panel[data-state=muted] .va-wave{opacity:.35}',
  '.va-panel[data-state=muted] .va-wave span{animation:none;height:6px}',
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
  // --- 字幕分角色：上「你说」（用户 STT，最近 2 行）+ 下「阿源」（助手回复，最近 4 行） ---
  '.va-stt{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:70px}',
  '.va-stt__block{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.va-stt__label{font-size:10px;line-height:14px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#81858c);flex:none}',
  '.va-stt__block[data-role=user] .va-stt__label{color:var(--dsw-alias-state-business-primary,#4176e6)}',
  '.va-stt__text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#0f1115);display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}',
  '.va-stt__block[data-role=user] .va-stt__text{-webkit-line-clamp:2;max-height:calc(1.55em * 2)}',
  '.va-stt__block[data-role=assistant] .va-stt__text{-webkit-line-clamp:4;max-height:calc(1.55em * 4)}',
  '.va-stt__text[data-empty=true]{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}',
  '.va-stt__sep{height:1px;background:var(--dsw-alias-border-l2,#0000001a);flex:none;margin:1px 0}',
  '.va-foot{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}',
  '.va-mic{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#0000001a);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:11px;line-height:18px;white-space:nowrap;cursor:pointer}',
  '.va-mic:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f3f5fa)}',
  '.va-mic:active:not(:disabled){transform:scale(.97)}',
  '.va-mic:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#506be2);outline-offset:1px}',
  '.va-mic:disabled{cursor:default;opacity:.75}',
  '.va-mic[data-mic=on]{color:var(--dsw-alias-state-success-primary,#2ea043)}',
  '.va-mic[data-mic=off]{color:var(--dsw-alias-state-warn-primary,#d29922)}',
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

function sameRect(a, b, tolerance = 1) {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(a.left - b.left) <= tolerance && Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

export function sameRowState(a, b) {
  if (!a || !b) return false
  return a.gap === b.gap && a.view.width === b.view.width && a.view.height === b.view.height &&
    sameRect(a.ball, b.ball) && sameRect(a.bubble, b.bubble) && sameRect(a.fallback, b.fallback)
}

/**
 * 合并「live 邻居快照」与「上次有效快照」（纯函数，可单测）。
 * live 里一个邻居都读不到时（兄弟按钮后挂载/卸载/HMR 瞬间、或渲染快照过期），用 last 顶上，
 * 保证位置计算永远拿得到上一次有效锚点，而不是退化成 null → 掉到兜底角。
 */
export function mergeNeighborSnapshot(live, last) {
  if (!live) return last || null
  if (live.ball || live.bubble) return live
  if (!last) return live
  return Object.assign({}, last, { view: live.view })
}

// ---------------------------------------------------------------------------
// 锚点（阿源鲸鱼广播的 ayuan:launcher-anchor-v1）→ 电话槽位（纯函数，可单测）
//
// 契约 v2（ayuan / leo-quick 已实现，2026-10-29）：
//   anchor = { visible, x, y, width, height, dock: 'left'|'right'|'top'|'bottom'|null, expanded, panelOpen }
//   - dock left/right：闪电/电话与鲸鱼同 x（贴边方向绝不 clamp，贴边时允许负数/半出屏），
//     电话 y = clampY(anchor.y - 2*step)，闪电 y = clampY(anchor.y - 1*step)；
//   - dock top/bottom：闪电/电话与鲸鱼同 y，电话 x = clampX(anchor.x - 2*step)，闪电 x = clampX(anchor.x - 1*step)；
//   - dock null：电话 = 闪电左边一格（x = anchor.x - 2*step，同中线）；左槽出视口 → 右侧
//     x = anchor.x + width + gap + step（闪电在 anchor.x + width + gap）。
// 旧实现靠 elementFromPoint 探测页面内容 + 渲染快照 useRow，会因宿主侧栏 button / 浮层遮挡 / 快照过期
// 把电话推到 (vw-24-size, vh-24-size) 兜底角（实机 15:19~15:33 多次上报）—— 现在只认 anchor。
// ---------------------------------------------------------------------------
export function readAnchorFromEvent(detail) {
  if (!detail || detail.visible !== true) return null
  const x = num(detail.x)
  const y = num(detail.y)
  const width = num(detail.width)
  const height = num(detail.height)
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null
  const dock = ['left', 'right', 'top', 'bottom'].includes(detail.dock) ? detail.dock : null
  return { visible: true, x, y, width, height, dock, expanded: detail.expanded === true, panelOpen: detail.panelOpen === true }
}

/**
 * 两帧锚点是否等价（纯函数）：拖动时阿源会按 pointermove 频率广播锚点事件，
 * 值没变就不必触发 React 重渲染（一次渲染会连带整个通话面板）。
 */
export function sameAnchorSnapshot(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.visible === b.visible && a.x === b.x && a.y === b.y && a.width === b.width &&
    a.height === b.height && a.dock === b.dock && a.expanded === b.expanded && a.panelOpen === b.panelOpen
}

/** 没有 anchor 事件时（旧版阿源 / 事件丢失）从 DOM 邻居 rect 反推等效 anchor；dock 由半出屏几何推断。 */
export function anchorFromNeighbors(row, fallback = null) {
  if (!row || !row.view) return fallback
  const view = row.view
  const bubble = row.bubble
  if (bubble) {
    const dock = bubble.left <= 0.5 ? 'left'
      : bubble.left + bubble.width >= view.width - 0.5 ? 'right'
        : bubble.top <= 0.5 ? 'top'
          : bubble.top + bubble.height >= view.height - 0.5 ? 'bottom'
            : null
    return { visible: true, x: bubble.left, y: bubble.top, width: bubble.width, height: bubble.height, dock, expanded: false, panelOpen: false }
  }
  const ball = row.ball
  if (!ball) return fallback
  if (ball.left <= 0.5) return { visible: true, x: ball.left, y: ball.top + STEP, width: ball.width, height: ball.height, dock: 'left', expanded: false, panelOpen: false }
  if (ball.left + ball.width >= view.width - 0.5) return { visible: true, x: ball.left, y: ball.top + STEP, width: ball.width, height: ball.height, dock: 'right', expanded: false, panelOpen: false }
  if (ball.top <= 0.5) return { visible: true, x: ball.left + STEP, y: ball.top, width: ball.width, height: ball.height, dock: 'top', expanded: false, panelOpen: false }
  if (ball.top + ball.height >= view.height - 0.5) return { visible: true, x: ball.left + STEP, y: ball.top, width: ball.width, height: ball.height, dock: 'bottom', expanded: false, panelOpen: false }
  return { visible: true, x: ball.left + STEP, y: ball.top, width: ball.width, height: ball.height, dock: null, expanded: false, panelOpen: false }
}

export function anchorRect(anchor) {
  if (!anchor || anchor.visible === false) return null
  const width = anchor.width
  const height = anchor.height
  return {
    left: anchor.x, top: anchor.y, right: anchor.x + width, bottom: anchor.y + height,
    width, height, cx: anchor.x + width / 2, cy: anchor.y + height / 2,
  }
}

const clampXIn = (value, view, size) => clamp(value, PAD, Math.max(PAD, view.width - size - PAD))
const clampYIn = (value, view, size) => clamp(value, PAD, Math.max(PAD, view.height - size - PAD))

/**
 * 电话槽位（纯函数）：只依赖 anchor + 视口，不读页面 DOM。
 * 返回 { left, top, mode, side, dock, clamped }；anchor 为 null（从未拿到过）返回 null，由 settleSpot 兜底。
 */
export function computePhoneSpot({ anchor = null, view, size = DEFAULT_BALL, gap = DEFAULT_GAP, step = STEP, pad = PAD }) {
  if (!anchor || anchor.visible === false || !view) return null
  const sizeNow = Number.isFinite(size) && size > 0 ? size : DEFAULT_BALL
  const anchorWidth = Number.isFinite(anchor.width) ? anchor.width : sizeNow
  const anchorHeight = Number.isFinite(anchor.height) ? anchor.height : sizeNow
  const dock = anchor.dock
  if (dock === 'left' || dock === 'right') {
    // 贴边方向（x）绝不 clamp：贴边时可以是负数/超视口，就是半出屏。
    const rawTop = anchor.y - 2 * step
    const top = clampYIn(rawTop, view, sizeNow)
    return { left: anchor.x, top, mode: 'dock-vertical', side: 'above', dock, clamped: Math.abs(top - rawTop) > 0.01 }
  }
  if (dock === 'top' || dock === 'bottom') {
    // 贴边方向（y）绝不 clamp。
    const rawLeft = anchor.x - 2 * step
    const left = clampXIn(rawLeft, view, sizeNow)
    return { left, top: anchor.y, mode: 'dock-horizontal', side: 'left', dock, clamped: Math.abs(left - rawLeft) > 0.01 }
  }
  // 闪电落在锚点左侧时（与 expectedLightningRect 同一判定），电话贴锚点右侧即可，不再预留一格
  const lightningOnLeft = anchor.x - gap - sizeNow >= pad
  const leftSlot = lightningOnLeft ? anchor.x - 2 * step : anchor.x - gap - sizeNow
  const rightSlot = lightningOnLeft ? anchor.x + anchorWidth + gap : anchor.x + anchorWidth + gap + step
  const useRight = leftSlot < pad
  const rawLeft = useRight ? rightSlot : leftSlot
  const rawTop = anchor.y + (anchorHeight - sizeNow) / 2
  const left = clampXIn(rawLeft, view, sizeNow)
  const top = clampYIn(rawTop, view, sizeNow)
  return {
    left, top, mode: 'row', side: useRight ? 'right' : 'left', dock: null,
    clamped: Math.abs(left - rawLeft) > 0.01 || Math.abs(top - rawTop) > 0.01,
  }
}

/** 闪电槽位（纯函数，仅用于一致性校验）：按 leo-quick anchorPosition 的同一套公式从 anchor 推导。 */
export function expectedLightningRect({ anchor = null, view, size = DEFAULT_BALL, gap = DEFAULT_GAP, step = STEP, pad = PAD }) {
  if (!anchor || anchor.visible === false || !view) return null
  const sizeNow = Number.isFinite(size) && size > 0 ? size : DEFAULT_BALL
  const anchorWidth = Number.isFinite(anchor.width) ? anchor.width : sizeNow
  const anchorHeight = Number.isFinite(anchor.height) ? anchor.height : sizeNow
  const dock = anchor.dock
  let left
  let top
  if (dock === 'left' || dock === 'right') {
    left = anchor.x
    top = clampYIn(anchor.y - step, view, sizeNow)
  } else if (dock === 'top' || dock === 'bottom') {
    left = clampXIn(anchor.x - step, view, sizeNow)
    top = anchor.y
  } else {
    const leftCandidate = anchor.x - gap - sizeNow
    const rightCandidate = anchor.x + anchorWidth + gap
    const fitsLeft = leftCandidate >= pad
    const fitsRight = rightCandidate + sizeNow <= view.width - pad
    const rawLeft = fitsLeft ? leftCandidate : fitsRight ? rightCandidate : anchor.x
    const rawTop = fitsLeft || fitsRight ? anchor.y : anchor.y - gap - sizeNow
    left = clampXIn(rawLeft, view, sizeNow)
    top = clampYIn(rawTop, view, sizeNow)
  }
  return {
    left, top, right: left + sizeNow, bottom: top + sizeNow,
    width: sizeNow, height: sizeNow, cx: left + sizeNow / 2, cy: top + sizeNow / 2,
  }
}

/**
 * 位置结算（纯函数，可单测）：永远优先贴着邻居，其次保持上一次有效位置，最后才用一次性兜底角。
 * - live：本次从有效 anchor 算出了槽位 → 采用并记入缓存；
 * - last：这次读不到 anchor（后挂载/卸载/HMR/事件没来）→ 保持上一次有效位置，绝不跳角落；
 * - fallback：从启动到现在从未测到过有效位置 → 才允许右下角兜底（并计入 fallbackCount 上报）。
 */
export function settleSpot(computed, last, view = null, size = DEFAULT_BALL) {
  if (computed) {
    return { left: computed.left, top: computed.top, mode: computed.mode, side: computed.side, dock: computed.dock || null, source: 'live' }
  }
  if (last) return { left: last.left, top: last.top, mode: last.mode, side: last.side, dock: last.dock || null, source: 'last' }
  const v = view || { width: 0, height: 0 }
  return {
    left: Math.max(PAD, v.width - 24 - size),
    top: Math.max(PAD, v.height - 24 - size),
    mode: 'fallback', side: 'dock', dock: null, source: 'fallback',
  }
}

/** 中心点提取：兼容 DOMRect 与 metrics 里的 {x,y,w,h} 两种表示。 */
function centerOf(rect) {
  if (!rect) return null
  const width = Number.isFinite(rect.width) ? rect.width : rect.w
  const height = Number.isFinite(rect.height) ? rect.height : rect.h
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const left = Number.isFinite(rect.left) ? rect.left : rect.x
  const top = Number.isFinite(rect.top) ? rect.top : rect.y
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  return { cx: left + width / 2, cy: top + height / 2 }
}

/**
 * 掉队检测（纯函数）：电话中心与锚点（鲸鱼/闪电）中心距离 > limit 视为异常。
 * 实机那次兜底坐标 (1982,1038) 与鲸鱼相距约 1900px —— 必须立刻重算并上报，不能静默忍着。
 */
export function detachDistance(phone, anchor, limit = 200) {
  const a = centerOf(phone)
  const b = centerOf(anchor)
  if (!a || !b) return { distance: null, detached: null, limit }
  const distance = Math.round(Math.hypot(a.cx - b.cx, a.cy - b.cy) * 100) / 100
  return { distance, detached: distance > limit, limit }
}

// ---------------------------------------------------------------------------
// 字幕（分角色）：session.js 上送 {kind, role, content, turnId, replace}
// ---------------------------------------------------------------------------
export const TRANSCRIPT_LIMIT = { user: 400, assistant: 900 }

/**
 * 字幕状态归并（纯函数，可单测）：两块 —— 「你说」= 用户 STT，「阿源」= 助手回复；只保留最近一轮。
 * - reset（用户打断 / 新 turn 开始）→ 两块一起清空；
 * - delta → 增量追加（user 的 replace=true 表示整段替换）；
 * - final → 一般给完整文本：比已显示内容更完整才替换，避免回退闪烁；
 * - discard → 清掉对应那一块。
 */
export function reduceTranscript(state, event) {
  const base = state && typeof state === 'object'
    ? state
    : { user: '', assistant: '', turnId: null, reason: '' }
  if (!event || typeof event !== 'object') return base
  if (event.kind === 'reset') {
    return {
      user: '',
      assistant: '',
      turnId: event.turnId == null ? null : String(event.turnId),
      reason: String(event.reason || 'reset'),
    }
  }
  const role = event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : null
  if (!role) return base
  if (event.kind === 'discard') {
    const next = Object.assign({}, base)
    next[role] = ''
    return next
  }
  if (event.kind !== 'delta' && event.kind !== 'final') return base
  const content = typeof event.content === 'string' ? event.content : ''
  const turnId = event.turnId == null ? base.turnId : String(event.turnId)
  const turnChanged = Boolean(turnId && base.turnId && turnId !== base.turnId)
  if (!content && !turnChanged) return base
  const next = turnChanged
    ? { user: '', assistant: '', turnId, reason: base.reason }
    : Object.assign({}, base, { turnId })
  const prev = String(next[role] || '')
  let value
  if (event.kind === 'delta') {
    value = event.replace === true ? content : prev + content
  } else {
    value = !prev || event.replace === true || content.startsWith(prev) || content.length >= prev.length ? content : prev
  }
  const limit = TRANSCRIPT_LIMIT[role] || 400
  next[role] = value.length > limit ? value.slice(-limit) : value
  return next
}


// ---------------------------------------------------------------------------
// 面板避让算法（可单测）：优先按钮排上方、右缘对齐鲸鱼右缘；被阿源浮层/闪电菜单挡住就换位。
// ---------------------------------------------------------------------------
export function placePanel({ row = null, view, width = PANEL_MAX_WIDTH, height = 280, avoidRects = [], rowRects = [], preferredMode = null }) {
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
    // preferredMode：输入没变时沿用上一次的候选模式，避免 above/below 在临界分数上来回跳（手机端闪烁根因之一）。
    const score = overlap * 1000 + (modeCost[c.mode] ?? 9) + (crampedAbove ? 8 : 0) + (Math.abs(left - (right - panelWidth)) <= 0.5 ? 0 : 0.4) - (c.mode === preferredMode ? 1.4 : 0)
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

// 一个「设备像素」内的取整噪声不判 FAIL：兄弟插件（闪电/鲸鱼）在 paint 时的像素吸附
// 可能与我们差 1 物理像素（dpr 1.25 时 = 0.8 CSS px）。设计容差本来只管亚像素，
// 但跨插件的两个独立 DOM 盒子各自吸附，实测会出现 7.2px vs 期望 8.0px 的瞬时值。
export function gapTolerance(dpr = 1) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return Math.max(0.5, 1 / ratio + 0.25)
}

// 不变量：三按钮同尺寸/同基线/同 gap/同边框观感 + 不遮挡 + 面板在视口内
export function computeMetrics({
  view, phone = null, phoneStyle = null, ball = null, ballStyle = null,
  bubble = null, bubbleStyle = null, bubbleVisible = true, avoidRects = [], panel = null, panelStyle = null,
  gap = DEFAULT_GAP, anchor = null, anchorSource = null, fallbackCount = 0, step = STEP,
  dpr = 1,
}) {
  const toRect = (r) => (r ? { x: round2(r.left), y: round2(r.top), w: round2(r.width), h: round2(r.height), cx: round2(r.cx), cy: round2(r.cy) } : null)
  const bubbleRect = bubbleVisible ? bubble : null
  // 锚点：优先用事件（带 dock/expanded）；没事件时从 DOM 邻居反推（旧版兄弟插件也能测）。
  const liveAnchor = anchor && anchor.visible !== false ? anchor : null
  const effectiveAnchor = liveAnchor || anchorFromNeighbors({ ball, bubble: bubbleRect, view })
  const anchorBox = anchorRect(effectiveAnchor)
  const dock = effectiveAnchor ? (effectiveAnchor.dock || null) : null
  const mode = dock === 'left' || dock === 'right' ? 'dock-vertical'
    : dock === 'top' || dock === 'bottom' ? 'dock-horizontal'
      : 'row'
  const phoneSize = phone && Number.isFinite(phone.width) && phone.width > 0 ? phone.width : DEFAULT_BALL
  const expected = effectiveAnchor ? computePhoneSpot({ anchor: effectiveAnchor, view, size: phoneSize, gap, step }) : null
  const lightningExpected = effectiveAnchor ? expectedLightningRect({ anchor: effectiveAnchor, view, size: phoneSize, gap, step }) : null
  const lightningBox = ball
  const anchorStyle = ball ? ballStyle : bubbleRect ? bubbleStyle : null
  const styleParity = phoneStyle && anchorStyle ? {
    borderRadius: cssEqual(phoneStyle.borderRadius, anchorStyle.borderRadius),
    borderWidth: cssEqual(phoneStyle.borderWidth, anchorStyle.borderWidth),
    borderColor: cssEqual(phoneStyle.borderColor, anchorStyle.borderColor),
    boxShadow: cssEqual(phoneStyle.boxShadow, anchorStyle.boxShadow),
  } : null
  const sizeDelta = anchorBox && phone ? { w: round2(phone.width - anchorBox.width), h: round2(phone.height - anchorBox.height) } : null
  const expectedDelta = phone && expected ? { x: round2(phone.left - expected.left), y: round2(phone.top - expected.top) } : null
  const lightningDelta = lightningBox && lightningExpected
    ? { x: round2(lightningBox.left - lightningExpected.left), y: round2(lightningBox.top - lightningExpected.top) }
    : null
  const dockFixedX = mode === 'dock-vertical' && phone && anchorBox ? round2(phone.left - anchorBox.left) : null
  const dockFixedY = mode === 'dock-horizontal' && phone && anchorBox ? round2(phone.top - anchorBox.top) : null
  // 电话与闪电的相邻间隙：三种布局都应是 gap（dock 时电话在闪电再往外一格，still gap=8）。
  const stackGap = (() => {
    if (!lightningBox || !phone) return null
    if (mode === 'dock-vertical') return round2(phone.top <= lightningBox.top ? lightningBox.top - phone.bottom : phone.top - lightningBox.bottom)
    if (mode === 'dock-horizontal') return round2(phone.left <= lightningBox.left ? lightningBox.left - phone.right : phone.left - lightningBox.right)
    const candidates = [round2(lightningBox.left - phone.right), round2(phone.left - lightningBox.right)]
    if (bubbleVisible && bubbleRect) {
      candidates.push(round2(bubbleRect.left - phone.right), round2(phone.left - bubbleRect.right))
    }
    return candidates.reduce((best, cur) => (Math.abs(cur) < Math.abs(best) ? cur : best))
  })()
  // Lead 契约里的台阶：dock 竖排 |phone.top - lightning.top| = step；dock 横排 |phone.left - lightning.left| = step。
  const lightningStep = (() => {
    if (!lightningBox || !phone) return null
    if (mode === 'dock-vertical') return round2(phone.top - lightningBox.top)
    if (mode === 'dock-horizontal') return round2(phone.left - lightningBox.left)
    return null
  })()
  const overlapAnchor = anchorBox && phone ? intersectArea(phone, anchorBox) : null
  const inViewportOk = (() => {
    if (!phone) return null
    if (mode === 'row') return insideViewport(phone, view)
    if (mode === 'dock-vertical') {
      // 贴边方向（x）允许半出屏；纵向必须完整在视口内。
      return phone.top >= -0.01 && phone.bottom <= view.height + 0.01 && phone.right > 0 && phone.left < view.width
    }
    return phone.left >= -0.01 && phone.right <= view.width + 0.01 && phone.bottom > 0 && phone.top < view.height
  })()
  const panelOverflow = panel ? !insideViewport(panel, view) : null
  const detach = phone && anchorBox ? detachDistance(phone, anchorBox) : { distance: null, detached: null, limit: 200 }
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
  const expectedSlot = expectedDelta ? Math.abs(expectedDelta.x) <= 0.5 && Math.abs(expectedDelta.y) <= 0.5 : null
  const sameBaseline = mode === 'row' && expectedDelta ? Math.abs(expectedDelta.y) <= 0.5 : null
  // 跨盒子（电话 vs 兄弟按钮）的两个量都允许 1 物理像素的取整噪声；跨插件无从对齐到同一像素栅格。
  const gapTol = gapTolerance(dpr)
  const invariants = {
    sameSize: sizeDelta ? Math.abs(sizeDelta.w) <= 0.5 && Math.abs(sizeDelta.h) <= 0.5 : null,
    styleParity: styleParity ? Object.values(styleParity).every(Boolean) : null,
    expectedSlot,
    sameBaseline,
    dockFixedX: dockFixedX == null ? null : Math.abs(dockFixedX) <= 0.5,
    dockFixedY: dockFixedY == null ? null : Math.abs(dockFixedY) <= 0.5,
    stackGap: stackGap == null ? null : Math.abs(stackGap - Math.max(0, step - phoneSize)) <= gapTol,
    lightningStep: lightningStep == null ? null : Math.abs(Math.abs(lightningStep) - step) <= gapTol,
    noOverlap: overlapAnchor == null ? null : overlapAnchor <= 0.5,
    inViewport: inViewportOk == null ? null : inViewportOk,
    anchorNearby: detach.detached == null ? null : !detach.detached,
    panelNoOverlapFloat: panel ? (panelOverlaps.float || 0) <= 0.5 : null,
    panelNoOverlapMenu: panel ? (panelOverlaps.menu || 0) <= 0.5 : null,
    panelInViewport: panelOverflow == null ? null : !panelOverflow,
  }
  const required = Object.keys(invariants).filter((key) => invariants[key] !== null)
  const pass = required.every((key) => invariants[key] === true)
  const source = anchorSource || (liveAnchor ? 'event' : effectiveAnchor ? 'derived' : null)
  return {
    at: Date.now(),
    viewport: { width: round2(view.width), height: round2(view.height) },
    mode,
    dock,
    side: expected ? expected.side : null,
    bubbleVisible,
    anchor: effectiveAnchor ? {
      rect: toRect(anchorBox),
      dock,
      expanded: effectiveAnchor.expanded === true,
      panelOpen: effectiveAnchor.panelOpen === true,
      source,
    } : null,
    anchorSource: source,
    fallbackCount,
    phone: phone ? { rect: toRect(phone), style: compactStyle(phoneStyle) } : null,
    lightning: ball ? { rect: toRect(ball), style: compactStyle(ballStyle) } : null,
    bubble: bubble ? { rect: toRect(bubble), style: compactStyle(bubbleStyle), visible: bubbleVisible } : null,
    gap: round2(gap),
    step: round2(step),
    expectedPhone: expected ? { left: round2(expected.left), top: round2(expected.top), mode: expected.mode, side: expected.side } : null,
    expectedDelta,
    lightningExpected: lightningExpected ? toRect(lightningExpected) : null,
    lightningDelta,
    dockFixedX,
    dockFixedY,
    stackGap,
    stackGapExpected: round2(Math.max(0, step - phoneSize)),
    gapTolerance: round2(gapTol),
    lightningStep,
    sizeDelta,
    styleParity,
    phoneOverlaps,
    panel: panel ? { rect: toRect(panel), style: compactStyle(panelStyle), overlaps: panelOverlaps, maxHeight: panelStyle ? panelStyle.maxHeight : null } : null,
    overflow: inViewportOk == null ? null : !inViewportOk,
    anchorDistance: detach.distance,
    detachLimit: detach.limit,
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

// 说明：位置计算不再用 elementFromPoint 探测页面内容（会把宿主侧栏/阿源浮层误判成占用，
// 导致电话失去贴邻居的槽位、掉到右下角被浮层挡住）；现在只由 computePhoneSpot(anchor) 派生。

const BUILD_TAG = 'ui2-dock4-stt-4-tolerance'

function reportMetrics(payload) {
  payload.buildTag = BUILD_TAG
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
  const delta = metrics.expectedDelta || {}
  const mode = metrics.mode || 'row'
  const sizeText = fmt(metrics.sizeDelta && metrics.sizeDelta.w) + '×' + fmt(metrics.sizeDelta && metrics.sizeDelta.h)
  const problems = []
  let base
  if (mode === 'dock-vertical') {
    base = '贴边竖排 · 与鲸鱼 X 偏差 ' + fmt(metrics.dockFixedX) + 'px · 与闪电台阶 ' + fmt(metrics.lightningStep) + 'px · 尺寸差 ' + sizeText
    if (inv.dockFixedX === false) problems.push('与鲸鱼 X 偏差 ' + fmt(metrics.dockFixedX) + 'px 超差')
    if (inv.lightningStep === false) problems.push('与闪电台阶 ' + fmt(metrics.lightningStep) + 'px ≠ ' + fmt(metrics.step) + 'px')
  } else if (mode === 'dock-horizontal') {
    base = '贴边横排 · 与鲸鱼 Y 偏差 ' + fmt(metrics.dockFixedY) + 'px · 与闪电台阶 ' + fmt(metrics.lightningStep) + 'px · 尺寸差 ' + sizeText
    if (inv.dockFixedY === false) problems.push('与鲸鱼 Y 偏差 ' + fmt(metrics.dockFixedY) + 'px 超差')
    if (inv.lightningStep === false) problems.push('与闪电台阶 ' + fmt(metrics.lightningStep) + 'px ≠ ' + fmt(metrics.step) + 'px')
  } else {
    base = '一排 · 槽位偏差 (' + fmt(delta.x) + ', ' + fmt(delta.y) + ') · 与闪电间隙 ' + fmt(metrics.stackGap) + 'px · 尺寸差 ' + sizeText
    if (inv.sameBaseline === false) problems.push('同一中线偏差 ' + fmt(delta.y) + 'px 超差')
  }
  if (inv.expectedSlot === false) problems.push('偏离锚点槽位 (' + fmt(delta.x) + ', ' + fmt(delta.y) + ')px')
  if (inv.stackGap === false) problems.push('与闪电间隙 ' + fmt(metrics.stackGap) + 'px ≠ ' + fmt(metrics.stackGapExpected) + 'px')
  if (inv.sameSize === false) problems.push('尺寸差 ' + sizeText + 'px')
  if (inv.styleParity === false) problems.push('边框/阴影与闪电不一致')
  if (inv.noOverlap === false) problems.push('按钮互相压叠')
  if (inv.inViewport === false) problems.push('按钮超出视口')
  if (inv.anchorNearby === false) problems.push('按钮掉队（距锚点 ' + fmt(metrics.anchorDistance) + 'px）')
  if (inv.panelNoOverlapFloat === false) problems.push('面板压住阿源浮层')
  if (inv.panelNoOverlapMenu === false) problems.push('面板压住闪电菜单')
  if (inv.panelInViewport === false) problems.push('面板超出视口')
  if (!problems.length && metrics.pass !== true) problems.push('存在未通过项')
  // 通过但数值不是精确设计值时，说明只是 1 物理像素内的吸附噪声，标注一下别让人误会。
  let note = ''
  if (!problems.length && mode === 'row' && inv.stackGap === true &&
    Math.abs(Number(metrics.stackGap) - Number(metrics.stackGapExpected)) > 0.5) {
    note = '（亚像素取整）'
  } else if (!problems.length && (mode === 'dock-vertical' || mode === 'dock-horizontal') && inv.lightningStep === true &&
    Math.abs(Math.abs(Number(metrics.lightningStep)) - Number(metrics.step)) > 0.5) {
    note = '（亚像素取整）'
  }
  return problems.length ? base + ' · ' + problems.join(' · ') + ' · FAIL' : base + note + ' · PASS'
}

// 诚实标题：上游 speech-to-speech 没就绪 ≠ 通话中，也不是错误；有 voice connected/转写证据才算通话中。
export function deriveVoiceStatus({ state, step = '', detail = '', mic = 'opening', muted = false, caption = '' }) {
  const stepText = String(step || '')
  const detailText = String(detail || '')
  const upstreamDown = /voice\s*unavailable|unavailable/i.test(stepText) || /unavailable|不可用/i.test(detailText)
  const voiceConnected = /voice\s*connected/i.test(stepText) || String(caption || '').length > 0
  const micReady = mic === 'on'
  if (state === 'error') {
    return { title: '连接失败', sub: detailText || '语音链路建立失败', tone: 'error', retry: true }
  }
  // 主动关麦优先于「通话中」：无声可选时，标题必须如实说麦克风已关。
  if (muted) {
    return { title: '麦克风已静音', sub: '点一下下方的麦克风即可恢复说话', tone: 'muted', retry: false }
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

// 面板底部麦克风胶囊的纯派生：文案/图标/颜色状态/可点性集中一处，便于单测。
// 关麦是「停止上行人声」，不是断开连接：胶囊在采集就绪后始终可点，用来反复开关。
export function deriveMicControl({ mic = 'opening', muted = false } = {}) {
  const error = mic === 'error'
  const ready = mic === 'on'
  return {
    label: error ? '麦克风不可用' : muted ? '麦克风已关闭' : ready ? '麦克风已开启' : '正在打开麦克风',
    icon: !error && muted ? '🔇' : '🎙',
    dataMic: error ? 'error' : muted ? 'off' : mic,
    disabled: !ready,
    ariaPressed: muted ? 'true' : 'false',
    ariaLabel: error ? '麦克风不可用' : muted ? '麦克风已关闭，点击打开' : ready ? '麦克风已开启，点击关闭' : '正在打开麦克风',
    hint: muted ? '已静音 · 点麦克风恢复 · Esc 关闭' : '说话即可，随时打断 · Esc 关闭',
  }
}

// ---------------------------------------------------------------------------
// React 组件
// ---------------------------------------------------------------------------
export function createLauncher({ React, h }) {
  const { useCallback, useEffect, useRef, useState } = React

  function useRow() {
    const [row, setRow] = useState(() => readNeighbors(document, window))
    const refresh = useCallback(() => {
      const next = readNeighbors(document, window)
      setRow((prev) => mergeNeighborSnapshot(next, prev) || next)
      return next
    }, [])
    useEffect(() => {
      let raf = 0
      let stopped = false
      let last = null
      const tick = () => {
        if (stopped) return
        const now = Date.now()
        // 整排拖动期间锚点事件已经按帧驱动电话位置；暂停 DOM 轮询，避免拖动时再叠 12Hz 的整树重渲染。
        if (document.visibilityState !== 'hidden' && !rowDragging && now - (tick.at || 0) >= 83) {
          tick.at = now
          const next = readNeighbors(document, window)
          if (!last || !sameRowState(next, last)) {
            last = next
            setRow(next)
          }
        }
        raf = requestAnimationFrame(tick)
      }
      tick()
      // rAF 在个别 Electron 场景会停摆/被节流（实机「渲染快照过期、位置掉到兜底角」的教训），
      // 再加一层 200ms 定时器，保证邻居位置变化总能进入渲染。
      const interval = setInterval(tick, 1000)
      return () => { stopped = true; cancelAnimationFrame(raf); clearInterval(interval) }
    }, [])
    return [row, refresh]
  }

  function VoicePanel({ onClose, row, metrics, bubbleVisible, anchorRect = null }) {
    const [state, setState] = useState('connecting')
    const [mic, setMic] = useState('opening')
    // 麦克风开关（用户主动静音）：视图侧状态由 session 的 onMuted 回调同步，点击走 session.setMuted。
    const [muted, setMuted] = useState(false)
    const [step, setStep] = useState('init')
    const [detail, setDetail] = useState('')
    const [diag, setDiag] = useState('')
    // 字幕分角色：你说 = 用户 STT（role=user），阿源 = 助手回复（role=assistant）；只保留最近一轮。
    const [transcript, setTranscript] = useState(() => ({ user: '', assistant: '', turnId: null, reason: '' }))
    const [box, setBox] = useState(null)
    // 面板刚打开的头 1.2s 内不展示 FAIL：此时按钮/兄弟插件还在第一帧落位，测量可能落在过渡帧；
    // 真正的持续失败会在 streak 判定后上报，不受影响。
    const [openedAt] = useState(() => Date.now())
    const panelRef = useRef(null)
    const sessionRef = useRef(null)
    const rowRef = useRef(row)
    const bubbleVisibleRef = useRef(bubbleVisible)
    const placeRef = useRef(null)
    const lastPlaceSigRef = useRef('')
    const lastPlaceModeRef = useRef(null)
    // 重排输入签名：内容/邻居/锚点没变就不必每 120ms 读一遍 DOM（空闲时从 ~8 次/秒降到 ~1.7 次/秒）。
    const placeInputsRef = useRef('')
    const lastPlaceInputsRef = useRef('')
    const lastPlaceAtRef = useRef(0)
    const forcePlaceRef = useRef(false)
    // 字幕增量合并：上游按 token 流式下发，逐条 setState 会按 WS 消息频率重渲染整个面板；
    // 合并到每帧最多一次，拖动/播报同时发生时明显减负。
    const transcriptQueueRef = useRef([])
    const transcriptRafRef = useRef(0)
    rowRef.current = row
    bubbleVisibleRef.current = bubbleVisible

    const queueTranscript = (event) => {
      transcriptQueueRef.current.push(event)
      if (transcriptRafRef.current) return
      transcriptRafRef.current = requestAnimationFrame(() => {
        transcriptRafRef.current = 0
        const queued = transcriptQueueRef.current
        transcriptQueueRef.current = []
        if (!queued.length) return
        setTranscript((prev) => queued.reduce(reduceTranscript, prev))
      })
    }

    useEffect(() => () => {
      if (transcriptRafRef.current) { cancelAnimationFrame(transcriptRafRef.current); transcriptRafRef.current = 0 }
      transcriptQueueRef.current = []
    }, [])

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
        onTranscript: queueTranscript,
        onMic: setMic,
        onMuted: setMuted,
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
      const nowMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
      if (!forcePlaceRef.current && placeInputsRef.current === lastPlaceInputsRef.current && nowMs - lastPlaceAtRef.current < 600) return
      forcePlaceRef.current = false
      lastPlaceInputsRef.current = placeInputsRef.current
      lastPlaceAtRef.current = nowMs
      const view = { width: innerWidth, height: innerHeight }
      const rawRow = rowRef.current
      const rowNow = bubbleVisibleRef.current === false ? Object.assign({}, rawRow, { bubble: null, sameRow: false }) : rawRow
      const avoid = readAvoidRects(document, window)
      const phoneRect = rectFromElement(document.querySelector('.va-phone'))
      const rowRects = [rowNow.ball, rowNow.bubble, phoneRect, anchorRect].filter(Boolean)
      // 用 scrollHeight（内容固有高度）而不是当前渲染高度：当前高度被上一轮的 maxHeight 钳过，
      // 回喂给 placePanel 会让候选位置在 above/below 之间自激振荡（手机端「疯狂闪烁」根因）。
      const scrollHeight = Number(el.scrollHeight)
      const height = Math.max(140, Math.min(Number.isFinite(scrollHeight) && scrollHeight > 0 ? scrollHeight : 300, view.height - PANEL_MARGIN * 2))
      const sig = [
        Math.round(view.width), Math.round(view.height),
        rowNow.ball ? Math.round(rowNow.ball.left) + ':' + Math.round(rowNow.ball.top) : '-',
        rowNow.bubble ? Math.round(rowNow.bubble.left) + ':' + Math.round(rowNow.bubble.top) : '-',
        anchorRect ? Math.round(anchorRect.left) + ':' + Math.round(anchorRect.top) : '-',
        bubbleVisibleRef.current === false ? '0' : '1',
      ].join('|')
      const preferredMode = lastPlaceSigRef.current === sig ? lastPlaceModeRef.current : null
      const next = placePanel({
        row: rowNow, view, width: PANEL_MAX_WIDTH, height, avoidRects: avoid, rowRects, preferredMode,
      })
      if (!next) return
      lastPlaceSigRef.current = sig
      lastPlaceModeRef.current = next.mode
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
      let lastAt = 0
      const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
      const run = (force) => {
        if (!placeRef.current) return
        if (document.visibilityState === 'hidden' || launcherDragging || rowDragging) return
        const now = nowMs()
        if (!force && now - lastAt < PLACE_MIN_INTERVAL_MS) return
        lastAt = now
        placeRef.current()
      }
      const loop = () => { run(false); raf = requestAnimationFrame(loop) }
      loop()
      const onResize = () => { forcePlaceRef.current = true; run(true) }
      window.addEventListener('resize', onResize)
      return () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('resize', onResize)
      }
    }, [])

    // 诚实标题：上游未就绪时显示「正在连接语音服务…」，不再把「等上游」显示成「通话中」。
    const voiceStatus = deriveVoiceStatus({ state, step, detail, mic, muted, caption: transcript.user || transcript.assistant })
    const dotLabel = voiceStatus.title
    const subLabel = voiceStatus.sub
    const displayState = voiceStatus.tone
    const retry = () => {
      try { sessionRef.current && sessionRef.current.retry && sessionRef.current.retry() } catch {}
    }
    // 麦克风胶囊也是开关：点一下关麦（不再上行人声），再点恢复。未就绪/出错时不可点。
    const micControl = deriveMicControl({ mic, muted })
    const toggleMute = () => {
      if (micControl.disabled) return
      const session = sessionRef.current
      if (!session || typeof session.setMuted !== 'function') return
      try { session.setMuted(!muted) } catch {}
    }
    const pass = metrics ? metrics.pass : null
    const metricLine = formatMetricsLine(metrics)
    const settling = Date.now() - openedAt < 1200
    const shownPass = settling && pass === false ? null : pass
    const shownMetricLine = settling && pass === false ? '测量中…' : metricLine
    // 每帧渲染只登记「重排输入」的纯状态签名（不碰 DOM）；placeRef 在下一帧用它判断要不要真读布局。
    placeInputsRef.current = [
      innerWidth, innerHeight,
      row.ball ? Math.round(row.ball.left) + ':' + Math.round(row.ball.top) + ':' + Math.round(row.ball.width) : '-',
      row.bubble ? Math.round(row.bubble.left) + ':' + Math.round(row.bubble.top) : '-',
      anchorRect ? Math.round(anchorRect.left) + ':' + Math.round(anchorRect.top) + ':' + Math.round(anchorRect.width) : '-',
      bubbleVisible ? '1' : '0',
      transcript.user.length, transcript.assistant.length,
      step.length, detail.length, diag.length,
      mic, muted ? '1' : '0', shownMetricLine.length, shownPass == null ? '?' : String(shownPass),
    ].join('|')
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
    h('div', { className: 'va-stt' },
      h('div', { className: 'va-stt__block', 'data-role': 'user' },
        h('span', { className: 'va-stt__label' }, '你说'),
        h('div', { className: 'va-stt__text', 'data-empty': transcript.user ? 'false' : 'true' },
          transcript.user || '等你说话…')),
      h('div', { className: 'va-stt__sep', 'aria-hidden': true }),
      h('div', { className: 'va-stt__block', 'data-role': 'assistant' },
        h('span', { className: 'va-stt__label' }, '阿源'),
        h('div', { className: 'va-stt__text', 'data-empty': transcript.assistant ? 'false' : 'true' },
          transcript.assistant || '阿源会在这里回应'))),
    h('div', { className: 'va-foot' },
      h('button', {
        type: 'button',
        className: 'va-mic',
        'data-mic': micControl.dataMic,
        'aria-pressed': micControl.ariaPressed,
        'aria-label': micControl.ariaLabel,
        title: mic === 'on' ? (muted ? '点击打开麦克风' : '点击关闭麦克风') : micControl.label,
        disabled: micControl.disabled,
        onPointerDown: (event) => event.stopPropagation(),
        onClick: toggleMute,
      }, micControl.icon + ' ' + micControl.label),
      voiceStatus.retry ? h('button', {
        type: 'button', className: 'va-retry', onClick: retry,
      }, '重试') : null,
      h('span', { className: 'va-hint' }, micControl.hint)),
    h('div', { className: 'va-metric', 'data-pass': shownPass == null ? undefined : String(shownPass) }, shownMetricLine),
    h('details', { className: 'va-diag', open: true },
      h('summary', null, '诊断' + (shownPass === false ? '（不变量 FAIL）' : shownPass === true ? '（PASS）' : '')),
      h('div', { className: 'va-diag__line' }, 'step: ' + step),
      h('div', { className: 'va-diag__line' }, 'anchor: ' + (metrics && metrics.anchorSource ? metrics.anchorSource : 'none') +
        (metrics && metrics.dock ? ' · dock ' + metrics.dock : '') +
        ' · 兜底×' + (metrics && Number.isFinite(metrics.fallbackCount) ? metrics.fallbackCount : 0) +
        ' · 距锚点 ' + fmt(metrics && metrics.anchorDistance) + 'px'),
      detail ? h('div', { className: 'va-diag__error' }, detail) : null,
      diag ? h('div', { className: 'va-diag__line' }, diag) : null))
  }

  // 拖动整排按钮时面板位置冻结（place 循环让路），此时几何 props 的变化不值得重渲染整棵面板；
  // 面板内容（字幕/状态）由它自己的 state 驱动，不受影响。松手后 rowDragging=false + refreshRow()，
  // 父组件补一帧完整渲染，面板按新槽位重新落位。
  const VoicePanelMemo = typeof React.memo === 'function'
    ? React.memo(VoicePanel, (prev, next) => {
      if (!rowDragging) return false
      return prev.metrics === next.metrics && prev.bubbleVisible === next.bubbleVisible
    })
    : VoicePanel

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
    const [rowState, refreshRow] = useRow()
    // 锚点：ayuan 广播 {x,y,width,height,dock,expanded}。位置只认 anchor，不读页面 DOM 里有什么 UI。
    const anchorEventRef = useRef(null)
    const lastAnchorRef = useRef(null)
    const lastNeighborRef = useRef(null)
    const lastSpotRef = useRef(null)
    const spotSourceRef = useRef('none')
    const fallbackCountRef = useRef(0)
    const anchorSourceRef = useRef('none')
    const [anchorTick, setAnchorTick] = useState(0)
    const [bubbleVisible, setBubbleVisible] = useState(true)
    // 锚点事件：拖动时阿源按 pointermove 频率广播，原来每来一条就 setState 一次，
    // 等于按事件频率重渲染整个通话面板。现在合并到每帧最多一次，并跳过完全相同的值。
    useEffect(() => {
      let pending = null
      let raf = 0
      const flush = () => {
        raf = 0
        const next = pending
        pending = null
        if (!next || sameAnchorSnapshot(next, lastAnchorRef.current)) return
        anchorEventRef.current = next
        lastAnchorRef.current = next
        setAnchorTick((value) => (value + 1) % 1000000)
      }
      const onAnchor = (event) => {
        const detail = event && event.detail
        if (!detail || typeof detail.visible !== 'boolean') return
        const visible = detail.visible !== false
        setBubbleVisible((prev) => (prev === visible ? prev : visible))
        if (!visible) return
        const next = readAnchorFromEvent(detail)
        if (!next) return
        pending = next
        if (!raf) raf = requestAnimationFrame(flush)
      }
      window.addEventListener('ayuan:launcher-anchor-v1', onAnchor)
      try { window.dispatchEvent(new Event('leo-quick:anchor-request-v1')) } catch {}
      return () => {
        window.removeEventListener('ayuan:launcher-anchor-v1', onAnchor)
        if (raf) cancelAnimationFrame(raf)
      }
    }, [])
    // 整排拖动（leo-quick 协议，任意一个按钮发起）：拖动期间让出指标测量（它要量几何/computedStyle，
    // 会和拖动抢布局），并顺手统计拖动窗口的帧间隔上报 /voice-ayuan/report（kind=drag-perf）。
    useEffect(() => {
      let probe = null
      let raf = 0
      const stopDrag = () => {
        const wasDragging = rowDragging
        rowDragging = false
        if (rowDragTimer) { clearTimeout(rowDragTimer); rowDragTimer = null }
        // 拖动期间暂停了 DOM 轮询，松手后立刻补一次，面板立刻回到正确槽位。
        if (wasDragging) { try { refreshRow() } catch {} }
      }
      const finish = () => {
        raf = 0
        const done = probe
        probe = null
        stopDrag()
        if (!done || !done.deltas.length) return
        let sum = 0
        let max = 0
        let slow = 0
        for (const delta of done.deltas) {
          sum += delta
          if (delta > max) max = delta
          if (delta >= 32) slow += 1
        }
        try {
          reportMetrics({
            kind: 'drag-perf',
            source: 'voice-ayuan-launcher',
            at: new Date().toISOString(),
            url: location.href,
            stats: {
              moves: done.moves,
              frames: done.deltas.length,
              avgFrameMs: Math.round((sum / done.deltas.length) * 10) / 10,
              maxFrameMs: Math.round(max * 10) / 10,
              slowFrames: slow,
            },
          })
        } catch {}
      }
      const tick = (ts) => {
        raf = 0
        if (!probe) return
        if (probe.last != null) {
          probe.deltas.push(ts - probe.last)
          if (probe.deltas.length > 900) probe.deltas.splice(0, 600)
        }
        probe.last = ts
        if (Date.now() - probe.lastMoveAt > 500) { finish(); return }
        raf = requestAnimationFrame(tick)
      }
      const onMove = (event) => {
        const detail = event && event.detail
        rowDragging = true
        if (rowDragTimer) clearTimeout(rowDragTimer)
        rowDragTimer = setTimeout(stopDrag, 350)
        if (detail && detail.end === true) stopDrag()
        const now = Date.now()
        if (!probe) { probe = { deltas: [], last: null, lastMoveAt: now, moves: 0 } }
        probe.moves += 1
        probe.lastMoveAt = now
        if (!raf) raf = requestAnimationFrame(tick)
      }
      window.addEventListener('leo-quick:launcher-move-v1', onMove)
      return () => {
        window.removeEventListener('leo-quick:launcher-move-v1', onMove)
        if (raf) cancelAnimationFrame(raf)
        stopDrag()
      }
    }, [])
    // 窗口最顶部/最底部有一条不可交互带（标题条/边缘），贴到那里会「点不了也拖不动」。
    // 自动把鲸鱼拉回安全区（最多 3 次、间隔 4s），整排跟着回到可点位置。
    useEffect(() => {
      let rescues = 0
      let lastAt = 0
      let stopped = false
      const rescue = () => {
        if (stopped || rescues >= 3) return
        const el = document.querySelector('.ay-yuan-bubble')
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (!(rect.width > 0) || !(rect.height > 0)) return
        const viewW = innerWidth
        const viewH = innerHeight
        const unsafeTop = rect.top < 24
        const unsafeBottom = rect.bottom > viewH - 6
        if (!unsafeTop && !unsafeBottom) return
        const now = Date.now()
        if (now - lastAt < 4000) return
        lastAt = now
        rescues += 1
        const x = Math.max(8, Math.min(rect.left, viewW - rect.width - 8))
        const y = Math.max(64, Math.min(viewH - rect.height - 64, viewH / 2))
        window.dispatchEvent(new CustomEvent('leo-quick:launcher-move-v1', {
          detail: { x, y: unsafeTop ? 72 : y, end: true },
        }))
      }
      const timer = setInterval(rescue, 900)
      const first = setTimeout(() => { rescue(); setTimeout(() => { stopped = true; clearInterval(timer) }, 12000) }, 500)
      return () => { clearInterval(timer); clearTimeout(first) }
    }, [])
    // 渲染期不再读 DOM：邻居位置由 useRow 的 ~12Hz 轮询维护，锚点事件已在 rAF 合并进 ref。
    // 原来这里每次渲染都 readNeighbors + getBoundingClientRect，拖动时每个 pointermove 都会强制一次
    // 全页布局，再叠加通话面板的整棵子树重渲染 —— 这就是「开着通话面板拖动三个按钮发卡」的主因。
    useEffect(() => {
      if (rowState && (rowState.ball || rowState.bubble)) lastNeighborRef.current = rowState
    }, [rowState])
    const row = mergeNeighborSnapshot(rowState, lastNeighborRef.current) ||
      { ball: null, bubble: null, sameRow: false, gap: DEFAULT_GAP, view: { width: innerWidth, height: innerHeight }, fallback: null }
    const coarse = (() => {
      try { return window.matchMedia('(pointer:coarse)').matches } catch { return false }
    })()
    // 锚点优先吃事件里的 x/y：契约 v2 下阿源按 pointermove 广播的就是 DOM 真值，且已合并到 rAF；
    // 只有事件缺失（旧版阿源）才退回 useRow 轮询的 DOM 快照。
    const domAnchor = anchorFromNeighbors(row, null)
    const eventAnchor = anchorEventRef.current
    const fromEvent = Boolean(eventAnchor && bubbleVisible)
    let anchor = fromEvent ? eventAnchor : (domAnchor || null)
    let anchorSource = 'none'
    if (anchor) {
      anchorSource = fromEvent ? 'event' : 'derived'
      lastAnchorRef.current = anchor
    } else if (lastAnchorRef.current) {
      anchor = lastAnchorRef.current
      anchorSource = 'last'
    }
    anchorSourceRef.current = anchorSource
    const view = row.view
    const phoneSize = anchor && Number.isFinite(anchor.width) && anchor.width > 0
      ? Math.max(28, Math.round(anchor.width))
      : row.ball ? Math.max(28, Math.round(row.ball.width)) : (coarse ? COARSE_BALL : DEFAULT_BALL)
    const computed = computePhoneSpot({ anchor, view, size: phoneSize, gap: row.gap })
    const settled = settleSpot(computed, lastSpotRef.current, view, phoneSize)
    if (settled.source === 'live') {
      lastSpotRef.current = { left: settled.left, top: settled.top, mode: settled.mode, side: settled.side, dock: settled.dock }
    } else if (settled.source === 'fallback' && spotSourceRef.current !== 'fallback') {
      fallbackCountRef.current += 1
    }
    spotSourceRef.current = settled.source
    // 本地拖动位移只在「从来没有过锚点」时生效；一旦锚点可用，历史 offset 全部忽略（实机 15:22:57 的错位来源）。
    const localOnly = settled.source === 'fallback'
    const left = localOnly ? clamp(settled.left + offset.dx, 4, Math.max(4, view.width - phoneSize - 4)) : settled.left
    const top = localOnly ? clamp(settled.top + offset.dy, 4, Math.max(4, view.height - phoneSize - 4)) : settled.top
    const bubbleRect = bubbleVisible ? row.bubble : null
    const anchorBox = anchorRect(anchor)
    // 有鲸鱼时拖动交给 leo-quick 协议（阿源会移动鲸鱼，整排跟着走）；没有鲸鱼时允许本地拖动兜底。
    const hasBubble = !!bubbleRect
    useEffect(() => { if (hasBubble && (offset.dx || offset.dy)) setOffset({ dx: 0, dy: 0 }) }, [hasBubble, offset.dx, offset.dy])

    const onPointerDown = (event) => {
      if (event.button !== 0) return
      launcherDragging = true
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
      launcherDragging = false
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return
      if (drag.moved && drag.hasAnchor && drag.last) {
        window.dispatchEvent(new CustomEvent('leo-quick:launcher-move-v1', { detail: { x: drag.last.x, y: drag.last.y, end: true } }))
        setTimeout(() => { movedRef.current = false }, 0)
      }
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    }
    const onPointerCancel = () => { launcherDragging = false; dragRef.current = null }
    const onClick = () => {
      launcherDragging = false
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
        anchor: lastAnchorRef.current,
        anchorSource: anchorSourceRef.current,
        fallbackCount: fallbackCountRef.current,
        dpr: window.devicePixelRatio || 1,
      })
      try {
        window.__voiceAyuanMetrics = next
        window.__voiceAyuanMeasure = measure
      } catch {}
      setMetrics(next)
      return next
    }, [row.gap, bubbleVisible])

    useEffect(() => {
      // 拖动/拖动刚结束的 350ms 内不量几何：measure 会 getComputedStyle + getBoundingClientRect，
      // 和拖动同帧抢布局（这也是拖动发卡的叠加来源）。松手后由 320ms 定时器自然补测。
      const tick = () => { if (launcherDragging || rowDragging) return; measure() }
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

    // 掉队自愈：电话与锚点中心距离 >200px 时立刻用 live DOM 重算并上报一次（保持证据可定位）。
    useEffect(() => {
      if (!metrics || !metrics.phone) return
      if (metrics.anchorDistance == null || metrics.anchorDistance <= 200) return
      refreshRow()
      report('anchor-detached', metrics)
    }, [metrics, refreshRow, report])
    // 从未拿到过锚点（兄弟按钮都没挂载）→ 明确上报，别让兜底态被当成正常。
    useEffect(() => {
      if (!metrics) return
      if (metrics.anchorSource === 'none' && metrics.fallbackCount > 0) report('anchor-missing', metrics)
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
        onPointerEnter: (event) => {
          // 触摸/触控笔没有「悬停」语义；移动端 pointerenter 会随元素在手指下移动反复触发，
          // 进而反复展开/收起贴边 dock → 整排按钮闪烁。只让鼠标驱动 dock 展开。
          if (event && event.pointerType && event.pointerType !== 'mouse') return
          try { window.dispatchEvent(new CustomEvent('leo-quick:dock-reveal-v1', { detail: { active: true } })) } catch {}
        },
        onPointerLeave: (event) => {
          if (event && event.pointerType && event.pointerType !== 'mouse') return
          try { window.dispatchEvent(new CustomEvent('leo-quick:dock-reveal-v1', { detail: { active: false } })) } catch {}
        },
        onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
        onClick,
        style: phoneStyle,
      }, h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: PHONE_PATH }))),
      open ? h(VoicePanelMemo, {
        key: 'panel',
        onClose: () => setOpen(false),
        row,
        metrics,
        bubbleVisible,
        anchorRect: anchorBox,
      }) : null)
  }

  return VoiceLauncher
}
