from types import SimpleNamespace

import pytest

from app.services.ai import history


def _msg(i, role, content):
    return SimpleNamespace(id=i, role=role, content=content)


def _history(n):
    out = []
    for i in range(1, n + 1):
        role = "user" if i % 2 else "assistant"
        out.append(_msg(i, role, f"{role} message {i} about ns-{(i + 1) // 2}"))
    return out


def _stored(entries, upto=None, messages=None):
    """A summary as session_contexts.state holds it."""
    return {"upto_id": upto if upto is not None else entries[-1]["upto_id"], "text": history._join(entries),
            "messages": messages if messages is not None else sum(e["messages"] for e in entries),
            "updated_at": "t", "entries": entries}


class FakeDB:
    def __init__(self):
        self.writes = []
        self.stored = None  # what the database row would hold

    async def update_context(self, session_id, state=None, cache=None):
        self.writes.append((session_id, state))
        self.stored = dict(state) if state is not None else self.stored


class FakeCompletions:
    """Answers call i with texts[i] (the last one repeats); raises on the calls in fail_at."""

    def __init__(self, texts, fail_at=()):
        self.texts = texts if isinstance(texts, list) else [texts]
        self.fail_at, self.calls = set(fail_at), []

    async def create(self, **kwargs):
        i = len(self.calls)
        self.calls.append(kwargs)
        if i in self.fail_at:
            raise RuntimeError("model down")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.texts[min(i, len(self.texts) - 1)]))],
            usage=SimpleNamespace(prompt_tokens=300, completion_tokens=40, total_tokens=340),
        )


def _service(texts, fail_at=()):
    comp = FakeCompletions(texts, fail_at)
    return SimpleNamespace(model="granite4.1:8b", client=SimpleNamespace(chat=SimpleNamespace(completions=comp))), comp


def sanitize(role, content):
    return content or ""


def test_split_history_keeps_the_window_verbatim(monkeypatch):
    monkeypatch.setattr(history.settings, "AI_CHAT_HISTORY_MESSAGES", 10, raising=False)
    older, recent = history.split_history(_history(14))
    assert [m.id for m in older] == [1, 2, 3, 4] and [m.id for m in recent] == list(range(5, 15))
    older, recent = history.split_history(_history(10))
    assert older == [] and len(recent) == 10
    monkeypatch.setattr(history.settings, "AI_CHAT_HISTORY_MESSAGES", 1, raising=False)
    assert history.window() == 2  # never below one full turn


def test_load_and_render():
    assert history.load(None) is None and history.load({"summary": {"text": ""}}) is None
    s = history.load({"summary": _stored([{"upto_id": 4, "messages": 4, "text": "User asked about ns-1."}])})
    assert s.upto_id == 4 and s.messages == 4 and s.text == "- User asked about ns-1." and len(s.entries) == 1
    block = history.render_block(s)
    assert block["role"] == "user" and "summary of 4 messages" in block["content"] and block["content"].endswith("- User asked about ns-1.")
    # A summary stored before notes existed becomes one note.
    legacy = history.load({"summary": {"upto_id": "6", "text": "Earlier: ns-1.", "messages": 6, "updated_at": "t"}})
    assert legacy.entries == [{"upto_id": 6, "messages": 6, "text": "Earlier: ns-1."}]


def test_to_plain_keeps_prose_and_section_titles_drops_fences_and_tags():
    answer = (
        "<details>\n<summary><strong>📊 결과</strong></summary>\n\n```\nNAME   READY   STATUS\nweb-1  1/1     Running\n```\n\n"
        "- **재시작한 파드**: 없음\n</details>\n\n<details>\n<summary><strong>🗂️ 기억해야 할 사항</strong></summary>\n\n`web-1`만 떠 있음\n</details>"
    )
    plain = history.to_plain(answer)
    assert "📊 결과" in plain and "재시작한 파드: 없음" in plain and "web-1만 떠 있음" in plain
    assert "web-1  1/1" not in plain and "```" not in plain and "<" not in plain and "**" not in plain
    assert "\n\n\n" not in plain


@pytest.mark.asyncio
async def test_no_older_messages_means_no_summary_and_no_call():
    service, comp = _service("x")
    out = await history.ensure_summary(service, FakeDB(), "s1", [], sanitize, {})
    assert out.summary is None and not out.created and comp.calls == []


