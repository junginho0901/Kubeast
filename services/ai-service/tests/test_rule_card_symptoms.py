"""How a rule card is picked by what is said to be wrong (ai.ruleCards.symptoms): which places are read and in what order,
what counts as a phrase, what the chart's cards may hold, and that nothing of it is read with the switch off. Which words
the default cards hold is in test_rule_card_symptom_words.py."""

import itertools
import json
import logging
import time

import pytest

from app.services import rule_cards
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import runner
from tests.test_alert_investigation import cfg, completion, install_loop, row
from tests.test_rule_cards import DEFAULTS, KINDS, DescribingService, chat_turn, first_message, raw_card
from tests.test_switch_cases import CASES

OFF, ON = rule_cards.Settings(True, True, DEFAULTS), rule_cards.Settings(True, True, rule_cards.cards_of("", "", True), True)
TOOLS = [{"function": {"name": n}} for n in ("prometheus_query", "timeline", "k8s_get_pod_logs", "k8s_describe_resource")]


def card(kind, *phrases, alerts=(), terms=(), symptom_alerts=()):
    return rule_cards.card_of(raw_card(
        kind=kind, alerts=list(alerts), terms=list(terms),
        symptoms={"alerts": list(symptom_alerts), "phrases": list(phrases)}), True)


def phrase(subject, state=(), unless=()):
    return {"subject": list(subject), **({"state": list(state)} if state else {}), **({"unless": list(unless)} if unless else {})}


def holds(one, text):
    return bool(rule_cards.pick([card("one", one)], texts=[text]))


def kinds(cards):
    return [c.kind for c in cards]


# --- a phrase -----------------------------------------------------------------------------------------------------

LATENCY = phrase(["latency", "응답 시간"], ["high", "above", "늘었", "높아"])


@pytest.mark.parametrize("text", [
    "latency is high", "HIGH LATENCY", "high p99 request latency", "latency of the search service in prod is above 1s",
    "latency: above 500ms", "latency > 500ms", "Latency ≥ 2 s", "응답 시간이 늘었어요", "응답시간이 늘었어요", "검색응답시간이 많이 늘었네",
    "latency가 높아졌어요", "응답 시간이 3초 이상으로 늘었습니다", "ｌａｔｅｎｃｙ is high",
])
def test_what_it_is_about_and_how_it_is_stand_near_each_other(text):
    assert holds(LATENCY, text)


@pytest.mark.parametrize("text", [
    "latency", "high", "latency latency", "응답 시간", "늘었어요",
    "latencies are high",  # another word
    "the highest latency",  # another word
    "Show the latency panel. The replica count is high",  # two sentences
    "latency\nthe replica count is high",
    "latency of one two three four five six seven eight nine is high",  # too far after it
    "high one two three latency",  # too far before it
    "응답 시간을 보여 주는 대시보드 화면의 사용자 목록이 늘었어요",  # too far after it, in Korean
    "latency < 500ms",
], ids=lambda t: t.replace("\n", " / "))
def test_a_word_alone_another_word_another_sentence_or_too_far_is_no_phrase(text):
    assert not holds(LATENCY, text)


def test_a_korean_word_does_not_start_across_a_space_the_phrase_does_not_have():
    assert holds(phrase(["응답 지연"]), "응답지연이 있어요") and holds(phrase(["응답 지연"]), "응답 지연이 있어요")
    assert not holds(phrase(["서비스"], ["지연"]), "서비스는 그대로 하지 연결만 바꿔")


def test_a_run_of_words_is_a_phrase_without_a_state():
    spike = phrase(["error spike", "에러 급증"])
    assert holds(spike, "An error spike at 10:00") and holds(spike, "에러급증이 있었어요")
    assert not holds(spike, "error rate spike") and not holds(spike, "에러가 급증")


@pytest.mark.parametrize("text, found", [
    ("the service is slow", True),
    ("the service rollout is slow", False),  # inside it
    ("the rollout service is slow", False),  # right before it
    ("after the rollout the service is slow", True),  # before it, not next to it
    ("the service is slow after the rollout", True),
    ("the service rollout is slow. The service is slow", True),  # one of two
    ("서비스가 느려요", True),
    ("서비스 배포가 느려요", False),
    ("새로 배포한 서비스가 느려요", True),
])
def test_an_unless_word_in_the_phrase_or_right_before_it_takes_it_away(text, found):
    assert holds(phrase(["service", "서비스"], ["slow", "느려"], ["rollout", "배포"]), text) is found


