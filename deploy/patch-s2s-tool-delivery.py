#!/usr/bin/env python3
"""Patch speech-to-speech 0.2.10 (voice-ayuan 魔改版) so tool-call events are
never silently dropped or delayed by speculative-turn / barge-in handling.

Bug (2026-10-30 19:07:53, reproduced 19:38:37):
  The LM emits one AssistantTextEvent with the spoken text and a second
  AssistantTextEvent carrying ``tools=[spawn_thinking]``. If an earlier
  barge-in already called ``cancel_scope.cancel()`` (discarding=True) and no
  AUDIO_RESPONSE_DONE ever arrives for the cancelled generation (its
  EndOfResponse is itself dropped as stale), ``discarding`` stays True.
  Then every AssistantTextEvent is silently dropped:
    * websocket_router._send_loop_for: `if discarding and isinstance(...): pass`
    * websocket_router._drain_pending_response_events: `if discarding: continue`
  and on_assistant_text can also drop it via
  commit_if_latest_after_reopen_grace() returning False.
  Net effect: the model says "我去查" + calls spawn_thinking, the server logs
  "Sending to clients: text='', tools=['spawn_thinking']", but the client never
  receives response.function_call_arguments.done -> no background task.

Fix:
  1. A tool-bearing AssistantTextEvent is terminal client-visible output:
     dispatch it immediately, never wait for the speculative reopen grace,
     never honor the staleness verdict, never let cancel/discard guards eat it.
  2. Interrupt/cancel queue flushes preserve tool-bearing events.
  3. `_drain_pending_response_events` sends them before response.done.
  4. The only allowed drop is a duplicate call_id (already emitted); it is
     logged at INFO. Drops of plain (no-tool) assistant text while discarding
     are also logged at INFO instead of being silent.
  5. Every tool delivery/drop decision is logged at INFO with the code path.

Idempotent; originals backed up as <file>.bak-voice-toolfix once.
Usage (on the GPU host, from the voice-ayuan repo root):
  python3 scripts/patch-s2s-tool-delivery.py [--check] [--revert]
"""
from __future__ import annotations

import argparse
import pathlib
import py_compile
import shutil
import sys

MARKER = "# voice-ayuan patch:tool-delivery"
PKG_TAIL = "speech_to_speech"
FILES = {
    "response": "api/openai_realtime/handlers/response.py",
    "service": "api/openai_realtime/service.py",
    "router": "api/openai_realtime/websocket_router.py",
}
BACKUP_SUFFIX = ".bak-voice-toolfix"


def find_root() -> pathlib.Path:
    root = pathlib.Path(__file__).resolve().parent.parent
    if list(root.glob("venv/lib/python*/site-packages/" + PKG_TAIL)):
        return root
    cwd = pathlib.Path.cwd()
    if list(cwd.glob("venv/lib/python*/site-packages/" + PKG_TAIL)):
        return cwd
    raise SystemExit("cannot locate venv/lib/python*/site-packages/%s from %s" % (PKG_TAIL, root))


def find_targets(root: pathlib.Path) -> dict[str, pathlib.Path]:
    pkg_dirs = sorted(root.glob("venv/lib/python*/site-packages/" + PKG_TAIL))
    if not pkg_dirs:
        raise SystemExit("missing " + str(root / "venv/lib/python*/site-packages/" + PKG_TAIL))
    pkg = pkg_dirs[0]
    return {key: pkg / rel for key, rel in FILES.items()}


# ── response.py ──────────────────────────────────────────────────────
RESPONSE_OLD_HEAD = """    def on_assistant_text(
        self,
        conn_id: str,
        event: AssistantTextEvent,
        *,
        wait_for_pending_reopen: bool = True,
    ) -> list[ServerEvent] | None:
        \"\"\"Handle assistant_text: emit transcript and/or tool-call events.\"\"\"
        if self._service.speculative_turns:
            commit_result: bool | None
            if wait_for_pending_reopen:
                commit_result = self._service.speculative_turns.commit_if_latest_after_reopen_grace(
                    event.turn_id,
                    event.turn_revision,
                )
            else:
                commit_result = self._service.speculative_turns.try_commit_if_latest_after_reopen_grace(
                    event.turn_id,
                    event.turn_revision,
                )
            if commit_result is None:
                return None
            if not commit_result:
                logger.debug("Dropping stale assistant text for turn=%s rev=%s", event.turn_id, event.turn_revision)
                return []
"""

