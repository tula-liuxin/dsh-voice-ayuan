# voice-ayuan launcher / panel 视觉与几何规格（T2 voice-ui）

> 依据：闪电按钮 leo-quick-launcher 的真实源码与构建产物、阿源鲸鱼按钮 ayuan/client.js 的真实 CSS、DSH 主题 token 真值，以及用户两张实机截图的像素取证。
> 本文件是 src/client/launcher.js 的施工依据；数值冲突时以「运行时读到的邻居 computedStyle / rect」为准，常量只作兜底。

## 0. 一句话

电话按钮 = 同一排的第二个槽位：与闪电**同尺寸、同边框、同圆角、同阴影、同图标规格、同基线（中线差 < 0.5px）、同 gap（8px）**；点击**不再出现任何额外描边/黑圈**（用 `aria-expanded` 换底色，和闪电完全一致）。面板锚定这排按钮上方、右缘对齐鲸鱼右缘，避开阿源浮层与闪电菜单，主题 token 配色，绝不黑底黑字。

## 1. 邻居真值

### 1.1 闪电按钮（leo-quick-launcher，优先级最高：电话按钮就在它左边一格）
来源：`C:\Users\23677\Documents\Codex\2026-10-28\new-chat\work\leo-quick-feature\src\client.jsx`（Lead 已修 bug 并重建 client.js）
```
.lq-root { position:fixed; z-index:121; pointer-events:auto; color:var(--dsw-alias-label-primary) }
.lq-ball {
  width:42px; height:42px; box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,#dedfe4);
  border-radius:50%; display:grid; place-items:center;
  color:var(--dsw-alias-brand-primary,#506be2);
  background:var(--dsw-alias-bg-base,#fff);
  box-shadow:0 3px 14px #00000019;
  touch-action:none; user-select:none; cursor:pointer;
}
.lq-ball:hover, .lq-ball[aria-expanded=true] { background:var(--dsw-alias-bg-layer-2,#f3f5fa) }
.lq-ball:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#506be2); outline-offset:2px }
@media (pointer:coarse) { .lq-ball { width:44px; height:44px } }
```
- 图标：`<Glyph type="bolt" size={21}/>`，svg viewBox 0 0 24 24、fill=currentColor、stroke=none。
- 定位：`anchorPosition(anchor, W, H)`，size=42、gap=8、pad=8：
  - fallback `{x:max(8,W-76-42), y:max(8,H-24-42)}`
  - dock left/right：x=clamp(anchor.x,8,W-42-8)；y=anchor.y>=90 ? anchor.y-h-8 : anchor.y+h+8；再 clamp
  - 普通：left=anchor.x-8-42；right=anchor.x+anchor.width+8；x=left>=8?left:(right+42<=W-8?right:clamp(anchor.x))；y=(left>=8||right+42<=W-8)?anchor.y:anchor.y-8-42；最后 clamp
- 事件协议：监听 `ayuan:launcher-anchor-v1`（detail {visible,panelOpen,x,y,width,height,dock}），主动发 `leo-quick:anchor-request-v1`，拖动发 `leo-quick:launcher-move-v1`（{x,y}，松手 {x,y,end:true}），hover 发 `leo-quick:dock-reveal-v1`（{active}）。
- 根容器带 `data-ayuan-ignore-origin=""`（阿源来源捕获器要忽略它）。

