"""Checks scripts/ai_eval_rca.py with made-up answers and truths (no cluster, no API).

  python3 -m pytest -q scripts/test_ai_eval_rca.py
  python3 scripts/test_ai_eval_rca.py        # the same checks without pytest
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ai_eval_rca as rca  # noqa: E402

CALLS = [{"tool": "timeline", "failed": False}, {"tool": "k8s_get_resources", "failed": False},
         {"tool": "loki_query", "failed": True}]

TRUTH = {
    "control": False,
    "fault_start": "2026-11-13T10:00:00Z",
    "time_tolerance_seconds": 120,
    "causes": [{"resource": "ConfigMap/shop-x/settings-b", "kind": "config_change",
                "accept_resources": ["settings-b", "(deployment|replicaset)/(shop-x/)?pricing"], "accept_kinds": ["rollout"]}],
    "path": [
        {"resource": "ConfigMap/shop-x/settings-b", "role": "cause", "required": True, "accept": ["settings-b"]},
        {"resource": "ReplicaSet/shop-x/pricing-<new>", "role": "via", "required": True, "accept": ["replicaset/(shop-x/)?pricing"]},
        {"resource": "Deployment/shop-x/checkout", "role": "symptom", "required": True, "accept": ["checkout"]},
    ],
    "also_ok": ["Deployment/shop-x/pricing"],
    "decoys": [{"resource": "Deployment/shop-x/checkout", "why": "the caller"},
               {"resource": "Node/*", "why": "idle"}],
}

CONTROL = {"control": True, "fault_start": None, "causes": [], "path": [], "also_ok": [],
           "decoys": [{"resource": "Deployment/shop-y/thumbnailer", "why": "restarted once"}]}


def answer(block) -> str:
    body = block if isinstance(block, str) else json.dumps(block)
    return "Some words about what I looked at.\n\n```rca\n" + body + "\n```\n"


def cause(resource, kind="config_change", started_at="2026-11-13T10:01:00Z", evidence=(1,)):
    return {"resource": resource, "kind": kind, "started_at": started_at, "evidence": list(evidence)}


GOOD_PATH = ["ConfigMap/shop-x/settings-b", "ReplicaSet/shop-x/pricing-7f9c", "Deployment/shop-x/checkout"]


def test_right_answer_passes_with_time_path_and_evidence():
    s = rca.score_rca(answer({"no_fault": False, "causes": [cause("ConfigMap/shop-x/settings-b")], "path": GOOD_PATH}), TRUTH, CALLS)
    assert s["block"] == "ok" and s["pass"] and s["score"] == 1.0
    assert s["time_ok"] is True and s["path_ok"] is True
    assert s["ungrounded"] == 0 and s["bad_evidence"] == []
    assert [h["at"] for h in s["path"]] == [0, 1, 2]


def test_accepted_other_name_and_kind():
    s = rca.score_rca(answer({"causes": [cause("deploy/shop-x/pricing", kind="rollout")], "path": GOOD_PATH}), TRUTH, CALLS)
    assert s["pass"] and s["causes"][0]["answer_resource"] == "deploy/shop-x/pricing"


def test_right_resource_wrong_kind_fails():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", kind="dns")]}), TRUTH, CALLS)
    assert not s["pass"] and s["score"] == 0.0
    assert s["causes"][0]["resource_found"] and not s["causes"][0]["found"]


def test_missing_cause_fails():
    s = rca.score_rca(answer({"causes": [cause("Deployment/shop-x/inventory", kind="crash")]}), TRUTH, CALLS)
    assert not s["pass"] and s["extras"] == ["Deployment/shop-x/inventory"]


def test_decoy_named_as_cause_fails_even_with_the_right_one():
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("Deployment/shop-x/checkout", kind="crash")]}
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert not s["pass"] and s["decoys_taken"] == ["Deployment/shop-x/checkout"]


def test_wildcard_decoy_matches_any_node():
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("Node/kind-worker", kind="node")]}
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert s["decoys_taken"] == ["Node/kind-worker"] and not s["pass"]


def test_extra_cause_costs_points_also_ok_does_not():
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("Service/shop-x/pricing", kind="dns"),
                        cause("Deployment/shop-x/pricing", kind="rollout")]}
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert s["pass"] and s["extras"] == ["Service/shop-x/pricing"]
    assert s["score"] == 0.75


def test_one_resource_under_many_kinds_costs_the_wrong_ones():
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("ConfigMap/shop-x/settings-b", kind="dns"),
                        cause("ConfigMap/shop-x/settings-b", kind="rollout")]}
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert s["pass"] and s["extras"] == ["ConfigMap/shop-x/settings-b"]
    assert s["score"] == 0.75  # rollout is an accepted kind too: not an extra
    block["causes"].append(cause("cm/shop-x/settings-b", kind="crash"))
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert not s["pass"] and s["score"] == 0.0 and s["extras"] == ["ConfigMap/shop-x/settings-b", "cm/shop-x/settings-b"]
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", kind="dns"), cause("ConfigMap/shop-x/settings-b", kind="node")]}), TRUTH, CALLS)
    assert not s["pass"] and s["score"] == 0.0 and s["extras"] == ["ConfigMap/shop-x/settings-b"]
    assert s["causes"][0]["answer_kind"] == "dns"


def test_more_than_one_extra_cause_fails_a_right_answer():
    right = cause("ConfigMap/shop-x/settings-b")
    for n, passes, score in ((0, True, 1.0), (1, True, 0.75), (2, False, 0.0), (4, False, 0.0), (6, False, 0.0)):
        guesses = [cause(f"Deployment/shop-x/guess{i}", kind="crash") for i in range(n)]
        s = rca.score_rca(answer({"causes": [right, *guesses]}), TRUTH, CALLS)
        assert (s["pass"], s["pass_grounded"], s["score"], len(s["extras"])) == (passes, passes, score, n), (n, s)
    # every kind on the right resource and three more objects: one list of guesses
    shotgun = [cause("ConfigMap/shop-x/settings-b", kind=k) for k in rca.KINDS if k != "none"]
    shotgun += [cause(f"ConfigMap/shop-x/other-{i}") for i in range(3)]
    s = rca.score_rca(answer({"causes": shotgun}), TRUTH, CALLS)
    assert not s["pass"] and s["causes"][0]["found"] and len(s["extras"]) == 14


def test_namespace_and_name_without_a_kind():
    assert rca.split_resource("shop-09/catalog") == (None, "shop-09", "catalog")
    assert rca.split_resource("svc/catalog") == ("service", None, "catalog")
    assert rca.split_resource("Deployment/catalog") == ("deployment", None, "catalog")
    assert rca.split_resource("deployments.apps/catalog") == ("deployment", None, "catalog")
    assert rca.split_resource("NetworkChaos/delay") == ("networkchaos", None, "delay")
    truth = {"control": False, "causes": [{"resource": "Deployment/shop-09/catalog", "kind": "resource_limit"}], "decoys": []}
    s = rca.score_rca(answer({"causes": [cause("shop-09/catalog", kind="resource_limit")]}), truth, CALLS)
    assert s["pass"] and s["score"] == 1.0 and s["extras"] == []
    s = rca.score_rca(answer({"causes": [cause("shop-10/catalog", kind="resource_limit")]}), truth, CALLS)
    assert not s["pass"] and s["extras"] == ["shop-10/catalog"]


def test_a_bare_name_is_not_a_wildcard_decoy():
    assert not rca.resource_matches("Node/*", "questions")
    assert not rca.resource_matches("Node/*", "shop-x/questions")
    assert rca.resource_matches("Node/*", "nodes/kind-worker")
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("questions", kind="storage")]}
    s = rca.score_rca(answer(block), TRUTH, CALLS)
    assert s["pass"] and s["decoys_taken"] == [] and s["extras"] == ["questions"]
    assert s["score"] == 0.75


def test_kind_spellings():
    assert rca.normal_kind("ConfigChange") == "config_change"
    assert rca.normal_kind("config-change") == "config_change"
    assert rca.normal_kind("Config change") == "config_change"
    assert rca.normal_kind("dependencyDown") == "dependency_down"
    assert rca.normal_kind("OOM") == "oom"
    for kind in ("ConfigChange", "config-change", "Config change", "CONFIG_CHANGE"):
        s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", kind=kind)]}), TRUTH, CALLS)
        assert s["pass"] and s["score"] == 1.0, kind
    s = rca.score_rca(answer({"no_fault": True, "causes": [cause("Deployment/shop-y/thumbnailer", kind="None")]}), CONTROL, CALLS)
    assert s["pass"]


def test_fence_tags():
    body = json.dumps({"no_fault": False, "causes": [cause("ConfigMap/shop-x/settings-b")]})
    for tag in ("rca", "RCA", "json rca", "rca json", " rca", "Rca"):
        s = rca.score_rca(f"Words.\n\n```{tag}\n{body}\n```\n", TRUTH, CALLS)
        assert s["block"] == "ok" and s["pass"], tag
    for tag in ("json", ""):
        s = rca.score_rca(f"Words.\n\n```{tag}\n{body}\n```\n", TRUTH, CALLS)
        assert s["block"] == "loose" and s["pass"], tag
    assert rca.score_rca("```yaml\n" + body + "\n```\n", TRUTH, CALLS)["block"] == "missing"
    assert rca.score_rca('```json\n{"items": []}\n```\n', TRUTH, CALLS)["block"] == "missing"
    text = "```json\n" + body + "\n```\n" + answer({"causes": [cause("Deployment/shop-x/checkout", kind="crash")]})
    assert rca.score_rca(text, TRUTH, CALLS)["block"] == "ok"  # a tagged block is taken before a loose one
    assert rca.strip_blocks("before\n```RCA\n{}\n```\nafter ```bash\nls\n```") == "before\n\nafter ```bash\nls\n```"
    loose = "```json\n" + body + "\n```\n```\n{\"no_fault\": true}\n```\n"
    kept = '```json\n{"items": []}\n```\n```json\nnot json\n```\n'
    assert rca.strip_blocks("before\n" + loose + kept + "after") == "before\n\n\n" + kept + "after"  # what extract_block reads


def test_pass_grounded():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", evidence=[1])]}), TRUTH, CALLS)
    assert s["pass"] and s["pass_grounded"]
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", evidence=[3])]}), TRUTH, CALLS)
    assert s["pass"] and not s["pass_grounded"]
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", evidence=[])]}), TRUTH, CALLS)
    assert s["pass"] and not s["pass_grounded"] and s["ungrounded"] == 1


def test_also_ok_is_not_an_extra():
    truth = dict(TRUTH, causes=[dict(TRUTH["causes"][0], accept_resources=["settings-b"])])
    block = {"causes": [cause("ConfigMap/shop-x/settings-b"), cause("Deployment/shop-x/pricing", kind="rollout")]}
    s = rca.score_rca(answer(block), truth, CALLS)
    assert s["pass"] and s["score"] == 1.0 and s["also_ok_named"] == ["Deployment/shop-x/pricing"]


def test_time_outside_tolerance_is_reported_not_failed():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", started_at="2026-11-13T10:05:00+00:00")]}), TRUTH, CALLS)
    assert s["pass"] and s["time_ok"] is False


def test_time_null_is_not_ok():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", started_at=None)]}), TRUTH, CALLS)
    assert s["time_ok"] is False


def test_path_out_of_order_or_short_is_not_ok():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b")], "path": list(reversed(GOOD_PATH))}), TRUTH, CALLS)
    assert s["pass"] and s["path_ok"] is False
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b")], "path": GOOD_PATH[:1]}), TRUTH, CALLS)
    assert s["path_ok"] is False


def test_optional_hop_does_not_take_a_required_hops_place():
    truth = {"causes": [{"resource": "ConfigMap/s/front-config", "kind": "config_change", "accept_resources": ["front-config"]}],
             "path": [{"resource": "ConfigMap/s/front-config", "role": "cause", "required": True, "accept": ["front-config"]},
                      {"resource": "Deployment/s/front", "role": "via", "required": False, "accept": ["front"]},
                      {"resource": "Deployment/s/front", "role": "symptom", "required": True, "accept": ["front"]}]}
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/s/front-config")], "path": ["ConfigMap/s/front-config", "Deployment/s/front"]}), truth, CALLS)
    assert s["path_ok"] is True


def test_evidence_pointing_at_a_failed_or_missing_call_is_ungrounded():
    s = rca.score_rca(answer({"causes": [cause("ConfigMap/shop-x/settings-b", evidence=[3, 9])]}), TRUTH, CALLS)
    assert s["pass"] and s["ungrounded"] == 1 and s["bad_evidence"] == [3, 9]
    assert s["causes"][0]["grounded"] is False


def test_no_block_and_bad_json():
    assert rca.score_rca("The cause is the ConfigMap.", TRUTH, CALLS)["block"] == "missing"
    assert rca.score_rca(answer("{not json"), TRUTH, CALLS)["block"] == "invalid"
    assert rca.score_rca(answer("[1, 2]"), TRUTH, CALLS)["block"] == "invalid"


def test_last_block_counts():
    text = answer({"causes": [cause("Deployment/shop-x/checkout", kind="crash")]}) + answer({"causes": [cause("ConfigMap/shop-x/settings-b")]})
    assert rca.score_rca(text, TRUTH, CALLS)["pass"]


def test_no_fault_on_a_real_fault_fails():
    assert not rca.score_rca(answer({"no_fault": True, "causes": []}), TRUTH, CALLS)["pass"]
    s = rca.score_rca(answer({"no_fault": True, "causes": [cause("ConfigMap/shop-x/settings-b")], "path": GOOD_PATH}), TRUTH, CALLS)
    assert not s["pass"] and s["score"] == 0.0 and s["causes"][0]["found"]


def test_control_right_only_with_no_fault():
    assert rca.score_rca(answer({"no_fault": True, "causes": []}), CONTROL, CALLS)["pass"]
    assert rca.score_rca(answer({"no_fault": True, "causes": [cause("Deployment/shop-y/thumbnailer", kind="none")]}), CONTROL, CALLS)["pass"]
    s = rca.score_rca(answer({"no_fault": False, "causes": [cause("Deployment/shop-y/thumbnailer", kind="crash")]}), CONTROL, CALLS)
    assert not s["pass"] and s["decoys_taken"] == ["Deployment/shop-y/thumbnailer"]
    s = rca.score_rca(answer({"no_fault": True, "causes": [cause("Deployment/shop-y/orders", kind="crash")]}), CONTROL, CALLS)
    assert not s["pass"] and s["extras"] == ["Deployment/shop-y/orders"]


def test_resource_matching():
    assert rca.resource_matches("ReplicaSet/ns/orders-<new>", "rs/ns/orders-6d8f7c")
    assert rca.resource_matches("Deployment/ns/web", "deployments.apps/ns/web")
    assert rca.resource_matches("Deployment/ns/web", "Deployment/web")
    assert not rca.resource_matches("Deployment/ns/web", "Service/ns/web")
    assert not rca.resource_matches("Deployment/ns/web", "Deployment/other/web")
    assert not rca.resource_matches("Deployment/ns/web", "Deployment/ns/web-2")


def test_fill_placeholders_keeps_the_original():
    truth = {"fault_start": "{{INJECT_TIME}}", "fault_end": "{{UNDO_TIME}}", "note": "from {{SETUP_TIME}}", "n": 3}
    filled = rca.fill_placeholders(truth, {"INJECT_TIME": "2026-11-13T10:00:00Z", "SETUP_TIME": "2026-11-13T09:50:00Z"})
    assert filled == {"fault_start": "2026-11-13T10:00:00Z", "fault_end": None, "note": "from 2026-11-13T09:50:00Z", "n": 3}
    assert truth["fault_start"] == "{{INJECT_TIME}}"


def test_forms_take_turns_and_swap_each_run():
    case = {"question": "q1", "question_vague": "q2"}
    assert rca.ask_order(case, 3) == [("question", "q1", 1), ("question_vague", "q2", 1), ("question_vague", "q2", 2),
                                      ("question", "q1", 2), ("question", "q1", 3), ("question_vague", "q2", 3)]
    assert rca.ask_order({"question": "q1"}, 2) == [("question", "q1", 1), ("question", "q1", 2)]


def test_question_forms_and_format():
    case = {"question": "q1", "question_vague": "q2"}
    assert rca.question_forms(case) == [("question", "q1"), ("question_vague", "q2")]
    assert rca.question_forms({"question": "q1"}) == [("question", "q1")]
    assert rca.question_with_format("q1", None) == "q1"
    assert rca.question_with_format("q1", "rca_block_v0") == "q1\n\n" + rca.RCA_BLOCK_V0


def test_schedule_orders_undo_and_asks():
    assert rca.schedule({}) == [("ask", None)]
    assert rca.schedule({"ask_after_seconds": 300}) == [("ask", 300)]
    assert rca.schedule({"ask_after_seconds": [360, 4200], "fault_duration_seconds": 300}) == [("undo", 300), ("ask", 360), ("ask", 4200)]
    assert rca.schedule({"ask_after_seconds": [300], "fault_duration_seconds": 300}) == [("undo", 300), ("ask", 300)]


def test_staged_and_case_checks():
    old = {"id": "01", "cluster": "self", "namespace": "eval-01", "question": "q", "expect": [], "wait": "true"}
    assert not rca.is_staged(old) and rca.check_case(old, False) == []
    staged = dict(old, answer_format="rca_block_v0", inject_cmds=["true"], ask_after_seconds=[300])
    assert rca.is_staged(staged) and rca.check_case(staged, True) == []
    assert any("truth.json" in p for p in rca.check_case(staged, False))
    assert rca.check_case(dict(old, ask_after_seconds=[60]), False)  # counts from an injection that is not there
    assert rca.check_case(dict(old, ask_after_seconds=[60], fault_start_at="setup"), False) == []
    assert rca.check_case(dict(old, fault_duration_seconds=60, inject_cmds=["true"]), False)
    assert rca.check_case(dict(old, answer_format="other"), True)


def report(likely: str, checked: str = "- k8s_get_resources: pods of shop-x") -> str:
    """An investigation report under the investigator's four headings."""
    return f"## Summary\nSomething fails.\n\n## What I checked\n{checked}\n\n## Likely cause\n{likely}\n\n## Next steps\n- Look again.\n"


