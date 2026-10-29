# voice-ayuan 上游实时语音 RUNBOOK

> 覆盖链路：**DSH GUI → 插件 ayuan 电话按钮 → 本机网关(qwen-audio-agent) → ssh 隧道 18765 → 服务器 speech-to-speech 8765 → STT/TTS 在 GPU1，LLM = DeepSeek V4.1 Flash（远端 responses-api）**
> 最后验证：2026-10-29 晚（真实中文 PCM 进、24k 语音+双向 transcript 出、function calling、打断、DeepSeek 切换后延迟对比均通过）
> 部署机：本地 Windows（DSH 桌面应用）+ 服务器 qiu_team@58.246.75.58:44022

---

## 0. TL;DR：30 秒自检

服务器（只读）：

```bash
ssh -p 44022 qiu_team@58.246.75.58 'systemctl --user status s2s-voice --no-pager -l -n 10; ss -ltnp | grep 8765; curl -s http://127.0.0.1:8765/v1/pool; nvidia-smi -i 1 --query-gpu=memory.used,memory.total --format=csv,noheader'
```

本机（Windows PowerShell）：

```powershell
Get-NetTCPConnection -State Listen | ? LocalPort -in 18765 | Select-Object LocalAddress,LocalPort,OwningProcess
node C:\Users\23677\Desktop\dsh-plugins\voice-ayuan\deploy\probe-upstream.mjs ws://127.0.0.1:18765/v1/realtime
```

正常判据：unit `active`；`8765` 在 listen；`/v1/pool` = `{"size":2,"in_use":0,...}`（或 in_use≥1 表示正在通话）；
本机 `18765` 有 ssh 进程监听；probe 输出 **HTTP 404**（uvicorn 只处理 upgrade，普通 GET 404 正常）+ **WS upgrade 101**。

---

## 1. 拓扑与文件位置

```
DSH GUI (Electron 内窗口, http://127.0.0.1:4273)
  └─ 插件 @local/voice-ayuan
       ├─ SshTunnel        ssh -N -L 18765:127.0.0.1:8765 qiu_team@58.246.75.58
       └─ GatewayProcess   fork node_modules/qwen-audio-agent .../bootstrap.mjs
             env: QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech
                  SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:18765/v1/realtime   ← 必须这一条
             /api/realtime  ← 浏览器经插件 /voice-ayuan/rt 反代
  └─ ws 18765 ──ssh──► 服务器 127.0.0.1:8765/v1/realtime (speech-to-speech, num_pipelines=2)
        ├─ VAD + STT (paraformer) + TTS (qwen3) → GPU1
        └─ LLM → https://api.deepseek.com/v1/responses (deepseek-flash, reasoning.effort=none, 流式)
```

> 2026-10-29 起实时层 LLM 已从本地 Qwen3-4B 换成 **DeepSeek V4.1 Flash**（responses-api，关思考）；
> 切换/回滚见 §8。STT/TTS/2 pipeline 不变，GPU1 占用从 ~29.8GB 降到 ~13.3GB。

| 位置 | 路径 |
|---|---|
| 本地插件仓库 | `C:\Users\23677\Desktop\dsh-plugins\voice-ayuan` |
| 插件入口/隧道/网关 | `index.js`、`lib/tunnel.js`、`lib/gateway.js`、`lib/ws-proxy.js` |
| 本 RUNBOOK / 验收脚本 | 仓库 `deploy/RUNBOOK.md`、`deploy/e2e-voice.mjs`、`deploy/probe-upstream.mjs`、`deploy/patch-s2s-mps.py`、`deploy/patch-s2s-reasoning.py`、`deploy/llm-probe.mjs`、`deploy/llm-handler-probe.py`、`deploy/s2s-voice.service`、`deploy/start.sh` |
| 上游 LLM 密钥（服务器，**不进 git**） | `~/co-dir/voice-ayuan/env/llm.env`（目录 700 / 文件 600，仅 `DEEPSEEK_API_KEY=...`） |
| 服务器 systemd 用户单元 | `~/.config/systemd/user/s2s-voice.service`（enabled + linger=yes） |
| 服务器启动脚本 | `~/co-dir/voice-ayuan/scripts/start.sh`（备份 `.bak-voice`） |
| 服务器 venv | `~/co-dir/voice-ayuan/venv` |
| 模型缓存 | `/mnt/data/co-dir/voice-ayuan/hf-cache`（HF_HOME）、`.../torch-hub`（TORCH_HOME） |
| 上游日志 | `journalctl --user -u s2s-voice`（start.sh 用 exec，不再写 logs/service.log） |
| 本地网关日志 | DSH 日志（T4 后为 `~/.dsh/logs/voice-ayuan.log`；旧版只进 DSH logger） |