@pytest.mark.parametrize("name, words", [
    ("HTTP5xxErrorRateHigh", " http 5xx error rate high "),
    ("HighP99Latency", " high p99 latency "),
    ("KubeAPIErrorBudgetBurn", " kube api error budget burn "),
    ("high_error-rate", " high error rate "),
    ("CPU사용률높음", " cpu 사용률높음 "),
    ("", "  "),
])
def test_an_alert_name_written_as_one_word_is_read_as_its_words(name, words):
    assert rule_cards.name_said(name) == words


def test_a_long_text_is_searched_at_its_start_and_its_end():
    filler = "x " * rule_cards.MAX_TEXT_CHARS
    assert holds(LATENCY, "latency is high " + filler) and holds(LATENCY, filler + "latency is high")
    assert not holds(LATENCY, filler + "latency is high " + filler)


@pytest.mark.parametrize("text, expected", [
    ("slow... why", " slow \n why "), ("slow?! why", " slow \n why "), ("slow… why", " slow \n why "), ("slow!!!", " slow \n "),
    ("p99.9 is 1.5s.", " p99 9 is 1 5s \n "), ("v1.2.3", " v1 2 3 "), ("...x", " x "), ("a;b; c", " a b \n c "), ("", "  "),
    ("느려요. 왜?", " 느려요 \n 왜 \n "), ("p95 > 5", " p95 above 5 "),
])
def test_a_run_of_marks_before_a_space_ends_one_sentence(text, expected):
    assert rule_cards.said(text) == expected


def test_two_places_are_one_phrase_only_so_many_characters_apart():
    assert holds(LATENCY, "latency " + "1 " * 90 + "is high")
    assert not holds(LATENCY, "latency " + "1 " * 110 + "is high")


# --- how long it takes --------------------------------------------------------------------------------------------

SUBJECTS, STATES = "api p99 5xx db cpu slo " * 50, "high slow fail burn is full hang " * 50
LONG = {
    "dots and a letter": "." * 7999 + "x",
    "ellipses and a letter": "…" * 7999 + "x",
    "marks and a letter": "?!" * 3999 + "x",
    "runs of dots": ("." * 1999 + "x") * 4,
    "a megabyte of dots": "." * 1_000_000 + "x",
    "a character of eighteen": "\ufdfa" * 7999,
    "a megabyte of characters of eighteen": "\ufdfa" * 1_000_000,
    "letters and no space": "a" * 7999,
    "capitals and no space": "A" * 7999,
    "Hangul and no space": "가" * 7999,
    "Latin and Hangul by turns": "a가" * 4000,
    "marks of comparison": " >1" * 2666,
    "a mark of comparison and spaces": ">" + " " * 7998,
    "combining marks": "a" + "\u0316\u0300" * 3999,
    "fifty places of each, far apart": SUBJECTS + "aa " * 1300 + STATES,
    "fifty places of each, the states first": STATES + "aa " * 1300 + SUBJECTS,
    "fifty places of each, near": "api 배포 slow 배포 p99 pull high " * 250,
    "Hangul words one in another": "배포가후느려" * 1300,
}


def seconds(**kw):
    """The processor time of one pick over the default cards, the least of three."""
    took = []
    for _ in range(3):
        start = time.process_time()
        rule_cards.pick(ON.cards, **kw)
        took.append(time.process_time() - start)
    return min(took)


@pytest.mark.parametrize("text", LONG.values(), ids=LONG)
def test_a_long_text_takes_little_time_wherever_it_is_read(text):
    # Some hundredths of a second at most; the dots took 0.8 s, the ellipses 7 s and the fifty places 3 s before the bounds.
    assert seconds(texts=[text]) < 0.4
    assert seconds(alertname=text) < 0.4
    assert seconds(alertname="Custom", labels={key: text[:8000] for key in rule_cards.TELLING_LABELS}) < 0.4