### 1.2 鲸鱼按钮（ayuan 2.0.0）
来源：`C:\Users\23677\Desktop\dsh-plugins\ayuan\client.js`（打包产物，CSS 在 1773/1795/1796 行，DOM 在 843 行，RobotIcon 在 549 行）
```
.ay-yuan-bubble { position:fixed; pointer-events:auto; display:flex; align-items:center; gap:8px;
  padding:12px 16px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px;
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 24px #0002; cursor:grab; touch-action:none; user-select:none; z-index:120 }
/* 覆盖 */
.ay-yuan-bubble { width:42px; height:42px; justify-content:center; padding:3px; gap:0;
  border-radius:50%; box-shadow:0 3px 14px #00000014; line-height:1 }
.ay-yuan-bubble .ay-yuan-whale { width:30px; height:30px }
```
- 图标：RobotIcon = svg 26×26（CSS 实际渲染 30×30），内含 circle(r=15,#eaf2ff) + 鲸鱼 path(#4f7cf7) + 星点(#ffc957)。
- 位置：`projectBubble()`，42/44px；默认 right:24/bottom:24；dock 时半出屏；拖动写入 localStorage `ayuan.bubble-position.v2`。
- 广播 `ayuan:launcher-anchor-v1`（Lead 已把 .ay-yuan-bubble z-index 120→121）。
- 阿源浮层：`.ay-yuan-float` 宽 620 高 720（默认 right:24 bottom:24），z-index 120，是面板必须避开的矩形。

### 1.3 DSH 主题 token 真值（浅色主题）
来源：`dsh-client-ui-theme/lib/client.js`（design-platform.css 与 token 块）
| token | 实际值 |
| --- | --- |
| `--dsw-alias-bg-base` | #fff |
| `--dsw-alias-bg-layer-1 / -2 / -3` | #fff（浅色下 hover 底色与 base 同色） |
| `--dsw-alias-border-l2` | #0000001a（10% 黑） |
| `--dsw-alias-brand-primary` | **#0f1115（近黑）** |
| `--dsw-alias-label-primary` | #0f1115 |
| `--dsw-alias-label-secondary` | #61666b |
| `--dsw-alias-label-tertiary` | #81858c |
| `--dsw-alias-bg-overlay` | #e9ecf2 |

关键：DSH 主题注入了
```css
@supports (corner-shape:superellipse(1.5)) {
  :root { --dsw-corner-shape:superellipse(1.5) }
  *, :before, :after { corner-shape:var(--dsw-corner-shape) }
}
```
所以 50% 圆角在此 Electron 里渲染为**超椭圆（squircle）**，三个按钮外形天然一致；截图里「圆角方形」不是 bug，是 DSH 全局 corner-shape。

## 2. 用户截图像素取证（2560×1380，device-scale-factor=1.25）

截图 2（d9…）：三按钮底部一排，电话在左、闪电中、鲸鱼右。
- 电话黑圈外沿 bbox = (2092,1075)–(2149,1132) = 58×58 device = **46.4×46.4 css**。
- 鲸鱼图标蓝色圆 bbox = (2220,1087)–(2254,1121)，直径 35 device = 28 css ≈ 30px 图标（anti-alias 后 35）+ 中心 = (2237,1104) device = (1789.6, 883.2) css。
- 电话黑圈外沿右边 2149 ≈ 闪电左边（2148 css 真值 1719×1.25=2148.75）→ **电话黑圈与闪电直接贴住（gap 0）**。
- 电话黑圈中心 y=1103.5，鲸鱼图标中心 y=1104 → 中线差 0.5 device ≈ 0.4 css（本来就几乎对齐，视觉错觉来自黑圈把电话放大 4px）。

**结论（与 Lead 根因一致）**：
1. 黑圈 = open 时 `boxShadow:0 0 0 2px var(--dsw-alias-brand-primary)`，而 brand-primary = #0f1115 近黑。
2. 显大 = 黑圈向外扩 2px（每边），视觉外径 46.4 css vs 邻居 42 css；按钮本身是 42（全局 box-sizing:border-box，实测 42+4=46.4）。
3. 不平行/不对称 = 位置公式 `rect.x - 94`：正确值应为 `闪电.left - 8 - 42 = 鲸鱼.left - 100`，-94 让电话与闪电只剩 2px（再被 2px 黑圈吃掉 → 贴住）。
4. 图标 = 20px、strokeWidth 1.7、color label-primary；闪电图标 21px（bolt 实心）、color brand-primary → 观感偏大偏黑。

## 3. 电话按钮规格（目标态）

| 项 | 值 | 依据 |
| --- | --- | --- |
| 尺寸 | 42×42（pointer:coarse 44×44），box-sizing:border-box | .lq-ball |
| 圆角 | 50%（+ DSH 全局 superellipse(1.5)） | .lq-ball |
| 边框 | 1px solid var(--dsw-alias-border-l2) | .lq-ball |
| 背景 | var(--dsw-alias-bg-base)；hover/[aria-expanded=true] → var(--dsw-alias-bg-layer-2) | .lq-ball |
| 阴影 | 0 3px 14px #00000019（**open 时不变，无任何 0 0 0 2px**） | .lq-ball |
| 图标 | svg 18×18、viewBox 24、fill none、stroke currentColor、stroke-width 1.8、linecap/linejoin round；color 继承按钮（brand-primary） | 用户要求 + Lead 规格；比原 20px/1.7 更贴近 .lq-ball 的 18/1.8 视觉重量 |
| 焦点 | outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px（仅键盘 focus-visible） | .lq-ball |
| z-index | 121 | .lq-root |
| 光标/行为 | cursor:grab；touch-action:none；user-select:none；拖动走 launcher-move 协议 | 现有交互 + Lead 协议 |
| 属性 | data-ayuan-ignore-origin=""；aria-label="阿源语音通话（可拖动）"；aria-expanded=open | .lq-root + 协议 |

**运行时对齐（以实物为准）**：挂载后读取 `.lq-root .lq-ball`（没有则 `.lq-ball`、`.lq-root`）的 rect + computedStyle；尺寸取 rect 宽高，样式（borderRadius/borderWidth/borderColor/boxShadow/color）与自身 computedStyle 不一致时以内联兜底覆盖。读不到邻居时用上表常量。

## 4. 槽位算法（电话按钮定位）

真值优先级：
1. 闪电按钮 rect（`.lq-root .lq-ball`；退 `.lq-ball`、`.lq-root`）
2. 鲸鱼按钮 rect（`.ay-yuan-bubble`）
3. localStorage `ayuan.bubble-position.v2` 复算（bubbleFallback，与阿源 projectBubble 同公式）
4. 视口右下兜底

gap：闪电与鲸鱼同排（|中线差| ≤ 2px）时取 `bubble.left - ball.right`（半像素取整，合理区间 0..40），否则用常量 8。
size：闪电 rect 宽（取整）/ 无邻居时 42（coarse 44）。

候选位（逐个检查：在视口 [8, W-size-8]×[8, H-size-8] 内，且 elementFromPoint 五个采样点未命中别的 button / 阿源浮层 / 闪电菜单）：
1. 左邻：`left = anchor.left - gap - size`，`top = anchor.top + (anchor.h - size)/2`（同中线）
2. 右邻：`left = anchor.right + gap`，同 top
3. 上方：`top = anchor.top - gap - size`，水平居中
4. 下方：`top = anchor.bottom + gap`，水平居中
5. 兜底：视口右下 `(W-24-size, H-24-size)`
命中即用；全部失败取 clamp 后的左邻位置。

不变量（挂载后 & 每次几何变化后测量）：
- `centerDeltaY = phone.cy - anchor.cy`，要求 **|Δ| < 0.5px**
- `gapLeft = anchor.left - phone.right` 与 `gapNeighbor = bubble.left - lightning.right`（同排时）差 ≤ 0.5px
- `sizeDelta = phone.w - anchor.w` / `phone.h - anchor.h`，|Δ| ≤ 0.5px
- 样式差：borderRadius / borderWidth / borderColor / boxShadow 与闪电 computedStyle 字符串一致
- 不压邻居：phone 与 lightning/bubble 矩形相交面积为 0
- 视口内：phone 完整在视口内

## 5. 拖动（不再转发 pointer 事件、不再 dispatch click）

- pointerdown：记录 `{startX,startY,anchorX,anchorY}`，anchor 取鲸鱼 rect left/top（无鲸鱼则本地 offset 拖动兜底）。
- 位移 > 4px 视为拖动：`dispatch CustomEvent('leo-quick:launcher-move-v1', {detail:{x:anchorX+dx, y:anchorY+dy}})`；松手再发 `{x,y,end:true}`；**不点击打开面板**。
- 原因：旧实现 forwardPointer 给 `.ay-yuan-bubble` + dispatch click → 会误开阿源浮层（用户「阿源浮框乱开」的根因之一）。

## 6. 通话面板

- 宽 `min(360, 100vw-24)`；圆角 14px；边距 12px。
- 背景 `var(--dsw-alias-bg-base)`、文字 `var(--dsw-alias-label-primary)`、边框 `1px solid var(--dsw-alias-border-l2)`、阴影 `0 12px 40px #0002`；次级文字 label-secondary/tertiary；状态色用 state-* token。**禁止 fixed 深色 rgba 底 + label-primary（浅色主题会黑底黑字）。**
- z-index 120（< 按钮 121，> 普通内容）。
- 锚定：优先「按钮排上方 10px、右缘对齐鲸鱼右缘」；与阿源浮层 `.ay-yuan-float`（可见时）或闪电菜单 `.lq-menu`（打开时）相交 → 依次尝试：整排左移 48px 步进 / 浮层上方 / 浮层左侧 / 按钮排下方 / 视口夹取；按「与避让矩形的重叠面积 → 模式代价」打分选最优。
- 高度：`maxHeight = 可用竖向空间（上放 = row.top-gap-12；下放 = viewH-24-row.bottom）`，最小 120；内部滚动。
- 内容（豆包式）：顶部状态点（live 呼吸动画）+ 标题 + 关闭；中部 5 条波形动画（live/connecting）；字幕区（可滚动）；底部麦克风状态 pill + 操作提示；诊断折叠区（一行精简指标 + step/detail/diag）。
- 埋点：`window.__voiceAyuanMetrics` + POST `/voice-ayuan/report`（挂载 2s 后、打开面板、不变量 FAIL、resize；节流 10s）。

## 7. 验证计划

1. `node --check`/esbuild 构建通过（不改 client.js，产物写临时目录）。
2. 纯几何函数单测（Node，无 DOM）：computeSpot 左邻/换槽/夹取；placePanel 避让阿源浮层/菜单；computeMetrics 不变量 PASS/FAIL。
3. 用户 Ctrl+R 后：三按钮连线成排、gap 一致、无黑圈；截图核对；同时读 `window.__voiceAyuanMetrics` 与 `~/.dsh/voice-ayuan-report.json`。
4. 面板打开不与阿源浮层/闪电菜单相交，不黑底黑字。


## 8. 附：session.js 契约（voice-conn 2026-10-29 更新后）

launcher 只消费回调，不碰 Socket/AudioContext：
- `onState` ∈ `connecting | reconnecting | ready | live | error`
- `onStep(step)` 阶段文本（含 wsUrl / 重试 n/3 / voice <stage>）
- `onDetail(detail)` 人类可读错误（含 WS close code）
- `onCaption(delta)` 助手转写增量（累计后展示）
- `onMic` ∈ `opening | on | error`
- `onDiag(diag)` 诊断行（媒体/权限/安全上下文/base 来源/wsUrl/上次 close code/attempt）
- `session.retry()`：error 态手动重试（launcher 用存在性判断兼容旧版 session.js）

面板对应表现：
- `reconnecting` → 标题「正在重连…」+ 副标题「语音链路断开，自动重试中」+ 警示色呼吸点
- `error` → 底部出现「重试」按钮（调用 `session.retry()`），红色 detail 常显
- 诊断区默认展开（`<details open>`），step / diag / close code 常显，供用户截图定位
- 精简指标行（ΔY / 间距 / 尺寸差 / PASS|FAIL）在面板内始终可见，无需展开


## 9. row / column 双布局模式（按 Lead 22:5x 实机 FAIL 修正）

**判别**：`|lightning.cy − bubble.cy| > 20px` → **column**（阿源 dock 分支把闪电排到鲸鱼上方/下方）；否则 **row**。鲸鱼广播 `visible:false`（卸载/隐藏）→ 忽略鲸鱼，退到底部右侧 row 兜底。

| 模式 | 电话位置公式 | 不变量 |
| --- | --- | --- |
| row（闪电与鲸鱼同排） | `left = lightning.left − gap − size`；`top = 闪电垂直中线 − size/2`（同基线）；左槽真的出视口时保持同 gap 放闪电右边（side=right，不再无条件 clamp） | sameBaseline（|Δcy|≤0.5）、sameSize、sideGap≈gap、styleParity、不压叠、视口内 |
| column（闪电在鲸鱼上方/下方） | `left = lightning.left`（同 x）；`top = lightning.top − gap − size`（叠在闪电正上方一格）；上方出界 → 闪电下方 `lightning.top + size + gap`（=+50）；仍不行才 clamp（保持同 x） | sameCenterX（|Δcx|≤0.5）、sameSize、columnGap≈gap、styleParity、不压叠、视口内 |

**指标新增字段**：`mode:'row'|'column'`、`side:'left'|'right'|'above'|'below'|'clamped'|'dock'`、`sideGap`（row）、`columnGap`（column）、`centerDeltaX`、`bubbleVisible`。`pass` 按模式只取相关不变量（不再让 column 模式永远 FAIL 刷 report）。

**面板避让**：边界矩形 = 电话 + 闪电 + 鲸鱼 的并集（column 模式下面板必须位于电话上方，不能压住电话），右缘对齐三者最右；`.ay-yuan-float`/`.lq-menu` 避让与 rAF 实时重算不变。

**实机状态换算（Lead 反馈的两条 FAIL 报告）**

| 报告 | viewport | 闪电 | 鲸鱼 | 新代码预期电话 | 预期 |
| --- | --- | --- | --- | --- | --- |
| 23:01:43 左 dock | 2048×1104 | (8,784) | (-21,834) | (8,734) column/above，columnGap=8、Δcx=0 | pass=true |
| 23:05:12 右 dock | 2048×983 | (1998,811) | (2027,861) | (1998,761) column/above，columnGap=8、Δcx=0 | pass=true |
| 23:00:58（原判 row） | 1280×672 | (1230,488.66) | (1259,538.66) | cy 差 50 → column：(1230,438.66) | pass=true |

> 注：23:00:58 那条其实是 `bubble.x=1259=1280−21` 的右 dock 态，按新判别同样走 column，电话叠在闪电上方，与右侧竖排一致。


## 10. 人类可读文案（2026-10-29 23:1x 按用户截图反馈）

### 10.1 指标行（按 mode 输出语义，FAIL 直接写哪项不满足）
- row：`对齐 ΔY 0.0px · 间距 8.0/8.0 · 尺寸差 0.0×0.0 · PASS`
- column：`竖排 · X 偏差 0.0px · 竖间距 8.0px · 尺寸差 0.0×0.0 · PASS`
- FAIL（红字，data-pass=false）：基础段之后追加失败原因，例如 `… · 对齐 ΔY 6.0px 超差 · FAIL`、`… · X 偏差 3.2px 超差 · 竖间距 5.0px ≠ 8.0px · FAIL`、`边框/阴影与闪电不一致`、`按钮互相压叠`、`面板压住阿源浮层` 等。
- 实现：`formatMetricsLine(metrics)`（纯函数，已单测）；不再直接展示 gapLeft=-42 这类会让人误会的原始值。

### 10.2 面板标题（诚实状态，上游未就绪 ≠ 通话中）
`deriveVoiceStatus({state, step, detail, mic, muted, caption})` 纯函数派生：
| 条件 | 标题 | 副标题 | 点/波形 |
| --- | --- | --- | --- |
| state=error | 连接失败 | detail 或「语音链路建立失败」 | 红点 + 重试按钮 |
| muted（非 error，优先于其它状态） | 麦克风已静音 | 点一下下方的麦克风即可恢复说话 | 警示点（黄，不呼吸）+ 波形停动 |
| state=live 且（step 含 voice connected 或已有转写 delta） | 通话中 | 实时语音 · 随时打断 | 绿点呼吸 + 波形 |
| step 含 voice unavailable / detail 含 unavailable·不可用 | 正在连接语音服务… | 本端麦克风已就绪，等服务端就绪后直接说话即可（mic 未开时写「正在准备本端麦克风…」） | 警示点 + 波形动画，**不是错误态** |
| state=reconnecting | 正在重连… | 语音链路断开，自动重试中 | 警示点呼吸 |
| state=live 但无就绪证据 | 麦克风已开启，等待语音服务… | 说话即可；服务端就绪后会实时回应 | 警示点 + 波形 |
| state=ready | 已连接，等待麦克风… | 正在打开麦克风 | 业务色点 |
| 其它 | 连接中… | 正在建立语音链路 | 警示点 + 波形 |
> 背景：用户截图里会话 step 是 `voice unavailable · speech-to-speech`、detail 写「上游语音服务 unavailable」，但面板标题显示「通话中」→ 用户以为能说话却没反应。现在只有拿到 voice connected/转写证据才显示「通话中」。
> 另：Lead 已关闭阿源贴边半隐藏，正常只剩 row 模式；column 分支保留作为兜底。

### 10.3 麦克风开关（2026-10-30，0.2.9）
- 面板底部 `🎙 麦克风已开启` 是 **按钮**：点击关麦（图标 🔇、文案「麦克风已关闭」、`data-mic=off`、黄字），再点恢复；麦克风未就绪/不可用时 `disabled`，避免点了没反应。
- 关麦语义（`session.setMuted`）：不再上行真实人声，但会话继续按原节奏发送等长**零样本**（服务端 VAD 听不到人声，连接与播放不断）；同时 `MediaStreamTrack.enabled=false` 并关闭本端打断检测（静音期间阿源说话不会被回声打断）。开麦立即恢复。
- 标题同步：静音时 `data-state=muted` 且标题「麦克风已静音」；连接失败仍优先显示错误 + 重试。
- 测试：`test/mic-mute.test.mjs`（引擎零样本/轨道/打断 + 标题派生 + 会话接口）。