端口：GUI 4273；本地插件的网关由 fork 时 `PORT=0` 随机分配（旧实例可能固定）；本地隧道 18765；远端 8765（**只 bind 127.0.0.1，公网不可达**）。

---

## 2. 服务器服务：启停 / 日志 / 自启

```bash
# 启停/重启
systemctl --user restart s2s-voice      # 重启（LLM 在远端后约 25~30s 起来；换回本地 Qwen 时约 55s）
systemctl --user stop s2s-voice
systemctl --user start s2s-voice
systemctl --user status s2s-voice --no-pager -l

# 日志（当前唯一可信来源）
journalctl --user -u s2s-voice -f
journalctl --user -u s2s-voice --no-pager -n 200 -o cat

# 就绪判据
ss -ltnp | grep 8765
curl -s http://127.0.0.1:8765/v1/pool            # {"size":2,"in_use":0,...}
curl -s http://127.0.0.1:8765/v1/usage           # 累计 tokens/audio/响应数
journalctl --user -u s2s-voice --no-pager -o cat | grep -E "pool size|Application startup complete"
systemctl --user show s2s-voice -p NRestarts -p MainPID -p ActiveEnterTimestamp
```

开机自启：`s2s-voice.service` 已 `enable`，且用户已开 linger（`loginctl show-user qiu_team | grep Linger` = yes）。
本机 Windows 侧不需要额外开机任务：DSH 启动时插件会自动起 ssh 隧道 + 网关子进程。

回退到单 pipeline（显存紧张/排查用）：

```bash
cd ~/co-dir/voice-ayuan
sed -i 's/--ws_port 8765 --num_pipelines 2 /--ws_port 8765 /' scripts/start.sh
systemctl --user restart s2s-voice
```

---

## 3. 端到端验收（真语音，硬证据）

脚本：`deploy/e2e-voice.mjs`（Node，自 fork 一个**独立网关**，不依赖 DSH 宿主）。

```powershell
cd C:\Users\23677\Desktop\dsh-plugins\voice-ayuan
node deploy/e2e-voice.mjs generate     # 1) 用上游 TTS 生成中文测试语音 fixture（deploy/fixtures/zh-user-*.wav）
node deploy/e2e-voice.mjs e2e          # 2) 网关 → 隧道 → 上游：发 16k PCM + 尾静音，收 24k audio.delta + 双向 transcript
node deploy/e2e-voice.mjs tool         # 3) function calling：session.update tools → response.function_call_arguments.done
node deploy/e2e-voice.mjs interrupt    # 4) 打断：助手说话中推用户语音 → speech_started + response.done(status=cancelled)
node deploy/e2e-voice.mjs concurrent   # 5) 双会话并发（证明 num_pipelines=2，不再单槽饿死）
node deploy/e2e-voice.mjs all          # 1+2+3
```

**验生产真实网关**（不 fork 测试网关，直接打插件当前在跑的网关；端口从
`http://127.0.0.1:<当前 GUI 端口>/voice-ayuan/status` 的 `origin` 里取。GUI 端口每次启动可能变
（见过 4273/4580），网关端口是随机的（见过 14576/2549）：

