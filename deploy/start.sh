#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── 上游 LLM 密钥（绝不进 git）────────────────────────────────────────────
# 服务器: ~/co-dir/voice-ayuan/env/llm.env，内容只有一行 DEEPSEEK_API_KEY=sk-...
# 目录 700 / 文件 600；本文件里只出现变量名。
if [ -f "$ROOT/env/llm.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/env/llm.env"
  set +a
fi
: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY is missing — write it to env/llm.env (chmod 600)}"

# ── 关思考 ───────────────────────────────────────────────────────────────
# s2s 的 --responses_api_disable_thinking 只发 chat_template_kwargs.enable_thinking=false，
# DeepSeek Responses API 接受但忽略它（实测 reasoning_tokens 仍 >0）；DeepSeek 关思考
# 要用 reasoning.effort=none。deploy/patch-s2s-reasoning.py 把下面这个 env 注入到
# requests 的 extra_body.reasoning.effort（默认 none）。
export VOICE_AYUAN_LLM_REASONING_EFFORT="${VOICE_AYUAN_LLM_REASONING_EFFORT:-none}"

# ── 模型环境（HF 离线加载，避免 hf-mirror 429 拖慢启动）──────────────────
export HF_HUB_DISABLE_XET=1
export SILERO_VAD_REPO=/mnt/data/co-dir/voice-ayuan/torch-hub/hub/snakers4_silero-vad_master
export TORCH_HOME=/mnt/data/co-dir/voice-ayuan/torch-hub
export HF_HOME=/mnt/data/co-dir/voice-ayuan/hf-cache
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-1}"

# ── 实时语音服务 ─────────────────────────────────────────────────────────
# LLM = DeepSeek V4.1 Flash（responses-api，关思考，流式）；STT/TTS 与 2 pipeline 不变。
# 回滚到本地 Qwen3-4B：cp scripts/start.sh.bak-qwen3-4b scripts/start.sh && systemctl --user restart s2s-voice
exec ./venv/bin/speech-to-speech --mode realtime --ws_host 127.0.0.1 --ws_port 8765 --num_pipelines 2 \
  --stt paraformer \
  --llm_backend responses-api --model_name deepseek-flash \
  --responses_api_base_url https://api.deepseek.com/v1 \
  --responses_api_api_key "$DEEPSEEK_API_KEY" \
  --responses_api_disable_thinking true \
  --responses_api_stream true \
  --stream_batch_sentences 1 \
  --tts qwen3 --qwen3_tts_model_name Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --qwen3_tts_speaker Vivian --qwen3_tts_language chinese --device cuda
