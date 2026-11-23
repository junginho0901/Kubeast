"""The same read twice in one chat answer or one alert investigation (AI_REFUSE_REPEATED_READS, chart
ai.refuseRepeatedReads, off by default).

A read tool called again with the same arguments less than REPEAT_SECONDS after the first call of that turn (chat) or
run (investigation) answered is not run: the model is told where it already has the answer and that other arguments
would run, as HolmesGPT does. Past REPEAT_SECONDS it runs, since a rollout or a pod may have moved on. A call that
failed or was refused is not kept, so it can be tried again. The check sits where the tool calls arrive
(streaming._call_tool for the chat, the investigator's run_tool), which both loops reach: the API-key loop and Claude
Code's calls on a Claude subscription.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from app.services import switch

REPEAT_SECONDS = 60.0
STATUS = "repeated"


def enabled() -> bool:
    return switch.env_on("AI_REFUSE_REPEATED_READS")


def key(name: str, args: Any) -> str:
    """Same tool, same arguments: an argument given as null is one not given (the tools read them with .get)."""
    given = {k: v for k, v in args.items() if v is not None} if isinstance(args, dict) else {}
    return json.dumps([name, given], sort_keys=True, ensure_ascii=False, default=str)


@dataclass(frozen=True)
class Seen:
    step: int                    # the iteration of the call that answered
    call: Optional[int]          # its number: the chat's call_id, the investigation's place in its call log (from 1)
    at: float                    # time.monotonic() when it answered


class RepeatGuard:
    """One per chat turn or investigation run."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._seen: dict[str, Seen] = {}

    def earlier(self, name: str, args: Any) -> Optional[Seen]:
        """The call this one repeats, when it is a read that answered less than REPEAT_SECONDS ago."""
        from app.services.tool_whitelists import READONLY_TOOL_NAMES

        if name not in READONLY_TOOL_NAMES:
            return None
        seen = self._seen.get(key(name, args))
        if seen is None or self._clock() - seen.at >= REPEAT_SECONDS:
            return None
        return seen

    def note(self, name: str, args: Any, *, step: int, call: Optional[int] = None) -> None:
        """A read that answered: the next same call within REPEAT_SECONDS is refused."""
        from app.services.tool_whitelists import READONLY_TOOL_NAMES

        if name in READONLY_TOOL_NAMES:
            self._seen[key(name, args)] = Seen(step=step, call=call, at=self._clock())

    def age(self, seen: Seen) -> int:
        return int(self._clock() - seen.at)


def refusal(seen: Seen, age: int, *, scope: str, numbered: bool = False) -> str:
    """What the model reads instead of a result. `scope`: "answer" (chat) or "investigation". `numbered`: the model
    reads each result under its call number (an investigation with investigation/numbers.py on), so the earlier call
    is named by that number, `repeat_of_call`, and not by its step."""
    told: dict[str, Any] = {"status": STATUS}
    if numbered and seen.call is not None:
        n = seen.call
        if seen.step == 0:
            where = f"by the server before the investigation started (call {n}); its answer is the one under [call {n}] above"
        else:
            where = f"as call {n} of this {scope}, {age} seconds ago; its result is the one under [call {n}] above"
        told["repeat_of_call"] = n
    else:
        if seen.step == 0:
            where = "by the server before the investigation started (step 0); its answer is above, before your first call"
        else:
            where = f"at step {seen.step} of this {scope}, {age} seconds ago; its result is above"
        told["repeat_of"] = seen.step
    told["message"] = (f"This read, the same tool with the same arguments, was already made {where}. It was not run again. "
                       "Use that result, or call with other arguments (another name, namespace, time range or filter) "
                       "to read something new.")
    return json.dumps(told, ensure_ascii=False)
