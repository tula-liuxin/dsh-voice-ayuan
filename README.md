# voice-ayuan · 阿源语音通话插件

在 DSH Web GUI 的输入区加一个通话图标，点开后用实时语音和阿源对话。

## 当前状态（M1 进行中）

- [x] 服务器：speech-to-speech 服务（systemd 用户单元 `s2s-voice`）
- [x] 插件 Host：自动起 SSH 隧道 + Gateway 子进程（`lib/tunnel.js`、`lib/gateway.js`）
- [x] 同源 WebSocket 代理：`/voice-ayuan/rt`（绕开跨端口 origin 校验）
- [x] 状态路由：`/voice-ayuan/status`
- [x] 客户端：composer 图标 + 通话浮层 + 麦克风采集 + 播放（`client.js`，esbuild 打包）
- [x] 通话中麦克风开关：点面板底部「🎙 麦克风已开启」即可关麦/开麦（关麦后不再上行人声，连接与播放不断）
- [ ] BackendPort 适配器：把语音派活接到当前 DSH 会话
- [ ] 任务级口头确认
- [ ] 双向录音
- [ ] 时间薄层

## 安装

1. 确认服务器服务在跑：`systemctl --user is-active s2s-voice`
2. DSH → 设置 → 插件 → 安装本地目录，指向本目录
3. 重新加载页面，输入区出现电话图标

## 架构

```
浏览器 ── /voice-ayuan/rt (同源 WS 代理) ──► Gateway 子进程 ──► SSH 隧道 ──► 术影服务器 :8765
```

Host 插件负责：起隧道、起 Gateway、注册代理路由、暴露 `ctx.voice` 服务。

## 部署（服务器）

见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。要点：

- 所有文件放镜像目录，**不写 home 根目录**
- `transformers` 必须 5.15.1；不装 `hf-xet`
- silero VAD 走本地（服务器连不上 GitHub）
- GPU 用 1 号卡（0 号被别人的 vLLM 占用）