```powershell
$env:E2E_GATEWAY_PORT='2549'           # 换成 /voice-ayuan/status 返回的 origin 端口
node deploy/e2e-voice.mjs e2e --skip-gateway
```

产物（`deploy/out/`，已在 git 中忽略，随时可由脚本重建）：`e2e-report.json`（指标）、`e2e-events.jsonl`（原始网关事件）、`e2e-output-24k.wav`（收到的语音）、`tool-report.json`、`interrupt-report.json`、`concurrent-report.json`。

一次通过的样子（2026-10-29 切换 DeepSeek 后实测，生产网关 origin=http://127.0.0.1:2549，隧道 18765，服务 pool size 2）：

```
[e2e] transcript.final user: "今天天气不错我们开始测试实时语音通话请把这句话说一遍"
[e2e] transcript.final assistant: "今天天气不错我们开始测试实时语音通话"
[e2e] audio.delta ... rate=24000   (25 块累计 198144 B = 4.13s)
[e2e] audio.done
[e2e] E2E PASS: audio=4.13s
[e2e] LATENCY(ms) {"pushEndToResponseStarted":258,"responseStartedToFirstAudio":215,"pushEndToFirstAudio":473,...}
```

同批验收（均 PASS）：`concurrent` 两连接同时在线 `pool.in_use=2`；`tool` 模型调用
`test_echo({"text":"你好阿源"})` 并收到 `response.function_call_arguments.done`；`interrupt` 助手说话中用户插话 →
`input_audio_buffer.speech_started` + `response.done(status=cancelled)`。DeepSeek 后两次 e2e 延迟稳定：
pushEnd→response.started 258/290ms，pushEnd→首个 audio.delta 473/474ms（Qwen3-4B 基线为 965/1146ms）。