def test_how_many_labels_and_texts_there_are_adds_nothing_to_what_is_searched(monkeypatch):
    searched, phrase_in = set(), rule_cards.phrase_in
    monkeypatch.setattr(rule_cards, "phrase_in", lambda phrase, text: searched.add(text) or phrase_in(phrase, text))
    spellings = ["".join(p) for p in itertools.product(*[(c, c.upper()) for c in "reason"])]
    labels = {key: f"label {n} " * 900 for n, key in enumerate(spellings)}
    rule_cards.pick(ON.cards, alertname="Custom", labels=labels, texts=[f"text {n} " * 900 for n in range(64)])
    # the alert's name, its labels and the other texts, each no longer than one
    assert len(spellings) == 64 and len(searched) == 3
    assert max(len(text) for text in searched) <= rule_cards.MAX_TEXT_CHARS + 10
    # each label and each text is a sentence of its own
    cards = [card("one", LATENCY)]
    assert rule_cards.pick(cards, labels={"reason": "latency", "condition": "high"}) == []
    assert rule_cards.pick(cards, texts=["latency", "high"]) == []
    assert kinds(rule_cards.pick(cards, labels={"reason": "x", "condition": "high latency"})) == ["one"]
    assert kinds(rule_cards.pick(cards, texts=["x", "high latency"])) == ["one"]


@pytest.mark.parametrize("text", LONG.values(), ids=LONG)
def test_what_is_searched_of_a_text_is_bounded(text):
    assert len(rule_cards.said(text)) <= 2 * (rule_cards.MAX_TEXT_CHARS + 2)


# --- where it is read ---------------------------------------------------------------------------------------------


def test_a_listed_alert_name_then_the_alerts_words_then_what_it_says_then_the_text():
    high = phrase(["latency"], ["high"])
    cards = [
        card("text-symptom", phrase(["cpu"], ["high"])),
        card("text-word", terms=["OOMKilled"]),
        card("alert-symptom", high),
        card("alert-word", terms=["DiskPressure"]),
        card("listed", symptom_alerts=["HighLatency"]),
    ]
    labels = {"alertname": "HighLatency", "condition": "DiskPressure"}
    got = kinds(rule_cards.pick(cards, alertname="HighLatency", labels=labels, texts=["OOMKilled and cpu is high"], limit=9))
    assert got == ["listed", "alert-word", "alert-symptom", "text-word", "text-symptom"]
    # at most two go
    assert kinds(rule_cards.pick(cards, alertname="HighLatency", labels=labels, texts=["OOMKilled and cpu is high"])) == got[:2]
    # in a tie the card with more matches, then the cards' order
    two = [card("one", high), card("other", high), card("both", high, phrase(["requests"], ["failing"]))]
    assert kinds(rule_cards.pick(two, texts=["latency is high, requests are failing"], limit=9)) == ["both", "one", "other"]


def test_of_the_labels_only_those_that_describe_are_read_for_a_phrase():
    slow = card("slow", phrase(["service"], ["slow"]))
    for key in ("service", "job", "pod", "namespace", "container", "instance", "deployment", "app"):
        assert rule_cards.pick([slow], alertname="Custom", labels={key: "slow-service"}) == [], key
    for key in ("reason", "condition", "category", "Reason", "summary", "description"):
        assert kinds(rule_cards.pick([slow], alertname="Custom", labels={key: "slow service"})) == ["slow"], key


def test_an_alerts_summary_and_description_are_read_with_the_switch_on_only():
    said = {"summary": "Search", "description": "Latency is high", "runbook_url": "https://example.com/oom/OOMKilled"}
    ask = dict(alertname="Custom", labels={"alertname": "Custom"}, tools=TOOLS)
    text, got = rule_cards.investigation_cards(ON, annotations=said, **ask)
    assert got == ["latency"] and text.startswith("Rule cards, picked by the server from the alert's name, labels and description")
    assert "Latency is high" not in text and "Search" not in text  # the alert only picks
    assert rule_cards.investigation_cards(ON, **ask) == ("", [])
    assert rule_cards.investigation_cards(ON, annotations={"summary": None, "description": ""}, **ask) == ("", [])
    # a reason in it picks too
    assert rule_cards.investigation_cards(ON, annotations={"message": "web was OOMKilled"}, **ask)[1] == ["oom"]
    assert rule_cards.investigation_cards(OFF, annotations=said, **ask) == ("", [])
    assert rule_cards.investigation_cards(OFF, annotations={"message": "web was OOMKilled"}, **ask) == ("", [])