def test_text_names_the_cause_and_its_kind():
    s = rca.score_text(report("The new ConfigMap `settings-b` changed a setting the pricing pods read."), TRUTH)
    assert s["section"] == "likely_cause" and s["pass"] and s["score"] == 1.0
    assert s["causes"][0]["named_as"] == ["settings-b"]


def test_text_accepts_another_name_and_kind():
    s = rca.score_text(report("deploy/shop-x/pricing was rolled out to a new revision."), TRUTH)
    assert s["pass"] and s["causes"][0]["kind_found"]


def test_text_needs_the_kind_too():
    s = rca.score_text(report("settings-b is involved somehow."), TRUTH)
    assert not s["pass"] and s["causes"][0]["resource_found"] and not s["causes"][0]["kind_found"]


def test_text_reads_only_the_likely_cause_section():
    s = rca.score_text(report("checkout's calls fail; the reason is unclear.", checked="- settings-b: a ConfigMap setting"), TRUTH)
    assert not s["pass"] and not s["causes"][0]["resource_found"]


def test_text_without_headings_reads_the_whole_report():
    s = rca.score_text("The ConfigMap settings-b holds a bad setting.", TRUTH)
    assert s["section"] == "whole" and s["pass"]


def test_text_lists_decoys_ruled_out_and_blamed_without_failing_a_fault_case():
    s = rca.score_text(report("The ConfigMap settings-b changed a setting; checkout and the nodes are fine."), TRUTH)
    assert s["pass"] and s["decoys_named"] == [] and s["decoys_ruled_out"] == ["checkout"]  # "nodes" names no Node
    s = rca.score_text(report("The ConfigMap settings-b changed a setting, so checkout fails."), TRUTH)
    assert s["pass"] and s["decoys_named"] == [] and s["score"] == 1.0  # the symptom beside its cause: its failure blames it not
    s = rca.score_text(report("Node/kind-worker ran out of memory and caused it."), TRUTH)
    assert not s["pass"] and s["decoys_named"] == ["Node/kind-worker"]