⚠️ 注意：
- 跑 e2e 会占上游 pipeline（当前 2 个槽）几十秒。真实用户正在通话时**不要跑**；跑之前可 `curl -s http://127.0.0.1:8765/v1/pool` 确认。
- e2e 正常结束会杀掉自己 fork 的网关；若脚本被强杀，可能残留 `node ... bootstrap.mjs` 进程，用
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'e2e-voice|bootstrap' | % { Stop-Process -Id $_.ProcessId -Force }` 清理。
- 只有 e2e/真实网关链路才是可信验收；**不要**用 mock 页面/日志截图当证据。
- 本机 18765 若不通，可手工起隧道验证：`ssh -N -p 44022 -L 18765:127.0.0.1:8765 qiu_team@58.246.75.58`，再用 `deploy/probe-upstream.mjs` 探测（HTTP 404 + WS 101 = 通）。

---

## 4. 上游行为说明（前端/voice-conn 必读）

| 行为 | 实测结论 |
|---|---|
| 输入音频 | PCM16 little-endian、单声道 **16 kHz**、base64 后 `input_audio_buffer.append`；服务端 server_vad，无需 commit |
| 尾静音 | **必须**在用户说完后继续推流（≥1.5~2.5s 静音），否则 server_vad 等不到 speech_stopped，本轮不触发 LLM/TTS |
| 输出音频 | `audio.delta` 里 base64 PCM16，**24 kHz**（网关事件带 `sampleRate:24000`），`audio.done` 收尾 |
| 用户转写 | 网关 `transcript.final { role:'user', content } `；上游还有 delta 流式版本 |
| 助手转写 | 网关 `transcript.final { role:'assistant', content }`；**客户端必须先回 `playback.started {responseId}`**，否则网关把转写留在 pending 不 flush（设计）；播完回 `playback.ended` |
| 打断 | 助手说话时用户开口：上游发 `input_audio_buffer.speech_started` 并取消在飞 response（`response.done` status=`cancelled`；**没有**独立 `response.interrupted` 事件）。网关侧表现为 `playback.clear(reason:'user_interruption')` + `voice.state listening`；前端收到应立刻停本地播放 |
| function calling | 上游支持 GA 方言 tools；实测模型发 `response.function_call_arguments.done`（name/arguments/call_id）。网关侧 client tools 走 session.hello 的 tools，模型调用会变 `tool.call` 事件；DeepSeek 后端同样实测通过（`test_echo`） |
| LLM 后端 | 当前 **DeepSeek V4.1 Flash（responses-api，关思考，流式）**；语音层只负责快速回应+转交，工具集由 voice-bridge 控制。延迟基准见 §8 |
| 并发 | `--num_pipelines N` 决定槽数；超了会 `Rejected connection: all N pipeline slots in use`。当前 **N=2**，两路会话可同时在线，`/v1/pool` 可查每槽 idle/active |

---

## 5. 常见故障决策表

| # | 现象 | 证据/定位 | 根因 | 处理 |
|---|---|---|---|---|
| 1 | 网关反复 `voice.connection connecting→unavailable`，远端 journal **没有** accepted | 本机临时监听 8765 看到 `GET /v1/realtime Host: 127.0.0.1:8765`；远端无连接 | 网关连了**默认 8765** 而不是隧道 18765：s2s provider 只认 `SPEECH_TO_SPEECH_REALTIME_URL`/`S2S_REALTIME_URL`，不认 dashscope 的 `QWEN_AUDIO_REALTIME_URL` | 确认 `lib/gateway.js` fork env 注入 `SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:18765/v1/realtime`（2026-10-29 已修） |
| 2 | 有连接、有 VAD，但永远没有转录/回复音频 | journal 连续 `paraformer_handler.py ... torch.mps.empty_cache()` → `RuntimeError: Cannot execute emptyCache() without MPS backend` | speech-to-speech 0.2.10 paraformer handler 在非 MPS 机器上误调 MPS API | `~/co-dir/voice-ayuan/venv/bin/python scripts/patch-s2s-mps.py`（幂等，自动备份 .bak-voice），然后 restart；**每次 pip 重装/升级后要重跑** |
| 3 | `Rejected connection: all N pipeline slots in use` | 远端 journal + `curl /v1/pool` | 并发会话超过槽数，或某槽 SESSION_END 没 drain 完（卡住） | 查 `/v1/pool` 哪个 unit active/releasing；短暂等待；长期卡住则重启服务；需要更高并发就加大 `--num_pipelines`（每加一个约 +13~15GB 显存） |
| 4 | 重启后长时间（>3min）不 listen、GPU 显存不涨、journal 停在导入日志 | journal 里没有 handler 加载日志；GPU 只有 ~2GB | 启动时访问 hf-mirror 被 **429 限速**（每次启动都会 HEAD/GET config），huggingface_hub 指数退避重试，2 pipeline 时更久 | start.sh 必须带 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`（模型已预下载）；确认后可 50~60s 起来 |
| 5 | CUDA OOM / torch 报错、服务反复重启 | `journalctl` 搜 `out of memory`；`nvidia-smi` | GPU1 显存被别的进程挤占（GPU0 常驻别人 vLLM），或 num_pipelines=2 在低显存时不够 | `nvidia-smi -i 1` 看占用；回退 num_pipelines=1；清理无关进程（**不要 pkill -f 误杀**，先看 pid/命令确认） |
| 6 | 本机 18765 不通，e2e/网关都连不上 | `Get-NetTCPConnection` 无 18765；`Get-CimInstance Win32_Process` 查 ssh | 隧道进程退出/网络断/端口被占 | 手工起隧道验证；插件侧 `lib/tunnel.js` 目前 SSH 退出后不会自动重连（建议 Lead 加退避重连）；端口冲突改 config `remote.tunnelLocalPort` |
| 7 | 远端 8765 有 listen 但本地连不上 | 远端 `ss -ltnp | grep 8765` 正常、本机 probe 超时 | ssh 隧道没起，或 ssh 转发到了别的端口 | 检查插件隧道参数 `-L 18765:127.0.0.1:8765`；本机手工隧道测试 |
| 8 | 网关 `/api/health` ok 但仍 unavailable | 网关日志（T4 后 `~/.dsh/logs/voice-ayuan.log`）看 provider 连接错误 | provider 配置/上游地址错；或上游容量忙 | 对照 #1/#3 处理 |
| 9 | 升级/重装后启动报 `upsample` setter / 缺 `standardize_rope` / qwentts-cpp wheel | journal ImportError | 版本不匹配 | 按 §6 版本锁定重装，**不要乱升级** |
| 10 | assistant transcript 一直为空，但 audio 正常 | 前端事件里没有回 `playback.started` | 设计：转写等回执后 flush | 前端在收到 first `audio.delta` 后回 `playback.started{responseId}`，播完回 `playback.ended` |
| 11 | 模型文件缺失/下载失败 | journal 404/429/连接错误；`/mnt/data/co-dir/voice-ayuan/hf-cache` 体积异常 | 未预下载或 hf-mirror 限速 | 跑 `scripts/download-models.sh` 预下载；或 ModelScope 下载到 models 目录（见 DEPLOY.md） |
| 12 | 服务启动即失败：`DEEPSEEK_API_KEY is missing` | start.sh 的 `: "${DEEPSEEK_API_KEY:?...}"` 报错；journal 见启动脚本退出 | `~/co-dir/voice-ayuan/env/llm.env` 缺失/为空/权限不对 | 重写 env 文件（`DEEPSEEK_API_KEY=sk-...`，chmod 600 目录 700）；**不要把密钥写进 start.sh 或 git** |
| 13 | 每次回复都出固定英文兜底 `"Wow I'm a bit slow today, could you repeat that?"` | journal `OpenAI API read timed out after 20.0s` | 到 api.deepseek.com 网络慢/断/限流，或 responses-api 请求超时（handler 默认 request_timeout_s=20） | 服务器 `curl -s -o /dev/null -w '%{http_code}' https://api.deepseek.com/v1/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"` 验证连通与鉴权；429 时等额度/限流恢复 |
| 14 | DeepSeek 回复变慢、token 费用变高、首个音频明显变晚 | 用 `deploy/llm-handler-probe.py` 看 `usage.reasoning_tokens` 是否 >0；journal 里 `output_tokens` 异常大 | 关思考没生效（s2s 的 disable_thinking 只发 chat_template_kwargs，DeepSeek 会忽略；或 env 被改） | 确认 `VOICE_AYUAN_LLM_REASONING_EFFORT=none`、补丁在（`python scripts/patch-s2s-reasoning.py --check`），并用探针确认 `reasoning_tokens=0` |
| 15 | 换了 DeepSeek 后 STT 有、但完全没回复 | journal 有 LLM 401/403/404 | base_url/model 写错，或密钥失效 | 校验 `--model_name deepseek-flash`、`--responses_api_base_url https://api.deepseek.com/v1`；用 `deploy/llm-probe.mjs` 直连确认 200 |

