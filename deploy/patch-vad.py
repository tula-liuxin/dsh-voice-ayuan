"""让 speech-to-speech 的 silero VAD 从本地目录加载（服务器连不上 GitHub）。

在 venv 里跑一次即可：
  ~/co-dir/voice-ayuan/venv/bin/python deploy/patch-vad.py
"""
import pathlib
import re
import sys

TARGET = pathlib.Path.home() / "co-dir/voice-ayuan/venv/lib/python3.12/site-packages/speech_to_speech/VAD/vad_handler.py"

def main() -> int:
    s = TARGET.read_text()
    if "SILERO_VAD_REPO" in s:
        print("already patched")
        return 0
    pattern = re.compile(r'torch\.hub\.load\(\s*"snakers4/silero-vad",\s*"silero_vad",[^)]*\)', re.S)
    replacement = (
        'torch.hub.load('
        'os.environ.get("SILERO_VAD_REPO", "snakers4/silero-vad"), '
        '"silero_vad", '
        'source=("local" if os.environ.get("SILERO_VAD_REPO") else "github"), '
        'trust_repo=True, skip_validation=True)'
    )
    patched, count = pattern.subn(replacement, s)
    if count != 1:
        print("unexpected matches:", count)
        return 1
    if not any(line.strip() == "import os" for line in patched.splitlines()):
        lines = patched.splitlines(True)
        for index, line in enumerate(lines):
            if line.startswith("from __future__"):
                lines.insert(index + 1, "import os\n")
                break
        else:
            lines.insert(0, "import os\n")
        patched = "".join(lines)
    TARGET.write_text(patched)
    print("patched ok")
    return 0

if __name__ == "__main__":
    sys.exit(main())
