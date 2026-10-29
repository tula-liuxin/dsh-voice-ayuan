#!/usr/bin/env python3
"""Patch speech-to-speech 0.2.10 ResponsesApiModelHandler so DeepSeek thinking
can be disabled.

Why: speech-to-speech's responses-api handler maps --responses_api_disable_thinking
to extra_body={"chat_template_kwargs": {"enable_thinking": False}} (a vLLM/Together
convention). DeepSeek's Responses API accepts but IGNORES that field and keeps
thinking on (verified: reasoning item + reasoning_tokens>0). DeepSeek disables
thinking with reasoning.effort="none" (accepted values: none,minimal,low,medium,
high,xhigh,ultra,max; "off" is rejected with HTTP 422).

Fix: after the handler builds its extra_body, merge
    {"reasoning": {"effort": <VOICE_AYUAN_LLM_REASONING_EFFORT, default "none">}}
so every Responses API request carries it.

Env:
  VOICE_AYUAN_LLM_REASONING_EFFORT  none (default) | minimal | low | medium | high | xhigh | ultra | max
  Set to "default" to leave the API default (thinking as the model decides).

Idempotent; original backed up as <file>.bak-voice-reasoning once.
Usage:
  python3 patch-s2s-reasoning.py [--file PATH] [--check]
"""
from __future__ import annotations

import argparse
import pathlib
import py_compile
import shutil
import sys

MARKER = "# voice-ayuan patch:deepseek-reasoning"

OLD_IMPORTS = "import logging\nimport time\n"
NEW_IMPORTS = "import logging\nimport os\nimport time\n"

ANCHOR = "        self.compactor = build_compactor(self._build_compaction_generate_fn()) if compact_history else None\n"
INJECT = (
    "        " + MARKER + " -- DeepSeek Responses API disables thinking via reasoning.effort\n"
    "        _voice_ayuan_effort = (os.environ.get(\"VOICE_AYUAN_LLM_REASONING_EFFORT\") or \"none\").strip().lower()\n"
    "        if _voice_ayuan_effort and _voice_ayuan_effort != \"default\":\n"
    "            self._extra_body = {**(self._extra_body or {}), \"reasoning\": {\"effort\": _voice_ayuan_effort}}\n"
)

TARGET_TAIL = "speech_to_speech/LLM/responses_api_language_model.py"


def default_target() -> pathlib.Path:
    root = pathlib.Path(__file__).resolve().parent.parent
    candidates = sorted(root.glob("venv/lib/python*/site-packages/" + TARGET_TAIL))
    if not candidates:
        raise SystemExit("cannot locate " + TARGET_TAIL + " under " + str(root / "venv"))
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=pathlib.Path, default=None)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    target = args.file or default_target()
    if not target.is_file():
        raise SystemExit("missing file: " + str(target))
    text = target.read_text(encoding="utf-8")

    if MARKER in text:
        print("ALREADY PATCHED:", target)
        return 0
    if OLD_IMPORTS not in text or ANCHOR not in text:
        raise SystemExit("unexpected source: anchors not found in " + str(target))
    if args.check:
        print("NOT PATCHED:", target)
        return 1

    backup = target.with_name(target.name + ".bak-voice-reasoning")
    if not backup.exists():
        shutil.copy2(target, backup)
        print("backup:", backup)

    patched = text.replace(OLD_IMPORTS, NEW_IMPORTS, 1).replace(ANCHOR, INJECT + ANCHOR, 1)
    target.write_text(patched, encoding="utf-8")
    py_compile.compile(str(target), doraise=True)
    print("PATCHED:", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
