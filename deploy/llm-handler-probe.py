#!/usr/bin/env python3
"""Handler-level probe for speech-to-speech ResponsesApiModelHandler + DeepSeek.

Instantiates the real handler (no GPU models involved) from the s2s venv, verifies
the voice-ayuan reasoning-effort patch is in effect, then measures against
api.deepseek.com/v1/responses:
  - streaming text: TTFT, total, Chinese reply quality
  - usage: reasoning_tokens (must be 0 => thinking disabled)
  - tool call: function_call item name/arguments + latency
  - nltk sentence tokenization of a Chinese reply (affects TTS streaming latency)

Run on the server with the s2s venv python:
  set -a; source ~/co-dir/voice-ayuan/env/llm.env; set +a
  VOICE_AYUAN_LLM_REASONING_EFFORT=none \
    ~/co-dir/voice-ayuan/venv/bin/python ~/co-dir/voice-ayuan/scripts/llm-handler-probe.py
"""
from __future__ import annotations

import json
import os
import queue
import time
from threading import Event

KEY = os.environ.get("DEEPSEEK_API_KEY", "")
if not KEY:
    raise SystemExit("DEEPSEEK_API_KEY missing (source env/llm.env)")

from nltk import sent_tokenize
from openai import Stream
from openai.types.responses import (
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemDoneEvent,
    ResponseTextDeltaEvent,
)
from speech_to_speech.LLM.responses_api_language_model import ResponsesApiModelHandler

BASE_URL = "https://api.deepseek.com/v1"
MODEL = "deepseek-flash"
REPORT = {"baseUrl": BASE_URL, "model": MODEL, "reasoningEffortEnv": os.environ.get("VOICE_AYUAN_LLM_REASONING_EFFORT")}


def build_handler(stream_batch_sentences: int) -> ResponsesApiModelHandler:
    started = time.perf_counter()
    handler = ResponsesApiModelHandler(
        Event(), queue.Queue(), queue.Queue(),
        setup_kwargs=dict(
            model_name=MODEL,
            base_url=BASE_URL,
            api_key=KEY,
            stream=True,
            disable_thinking=True,
            request_timeout_s=20.0,
            stream_batch_sentences=stream_batch_sentences,
            cancel_scope=None,
            speculative_turns=None,
        ),
    )
    REPORT["handlerWarmupMs"] = int((time.perf_counter() - started) * 1000)
    REPORT["extraBody"] = handler._extra_body
    REPORT["streamBatchSentences"] = handler.stream_batch_sentences
    return handler


def stream_call(handler, messages, tools=None, tool_choice=None, label=""):
    started = time.perf_counter()
    first_delta = None
    first_any = None
    text = ""
    tool_calls = []
    usage = None
    event_types = []
    api = handler.client.responses.create(
        model=MODEL,
        input=messages,
        stream=True,
        extra_body=handler._extra_body,
        timeout=handler.request_timeout,
        **({"tools": tools} if tools else {}),
        **({"tool_choice": tool_choice} if tool_choice else {}),
    )
    assert isinstance(api, Stream)
    for ev in api:
        event_types.append(type(ev).__name__)
        if first_any is None:
            first_any = time.perf_counter()
        if isinstance(ev, ResponseTextDeltaEvent):
            if first_delta is None:
                first_delta = time.perf_counter()
            text += ev.delta
        elif isinstance(ev, ResponseOutputItemDoneEvent) and isinstance(ev.item, ResponseFunctionToolCall):
            tool_calls.append({"name": ev.item.name, "arguments": ev.item.arguments, "at_ms": int((time.perf_counter() - started) * 1000)})
        elif isinstance(ev, ResponseCompletedEvent):
            u = getattr(ev.response, "usage", None)
            if u is not None:
                usage = {
                    "input_tokens": u.input_tokens,
                    "output_tokens": u.output_tokens,
                    "reasoning_tokens": getattr(getattr(u, "output_tokens_details", None), "reasoning_tokens", None),
                }
    return {
        "label": label,
        "ttftMs": int((first_delta - started) * 1000) if first_delta else None,
        "firstEventMs": int((first_any - started) * 1000) if first_any else None,
        "totalMs": int((time.perf_counter() - started) * 1000),
        "text": text,
        "toolCalls": tool_calls,
        "usage": usage,
        "eventTypes": sorted(set(event_types)),
    }


def user_input(text):
    return [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}]


def main():
    handler = build_handler(stream_batch_sentences=1)

    # 1) Chinese quick reply, thinking disabled
    r1 = stream_call(handler, user_input("用中文回答，只回一句话：你好，今天心情怎么样？"), label="zh-quick")
    REPORT["zhQuick"] = r1
    REPORT["zhSentenceSplit"] = sent_tokenize(r1["text"])

    # 2) Realistic short assistant turn
    r2 = stream_call(handler, user_input("用户说：帮我查一下明天北京的天气。请用一句自然的中文口语回应，不要编造天气数据。"), label="zh-assist")
    REPORT["zhAssist"] = r2
    REPORT["zhAssistSentenceSplit"] = sent_tokenize(r2["text"])

    # 3) Tool call (same flat GA tool schema the Gateway sends upstream)
    tools = [{
        "type": "function",
        "name": "test_echo",
        "description": "回声测试：原样返回 text 参数。",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    }]
    r3 = stream_call(
        handler,
        user_input("请调用 test_echo 工具，把 text 参数设为「你好阿源」，不要只用文字回答。"),
        tools=tools, tool_choice="auto", label="tool-call",
    )
    REPORT["toolCall"] = r3

    print(json.dumps(REPORT, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
