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
    assert (p["cached_tokens"], p["cache_creation_tokens"], p["model_calls"]) == (0, 0, 1)


def test_cached_tokens_and_prompt_size_are_summed_per_call():
    t = usage.new_turn_usage()
    # OpenAI-style object: prompt_tokens_details.cached_tokens
    usage.add_usage(t, SimpleNamespace(prompt_tokens=1000, completion_tokens=20, total_tokens=1020,
                                       prompt_tokens_details=SimpleNamespace(cached_tokens=800)), prompt_chars=4000)
    # Anthropic adapter: the same field plus cache_creation_input_tokens
    usage.add_usage(t, {"prompt_tokens": 1200, "completion_tokens": 30, "total_tokens": 1230,
                        "prompt_tokens_details": {"cached_tokens": 0}, "cache_creation_input_tokens": 1100}, prompt_chars=4100)
    # A provider without usage still counts the call and what we sent
    usage.add_usage(t, None, prompt_chars=4200)
    assert t["model_calls"] == 3 and t["prompt_chars"] == 12300
    assert t["cached_tokens"] == 800 and t["cache_creation_tokens"] == 1100
    assert t["prompt_tokens"] == 2200 and t["seen"] is True
    p = usage.chat_complete_payload(session_id="s1", provider="anthropic", model="m", cluster="c", usage=t,
                                    tool_calls=1, iterations=2, duration_ms=10)
    assert p["cached_tokens"] == 800 and p["cache_creation_tokens"] == 1100 and p["prompt_chars"] == 12300 and p["model_calls"] == 3


def test_payload_without_usage_keeps_prompt_chars_and_nulls_cache_fields():
    t = usage.add_usage(usage.new_turn_usage(), None, prompt_chars=900)
    p = usage.chat_complete_payload(session_id="s1", provider="ollama", model="m", cluster="c", usage=t,
                                    tool_calls=0, iterations=1, duration_ms=10)
    assert p["prompt_tokens"] is None and p["cached_tokens"] is None and p["cache_creation_tokens"] is None
    assert p["prompt_chars"] == 900 and p["model_calls"] == 1


def test_prompt_chars_counts_messages_and_tools_and_event_shape():
    messages = [{"role": "system", "content": "You are Kubeast."}, {"role": "user", "content": "파드 상태"}]
    tools = [{"type": "function", "function": {"name": "k8s_get_resources", "parameters": {"type": "object"}}}]
    only_messages = usage.prompt_chars(messages)
    assert only_messages > len("You are Kubeast.") + len("파드 상태")
    assert usage.prompt_chars(messages, tools) > only_messages
    assert usage.prompt_chars([], None) == 0
    ev = usage.usage_event(SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=0,
                                           prompt_tokens_details=SimpleNamespace(cached_tokens=4)), prompt_chars=77)
    assert ev == {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12, "cached_tokens": 4, "prompt_chars": 77}


def test_message_usage_keeps_the_turn_sums_or_nothing():
    """messages.usage: the same sums as the turn's ai.chat.complete row, None when the provider sent no usage."""
    totals = usage.new_turn_usage()
    assert usage.message_usage(totals, model="m") is None
    usage.add_usage(totals, SimpleNamespace(prompt_tokens=15000, completion_tokens=40, total_tokens=15040,
                                            prompt_tokens_details=SimpleNamespace(cached_tokens=14900)), prompt_chars=53000)
    usage.add_usage(totals, SimpleNamespace(prompt_tokens=300, completion_tokens=60, total_tokens=360), prompt_chars=900)
    kept = usage.message_usage(totals, model="granite4.1:8b")
    assert kept == {"prompt_tokens": 15300, "completion_tokens": 100, "cached_tokens": 14900, "model_calls": 2, "model": "granite4.1:8b"}
    payload = usage.chat_complete_payload(session_id="s", provider="ollama", model="granite4.1:8b", cluster="self", usage=totals,
                                          tool_calls=0, iterations=1, duration_ms=1)
    assert (payload["prompt_tokens"], payload["completion_tokens"], payload["cached_tokens"], payload["model_calls"]) == \
        (kept["prompt_tokens"], kept["completion_tokens"], kept["cached_tokens"], kept["model_calls"])
