"""Recorded tool answers for AI evaluation (evals/ai/README.md "Recorded tool answers"): one run records each read
tool's answer, later runs get the same answers back, so two models or two prompts can be compared on identical
cluster data instead of a dev cluster that changes between runs.

Off unless the environment says otherwise, read once at start (main.py), and not a chart value:

  AI_TOOL_REPLAY_MODE           off (default) | record | replay
  AI_TOOL_REPLAY_DIR            the directory of recorded answers (made when missing)
  AI_TOOL_REPLAY_TEST_INSTALL   must be "true" for record or replay; the service does not start without it

Every tool call of the chat (both loops and Claude Code) and of the alert investigator passes AIService.
_execute_function_with_context, which hands it here. Write and action tools are never recorded or replayed.

record: the call runs as always; its answer, masked again with the shared rules (redaction on whatever the install's
switch says), is written to <dir>/<tool>-<key>.json and that same text goes back to the model, so a replay returns
what the recording run saw.

replay: a recorded answer is returned without running the tool; a call with no recording gets an error result
saying so and never runs live. AIService._call_tool_server refuses too (an approved write included), so nothing
reaches tool-server. The audit row of every call is written as before, with replay: true and replay_hit.

key: sha256 of {"cluster", "tool", "args"} as compact JSON with sorted keys, after normalized_args — the model's
cluster argument dropped (the call is pinned to the active cluster, which is in the key), None values dropped,
strings stripped of surrounding whitespace. Nothing else is normalized: a PromQL written differently or another
time misses, which is why a replay run reports its hits.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional

log = logging.getLogger(__name__)

MODE_ENV = "AI_TOOL_REPLAY_MODE"
DIR_ENV = "AI_TOOL_REPLAY_DIR"
TEST_INSTALL_ENV = "AI_TOOL_REPLAY_TEST_INSTALL"

OFF, RECORD, REPLAY = "off", "record", "replay"
FORMAT = 1
# The outcome of the service's last call in replay mode: "hit", "miss" or "refused".
OUTCOME_ATTR = "tool_replay_outcome"
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")


class ReplayConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    mode: str = OFF
    directory: Optional[Path] = None


_settings = Settings()


def load(env: Mapping[str, str]) -> Settings:
    """The settings the environment asks for; ReplayConfigError when they cannot be used."""
    mode = (env.get(MODE_ENV) or OFF).strip().lower()
    if mode not in (OFF, RECORD, REPLAY):
        raise ReplayConfigError(f"{MODE_ENV}={mode!r}: use off, record or replay")
    if mode == OFF:
        return Settings()
    if (env.get(TEST_INSTALL_ENV) or "").strip().lower() != "true":
        raise ReplayConfigError(f"{MODE_ENV}={mode} needs {TEST_INSTALL_ENV}=true: recorded tool answers are for a test install only")
    raw = (env.get(DIR_ENV) or "").strip()
    if not raw:
        raise ReplayConfigError(f"{MODE_ENV}={mode} needs {DIR_ENV}")
    directory = Path(raw)
    # Made in replay too: a new pod starts with an empty /tmp, and the recordings are copied in after it has started
    # (each call reads its file then; until they are there every call is a miss).
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ReplayConfigError(f"{DIR_ENV}={raw}: cannot be made ({type(e).__name__})") from e
    if not directory.is_dir():
        raise ReplayConfigError(f"{DIR_ENV}={raw}: not a directory")
    return Settings(mode=mode, directory=directory)


def configure(settings: Settings) -> None:
    global _settings
    _settings = settings


def settings() -> Settings:
    return _settings


def start(env: Optional[Mapping[str, str]] = None) -> Settings:
    """Read the environment once, at start. Raises ReplayConfigError, so the service does not start half set."""
    s = load(os.environ if env is None else env)
    configure(s)
    if s.mode != OFF:
        held = sum(1 for _ in s.directory.glob("*.json"))
        log.warning("AI tool replay: %s, directory %s holding %d recordings (a test install; tool answers are %s)",
                    s.mode, s.directory, held,
                    "written to that directory" if s.mode == RECORD else "served from that directory, the cluster is not read")
    return s


def serving() -> bool:
    return _settings.mode == REPLAY


def _norm(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return {str(k): _norm(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [_norm(v) for v in value]
    return value


def normalized_args(args: Any) -> dict:
    if not isinstance(args, dict):
        return {}
    return {str(k): _norm(v) for k, v in args.items() if k != "cluster" and v is not None}


def key(cluster: str, tool: str, args: Any) -> str:
    text = json.dumps({"cluster": cluster, "tool": tool, "args": normalized_args(args)},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def path_for(directory: Path, tool: str, digest: str) -> Path:
    return directory / f"{_UNSAFE_NAME.sub('_', tool)[:64]}-{digest}.json"


def recordable(tool: str) -> bool:
    from app.services.tool_whitelists import ACTION_TOOL_NAMES, WRITE_TOOL_NAMES

    return tool not in WRITE_TOOL_NAMES and tool not in ACTION_TOOL_NAMES


def _mask_options():
    from app.services import redact

    env = redact.from_env()
    return redact.Options(enabled=True, pii=env.pii)


def masked(result: Any) -> str:
    from app.services import redact

    return redact.redact_text(result if isinstance(result, str) else str(result), _mask_options())[0]


def _masked_args(args: dict) -> Any:
    from app.services import redact

    return redact.redact_object(copy.deepcopy(args), _mask_options())[0]


def _write(directory: Path, cluster: str, tool: str, args: dict, text: str) -> None:
    digest = key(cluster, tool, args)
    record = {
        "format": FORMAT,
        "key": digest,
        "tool": tool,
        "cluster": cluster,
        "args": _masked_args(normalized_args(args)),
        "result": text,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    target = path_for(directory, tool, digest)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".rec-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=1)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read(directory: Path, tool: str, digest: str) -> Optional[str]:
    try:
        record = json.loads(path_for(directory, tool, digest).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log.warning("AI tool replay: recording %s-%s unreadable: %s", tool, digest[:12], type(e).__name__)
        return None
    if not isinstance(record, dict) or record.get("key") != digest or not isinstance(record.get("result"), str):
        return None
    return record["result"]


def _refusal(service, status: str, message: str) -> str:
    setattr(service, OUTCOME_ATTR, "refused")
    return json.dumps({"error": message, "status": status}, ensure_ascii=False)


async def answer(service, tool: str, args: Any, run: Callable[[], Awaitable[str]]) -> str:
    """The tool's answer as the mode gives it; `run` is the live call."""
    s = _settings
    if s.mode == OFF or s.directory is None:
        return await run()
    setattr(service, OUTCOME_ATTR, None)
    from app.services.ai import permissions

    call_args = args if isinstance(args, dict) else {}
    cluster = permissions.effective_cluster(service)
    if s.mode == RECORD:
        result = await run()
        if not recordable(tool):
            return result
        text = masked(result)
        try:
            _write(s.directory, cluster, tool, call_args, text)
        except OSError as e:
            log.warning("AI tool replay: %s not recorded: %s", tool, type(e).__name__)
        return text
    if not recordable(tool):
        return _refusal(service, "replay_refused", f"{tool} does not run in replay mode: only read tools are replayed, and nothing reaches the cluster.")
    if not service._is_tool_allowed(tool):
        return _refusal(service, "not_permitted", f"{tool} is not permitted for this user.")
    if reason := permissions.namespace_scope_error(getattr(service, "token", None), cluster, tool, call_args):
        return _refusal(service, "forbidden", reason)
    digest = key(cluster, tool, call_args)
    recorded = _read(s.directory, tool, digest)
    if recorded is None:
        setattr(service, OUTCOME_ATTR, "miss")
        return json.dumps({
            "error": f"No recorded answer for this {tool} call (replay mode, key {digest[:12]}). The cluster was not read.",
            "status": "replay_miss",
        }, ensure_ascii=False)
    setattr(service, OUTCOME_ATTR, "hit")
    return recorded


def call_fields(service, ran: bool) -> dict:
    """What a tool call's audit row, its chat event and its investigation entry add in replay mode: replay, and for a
    call that came here whether a recording answered it. Empty in the other modes."""
    if _settings.mode != REPLAY:
        return {}
    if not ran:
        return {"replay": True}
    return {"replay": True, "replay_hit": getattr(service, OUTCOME_ATTR, None) == "hit"}


def refused_call() -> str:
    """AIService._call_tool_server's answer in replay mode."""
    return json.dumps({"error": "Replay mode: this install reads no cluster, so the call was not run.", "status": "replay_refused"},
                      ensure_ascii=False)