# The reviews' reports (kubeast/raw/20261115/review-eval/findings.md 4 and the second review), on truths shaped as the
# shown cases 03, 09, 12, 13, 14, 19, 21 and 22, and made-up ones (shop-x): no hidden case's truth is written here.
T12 = {"control": False, "causes": [{"resource": "ConfigMap/shop-12/storefront-config", "kind": "config_change", "accept_resources": [],
                                     "accept_kinds": []}],
       "also_ok": [], "decoys": [{"resource": "Deployment/shop-12/notifier"}, {"resource": "Deployment/shop-12/cart"}]}
T12_PATH = dict(T12, path=[{"resource": "ConfigMap/shop-12/storefront-config", "role": "cause", "accept": ["storefront-config"]},
                           {"resource": "Deployment/shop-12/cart", "role": "via", "accept": ["cart"]},
                           {"resource": "Deployment/shop-12/storefront", "role": "symptom", "accept": ["storefront"]}])
C13 = {"control": True, "causes": [], "also_ok": [],
       "decoys": [{"resource": "Deployment/shop-13/thumbnailer"}, {"resource": "Deployment/shop-13/orders"}]}
C14 = {"control": True, "causes": [], "also_ok": [],
       "decoys": [{"resource": "Deployment/shop-14/orders"}, {"resource": "ReplicaSet/shop-14/orders-<new>"}]}