---

## 6. 版本锁定（不要随意升级）

| 包 | 版本 | 原因 |
|---|---|---|
| speech-to-speech | **0.2.10** | 1.1.0 依赖 `qwentts-cpp-python` 无 Linux cp312 wheel |
| transformers | **5.15.1** | 5.21 报 `upsample` setter；4.57 缺 `standardize_rope` |
| torch | 2.15.0 | 随 s2s 解析 |
| torchaudio | 2.11.1 | 同上 |
| hf-xet | **不装** | hf-mirror 不代理 Xet CAS，会 401/挂死 |
| Python | 3.12 | venv 现状 |
| GPU | **GPU1（CUDA_VISIBLE_DEVICES=1）** | GPU0 常驻别人 vLLM |
| 实时 LLM | **DeepSeek V4.1 Flash（deepseek-flash）** | 远端 `https://api.deepseek.com/v1` Responses API；关思考 `reasoning.effort=none`；本地不再加载 Qwen3-4B |
| openai SDK | 随 s2s 0.2.10 解析 | responses-api handler 依赖它；不要单独降级 |

本地补丁（pip 重装/升级会被覆盖 → **重装后必须重跑**）：
- `deploy/patch-s2s-mps.py` → `speech_to_speech/STT/paraformer_handler.py`（MPS 空缓存 bug）
- `deploy/patch-s2s-reasoning.py` → `speech_to_speech/LLM/responses_api_language_model.py`（把 `VOICE_AYUAN_LLM_REASONING_EFFORT` 注入 extra_body.reasoning.effort，DeepSeek 关思考）
两者都幂等、带 marker、`--check` 可只检查，并自动备份 `.bak-voice*`。