def test_the_question_is_read_for_a_phrase_with_the_switch_on_only():
    for question in ("why is the search service slow?", "search 서비스가 왜 느려?"):
        note, got = rule_cards.chat_cards(question, TOOLS, ON)
        assert got == ["latency"] and note.startswith("Rule cards, picked by the server from the failure or symptom the question names")
        assert rule_cards.chat_cards(question, TOOLS, OFF) == (None, [])
    assert rule_cards.chat_cards("파드 몇 개야?", TOOLS, ON) == (None, [])
    assert rule_cards.chat_cards("why is the search service slow?", TOOLS, rule_cards.Settings(investigations=True, cards=ON.cards, symptoms=True)) == (None, None)


@pytest.mark.asyncio
async def test_a_chat_turn_gets_the_card_of_the_symptom_it_asks_about_with_the_switch_on_only(monkeypatch):
    monkeypatch.setenv("AI_RULE_CARDS_CHAT", "true")
    monkeypatch.delenv("AI_RULE_CARDS_SYMPTOMS", raising=False)
    off = await chat_turn(monkeypatch, "why is the search service slow?")
    assert [m["role"] for m in off] == ["system", "user", "system"]
    monkeypatch.setenv("AI_RULE_CARDS_SYMPTOMS", "true")
    on = await chat_turn(monkeypatch, "why is the search service slow?")
    assert on[:3] == off and 'Card "latency"' in on[3]["content"] and len(on) == 4
    # a question that names a reason gets what it got, but for where it was picked from
    with_reason = await chat_turn(monkeypatch, "why is web OOMKilled?")
    monkeypatch.delenv("AI_RULE_CARDS_SYMPTOMS")
    before = await chat_turn(monkeypatch, "why is web OOMKilled?")
    assert [m["content"].replace("the failure or symptom the question names", "the failure the question names") for m in with_reason] == [
        m["content"] for m in before]


# --- the switch ---------------------------------------------------------------------------------------------------