TX = {"control": False, "causes": [{"resource": "ConfigMap/shop-x/gateway-settings", "kind": "config_change",
                                    "accept_kinds": ["dns", "dependency_down"]}],
      "also_ok": [], "decoys": [{"resource": "Deployment/shop-x/ledger"}]}
T19 = {"control": False, "causes": [{"resource": "ConfigMap/shop-19/edge-routes", "kind": "config_change", "accept_kinds": []}],
       "also_ok": ["Service/shop-19/frontdoor"], "decoys": [{"resource": "Deployment/shop-19/storefront"}]}


def test_text_control_fails_when_it_names_a_decoy_as_the_cause():
    for text, truth, blamed in [
        ("The thumbnailer restart (exit 143) is what broke the orders. The other services are running normally.", C13, ["thumbnailer"]),
        ("thumbnailer가 재시작(exit 143)하면서 주문이 실패했습니다. 나머지 서비스는 정상입니다.", C13, ["thumbnailer"]),
        ("orders를 4.18.1로 롤아웃한 것이 느려진 원인입니다. 롤아웃 자체는 정상적으로 끝났습니다.", C14, ["orders"]),
        ("The orders rollout made it slower. Nothing is broken.", C14, ["orders"]),
    ]:
        s = rca.score_text(report(text), truth)
        assert not s["pass"] and s["decoys_named"] == blamed, (text, s)