@pytest.mark.asyncio
async def test_first_note_is_built_masked_capped_and_stored(monkeypatch):
    monkeypatch.setattr(history.settings, "AI_CHAT_SUMMARY_MAX_CHARS", 600, raising=False)
    assert history.note_cap() == 120  # a sixth of the whole, floor 120
    long_text = "User asked about ns-1 and ns-2; token was Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig " + "x" * 400
    service, comp = _service(long_text)
    db = FakeDB()
    state = {"other": 1}  # the turn's tool_context.state
    older = _history(4)
    out = await history.ensure_summary(service, db, "s1", older, sanitize, state)
    assert out.created and out.new_messages == 4 and out.summary.upto_id == 4 and out.summary.messages == 4
    note = out.summary.entries[0]["text"]
    assert "eyJhbGciOiJIUzI1NiJ9" not in note, "a token in the note is masked like tool output"
    assert len(note) <= 240 + 2 and out.summary.text == "- " + note  # 4 messages → two turns' worth of note
    assert out.usage_totals()["prompt_tokens"] == 300 and out.usage_totals()["model_calls"] == 1 and out.calls[0][1] > 0
    # The model saw the instruction, every older message labelled by role, and the directive last.
    sent = comp.calls[0]["messages"]
    assert sent[0]["role"] == "system" and "never answer" in sent[0]["content"]
    body = sent[1]["content"]
    assert "user: user message 1" in body and "assistant: assistant message 4" in body
    assert "at most 240 characters" in body and body.rstrip().endswith("describe them.")  # 4 messages → two turns' worth
    assert comp.calls[0]["model"] == "granite4.1:8b" and comp.calls[0]["temperature"] == 0.2
    # Kept under "summary" in the state dict that was passed in (other keys untouched) and persisted at once.
    assert state["summary"]["upto_id"] == 4 and state["summary"]["entries"][0]["text"] == note and state["other"] == 1
    assert db.writes[0][0] == "s1" and db.writes[0][1] is state


@pytest.mark.asyncio
async def test_notes_are_reused_until_new_messages_fall_out_then_appended_not_rewritten():
    first = {"upto_id": 4, "messages": 4, "text": "User asked about ns-1 and ns-2; 3 pods running."}
    state = {"other": 1, "summary": _stored([first])}
    service, comp = _service("User asked about ns-3; one pod restarted.")
    db = FakeDB()
    # Nothing new beyond id 4: reuse, no model call, no write.
    out = await history.ensure_summary(service, db, "s1", _history(4), sanitize, state)
    assert out.summary.entries == [first] and not out.created and comp.calls == [] and db.writes == []
    # Two more messages dropped out of the window: one call about only those two — the earlier note is not
    # re-generated by the model, it stays word for word in front of the new one.
    out = await history.ensure_summary(service, db, "s1", _history(6), sanitize, state)
    assert out.created and out.new_messages == 2 and out.summary.upto_id == 6 and out.summary.messages == 6
    body = comp.calls[0]["messages"][1]["content"]
    assert "message 5" in body and "message 6" in body and "message 3" not in body and "ns-1 and ns-2" not in body
    assert body.rstrip().endswith("describe them.")
    assert out.summary.entries == [first, {"upto_id": 6, "messages": 2, "text": "User asked about ns-3; one pod restarted."}]
    assert out.summary.text == "- User asked about ns-1 and ns-2; 3 pods running.\n- User asked about ns-3; one pod restarted."
    assert not out.compacted and state["other"] == 1 and state["summary"]["entries"] == out.summary.entries


@pytest.mark.asyncio
async def test_over_the_cap_the_oldest_half_is_merged_into_one_note(monkeypatch):
    monkeypatch.setattr(history.settings, "AI_CHAT_SUMMARY_MAX_CHARS", 200, raising=False)  # note cap 120
    old = [{"upto_id": 2, "messages": 2, "text": "A" * 80}, {"upto_id": 4, "messages": 2, "text": "B" * 80}]
    state = {"summary": _stored(old)}
    service, comp = _service(["C" * 80, "AB merged"])
    out = await history.ensure_summary(service, FakeDB(), "s1", _history(6), sanitize, state)
    assert out.created and out.compacted and len(comp.calls) == 2
    merge_body = comp.calls[1]["messages"][1]["content"]
    assert "A" * 80 in merge_body and "B" * 80 in merge_body and "C" * 80 not in merge_body and "Merge the notes" in merge_body
    assert out.summary.entries == [{"upto_id": 4, "messages": 4, "text": "AB merged"}, {"upto_id": 6, "messages": 2, "text": "C" * 80}]
    assert out.summary.messages == 6 and len(out.summary.text) <= 200 and out.usage_totals()["model_calls"] == 2
    # The merge call failing: the oldest notes are cut by hand instead, the new note is still kept.
    state = {"summary": _stored(old)}
    service, comp = _service(["C" * 80], fail_at={1})
    out = await history.ensure_summary(service, FakeDB(), "s1", _history(6), sanitize, state)
    assert out.created and out.compacted and out.error is None and len(out.summary.entries) == 2
    assert out.summary.entries[0]["text"].startswith("A" * 60 + " / " + "B" * 60) and out.summary.entries[1]["text"] == "C" * 80