def settings_of(monkeypatch, **env):
    for name in ("AI_RULE_CARDS_CHAT", "AI_RULE_CARDS_INVESTIGATIONS", "AI_RULE_CARDS_SYMPTOMS", "AI_RULE_CARDS", "AI_RULE_CARDS_REMOVE"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return rule_cards.load()


def test_the_switch_alone_reads_no_cards(monkeypatch, tmp_path):
    monkeypatch.setattr(rule_cards, "DEFAULTS_FILE", tmp_path / "missing.json")
    assert settings_of(monkeypatch, AI_RULE_CARDS_SYMPTOMS="true") == rule_cards.Settings()


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_the_switch_reads_the_one_switch_rule(monkeypatch, case):
    got = settings_of(monkeypatch, AI_RULE_CARDS_CHAT="true", AI_RULE_CARDS_SYMPTOMS=case["value"])
    assert got.symptoms is case["on"] and got.cards == (ON if case["on"] else OFF).cards


def test_with_the_switch_off_a_cards_symptoms_are_not_read(monkeypatch):
    plain = raw_card()
    for symptoms in ({"alerts": ["Slow"], "phrases": [phrase(["latency"], ["high"])]}, "not an object", {"phrases": 3}):
        assert rule_cards.card_of({**plain, "symptoms": symptoms}) == rule_cards.card_of(plain)
    got = settings_of(monkeypatch, AI_RULE_CARDS_CHAT="true", AI_RULE_CARDS=json.dumps([{**plain, "symptoms": "not an object"}]))
    assert kinds(got.cards) == KINDS + ["payments-db"] and not any(c.phrases for c in got.cards) and not got.symptoms


def test_the_chart_can_replace_and_remove_the_cards_the_switch_adds(monkeypatch, caplog):
    ours = raw_card(kind="latency", title="Our latency", alerts=[], terms=[], symptoms={"phrases": [phrase(["@service"], ["@slow"])]})
    with caplog.at_level(logging.WARNING, logger=rule_cards.__name__):
        got = settings_of(monkeypatch, AI_RULE_CARDS_CHAT="true", AI_RULE_CARDS_SYMPTOMS="true", AI_RULE_CARDS=json.dumps([ours]),
                          AI_RULE_CARDS_REMOVE="error_rate")
    assert kinds(got.cards) == KINDS + ["latency", "resource_pressure"] and not caplog.records
    assert [c.title for c in rule_cards.pick(got.cards, texts=["the service is slow"])] == ["Our latency"]


# --- a card of the chart's ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("symptoms, why", [
    (["latency"], "is not an object"),
    ({"alerts": "HighLatency"}, "is not a list of strings"),
    ({"phrases": {"subject": ["a b"]}}, "phrases is not a list"),
    ({"phrases": ["latency is high"]}, "phrase 1 is not an object"),
    ({"phrases": [{"state": ["high"]}]}, "phrase 1 has no subject"),
    ({"phrases": [phrase(["slow"])]}, "is one word"),
    ({"phrases": [phrase(["느려"])]}, "is one word"),
    ({"phrases": [phrase(["@slow"])]}, "is one word"),
    ({"phrases": [phrase(["--"], ["high"])]}, "holds no letter or digit"),
    ({"phrases": [phrase(["latency"], ["@no such list"])]}, "no word list is named '@no such list'"),
    ({"phrases": [phrase(["latency"], [3])]}, "is not a list of strings"),
    ({"phrases": [phrase(["응답 " * 18], ["높아"])]}, "subject: an entry is more than 5 words"),
    ({"phrases": [phrase(["latency"], ["high"], ["one two three four five six"])]}, "unless: an entry is more than 5 words"),
    ({"phrases": [phrase(["latency"], ["high"])] * (rule_cards.MAX_PHRASES + 1)}, "more than 8 phrases"),
    ({"phrases": [phrase(["latency"], [f"w{n}" for n in range(rule_cards.MAX_PHRASE_WORDS + 1)])]}, "holds more than 80 entries"),
    ({"alerts": [f"Alert{n}" for n in range(rule_cards.MAX_WORDS)]}, "more than 20 alert names and terms"),
], ids=lambda v: v if isinstance(v, str) else "")
def test_a_chart_card_whose_symptoms_are_wrong_is_left_out_with_why(symptoms, why, caplog):
    with caplog.at_level(logging.WARNING, logger=rule_cards.__name__):
        cards = rule_cards.cards_of(json.dumps([raw_card(symptoms=symptoms), raw_card(kind="kept")]), "", True)
    assert kinds(cards) == kinds(ON.cards) + ["kept"]
    assert [why in r.getMessage() and "left out" in r.getMessage() for r in caplog.records if r.name == rule_cards.__name__] == [True]


def test_an_entry_of_the_most_words_is_looked_for_as_sixteen_strings_at_most():
    assert rule_cards.MAX_ENTRY_WORDS == 5
    entry = "응답 시간 너무 많이 느려"
    one = card("one", phrase([entry])).phrases[0]
    assert len(one.subject) == 16 and entry in one.subject and entry.replace(" ", "") in one.subject
    assert holds(phrase([entry]), "응답시간 너무많이 느려요")


def test_every_shared_word_list_is_used_and_read():
    used = {item[1:] for raw in json.loads(rule_cards.DEFAULTS_FILE.read_text(encoding="utf-8"))
            for p in (raw.get("symptoms") or {}).get("phrases") or []
            for key in ("subject", "state", "unless") for item in p.get(key) or [] if item.startswith("@")}
    assert used == set(rule_cards.WORD_LISTS)


@pytest.mark.asyncio
@pytest.mark.parametrize("symptoms", [False, True])
async def test_an_investigation_reads_the_alerts_description_with_the_switch_on_only(monkeypatch, symptoms):
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")
    monkeypatch.setenv("AI_RULE_CARDS_SYMPTOMS", str(symptoms))
    service = DescribingService([completion(content="## Summary\nok")])
    install_loop(monkeypatch, service, [])
    r = row(alertname="Custom", labels={"alertname": "Custom"}, annotations={"description": "CPU usage is high"})
    progress = {}
    await runner.investigate(cfg(max_steps=5), r, progress)
    plain = inv_prompt.alert_message(cluster="self", alert=runner.alert_view(r))
    assert progress["rule_cards"] == (["resource_pressure"] if symptoms else [])
    assert (first_message(service) == plain) is not symptoms
    assert ('Card "resource_pressure"' in first_message(service)) is symptoms