---

## 7. 变更记录

- 2026-10-29：定位两个真故障——① 插件网关 env 用错变量连到默认 8765（Lead 已修 `lib/gateway.js`）；② 上游 0.2.10 paraformer 在 CUDA 机器误调 `torch.mps.empty_cache()` 导致 ASR 全挂（本仓库补丁修复）。
- 2026-10-29：服务改持久化 systemd user unit（enabled + Restart=always + linger）；启动改为 HF 离线加载（`HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`），启动 36s（1 pipeline）/54s（2 pipelines）。
- 2026-10-29：`--num_pipelines 2` 实测可用（GPU1 约 28.7GB / 49.1GB，留 ~20GB 余量），并发双会话不再互相饿死。
- 待办：宿主 DSH 重启把网关切回 `18765` 后，**关掉 Lead 临时起的 8765→服务器 8765 隧道**（避免两套隧道并存；只留插件自己那条 18765）。
- 2026-10-29 23:40：实时层 LLM 从本地 Qwen3-4B 切换为 **DeepSeek V4.1 Flash**（responses-api + reasoning.effort=none + 流式，2 pipeline 不变）。启动 54s→27s，GPU1 29.8GB→13.3GB；生产网关 e2e 通过，pushEnd→首音频 473/474ms（Qwen 基线 1146ms）。旧配置备份 `scripts/start.sh.bak-qwen3-4b`，回滚见 §8。

---

## 8. LLM 后端：DeepSeek V4.1 Flash（切换 / 验证 / 回滚）

实时层只负责**快速回应 + 把活转交给阿源**，所以 LLM 用远端 DeepSeek Flash（关思考、流式），STT/TTS 仍在本机 GPU1。

### 8.1 当前生效配置（服务器 `scripts/start.sh`）

```bash
# 密钥：source env/llm.env（内容只有 DEEPSEEK_API_KEY=sk-...，dir 700 / file 600，不进 git）
--llm_backend responses-api --model_name deepseek-flash \
--responses_api_base_url https://api.deepseek.com/v1 \
--responses_api_api_key "$DEEPSEEK_API_KEY" \
--responses_api_disable_thinking true \
--responses_api_stream true \
--stream_batch_sentences 1
# 其余不变：--stt paraformer、--tts qwen3（Vivian/chinese）、--num_pipelines 2、--device cuda
```

- 启动时每个 pipeline 会做一次 Responses API warmup（约 0.7~0.9s，会产生少量 token 费用）。
- 启动时间 ~27s（LLM 不在本地后更快）；GPU1 ~13.3GB（STT+TTS×2）。
- 单轮请求超时 20s（handler 默认），超时会说固定英文兜底句（见 §5 #13）。

### 8.2 关思考为什么需要补丁

s2s 0.2.10 的 `--responses_api_disable_thinking` 对非 OpenAI 端只发
`extra_body.chat_template_kwargs.enable_thinking=false`（vLLM/Together 约定）。**DeepSeek 接受但忽略**该字段
（实测 reasoning_tokens 仍 40~90）。DeepSeek Responses API 的正确写法是
`reasoning: {"effort": "none"}`（合法值 none/minimal/low/medium/high/xhigh/ultra/max；`off` 会 422）。