RESPONSE_NEW_HEAD = """    def on_assistant_text(
        self,
        conn_id: str,
        event: AssistantTextEvent,
        *,
        wait_for_pending_reopen: bool = True,
    ) -> list[ServerEvent] | None:
        \"\"\"Handle assistant_text: emit transcript and/or tool-call events.\"\"\"
        # voice-ayuan patch:tool-delivery -- a tool-bearing AssistantTextEvent is
        # terminal client-visible output. It must never wait for a speculative
        # reopen grace and must be delivered even when the turn is considered
        # stale; only a duplicate call_id may be suppressed (logged at INFO).
        if self._service.speculative_turns:
            if event.tools:
                commit_result = self._service.speculative_turns.try_commit_if_latest_after_reopen_grace(
                    event.turn_id,
                    event.turn_revision,
                )
                logger.info(
                    "voice-ayuan tool-delivery: delivering tool call(s) %s turn=%s rev=%s (commit_result=%s)",
                    [getattr(tool, "name", "?") for tool in event.tools],
                    event.turn_id,
                    event.turn_revision,
                    commit_result,
                )
            else:
                commit_result: bool | None
                if wait_for_pending_reopen:
                    commit_result = self._service.speculative_turns.commit_if_latest_after_reopen_grace(
                        event.turn_id,
                        event.turn_revision,
                    )
                else:
                    commit_result = self._service.speculative_turns.try_commit_if_latest_after_reopen_grace(
                        event.turn_id,
                        event.turn_revision,
                    )
                if commit_result is None:
                    return None
                if not commit_result:
                    logger.info(
                        "voice-ayuan tool-delivery: dropping stale assistant text without tools turn=%s rev=%s",
                        event.turn_id,
                        event.turn_revision,
                    )
                    return []
"""

RESPONSE_OLD_TOOLS = """        if event.tools:
            st.response_usage.tool_calls += len(event.tools)
            for tool in event.tools:
                events.append(
                    ResponseFunctionCallArgumentsDoneEvent(
"""

RESPONSE_NEW_TOOLS = """        if event.tools:
            # voice-ayuan patch:tool-delivery -- duplicate call_id is the only
            # case where a tool call may be suppressed, and it is logged.
            delivered_tools = []
            for tool in event.tools:
                call_id = getattr(tool, "call_id", None)
                if call_id and call_id in st.emitted_tool_call_ids:
                    logger.info(
                        "voice-ayuan tool-delivery: suppressing duplicate function_call call_id=%s name=%s",
                        call_id,
                        getattr(tool, "name", "?"),
                    )
                    continue
                if call_id:
                    st.emitted_tool_call_ids.add(call_id)
                delivered_tools.append(tool)
            st.response_usage.tool_calls += len(delivered_tools)
            for tool in delivered_tools:
                events.append(
                    ResponseFunctionCallArgumentsDoneEvent(
"""

# ── service.py ───────────────────────────────────────────────────────
SERVICE_OLD_FIELD = """    speculative_input_item_id: Optional[str] = None
    speculative_audio_duration_s: float = 0.0
"""

SERVICE_NEW_FIELD = """    speculative_input_item_id: Optional[str] = None
    speculative_audio_duration_s: float = 0.0
    # voice-ayuan patch:tool-delivery -- tool call_ids already emitted to the client
    emitted_tool_call_ids: set[str] = Field(default_factory=set)
"""

SERVICE_OLD_DISPATCH = """    ) -> list[ServerEvent] | None:
        is_stale = self._is_stale_turn_event(event, wait_for_pending_reopen=wait_for_pending_reopen)
        if is_stale is None:
            return None
"""

