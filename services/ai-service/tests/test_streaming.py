# streaming 회귀 — SSE 응답 형식 / yield 순서 / error path 검증.
#
# 4a (이번 PR): suggest_optimization_stream 만. 4b/4c 에서 이 파일에 chat_stream /
# session_chat_stream 테스트 추가.
#
# OpenAI / Anthropic SDK client 의 async stream 은 mock 하기 복잡 (async
# iterable + chunk.choices[0].delta.content / chunk.usage 형식). 핵심 회귀
# 가드만 단위 테스트로 cover, 실제 streaming 흐름은 e2e (ai-chat.spec) +
# 사용자 UI 검증으로.

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.ai.streaming import suggest_optimization_stream


def _make_service():
    """Minimal AIService mock."""
    service = SimpleNamespace()
    service.model = "gpt-4"
    service.client = MagicMock()
    # _build_optimization_observations 는 dict 반환 (관측 표 + draft)
    service._build_optimization_observations = AsyncMock(
        return_value={
            "observations_md": "| ns | pod | cpu |\n|---|---|---|\n| default | foo | 100m |",
            "action_plan_md": "Test draft action plan",
        }
    )
    return service


def _make_stream_chunks(contents: list[str], usage=None, finish_reason="stop", usage_only_tail=False):
    """OpenAI streaming chunk 형식의 async iterable mock.

    usage_only_tail=True 면 stream_options.include_usage 가 보내는 모양 그대로 —
    usage 는 choices 가 빈 마지막 청크에만 실린다."""
    chunks = []
    for i, content in enumerate(contents):
        is_last = i == len(contents) - 1
        delta = SimpleNamespace(content=content)
        choice = SimpleNamespace(
            delta=delta,
            finish_reason=finish_reason if is_last else None,
        )
        chunk = SimpleNamespace(
            choices=[choice],
            usage=usage if is_last and not usage_only_tail else None,
        )
        chunks.append(chunk)
    if usage_only_tail:
        chunks.append(SimpleNamespace(choices=[], usage=usage))

    class FakeStream:
        def __aiter__(self):
            return self

        def __init__(self):
            self._iter = iter(chunks)

        async def __anext__(self):
            try:
                return next(self._iter)
            except StopIteration:
                raise StopAsyncIteration

    return FakeStream()


@pytest.mark.asyncio
async def test_observations_failure_yields_error_and_done():
    """_build_optimization_observations 가 raise 하면 SSE error + DONE 으로 끝."""
    service = _make_service()
    service._build_optimization_observations = AsyncMock(
        side_effect=RuntimeError("k8s api unreachable")
    )

    events = []
    async for chunk in suggest_optimization_stream(service, "default"):
        events.append(chunk)

    assert len(events) == 2, f"expected error + DONE, got: {events}"
    # 첫 이벤트: error JSON
    assert events[0].startswith("data: ")
    payload = json.loads(events[0][len("data: "):].rstrip("\n"))
    assert payload.get("kind") == "error"
    assert "k8s api unreachable" in payload.get("error", "")
    # 둘째: DONE
    assert events[1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_error_event_masks_a_provider_key():
    """A provider error that repeats the key reaches the browser masked."""
    key = "sk-" + "proj-" + ("aB3dE6" * 10)
    service = _make_service()
    service._build_optimization_observations = AsyncMock(
        side_effect=RuntimeError(f"Error code: 401 - Incorrect API key provided: {key}")
    )

    events = [chunk async for chunk in suggest_optimization_stream(service, "default")]
    payload = json.loads(events[0][len("data: "):].rstrip("\n"))
    assert key not in events[0]
    assert "Incorrect API key provided: <REDACTED:api_key>" in payload.get("error", "")


@pytest.mark.asyncio
async def test_happy_path_yields_observed_then_answer_then_meta_then_done():
    """정상 흐름: observed → answer chunks → meta → (usage if available) → DONE."""
    service = _make_service()
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=20, total_tokens=30)
    service.client.chat.completions.create = AsyncMock(
        return_value=_make_stream_chunks(
            contents=["답변", " 시작", " 끝"], usage=usage, finish_reason="stop"
        )
    )

    events = []
    async for chunk in suggest_optimization_stream(service, "default", lang="ko"):
        events.append(chunk)

    # SSE payload 만 파싱
    parsed = []
    for ev in events:
        if ev == "data: [DONE]\n\n":
            parsed.append({"_done": True})
            continue
        body = ev[len("data: "):].rstrip("\n")
        parsed.append(json.loads(body))

    kinds = [p.get("kind") if not p.get("_done") else "DONE" for p in parsed]

    # observed 가 첫 번째
    assert kinds[0] == "observed"
    # answer chunks 들이 그 다음 (3개)
    assert kinds[1:4] == ["answer", "answer", "answer"]
    # meta 다음
    assert kinds[4] == "meta"
    # usage (선택적)
    assert kinds[5] == "usage"
    # DONE 마지막
    assert kinds[-1] == "DONE"

    # observed 의 content 가 markdown 표 + draft 헤더 포함
    assert "최적화 제안" in parsed[0]["content"]
    # answer content 합치면 원본 chunk 와 같음
    answer_concat = "".join(p["content"] for p in parsed[1:4])
    assert answer_concat == "답변 시작 끝"
    # usage 데이터 보존
    assert parsed[5]["usage"]["total_tokens"] == 30