def test_text_control_passes_on_the_no_fault_words_it_missed():
    for text, truth in [
        ("Nothing points at a fault: the thumbnailer restarted once and has run since; orders answer every call.", C13),
        ("주문 실패 흔적을 찾지 못했습니다. thumbnailer 재시작 1회는 주문 경로와 무관합니다.", C13),
        ("I found no evidence of a fault. thumbnailer restarted once and orders answered every call.", C13),
        ("No fault found: the orders rollout finished cleanly and latency stayed flat.", C14),
        ("장애가 없습니다. thumbnailer는 한 번 재시작했을 뿐이고 orders는 모든 요청에 답합니다.", C13),
    ]:
        s = rca.score_text(report(text), truth)
        assert s["pass"] and s["no_fault"] and s["decoys_named"] == [], (text, s)


def test_text_fault_case_fails_when_its_cause_is_ruled_out():
    for text, truth in [
        ("storefront-config was not changed; I found no config change. cart is down.", T12),
        ("storefront-config는 바뀌지 않았습니다. cart가 중단되었습니다.", T12),
        ("edge-routes config looks normal; the 404 comes from storefront being down.", T19),
    ]:
        s = rca.score_text(report(text), truth)
        assert not s["pass"] and not s["causes"][0]["resource_found"] and s["causes"][0]["ruled_out"], (text, s)


def test_text_fault_case_fails_when_the_report_says_no_fault():
    for text in ("No fault found. storefront-config and its settings look as expected.",
                 "장애가 없습니다. storefront-config 설정을 바꾼 기록은 있습니다."):
        s = rca.score_text(report(text), T12)
        assert not s["pass"] and s["no_fault"], (text, s)


def test_text_fault_case_with_the_rest_said_to_be_normal_passes():
    for text in ("storefront-config's cart_url setting was edited in place; cart calls go to a dead address. The other services are running normally.",
                 "storefront-config의 cart_url 설정이 바뀌어 장바구니 호출이 실패합니다. 나머지 서비스는 정상입니다.",
                 "storefront-config changed the cart_url setting; notifier's restarts are unrelated.",
                 "There is no problem with notifier; storefront-config changed the cart_url setting."):
        s = rca.score_text(report(text), T12)
        assert s["pass"] and not s["no_fault"], (text, s)


def test_text_a_name_ends_at_hangul():
    for text, truth in [("storefront-config가 원인입니다.", T12), ("storefront-config is the cause.", T12),
                        ("gateway-settings를 확인해야 합니다.", TX), ("Check gateway-settings.", TX)]:
        s = rca.score_text(report(text), truth)
        assert not s["pass"] and s["causes"][0]["resource_found"] and not s["causes"][0]["kind_found"], (text, s)
    assert rca.score_text(report("storefront-config가 원인입니다. 설정 값이 잘못됐습니다."), T12)["causes"][0]["kind_found"] is False
    assert rca.score_text(report("storefront-config의 설정 값이 잘못됐습니다."), T12)["pass"]


T09 = {"control": False, "causes": [{"resource": "Deployment/shop-09/catalog", "kind": "resource_limit", "accept_kinds": [],
                                     "accept_resources": ["(deployment|replicaset|pod)/(shop-09/)?catalog", "^catalog"]}],
       "path": [{"resource": "Deployment/shop-09/catalog", "role": "cause"}, {"resource": "Deployment/shop-09/storefront", "role": "symptom"}],
       "also_ok": [], "decoys": [{"resource": "Deployment/shop-09/recommender"}, {"resource": "Node/*"},
                                 {"resource": "Deployment/shop-09/storefront"}]}
TWO = {"control": False, "causes": [
           {"resource": "Deployment/shop-x/gallery", "kind": "image", "accept_kinds": ["rollout"],
            "accept_resources": ["(deployment|replicaset|pod)/(shop-x/)?gallery", "^gallery"]},
           {"resource": "Service/shop-x/stock", "kind": "config_change", "accept_kinds": ["dependency_down"],
            "accept_resources": ["(service|endpoints|endpointslice)/(shop-x/)?stock", "^stock$"]}],
       "path": [{"resource": "Deployment/shop-x/gallery", "role": "cause"}, {"resource": "Service/shop-x/stock", "role": "cause"},
                {"resource": "Deployment/shop-x/basket", "role": "via"}, {"resource": "Deployment/shop-x/front", "role": "symptom"}],
       "also_ok": [], "decoys": [{"resource": "Deployment/shop-x/front"}, {"resource": "Deployment/shop-x/basket"},
                                 {"resource": "Deployment/shop-x/stock"}]}