SERVICE_NEW_DISPATCH = """    ) -> list[ServerEvent] | None:
        # voice-ayuan patch:tool-delivery -- a tool-bearing AssistantTextEvent is
        # terminal client-visible output: bypass the speculative reopen wait and
        # the staleness verdict entirely, deliver immediately, and log it.
        if isinstance(event, AssistantTextEvent) and event.tools:
            stale = self._is_stale_turn_event(event, wait_for_pending_reopen=False)
            if stale is not False:
                logger.info(
                    "voice-ayuan tool-delivery: delivering tool call(s) %s for turn=%s rev=%s "
                    "despite stale=%s (non-blocking check)",
                    [getattr(tool, "name", "?") for tool in event.tools],
                    event.turn_id,
                    event.turn_revision,
                    stale,
                )
            self._observe_turn_event(event)
            return self.response.on_assistant_text(
                conn_id,
                event,
                wait_for_pending_reopen=False,
            )
        is_stale = self._is_stale_turn_event(event, wait_for_pending_reopen=wait_for_pending_reopen)
        if is_stale is None:
            return None
"""

# ── websocket_router.py ──────────────────────────────────────────────
ROUTER_OLD_KEEP = """def _keep_user_text_event(item: Any) -> bool:
    return isinstance(
        item,
        (SpeechStoppedEvent, PartialTranscriptionEvent, TranscriptionCompletedEvent, TokenUsageEvent),
    )
"""

ROUTER_NEW_KEEP = """def _keep_user_text_event(item: Any) -> bool:
    return isinstance(
        item,
        (SpeechStoppedEvent, PartialTranscriptionEvent, TranscriptionCompletedEvent, TokenUsageEvent),
    )


def _is_tool_bearing_assistant_text(item: Any) -> bool:
    # voice-ayuan patch:tool-delivery -- tool-bearing assistant text must never be
    # silently flushed or discarded.
    return isinstance(item, AssistantTextEvent) and bool(getattr(item, "tools", None))


def _keep_user_text_or_tool_event(item: Any) -> bool:
    # voice-ayuan patch:tool-delivery -- tool calls survive interrupt flushes.
    return _keep_user_text_event(item) or _is_tool_bearing_assistant_text(item)
"""

ROUTER_OLD_DRAIN = """            if isinstance(item, TokenUsageEvent):
                unit.service.dispatch_pipeline_event(session_id, item)
                drained_usage += 1
            elif drain_assistant_events and isinstance(item, AssistantTextEvent):
                drained_assistant += 1
                if unit.cancel_scope.discarding:
                    continue
                events = unit.service.dispatch_pipeline_event(session_id, item)
                if ws is not None and events:
                    await _send_events(ws, events)
            else:
"""

ROUTER_NEW_DRAIN = """            if isinstance(item, TokenUsageEvent):
                unit.service.dispatch_pipeline_event(session_id, item)
                drained_usage += 1
            elif _is_tool_bearing_assistant_text(item):
                # voice-ayuan patch:tool-delivery -- deliver tool calls before
                # response.done even when discarding and past a text boundary.
                drained_assistant += 1
                logger.info(
                    "Pipeline %d: delivering %d tool call(s) during response drain (discarding=%s, turn=%s rev=%s)",
                    unit.index,
                    len(item.tools),
                    unit.cancel_scope.discarding,
                    item.turn_id,
                    item.turn_revision,
                )
                events = unit.service.dispatch_pipeline_event(session_id, item)
                if ws is not None and events:
                    await _send_events(ws, events)
            elif drain_assistant_events and isinstance(item, AssistantTextEvent):
                drained_assistant += 1
                if unit.cancel_scope.discarding:
                    logger.info(
                        "Pipeline %d: dropping assistant text during response drain (discarding=True, no tools, turn=%s rev=%s)",
                        unit.index,
                        item.turn_id,
                        item.turn_revision,
                    )
                    continue
                events = unit.service.dispatch_pipeline_event(session_id, item)
                if ws is not None and events:
                    await _send_events(ws, events)
            else:
"""