@pytest.mark.asyncio
@pytest.mark.parametrize("lang,heading,source_line,english_only", [
    ("ko", "## 최적화 제안 (AI)", "'사용량 출처' 줄", False),
    ("en", "## Optimization suggestions (AI)", "'Usage source' line", True),
])
async def test_the_prompt_and_heading_follow_the_ui_language(lang, heading, source_line, english_only):
    """화면 언어로 표 머리말·프롬프트·답 — 모델이 표 줄을 다른 언어 그대로 옮기지 않게(#69)."""
    service = _make_service()
    create_calls = []

    async def create_mock(**kwargs):
        create_calls.append(kwargs)
        return _make_stream_chunks(contents=["ok"])

    service.client.chat.completions.create = create_mock
    events = [c async for c in suggest_optimization_stream(service, "default", lang=lang)]

    service._build_optimization_observations.assert_awaited_once_with("default", lang)
    assert heading in json.loads(events[0][len("data: "):])["content"]
    system, user = create_calls[0]["messages"][0]["content"], create_calls[0]["messages"][1]["content"]
    assert f"screen is in {'Korean' if lang == 'ko' else 'English'}" in system
    assert source_line in user
    if english_only:
        assert not any("가" <= ch <= "힣" for ch in system + user)


@pytest.mark.asyncio
async def test_stream_create_fallback_when_stream_options_unsupported():
    """첫 client.chat.completions.create() 호출이 raise (e.g., 모델이
    stream_options 미지원) 면 stream_options 없이 재호출."""
    service = _make_service()
    usage = SimpleNamespace(prompt_tokens=5, completion_tokens=5, total_tokens=10)
    create_calls = []

    async def create_mock(**kwargs):
        create_calls.append(kwargs)
        # 첫 호출 (stream_options 포함) → 실패
        # 둘째 호출 (stream_options 없음) → 성공
        if "stream_options" in kwargs:
            raise RuntimeError("stream_options not supported by this model")
        return _make_stream_chunks(contents=["ok"], usage=usage)

    service.client.chat.completions.create = create_mock

    events = []
    async for chunk in suggest_optimization_stream(service, "default"):
        events.append(chunk)

    # 두 번 호출됨 (첫째 실패, 둘째 성공)
    assert len(create_calls) == 2
    assert "stream_options" in create_calls[0]
    assert "stream_options" not in create_calls[1]
    # 정상 종료 (DONE 포함)
    assert events[-1] == "data: [DONE]\n\n"


def _capture_audit(monkeypatch):
    rows: list[dict] = []

    async def fake_write_audit(**kw):
        rows.append(kw)
        return True

    monkeypatch.setattr("app.services.audit_writer.write_audit", fake_write_audit)
    return rows


