#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export HF_HUB_DISABLE_XET=1
export SILERO_VAD_REPO=/mnt/data/co-dir/voice-ayuan/torch-hub/hub/snakers4_silero-vad_master
export TORCH_HOME=/mnt/data/co-dir/voice-ayuan/torch-hub
export HF_HOME=/mnt/data/co-dir/voice-ayuan/hf-cache
export HF_ENDPOINT=https://hf-mirror.com
# 模型已在 /mnt/data/co-dir/voice-ayuan/hf-cache 预下载：离线加载避免每次启动打
# hf-mirror 被 429 限速拖慢（实测 2 pipeline 启动会因此卡数分钟）。
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-1}"
exec ./venv/bin/speech-to-speech --mode realtime --ws_host 127.0.0.1 --ws_port 8765 --num_pipelines 2 \
  --stt paraformer --llm_backend transformers --model_name Qwen/Qwen3-4B-Instruct-2507 \
  --tts qwen3 --qwen3_tts_model_name Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --qwen3_tts_speaker Vivian --qwen3_tts_language chinese --device cuda