ROUTER_OLD_SEND_GUARD = """                    if unit.cancel_scope.discarding and isinstance(text_msg, AssistantTextEvent):
                        pass
                    elif ws is not None and isinstance(text_msg, PipelineEvent) and session_id:
                        events = unit.service.dispatch_pipeline_event(session_id, text_msg)
                        if events:
                            await _send_events(ws, events)
"""

ROUTER_NEW_SEND_GUARD = """                    if (
                        unit.cancel_scope.discarding
                        and isinstance(text_msg, AssistantTextEvent)
                        and not _is_tool_bearing_assistant_text(text_msg)
                    ):
                        # voice-ayuan patch:tool-delivery -- never silent: log the drop.
                        logger.info(
                            "Pipeline %d: dropping assistant text while discarding (no tools, turn=%s rev=%s)",
                            unit.index,
                            text_msg.turn_id,
                            text_msg.turn_revision,
                        )
                    elif ws is not None and isinstance(text_msg, PipelineEvent) and session_id:
                        if _is_tool_bearing_assistant_text(text_msg):
                            logger.info(
                                "Pipeline %d: delivering %d tool call(s)%s (turn=%s rev=%s)",
                                unit.index,
                                len(text_msg.tools),
                                " despite discarding=True" if unit.cancel_scope.discarding else "",
                                text_msg.turn_id,
                                text_msg.turn_revision,
                            )
                        events = unit.service.dispatch_pipeline_event(session_id, text_msg)
                        if events:
                            await _send_events(ws, events)
"""

ROUTER_OLD_FLUSH = "_flush_queue(unit.text_output_queue, preserve=_keep_user_text_event)"
ROUTER_NEW_FLUSH = "_flush_queue(unit.text_output_queue, preserve=_keep_user_text_or_tool_event)"


def patch_file(path: pathlib.Path, replacements: list[tuple[str, str, int]], *, check: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("ALREADY PATCHED:", path)
        return True
    for old, new, count in replacements:
        if old not in text:
            raise SystemExit("unexpected source: anchor not found in %s:\n%s" % (path, old[:200]))
        found = text.count(old)
        if count < 0:
            if found < 1:
                raise SystemExit("anchor missing in %s:\n%s" % (path, old[:200]))
        elif found != count:
            raise SystemExit("anchor appears %d times (expected %d) in %s:\n%s" % (found, count, path, old[:200]))
        text = text.replace(old, new, -1 if count < 0 else count)
    if check:
        print("NOT PATCHED:", path)
        return False
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup.exists():
        shutil.copy2(path, backup)
        print("backup:", backup)
    path.write_text(text, encoding="utf-8")
    py_compile.compile(str(path), doraise=True)
    print("PATCHED:", path)
    return True


def revert_file(path: pathlib.Path) -> None:
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup.exists():
        print("no backup, skip:", path)
        return
    shutil.copy2(backup, path)
    py_compile.compile(str(path), doraise=True)
    print("REVERTED:", path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--revert", action="store_true")
    args = parser.parse_args()

    targets = find_targets(find_root())
    if args.revert:
        for path in targets.values():
            revert_file(path)
        return 0

    ok = True
    # response.py: two independent edits; the marker check happens per file.
    ok &= patch_file(
        targets["response"],
        [(RESPONSE_OLD_HEAD, RESPONSE_NEW_HEAD, 1), (RESPONSE_OLD_TOOLS, RESPONSE_NEW_TOOLS, 1)],
        check=args.check,
    )
    ok &= patch_file(
        targets["service"],
        [(SERVICE_OLD_FIELD, SERVICE_NEW_FIELD, 1), (SERVICE_OLD_DISPATCH, SERVICE_NEW_DISPATCH, 1)],
        check=args.check,
    )
    ok &= patch_file(
        targets["router"],
        [
            (ROUTER_OLD_KEEP, ROUTER_NEW_KEEP, 1),
            (ROUTER_OLD_DRAIN, ROUTER_NEW_DRAIN, 1),
            (ROUTER_OLD_SEND_GUARD, ROUTER_NEW_SEND_GUARD, 1),
            (ROUTER_OLD_FLUSH, ROUTER_NEW_FLUSH, -1),
        ],
        check=args.check,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())


