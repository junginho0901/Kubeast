"""The model calls one chat answer may make (AI_CHAT_MAX_STEPS, chart ai.chat.maxSteps), what the last of them is told and
what the chat says when that one wrote nothing. On a Claude subscription Claude Code makes the calls and stops at its own
limit (ai.providers.claudeCode.maxTurns); one call without tools then writes the answer. An answer cut at its length goes
on with CONTINUE."""

from __future__ import annotations

import os
from typing import Optional

from app.services.ai.language import detect_response_language

DEFAULT_STEPS = 20
STEPS_RANGE = (1, 100)
SETTING = "ai.chat.maxSteps"
CLAUDE_CODE_SETTING = "ai.providers.claudeCode.maxTurns"
# The language is the answer's, which the model has in front of it: the instruction names none.
CONTINUE = ("Your last answer stopped at its length limit. Go on from right after where it stopped, in the language of that "
            "answer, and do not repeat what it already says.")


def max_steps() -> int:
    """1 to 100: a number outside is the nearer end, anything that is not a number the default. float() first, since the
    chart writes a million as 1e+06."""
    low, high = STEPS_RANGE
    try:
        return min(high, max(low, int(float(os.getenv("AI_CHAT_MAX_STEPS", "").strip() or DEFAULT_STEPS))))
    except (ValueError, OverflowError):
        return DEFAULT_STEPS


def final_message(question: str) -> str:
    """The last call's user message. It names the language of the question, as the language directive does: an English
    sentence that names none can turn a Korean question's answer English."""
    return (
        "You cannot call any more tools for this answer. Answer the question now from what you have read, and say plainly "
        f"what you could not read or check. Write the answer in {detect_response_language(question)}, the language of the question."
    )


def no_answer(question: str, setting: str, finish_reason: Optional[str] = None) -> str:
    """What the chat shows when the last call wrote no text, in the language of the question: that the calls are used up,
    unless the answer ended at its length or the provider's filter stopped it (the last finish reason)."""
    korean = detect_response_language(question) == "Korean"
    if finish_reason == "length":
        if korean:
            return ("모델이 답을 쓰기 전에 답 최대 길이에 닿았습니다. 질문을 더 좁혀 다시 묻거나, "
                    "관리자에게 이 모델의 답 최대 길이(max_tokens)를 올려 달라고 요청하세요.")
        return ("The model reached its answer length before it wrote an answer. Ask something narrower, or ask an "
                "administrator to raise the model's answer length (max_tokens).")
    if finish_reason == "content_filter":
        if korean:
            return "모델 공급자의 콘텐츠 필터가 답이 나오기 전에 답을 막았습니다. 다른 말로 다시 질문하세요."
        return ("The model provider's content filter stopped the answer before any of it came. Ask the question in other "
                "words.")
    if korean:
        return (f"모델이 한 답변에 쓸 수 있는 호출을 모두 쓰고도 답을 쓰지 못했습니다. 질문을 더 좁혀 다시 묻거나, "
                f"관리자에게 {setting} 값을 올려 달라고 요청하세요.")
    return ("The model used all the calls one answer may make and wrote no answer. Ask something narrower, or ask an "
            f"administrator to raise {setting}.")
