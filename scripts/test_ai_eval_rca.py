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
    assert s["score"] == 1.0 - rca.EXTRA_CAUSE_PENALTY


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


def test_text_lists_decoys_without_failing():
    s = rca.score_text(report("The ConfigMap settings-b changed a setting; checkout and the nodes are fine."), TRUTH)
    assert s["pass"] and s["decoys_named"] == ["checkout"]  # "nodes" names no Node: a wildcard name needs the kind
    s = rca.score_text(report("Node/kind-worker is out of memory."), TRUTH)
    assert not s["pass"] and s["decoys_named"] == ["Node/kind-worker"]


def test_text_control_passes_only_when_it_says_no_fault():
    assert rca.score_text(report("No fault found: orders work as expected; thumbnailer restarted once."), CONTROL)["pass"]
    assert rca.score_text(report("문제가 없습니다. thumbnailer는 한 번 재시작했을 뿐입니다."), CONTROL)["pass"]
    s = rca.score_text(report("thumbnailer crashed and broke the orders."), CONTROL)
    assert not s["pass"] and s["decoys_named"] == ["thumbnailer"]


def test_text_ignores_an_rca_block():
    text = report("Unclear.") + "\n```rca\n" + json.dumps({"causes": [cause("ConfigMap/shop-x/settings-b")]}) + "\n```\n"
    assert not rca.score_text(text, TRUTH)["pass"]


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