def test_text_a_shotgun_of_kinds_does_not_pass():
    for text in ("catalog: maybe a config change, a restart, slow dependency, a limit or the node.",
                 "catalog: 설정 변경, 재시작, 응답 지연, 리소스 한도 또는 노드 문제일 수 있습니다."):
        s = rca.score_text(report(text), T09)
        assert (s["pass"], s["score"], s["extras"]) == (False, 0.0, 3), (text, s)
        assert s["causes"][0]["found"] and s["causes"][0]["other_kinds"] == ["config_change", "crash", "dependency_slow", "node"]


def test_text_kind_words_listed_after_two_causes_speak_of_the_nearer_one():
    for text in ("gallery and stock: image pull issue, config, endpoints down.",
                 "gallery와 stock: 이미지 풀 문제, 설정, 엔드포인트 중단."):
        s = rca.score_text(report(text), TWO)
        assert (s["pass"], s["score"]) == (False, 0.0), (text, s)
        assert [(c["resource_found"], c["kind_found"], c["other_kinds"]) for c in s["causes"]] == [(True, False, []), (True, True, ["image"])]
    for text in ("gallery's new image tag is missing, and stock's selector config no longer matches its pods.",
                 "gallery는 이미지 태그가 잘못됐고 stock은 셀렉터 설정이 바뀌었습니다."):
        s = rca.score_text(report(text), TWO)
        assert (s["pass"], s["score"], s["extras"]) == (True, 1.0, 0), (text, s)


def test_text_other_objects_named_as_causes_cost_points():
    s = rca.score_text(report("catalog, recommender or Deployment/shop-09/orders-db could be the cause of the CPU limit."), T09)
    assert (s["pass"], s["score"], s["extras"]) == (False, 0.0, 2)
    assert s["extra_objects"] == ["Deployment/shop-09/orders-db", "recommender"]
    s = rca.score_text(report("catalog hits its CPU limit and is throttled, and recommender adds load."), T09)
    assert (s["pass"], s["score"], s["extras"], s["extra_objects"]) == (True, 0.75, 1, ["recommender"])
    s = rca.score_text(report("catalog hits its CPU limit and is throttled; recommender is busier but unrelated."), T09)
    assert (s["pass"], s["score"], s["extras"]) == (True, 1.0, 0)  # ruled out: no extra


def test_text_the_symptom_and_one_more_kind_word_are_free():
    for text in ("catalog runs at its 25m CPU limit, so its requests are throttled and storefront's product list is slow.",
                 "catalog가 25m CPU 한도에 걸려 스로틀되고, 그래서 storefront의 상품 목록이 느려졌습니다."):
        s = rca.score_text(report(text), T09)
        assert (s["pass"], s["score"], s["extras"], s["extra_objects"]) == (True, 1.0, 0, []), (text, s)
        assert s["causes"][0]["other_kinds"] == ["dependency_slow"]
    s = rca.score_text(report("catalog runs at its CPU limit and is slow; it also restarted."), T09)
    assert (s["pass"], s["score"], s["extras"]) == (True, 0.75, 1)


def test_text_kind_words_only_in_the_sentence_naming_the_cause():
    s = rca.score_text(report("storefront-config is the cause. notifier's settings changed too."), T12)
    assert not s["pass"] and not s["causes"][0]["kind_found"]
    s = rca.score_text("**Summary** cart down.\n**Likely cause** cart is down.\n**Ruled out** storefront-config: config unchanged.", T12)
    assert s["section"] == "whole" and not s["pass"]


def test_text_control_passes_only_when_it_says_no_fault():
    assert rca.score_text(report("No fault found: orders work as expected; thumbnailer restarted once."), CONTROL)["pass"]
    assert rca.score_text(report("문제가 없습니다. thumbnailer는 한 번 재시작했을 뿐입니다."), CONTROL)["pass"]
    s = rca.score_text(report("thumbnailer crashed and broke the orders."), CONTROL)
    assert not s["pass"] and s["decoys_named"] == ["thumbnailer"]


def test_text_ignores_an_rca_block():
    text = report("Unclear.") + "\n```rca\n" + json.dumps({"causes": [cause("ConfigMap/shop-x/settings-b")]}) + "\n```\n"
    assert not rca.score_text(text, TRUTH)["pass"]


T21 = {"control": False, "causes": [{"resource": "ConfigMap/shop-21/search-indexes-2", "kind": "config_change",
                                     "accept_resources": ["search-indexes-2"], "accept_kinds": ["rollout"]}],
       "path": [{"resource": "ConfigMap/shop-21/search-indexes-2", "role": "cause", "accept": ["search-indexes-2", "questions"]},
                {"resource": "StatefulSet/shop-21/search", "role": "via", "accept": ["^(statefulset|pod)/(shop-21/)?search(-[0-9])?$", "^search(-[0-9])?$"]},
                {"resource": "Deployment/shop-21/storefront", "role": "symptom", "accept": ["storefront"]}],
       "also_ok": ["StatefulSet/shop-21/search", "Pod/shop-21/search-<n>", "Service/shop-21/search"],
       "decoys": [{"resource": "CronJob/shop-21/report-builder"}, {"resource": "Deployment/shop-21/storefront"}, {"resource": "Node/*"}]}
