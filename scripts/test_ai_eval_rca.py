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
