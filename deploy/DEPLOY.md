# 术影服务器部署（voice-ayuan）

> 规则：**一律放镜像目录，不写 home 根目录。**
> 工作区 `~/co-dir/voice-ayuan` ↔ 镜像 `/mnt/data/co-dir/voice-ayuan`。

## 目录

| 路径 | 用途 |
|---|---|
| `~/co-dir/voice-ayuan/venv` | Python 3.12 venv |
| `~/co-dir/voice-ayuan/scripts/{start,status,download-models}.sh` | 启停与自检 |
| `/mnt/data/co-dir/voice-ayuan/hf-cache` | `HF_HOME` |
| `/mnt/data/co-dir/voice-ayuan/torch-hub` | `TORCH_HOME`（含本地 silero-vad） |
| `/mnt/data/co-dir/voice-ayuan/models` | 预留：ModelScope 直下权重 |

## 已验证的版本组合（不可随意升级）

| 包 | 版本 | 原因 |
|---|---|---|
| speech-to-speech | 0.2.10 | 1.1.0 依赖 `qwentts-cpp-python`，无 Linux cp312 wheel |
| transformers | **5.15.1** | 5.21 报 `upsample` setter；4.57 缺 `standardize_rope` |
| torch | 2.15.0 | 随 s2s 解析 |
| hf-xet | **不装** | hf-mirror 不代理 Xet CAS，会 401/挂死 |

## 安装

```bash
ssh -p 44022 qiu_team@58.246.75.58
mkdir -p ~/co-dir/voice-ayuan/{logs,config,scripts}
mkdir -p /mnt/data/co-dir/voice-ayuan/{models,hf-cache,torch-hub/hub}
python3 -m venv ~/co-dir/voice-ayuan/venv
~/co-dir/voice-ayuan/venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  "speech-to-speech[paraformer]"
~/co-dir/voice-ayuan/venv/bin/pip install transformers==5.15.1
~/co-dir/voice-ayuan/venv/bin/pip uninstall -y hf-xet
```

## 三个必须的避坑补丁

1. **GitHub 不可达** → 把 silero-vad 文件放到 `torch-hub/hub/snakers4_silero-vad_master`，
   然后跑 `deploy/patch-vad.py` 让 VAD 走本地。
2. **HF Xet 挂死** → 卸载 `hf-xet`。
3. **hf-mirror 429** → 用 `scripts/download-models.sh` 单独预下模型，不要边跑边下。

## 模型（国内镜像备选）

ModelScope 上两个都有，重装时优先：
```bash
modelscope download --model Qwen/Qwen3-4B-Instruct-2507 \
  --local_dir /mnt/data/co-dir/voice-ayuan/models/Qwen3-4B-Instruct-2507
modelscope download --model Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --local_dir /mnt/data/co-dir/voice-ayuan/models/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

## 运行

```bash
systemd-run --user --unit=s2s-voice --collect \
  --working-directory=$HOME/co-dir/voice-ayuan \
  $HOME/co-dir/voice-ayuan/scripts/start.sh
systemctl --user status s2s-voice
journalctl --user -u s2s-voice -f
```

隧道（插件会自动起，手工验证用）：
```bash
ssh -N -p 44022 -L 18765:127.0.0.1:8765 qiu_team@58.246.75.58
```

## GPU

2×4090 48G；GPU0 常驻别人的 vLLM（约 46G），服务固定用 **GPU1**（`CUDA_VISIBLE_DEVICES=1`）。