@pytest.mark.asyncio
async def test_audit_row_per_optimization_run(monkeypatch):
    """ai.chat.complete(phase optimization) 1건 — 토큰·target namespace·iterations 1."""
    service = _make_service()
    service.cluster_name = "self"
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=20, total_tokens=30)
    service.client.chat.completions.create = AsyncMock(
        return_value=_make_stream_chunks(contents=["a", "b"], usage=usage, finish_reason="stop")
    )
    rows = _capture_audit(monkeypatch)
    actor = {"user_id": "u1", "email": "u1@example.com"}
    http = {"ip": "10.0.0.1", "user_agent": "ua", "request_id": "rid", "path": "/api/v1/ai/suggest-optimization/stream"}

    events = [c async for c in suggest_optimization_stream(service, "kube-system", audit_actor=actor, audit_http=http)]

    assert events[-1] == "data: [DONE]\n\n"
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == "ai.chat.complete"
    assert row["result"] == "success"
    assert row["actor_email"] == "u1@example.com"
    assert (row["target_type"], row["target_id"]) == ("namespace", "kube-system")
    assert row["cluster"] == "self"
    assert row["path"] == http["path"]
    after = row["after"]
    assert after["phase"] == "optimization"
    assert after["session_id"] is None
    assert (after["prompt_tokens"], after["completion_tokens"], after["total_tokens"]) == (10, 20, 30)
    assert (after["tool_calls"], after["iterations"]) == (0, 1)
    assert after["finish_reason"] == "stop"
    assert after["model"] == "gpt-4"