→ `deploy/patch-s2s-reasoning.py` 在 handler 里把 `VOICE_AYUAN_LLM_REASONING_EFFORT`（默认 none）合并进
`extra_body.reasoning.effort`。start.sh 显式导出该 env。

验证关思考生效（三种方式任选）：
1) 服务器跑 `deploy/llm-handler-probe.py`，看 `usage.reasoning_tokens == 0` 且 `extraBody.reasoning.effort == "none"`；
2) 本机跑 `node deploy/llm-probe.mjs` 对比 `reasoning.effort=none` vs 不传（后者 items 含 `reasoning`）；
3) journal 里 `Token usage (response)` 的 output tokens 很小（正常短答 9~40），没有成倍 reasoning 消耗。

### 8.3 切换到其它 LLM（通用步骤）

1. 服务器 `env/llm.env` 加对应 key（600 权限）；
2. `cp scripts/start.sh scripts/start.sh.bak-<旧后端>`；
3. 改 `--llm_backend responses-api --model_name <model> --responses_api_base_url <base_url> --responses_api_api_key "$KEY"`；
4. `systemctl --user restart s2s-voice` → `curl /v1/pool` + journal 看 `ResponsesApiModelHandler: warmed up`；
5. 跑 §3 的 e2e + tool + interrupt 再收工。

### 8.4 回滚到本地 Qwen3-4B（一键）

```bash
ssh -p 44022 qiu_team@58.246.75.58 '
  cd ~/co-dir/voice-ayuan &&
  cp scripts/start.sh.bak-qwen3-4b scripts/start.sh &&
  systemctl --user restart s2s-voice'
# 约 55s 后 8765 就绪；验证：curl -s http://127.0.0.1:8765/v1/pool
```

### 8.5 延迟/质量基准（2026-10-29 实测，同一链路 生产网关→18765→服务器）

| 指标（e2e 通过生产的插件网关） | Qwen3-4B（本地 transformers） | DeepSeek V4.1 Flash（responses-api，none） |
|---|---|---|
| pushEnd → response.started | 965 ms | **258 / 290 ms** |
| pushEnd → 首个 24k audio.delta | 1146 ms | **473 / 474 ms** |
| userFinal → response.started | 1584 ms | **884 / 906 ms** |
| response.started → 首音频（TTS 侧） | 181 ms | 184 / 215 ms |
| handler 直测 TTFT（中文短答） | — | 360 ms（快速） / 688 ms（真实短问答） |
| handler 直测 tool call 首个事件→call 完成 | — | 118 ms → 881 ms |
| 输出语音 | 4.06s | 4.13 / 4.77s |
| 质量样例（中文） | 「今天天气不错我们开始测试实时语音通话」 | 「你好！谢谢关心，我今天心情挺好的，希望你也一样！」；「好的，不过我现在没法直接查实时天气…」（不编造） |
| 关思考 | 不适用（无思考） | reasoning_tokens=0（三次调用均 0） |

产物对照：`deploy/out/baseline-qwen3-4b-report.json`、`deploy/out/e2e-deepseek-gateway.log`、`deploy/out/e2e-deepseek-gateway-2.log`、
`deploy/out/tool-report.json`、`deploy/out/interrupt-report.json`；handler 级报告在服务器 `~/co-dir/voice-ayuan/logs/llm-probe-report.json`。

---

## 9. 只读/写域约定（本仓库工作流）

- 服务器只写镜像目录：`~/co-dir/voice-ayuan`、`/mnt/data/co-dir/voice-ayuan`；systemd 单元属于用户配置（`~/.config/systemd/user/`）。
- 禁止用 `pkill -f` 盲杀；先 `ps -o pid,etime,cmd` 确认。
- 改脚本后同步两处：仓库 `deploy/`（源码）+ 服务器 `scripts/`，避免漂移。
