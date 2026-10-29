#!/usr/bin/env bash
set -euo pipefail
export HF_HUB_DISABLE_XET=1
export HF_HOME=/mnt/data/co-dir/voice-ayuan/hf-cache
export HF_ENDPOINT=https://hf-mirror.com
cd "$(dirname "$0")/.."
exec ./venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
for repo in ["Qwen/Qwen3-4B-Instruct-2507", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"]:
    print("downloading", repo, flush=True)
    snapshot_download(repo_id=repo, max_workers=2)
    print("done", repo, flush=True)
PY