T22 = {"control": False, "causes": [{"resource": "ConfigMap/shop-22/shop-api-settings", "kind": "config_change",
                                     "accept_resources": ["shop-api-settings", "WEB_WORKERS"], "accept_kinds": ["rollout"]}],
       "path": [{"resource": "ConfigMap/shop-22/shop-api-settings", "role": "cause", "accept": ["shop-api-settings", "WEB_WORKERS"]},
                {"resource": "Deployment/shop-22/shop-api", "role": "via",
                 "accept": ["^(deployment|replicaset|pod)/(shop-22/)?shop-api(-[a-z0-9]{6,10})?(-[a-z0-9]{5})?$", "^shop-api$"]},
                {"resource": "Deployment/shop-22/visitor", "role": "symptom", "accept": ["visitor", "service/(shop-22/)?shop-api"]}],
       "also_ok": ["Deployment/shop-22/shop-api", "ReplicaSet/shop-22/shop-api-<hash>", "Pod/shop-22/shop-api-<hash>", "Service/shop-22/shop-api"],
       "decoys": [{"resource": "Deployment/shop-22/session-cache"}, {"resource": "Deployment/shop-22/visitor"}, {"resource": "Node/*"}]}
# 03 after the second review: the Job's namespace counts only with a kind or a path, not as the word "reports".
T03 = {"control": False, "causes": [{"resource": "Node/kubeast-b-control-plane", "kind": "node", "accept_kinds": ["resource_limit"],
                                     "accept_resources": ["^nodes?$", "control-plane", "monthly-report", "^namespace/reports$", "(^|/)reports/"]}],
       "path": [{"resource": "Node/kubeast-b-control-plane", "role": "cause", "accept": ["^nodes?$", "control-plane", "monthly-report"]},
                {"resource": "Deployment/shop-03/search", "role": "symptom", "accept": ["(^|/)(search|pricing|thumbnails|storefront|image-worker)$"]}],
       "also_ok": [], "decoys": [{"resource": "Deployment/shop-03/search"}, {"resource": "Deployment/shop-03/thumbnails"},
                                 {"resource": "Deployment/shop-03/storefront"}]}


def test_text_a_shotgun_across_lines_or_sentences_does_not_pass():
    """The second review's 2: candidates written one to a bullet or a sentence are read over the whole section."""
    for text, truth, blamed in [
        ("- storefront-config's cart_url setting changed\n- Deployment/shop-12/cart crashed\n"
         "- Deployment/shop-12/notifier is failing and caused the errors\n- Node/kind-worker is NotReady\n- DNS resolution fails",
         T12, ["Deployment/shop-12/notifier"]),
        ("storefront-config's setting changed. Or notifier crashed and caused it. Or the node is out of memory. Or DNS is broken. "
         "Or a NetworkPolicy blocks it.", T12, ["notifier"]),
        ("- catalog is throttled at its CPU limit\n- recommender uses most CPU and causes the slowness\n"
         "- Node/kind-worker is overloaded and causes it", T09, ["Node/kind-worker", "recommender"]),
    ]:
        s = rca.score_text(report(text), truth)
        assert (s["pass"], s["score"]) == (False, 0.0) and s["decoys_named"] == blamed, (text, s)
    s = rca.score_text(report("- storefront-config's cart_url setting changed\n- Deployment/shop-12/cart crashed\n- Node/kind-worker is NotReady"), T12)
    assert (s["pass"], s["extras"], s["extra_objects"]) == (False, 2, ["Deployment/shop-12/cart", "Node/kind-worker"]), s


def test_text_control_needs_no_fault_and_no_suspect():
    """The second review's 3: each of these names a cause or a suspect, so a control does not pass."""
    for text, truth in [
        ("Deployment/shop-13/catalog's connection pool is exhausted, which causes the order failures. thumbnailer looks normal.", C13),
        ("storefront 설정 변경 때문에 주문이 실패합니다. 나머지는 정상입니다.", C13),
        ("thumbnailer restarted and caused the order failures, while orders itself is healthy.", C13),
        ("thumbnailer 재시작 때문에 주문이 실패했고 orders는 정상입니다.", C13),
        ("thumbnailer restarted (exit 143) right before the order errors. orders itself is healthy.", C13),
        ("The orders rollout to 4.18.1 four minutes ago, then orders got slower. Other pods are fine.", C14),
    ]:
        s = rca.score_text(report(text), truth)
        assert not s["pass"] and not s["no_fault"], (text, s)
    s = rca.score_text(report("No fault found. Deployment/shop-13/catalog's connection pool causes the order failures."), C13)
    assert not s["pass"] and s["no_fault"] and s["suspects"] == ["Deployment/shop-13/catalog"], s
    s = rca.score_text(report("thumbnailer restarted and caused the order failures, while orders itself is healthy."), C13)
    assert s["decoys_named"] == ["thumbnailer"] and s["decoys_ruled_out"] == ["orders"], s