@pytest.mark.asyncio
async def test_summarizer_sees_prose_not_raw_output_and_the_note_comes_back_plain():
    """Assistant answers are <details> sections around fenced raw output. The summarizer gets the section
    titles and prose without the raw output, and markup it echoes back (a small model imitating the
    answer format, 10-16 probe) is dropped from the stored note."""
    answer = "<details>\n<summary><strong>📊 결과</strong></summary>\n\n```\nweb-1  1/1  Running\n```\n\n- **재시작한 파드**: 없음\n</details>"
    service, comp = _service("<details><summary><strong>요약</strong></summary>\n\nUser asked about ns-1; no pod restarted.\n</details>")
    state = {}
    out = await history.ensure_summary(service, FakeDB(), "s1", [_msg(1, "user", "ns-1 파드 상태?"), _msg(2, "assistant", answer)], sanitize, state)
    body = comp.calls[0]["messages"][1]["content"]
    assert "📊 결과" in body and "재시작한 파드: 없음" in body
    assert "web-1  1/1" not in body and "<details>" not in body and "```" not in body
    assert out.summary.entries[0]["text"] == "요약 User asked about ns-1; no pod restarted."
    assert "<" not in out.summary.text and state["summary"]["text"] == out.summary.text


@pytest.mark.asyncio
async def test_summary_survives_the_turns_end_of_turn_context_write():
    """The turn writes its in-memory tool-context state back when it ends. The
    summary has to live in that dict: written to the database alone, that
    write erased it and every turn re-summarised the whole history (10-16 probe)."""
    service, comp = _service("Earlier: ns-1 and ns-2.")
    db = FakeDB()
    state = {}  # restored once per process from session_contexts, then kept in memory
    await history.ensure_summary(service, db, "s1", _history(4), sanitize, state)
    await db.update_context("s1", state=state, cache={})  # what the turn does at its end
    assert db.stored["summary"]["upto_id"] == 4
    # Next turn, same state object: nothing new fell out → the summary is reused, no second call.
    out = await history.ensure_summary(service, db, "s1", _history(4), sanitize, state)
    assert not out.created and out.summary.upto_id == 4 and len(comp.calls) == 1


@pytest.mark.asyncio
async def test_model_failure_keeps_the_previous_notes_and_reports_the_error():
    state = {"summary": _stored([{"upto_id": 2, "messages": 2, "text": "Earlier: ns-1."}])}
    service, comp = _service("", fail_at={0})
    db = FakeDB()
    out = await history.ensure_summary(service, db, "s1", _history(4), sanitize, state)
    assert out.summary.text == "- Earlier: ns-1." and not out.created and out.error == "model down" and out.new_messages == 2
    assert db.writes == [] and state["summary"]["text"] == "- Earlier: ns-1." and out.usage_totals()["model_calls"] == 1
    # An empty answer is not stored either.
    service, comp = _service("   ")
    state = {}
    out = await history.ensure_summary(service, FakeDB(), "s1", _history(4), sanitize, state)
    assert out.summary is None and out.error == "empty summary" and not out.created and "summary" not in state


@pytest.mark.asyncio
async def test_notes_are_written_by_the_economy_model_when_there_is_one():
    service, chat_comp = _service("unused")
    economy = FakeCompletions("Earlier: ns-1.")
    service.summary_client = SimpleNamespace(chat=SimpleNamespace(completions=economy))
    service.summary_model = "small-model"
    out = await history.ensure_summary(service, FakeDB(), "s1", _history(2), sanitize, {})
    assert out.created and chat_comp.calls == [] and economy.calls[0]["model"] == "small-model"


@pytest.mark.asyncio
async def test_per_message_input_is_capped():
    service, comp = _service("ok")
    older = [_msg(1, "user", "a" * 5000), _msg(2, "assistant", "b" * 10)]
    await history.ensure_summary(service, FakeDB(), "s1", older, sanitize, {})
    body = comp.calls[0]["messages"][1]["content"]
    assert "a" * history.PER_MESSAGE_CAP in body and "a" * (history.PER_MESSAGE_CAP + 1) not in body and "…" in body


def test_notes_keep_the_values_the_user_stated_and_the_block_names_the_answer_language():
    """A note that says "the user gave a nickname" loses it: the value itself goes in, also when notes are merged; the
    recap block (written in English) does not decide the language of the answer."""
    assert "word for word" in history.DIGEST_DIRECTIVE and "a name, a number" in history.DIGEST_DIRECTIVE
    assert "every value the user stated word for word" in history.COMPACT_DIRECTIVE
    s = history.load({"summary": _stored([{"upto_id": 2, "messages": 2, "text": "User's nickname is 파란고래, number 47."}])})
    assert "answer in the language of the latest user message" in history.render_block(s)["content"]
