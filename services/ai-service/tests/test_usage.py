from types import SimpleNamespace

from app.services.ai import usage


def test_add_usage_sums_objects_and_dicts_and_ignores_none():
    t = usage.new_turn_usage()
    usage.add_usage(t, None)
    assert t["seen"] is False
    usage.add_usage(t, SimpleNamespace(prompt_tokens=100, completion_tokens=20, total_tokens=120))
    usage.add_usage(t, {"prompt_tokens": 50, "completion_tokens": 5, "total_tokens": 55})
    assert (t["prompt_tokens"], t["completion_tokens"], t["total_tokens"], t["seen"]) == (150, 25, 175, True)


def test_add_usage_derives_total_when_missing():
    t = usage.add_usage(usage.new_turn_usage(), {"prompt_tokens": 7, "completion_tokens": 3})
    assert t["total_tokens"] == 10


def test_payload_nulls_tokens_when_provider_sent_no_usage():
    p = usage.chat_complete_payload(
        session_id="s1", provider="ollama", model="granite4.1:8b", cluster="self",
        usage=usage.new_turn_usage(), tool_calls=2, iterations=3, duration_ms=1234, finish_reason="stop", message_length=42,
    )
    assert p["prompt_tokens"] is None and p["completion_tokens"] is None and p["total_tokens"] is None
    assert p["tool_calls"] == 2 and p["iterations"] == 3 and p["duration_ms"] == 1234
    assert p["provider"] == "ollama" and p["model"] == "granite4.1:8b" and p["cluster"] == "self"


def test_payload_carries_tokens_when_seen():
    t = usage.add_usage(usage.new_turn_usage(), {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
    p = usage.chat_complete_payload(
        session_id="s1", provider="openai", model="gpt-4o-mini", cluster="default",
        usage=t, tool_calls=0, iterations=1, duration_ms=800,
    )
    assert (p["prompt_tokens"], p["completion_tokens"], p["total_tokens"]) == (10, 5, 15)