def test_text_right_reports_the_second_review_read_as_wrong():
    """The second review's 4: a normal word speaks of the nearest name only, a change is a ConfigMap's config_change,
    one stretch of words is one kind, and "no problems elsewhere" rules the rest out."""
    for text, truth, score in [
        ("storefront-config의 cart_url 설정이 바뀌었고 notifier 재시작은 무관합니다.", T12, 1.0),
        ("storefront-config changed the cart_url setting, while notifier's restarts are unrelated.", T12, 1.0),
        ("storefront-config changed cart_url and notifier is unrelated.", T12, 1.0),
        ("storefront-config's cart_url was edited in place from /api/v1/cart to /api/v2/cart; cart only serves /api/v1/cart and answers 404.",
         T12_PATH, 1.0),
        ("shop-api-settings raised WEB_WORKERS from 3 to 6, so shop-api is OOMKilled at its memory limit.", T22, 1.0),
        ("The WEB_WORKERS setting in shop-api-settings was changed from 3 to 6, so shop-api is OOMKilled at its memory limit.", T22, 1.0),
        ("ConfigMap/shop-22/shop-api-settings raised WEB_WORKERS from 3 to 6; each worker's cache grows, so "
         "Pod/shop-22/shop-api-7f9c4d8b6-x2k4p hits its 64Mi memory limit and is OOMKilled, and visitor sees failures.", T22, 1.0),
        ("search-indexes-2 added a third index (105 MB instead of 66); when the rolling update removed one search node the others "
         "took its shards and hit the 48Mi memory limit, OOMKilled in turn.", T21, 0.75),  # "node": one kind too many
        ("storefront-config's cart_url setting was edited in place, so cart calls get 404. No problems elsewhere.", T12_PATH, 1.0),
        ("storefront-config's cart_url setting was edited in place, so cart calls get 404.\nNo issues found in the other workloads.", T12_PATH, 1.0),
    ]:
        s = rca.score_text(report(text), truth)
        assert (s["pass"], s["score"], s["no_fault"]) == (True, score, False), (text, s)
    s = rca.score_text(report("catalog runs at its memory limit."), T09)
    assert s["causes"][0]["other_kinds"] == ["oom"]  # "memory limit" is one kind, not oom and resource_limit
    s = rca.score_text(report("Deployment/shop-09/catalog was changed and is throttled at its CPU limit."), T09)
    assert s["causes"][0]["other_kinds"] == []  # a change is config_change only for a ConfigMap or Secret


def test_text_03_reads_the_job_by_its_name_and_the_node_by_what_it_does():
    """The second review's 5: the word "reports" alone names no cause, and a busy, saturated node is the node kind."""
    for text in ("storefront reports that search answers slowly; search may be hitting a CPU limit.",
                 "As the alert reports, search is slow; its CPU is throttled.",
                 "search, pricing and thumbnails all slowed at once; probably the node."):
        s = rca.score_text(report(text), T03)
        assert not s["pass"], (text, s)
    for text in ("Job monthly-report-run in reports keeps the node's CPU busy, so search, pricing and thumbnails slow down together.",
                 "The node's CPU is saturated by Job reports/monthly-report-run, which has no CPU limit.",
                 "Namespace/reports runs a Job that keeps the node's CPU busy."):
        s = rca.score_text(report(text), T03)
        assert s["pass"] and s["score"] == 1.0, (text, s)


def test_text_a_loose_json_block_left_in_the_report_is_not_read_as_words():
    text = ("## Summary\nok\n## Likely cause\nNo fault found: thumbnailer restarted once.\n```json\n"
            + json.dumps({"no_fault": True, "causes": [], "path": [], "ruled_out": ["Deployment/shop-13/thumbnailer"]}) + "\n```\n")
    s = rca.score_text(text, C13)
    assert s["pass"] and s["no_fault"] and s["decoys_named"] == [], s


def test_stored_result_scores_as_the_block_it_came_from():
    block = {"no_fault": False, "causes": [cause("ConfigMap/shop-x/settings-b", evidence=[1, 3])], "path": GOOD_PATH, "ruled_out": []}
    result = {"version": 1, "status": "ok", "no_fault": False, "path": GOOD_PATH, "ruled_out": [], "hypotheses": [],
              "causes": [{"resource": "ConfigMap/shop-x/settings-b", "kind": "config_change", "started_at": "2026-11-13T10:01:00Z",
                          "evidence": [{"call": 1, "tool": "timeline"}, {"call": 3, "tool": "loki_query", "failed": True}]}]}
    assert rca.score_block(*rca.block_of_result(result), TRUTH, CALLS) == rca.score_rca(answer(block), TRUTH, CALLS)
    assert rca.block_of_result(None) == (None, "missing")
    assert rca.block_of_result({"status": "invalid", "causes": []}) == (None, "invalid")
    assert rca.score_block(*rca.block_of_result({"status": "missing"}), TRUTH, CALLS)["block"] == "missing"


def test_alert_checks_and_send_time():
    staged = {"id": "01", "cluster": "self", "namespace": "eval-01", "question": "q", "inject_cmds": ["true"], "ask_after_seconds": [300]}
    good = dict(staged, alert={"labels": {"alertname": "ServiceSlow", "service": "web"}, "annotations": {"summary": "slow"}})
    assert rca.check_case(good, True) == [] and rca.is_staged({"alert": {}})
    assert rca.alert_name(good) == "ServiceSlow" and rca.alert_after(good) == 300
    assert rca.alert_after(dict(good, alert=dict(good["alert"], after_seconds=60))) == 60
    assert rca.alert_after({"alert": {"rule": "R"}}) == 0 and rca.alert_name({"alert": {"rule": "R"}}) == "R"
    assert any("truth.json" in p for p in rca.check_case(good, False))
    for alert in ({"annotations": {"summary": "x"}}, {"labels": {"alertname": "A"}, "rule": "B"}, {"labels": {"alertname": 3}},
                  {"labels": {"alertname": "A"}, "after_seconds": -1}, {"labels": {"alertname": "A"}, "extra": 1}, "ServiceSlow"):
        assert rca.check_case(dict(staged, alert=alert), True), alert


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e!r}")
    print(f"{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