@pytest.mark.asyncio
async def test_usage_only_final_chunk_is_counted_not_an_error(monkeypatch):
    """include_usage 의 마지막 청크(choices 비어 있음)는 토큰으로 세고 error 이벤트를 내지 않는다."""
    service = _make_service()
    usage = SimpleNamespace(prompt_tokens=7, completion_tokens=3, total_tokens=10)
    service.client.chat.completions.create = AsyncMock(
        return_value=_make_stream_chunks(contents=["x", "y"], usage=usage, usage_only_tail=True)
    )
    rows = _capture_audit(monkeypatch)

    events = [
        c async for c in suggest_optimization_stream(service, "default", audit_actor={"user_id": "u1", "email": "e"}, audit_http={})
    ]

    kinds = [json.loads(e[len("data: "):])["kind"] for e in events if e != "data: [DONE]\n\n"]
    assert "error" not in kinds
    assert kinds[-2:] == ["meta", "usage"]
    assert rows[0]["result"] == "success"
    assert rows[0]["after"]["total_tokens"] == 10
    assert rows[0]["after"]["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_optimization_failure_is_audited_with_null_tokens(monkeypatch):
    service = _make_service()
    service._build_optimization_observations = AsyncMock(side_effect=RuntimeError("tool-server down"))
    rows = _capture_audit(monkeypatch)

    events = [
        c
        async for c in suggest_optimization_stream(
            service, "default", audit_actor={"user_id": "u1", "email": "u1@example.com"}, audit_http={}
        )
    ]

    assert json.loads(events[0][len("data: "):])["kind"] == "error"
    assert events[-1] == "data: [DONE]\n\n"
    assert len(rows) == 1
    assert rows[0]["result"] == "failure"
    assert "tool-server down" in rows[0]["error"]
    assert rows[0]["after"]["phase"] == "optimization"
    assert rows[0]["after"]["total_tokens"] is None


@pytest.mark.asyncio
async def test_cancelled_optimization_is_audited_as_cancelled(monkeypatch):
    """클라이언트가 중간에 끊으면(generator 종료) finish_reason cancelled 행 1건, 토큰은 null."""
    service = _make_service()
    service.client.chat.completions.create = AsyncMock(return_value=_make_stream_chunks(contents=["a", "b", "c"]))
    rows = _capture_audit(monkeypatch)
    gen = suggest_optimization_stream(service, "default", audit_actor={"user_id": "u1", "email": "e"}, audit_http={})
    await gen.__anext__()  # observed
    await gen.__anext__()  # first answer chunk

    await gen.aclose()  # the client went away
    await asyncio.sleep(0.01)  # the spawned write runs on the loop

    assert len(rows) == 1
    assert rows[0]["after"]["finish_reason"] == "cancelled"
    assert rows[0]["after"]["phase"] == "optimization"
    assert rows[0]["after"]["total_tokens"] is None
    assert rows[0]["result"] == "success"


@pytest.mark.asyncio
async def test_optimization_without_actor_writes_no_audit_row(monkeypatch):
    service = _make_service()
    service.client.chat.completions.create = AsyncMock(return_value=_make_stream_chunks(contents=["a"]))
    rows = _capture_audit(monkeypatch)

    events = [c async for c in suggest_optimization_stream(service, "default")]

    assert events[-1] == "data: [DONE]\n\n"
    assert rows == []


def test_a_failed_model_call_names_its_provider_in_one_wording():
    """Every provider's failure reads the same, with a catalog key the screen translates (not "OpenAI API" for all)."""
    from app.services.ai.streaming import model_error

    sub = model_error(SimpleNamespace(provider="claude-code"), RuntimeError("Claude Code failed: exit 2"))
    assert sub == {"error": "AI model call failed (Claude subscription): Claude Code failed: exit 2", "error_key": "modelCall",
                   "error_args": {"provider": "Claude subscription", "detail": "Claude Code failed: exit 2"}}
    assert model_error(SimpleNamespace(provider="Anthropic"), RuntimeError("529"))["error_args"]["provider"] == "Anthropic"
    assert model_error(SimpleNamespace(provider="vllm-gw"), RuntimeError("x"))["error_args"]["provider"] == "vllm-gw"


def test_a_failed_model_call_says_the_kind_of_refusal():
    """Credit, rate, key and outage refusals carry their own catalog key and the English hint; a usage window its time."""
    from app.services.ai.streaming import model_error
    from app.services.anthropic_messages import AnthropicAPIError as Err
    from app.services.claude_code import ClaudeCodeError

    credit = model_error(SimpleNamespace(provider="anthropic"), Err(402, "billing_error", "Your credit balance is too low"))
    assert credit["error_key"] == "modelCredit" and "Admin → AI Models" in credit["error"] and credit["error_args"]["provider"] == "Anthropic"
    assert model_error(SimpleNamespace(provider="anthropic"), Err(429, "rate_limit_error", "Number of requests has exceeded"))["error_key"] == "modelRateLimit"
    assert model_error(SimpleNamespace(provider="anthropic"), Err(401, "authentication_error", "invalid x-api-key"))["error_key"] == "modelAuth"
    assert model_error(SimpleNamespace(provider="anthropic"), Err(529, "overloaded_error", "Overloaded"))["error_key"] == "modelUnavailable"
    window = model_error(SimpleNamespace(provider="claude-code"), ClaudeCodeError("Claude Code (HTTP 429): limit", subscription_error="rate_limit", resets_at=1792407600))
    assert window["error_key"] == "modelUsageWindow" and window["error_args"]["retry_at"] == "2026-10-19T11:00:00Z"
    assert "lifts at 2026-10-19T11:00:00Z" in window["error"]
    assert model_error(SimpleNamespace(provider=None), RuntimeError("x"))["error_args"]["provider"] == "unknown"


@pytest.mark.asyncio
async def test_optimization_over_the_daily_budget_shows_the_table_without_the_model(monkeypatch):
    """The user's daily chat budget covers the explanation: the observed table comes, the model is not called."""
    from app.services.ai import budget as budget_mod

    service = _make_service()
    service.client.chat.completions.create = AsyncMock()
    rows = _capture_audit(monkeypatch)
    monkeypatch.setattr(budget_mod, "limits", lambda: (0, 1000))

    async def db():
        return object()

    async def over(db, session_id, user_id, **kw):
        return budget_mod.Exceeded("user_daily", 1200, 1000)

    monkeypatch.setattr("app.database.get_db_service", db)
    monkeypatch.setattr(budget_mod, "check", over)
    events = [c async for c in suggest_optimization_stream(service, "shop", audit_actor={"user_id": "u1", "email": "e"}, audit_http={})]
    payloads = [json.loads(e[6:]) for e in events if e.startswith("data: {")]
    assert payloads[0]["kind"] == "observed"
    assert payloads[-1]["kind"] == "error" and payloads[-1]["error_key"] == "budgetUserDaily" and payloads[-1]["error_args"] == {"used": 1200, "limit": 1000}
    assert events[-1] == "data: [DONE]\n\n"
    service.client.chat.completions.create.assert_not_called()
    assert [r["action"] for r in rows] == ["ai.chat.budget_exceeded"] and rows[0]["after"]["phase"] == "optimization" and rows[0]["target_id"] == "shop"


@pytest.mark.asyncio
async def test_optimization_model_failure_says_the_kind(monkeypatch):
    from app.services.anthropic_messages import AnthropicAPIError

    service = _make_service()
    service.provider = "anthropic"
    service.client.chat.completions.create = AsyncMock(side_effect=AnthropicAPIError(402, "billing_error", "billing"))
    _capture_audit(monkeypatch)
    events = [c async for c in suggest_optimization_stream(service, "default")]
    err = [json.loads(e[6:]) for e in events if e.startswith("data: {") and '"error"' in e][0]
    assert err["kind"] == "error" and err["error_key"] == "modelCredit" and err["error_args"]["provider"] == "Anthropic"
