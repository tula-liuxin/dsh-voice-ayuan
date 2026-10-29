#!/usr/bin/env python3
"""Patch speech-to-speech 0.2.10 Paraformer STT crash on non-MPS hosts.

Bug (upstream 0.2.10): speech_to_speech/STT/paraformer_handler.py calls
torch.mps.empty_cache() unconditionally after every inference. On Linux +
CUDA torch this raises:

    RuntimeError: Cannot execute emptyCache() without MPS backend.

so ASR fails on every turn, no Transcription is produced, the LLM never runs
and the realtime session emits no response audio.

Fix: only touch the MPS cache when an MPS backend actually exists.

Idempotent: running it again does nothing. The original file is backed up next
to itself as <name>.bak-voice once. Exit code 0 means patched (or already).
"""
from __future__ import annotations

import argparse
import pathlib
import py_compile
import shutil
import sys

MARKER = "# voice-ayuan patch:mps-guard"
OLD = "        torch.mps.empty_cache()\n"

NEW = (
    "        # voice-ayuan patch:mps-guard -- torch.mps.empty_cache() raises on non-MPS hosts\n"
    "        try:\n"
    "            if getattr(torch.backends, \"mps\", None) is not None and torch.backends.mps.is_available():\n"
    "                torch.mps.empty_cache()\n"
    "        except Exception:  # pragma: no cover - defensive\n"
    "            pass\n"
)

TARGET_TAIL = "speech_to_speech/STT/paraformer_handler.py"


def default_target() -> pathlib.Path:
    root = pathlib.Path(__file__).resolve().parent.parent
    candidates = sorted(root.glob("venv/lib/python*/site-packages/" + TARGET_TAIL))
    if not candidates:
        raise SystemExit(
            "cannot locate " + TARGET_TAIL + " under " + str(root / "venv")
        )
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", type=pathlib.Path, default=None,
                        help="paraformer_handler.py path (default: repo venv)")
    parser.add_argument("--check", action="store_true",
                        help="only verify whether the patch is applied")
    args = parser.parse_args()

    target = args.file or default_target()
    if not target.is_file():
        raise SystemExit("missing file: " + str(target))
    text = target.read_text(encoding="utf-8")

    if MARKER in text:
        print("ALREADY PATCHED:", target)
        return 0
    if OLD not in text:
        raise SystemExit("unexpected source: marker line not found in " + str(target))

    if args.check:
        print("NOT PATCHED:", target)
        return 1

    backup = target.with_name(target.name + ".bak-voice")
    if not backup.exists():
        shutil.copy2(target, backup)
        print("backup:", backup)

    target.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    py_compile.compile(str(target), doraise=True)
    print("PATCHED:", target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
