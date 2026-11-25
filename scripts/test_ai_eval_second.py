"""Checks scripts/ai_eval_second.py, the second scoring a run records next to the first (ai_eval_rca.py): wrong answers
fail under both, right reports pass under the second, a control's answer is one of three outcomes, the kinds a case takes
besides its truth's are only what its NOTES.md says, and the tables keep incidents and controls apart. No cluster, no API;
the truths are the shown cases' own (a hidden case's folder is not read here).

  python3 -m pytest -q scripts/test_ai_eval_second.py
  python3 scripts/test_ai_eval_second.py        # the same checks without pytest
"""
import copy
import hashlib
import importlib.util
import io
import json
import re
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HARD = ROOT / "evals" / "ai-hard"
sys.path.insert(0, str(HERE))

import ai_eval_rca as rca  # noqa: E402
import ai_eval_second as second  # noqa: E402


def _load_ai_eval():
    spec = importlib.util.spec_from_file_location("ai_eval_second_under_test", HERE / "ai-eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AI_EVAL = _load_ai_eval()
MARKS = {"SETUP_TIME": "2026-01-01T00:00:00Z", "INJECT_TIME": "2026-01-01T00:05:00Z", "UNDO_TIME": "2026-01-01T00:10:00Z"}
CALLS = [{"tool": "timeline", "failed": False}, {"tool": "k8s_get_resources", "failed": False}, {"tool": "loki_query", "failed": False}]


def shown_cases() -> dict:
    cases, problems = AI_EVAL.load_cases(HARD, [], False)  # the shown cases only
    assert problems == [], problems
    return {c["id"][:2]: (d, c) for d, c in cases}


CASES = shown_cases()
TRUTHS = {n: rca.fill_placeholders(json.loads((d / "truth.json").read_text()), MARKS) for n, (d, _) in CASES.items()}
RULES = {n: second.load_rules(d) for n, (d, _) in CASES.items()}
WORDS = {n: {k: v for k, v in r.items() if k != "facts"} for n, r in RULES.items()}  # for the checks of one rule of the words
# 05's callee, read from its truth (the Service, and its name).
CALLEE = next(x["resource"] for x in TRUTHS["05"]["decoys"] if x["resource"].startswith("Service/"))
CALLED = CALLEE.rsplit("/", 1)[1]


def blk(*causes, no_fault=False):
    return {"no_fault": no_fault, "causes": [{"resource": r, "kind": k, "started_at": None, "evidence": [1]} for r, k in causes]}


def both_block(case, block, prose=""):
    truth = TRUTHS[case]
    return (rca.score_block(copy.deepcopy(block), "ok", truth, CALLS),
            second.score_block(copy.deepcopy(block), "ok", truth, CALLS, prose, RULES[case]))


def report(summary, likely):
    return f"## Summary\n{summary}\n\n## What I checked\n- the pods\n\n## Likely cause\n{likely}\n\n## Next steps\n1. look again\n"


def both_text(case, text):
    return rca.score_text(text, TRUTHS[case]), second.score_text(text, TRUTHS[case], RULES[case])


# --- wrong answers: they fail under both scorings ---

# (case, the block, the answer's prose, why it is wrong)
WRONG_BLOCKS = [
    ("01", blk(("Deployment/otel-demo/payment", "crash")), "", "the word the question uses"),
    ("01", blk(("Deployment/otel-demo/cart", "dependency_down")), "", "cart alone misses its store"),
    ("01", blk(("Deployment/otel-demo/checkout", "dependency_down")), "", "where the order fails"),
    ("03", blk(("Deployment/shop-03/search", "resource_limit")), "", "the busiest service"),
    ("03", blk(("Node/kubeast-b-control-plane", "node"), ("Deployment/shop-03/search", "node")), "", "the node and a decoy"),
    ("04", blk(("Deployment/shop-04/catalog", "dependency_down")), "", "the blocked backend"),
    ("04", blk(("NetworkPolicy/shop-04/allow-same-namespace", "config_change")), "", "the older policy"),
    ("04", blk(("NetworkPolicy/shop-04/allow-from-gateway", "crash")), "", "the right object, another mechanism"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "storefront was rolled out; its stock lookups fail", "a rollout alone (NOTES)"),
    ("05", blk(("Deployment/shop-05/storefront", "config_change")), "a config change broke storefront, bad address", "a change alone (NOTES)"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "storefront was rolled out. Its dnsPolicy is unchanged and its dnsConfig looks normal.",
     "the mechanism named only to rule it out"),
    ("05", blk(("Deployment/shop-05/storefront", "crash")), "storefront's dnsConfig lacks shop-05", "a kind the NOTES do not name"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")),
     "The new storefront release has a bug in its connection pool. The pod's dnsPolicy is ClusterFirst and the search domain list is normal.", "the settings read and found well"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "The new storefront release is broken. dnsPolicy: ClusterFirst, dnsConfig unset.", "the settings only read"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "The new storefront release is broken. DNS config is fine.", "the settings found well"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "The new storefront release changed its image. The search path in the storefront UI works.", "another search path"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "storefront's release changed its image; the dnsPolicy is ClusterFirst.", "a change of something else"),
    ("05", blk(("Deployment/shop-05/storefront", "rollout")), "storefront's image was changed without touching its dnsConfig.", "the settings left alone"),
    ("05", blk(("Deployment/shop-05/storefront", "config_change")), "I checked the DNS config, which matches the other services.", "the settings compared"),
    ("05", blk(("Deployment/shop-05/storefront", "config_change")), "reports has a dnsConfig that lacks shop-05. storefront was changed.", "another workload's settings"),
    ("05", blk(("Deployment/kube-system/coredns", "dns")), "dnsConfig", "CoreDNS"),
    ("05", blk((CALLEE, "config_change")), "dnsPolicy None ndots", "the callee, with DNS words beside it"),
    ("06", blk(("Deployment/shop-06/checkout", "rollout")), "", "the caller"),
    ("06", blk(("ConfigMap/shop-06/pricing-settings-7d4f8", "config_change")), "", "the old ConfigMap"),
    ("06", blk(("Deployment/shop-06/pricing", "crash")), "", "pricing as a whole"),
    ("07", blk(("Deployment/otel-demo/product-catalog", "dependency_slow")), "", "one end only"),
    ("07", blk(("Deployment/otel-demo/frontend", "dependency_slow")), "", "the other end only"),
    ("07", blk(("Deployment/otel-demo/astronomy-db", "dependency_slow")), "", "the database"),
    ("09", blk(("Deployment/shop-09/recommender", "resource_limit")), "", "the top CPU user"),
    ("09", blk(("Node/kubeast-b-control-plane", "node")), "", "the node"),
    ("09", blk(("Deployment/shop-09/catalog", "config_change")), "", "a change that never was"),
    ("09", blk(no_fault=True), "", "nothing is wrong"),
    ("09", blk(), "", "an empty list"),
    ("10", blk(("Deployment/otel-demo/product-catalog", "resource_limit")), "", "returns the errors"),
    ("10", blk(("Deployment/otel-demo/accounting", "dependency_slow")), "", "the lag is a symptom"),
    ("10", blk(("Deployment/otel-demo/astronomy-db", "storage")), "", "the database, another mechanism"),
    ("12", blk(("Deployment/shop-12/notifier", "crash")), "", "the loud decoy"),
    ("12", blk(("Deployment/shop-12/cart", "config_change")), "", "cart"),
    ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change"), ("Deployment/shop-12/notifier", "dns")), "", "the cause and a decoy"),
    ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change"), ("Deployment/shop-12/a", "crash"),
               ("Service/shop-12/b", "dns"), ("Node/n", "node")), "", "a list of guesses"),
    ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change"), ("ConfigMap/shop-12/storefront-config", "dns"),
               ("ConfigMap/shop-12/storefront-config", "crash"), ("ConfigMap/shop-12/storefront-config", "image")), "", "the cause under every kind"),
    ("13", blk(("Deployment/shop-13/thumbnailer", "crash")), "", "a made-up cause"),
    ("13", blk(("Deployment/shop-13/thumbnailer", "crash"), no_fault=True), "", "no_fault beside a cause"),
    ("13", blk(), "", "the cause left open on a control (NOTES: only no_fault is right)"),
    ("14", blk(("Deployment/shop-14/orders", "rollout")), "", "a made-up rollout"),
    ("16", blk(no_fault=True), "", "nothing is wrong now"),
    ("16", blk(("Deployment/shop-16/storefront", "dependency_down")), "", "the caller"),
    ("16", blk(("Deployment/shop-16/payments", "crash")), "", "a crash without evidence"),
    ("17", blk(("Deployment/shop-17/orders-db", "dependency_slow")), "", "the slow database without what loads it"),
    ("17", blk(("Deployment/shop-17/feed-builder", "resource_limit")), "", "the top CPU user"),
    ("17", blk(("CronJob/shop-17/reminder-sender", "crash")), "", "the right object, another mechanism"),
    ("19", blk(("Deployment/shop-19/storefront", "crash")), "", "the backend"),
    ("19", blk(("Deployment/shop-19/edge", "config_change")), "", "edge alone"),
    ("19", blk(("ConfigMap/shop-19/edge-routes", "dns")), "", "DNS"),
    ("20", blk(("Deployment/shop-20/shop-web", "crash")), "", "the crash, no change"),
    ("20", blk(("Deployment/shop-20/preview-web", "rollout")), "", "preview-web"),
    ("21", blk(("StatefulSet/shop-21/search", "oom")), "", "what the pod states show"),
    ("21", blk(("StatefulSet/shop-21/search", "rollout")), "", "the new pods fail"),
    ("21", blk(("CronJob/shop-21/report-builder", "oom")), "", "report-builder"),
    ("22", blk(("Deployment/shop-22/shop-api", "oom")), "", "what the pod states show"),
    ("22", blk(("Deployment/shop-22/shop-api", "resource_limit")), "", "raise the limit"),
    ("22", blk(("Deployment/shop-22/session-cache", "oom")), "", "session-cache"),
]

# The right object under a kind the case's NOTES.md does not give for it ("How the scorer judges"): no scoring takes it
# until the NOTES say so and the case's scoring.json quotes them.
KINDS_THE_NOTES_DO_NOT_GIVE = [
    ("04", "NetworkPolicy/shop-04/allow-from-gateway", "config_change"),
    ("09", "Deployment/shop-09/catalog", "rollout"),
    ("10", "Deployment/otel-demo/astronomy-db", "resource_limit"),
    ("16", "Deployment/shop-16/payments", "rollout"),
    ("17", "CronJob/shop-17/reminder-sender", "dependency_slow"),
    ("21", "ConfigMap/shop-21/search-indexes-2", "oom"),
    ("21", "ConfigMap/shop-21/search-indexes-2", "resource_limit"),
    ("22", "ConfigMap/shop-22/shop-api-settings", "oom"),
    ("22", "ConfigMap/shop-22/shop-api-settings", "resource_limit"),
]

# (case, summary, likely cause, why it is wrong)
WRONG_REPORTS = [
    ("01", "checkouts fail.", "payment is the culprit: its crash caused the checkouts to fail.", "the word the question uses"),
    ("01", "checkouts fail.", "Deployment/otel-demo/cart is down; its errors caused checkout to fail.", "cart alone"),
    ("03", "search in shop-03 is slow.", "Deployment/shop-03/search is the culprit: it uses the most CPU and needs a higher limit.", "the busiest service"),
    ("03", "search is slow.", "The node is fine. Deployment/shop-03/search is at its CPU limit, which caused the slow answers.", "the node cleared, search blamed"),
    ("04", "storefront cannot reach catalog.", "The culprit is Deployment/shop-04/catalog: it is not responding and its requests time out.", "the blocked backend"),
    ("04", "storefront cannot reach catalog.", "catalog is down because Service/shop-04/catalog broke. NetworkPolicy allow-from-gateway is unrelated.", "the policy ruled out"),
    ("04", "storefront times out.", "No fault found. NetworkPolicy allow-from-gateway was created earlier.", "no fault, the object only seen"),
    ("04", "storefront cannot reach catalog. A NetworkPolicy allow-from-gateway was created at 12:00.", "catalog is not responding to storefront.",
     "the cause only seen in the Summary"),
    ("05", "storefront lookups fail.", "CoreDNS is broken: deployment/kube-system/coredns fails DNS lookups, which caused storefront's errors.", "CoreDNS"),
    ("05", f"storefront cannot reach {CALLED}.", f"{CALLEE} has no endpoints, which caused the failure.", "the callee"),
    ("05", "storefront lookups fail.", "storefront was rolled out with a new release, which broke it.", "a rollout alone (NOTES)"),
    ("05", "storefront lookups fail.", "storefront was rolled out with a new release, which broke it. Its dnsPolicy is unchanged.", "a rollout, DNS ruled out"),
    ("06", "checkout sees 500s.", "checkout is the culprit; Deployment/shop-06/checkout broke.", "the caller"),
    ("06", "checkout sees 500s. ConfigMap pricing-settings-9b2c1 was created.", "The cause is checkout: it sends a bad request, checkout is the culprit.",
     "the cause seen, the caller blamed"),
    ("06", "checkout sees 500s. ConfigMap pricing-settings-9b2c1 was created.", "checkout sends bad requests, which caused the 500s.",
     "the cause seen, the caller blamed by a verb"),
    ("06", "checkout sees 500s.", "ConfigMap pricing-settings-9b2c1 was created earlier. checkout sends bad requests, which caused the 500s.",
     "the cause seen in the section, the caller blamed"),
    ("09", "storefront is slow.", "The culprit is recommender: it uses the most CPU and starves the node.", "the top CPU user"),
    ("09", "storefront is slow.", "No fault found; nothing is wrong.", "nothing is wrong"),
    ("10", "product lists fail.", "product-catalog is the cause: it returns the errors after a bad release.", "returns the errors"),
    ("12", "cart requests fail.", "Deployment/shop-12/notifier is in CrashLoopBackOff with a DNS error, which caused the failure.", "the loud decoy"),
    ("12", "cart requests fail. The ConfigMap storefront-config was updated.", "The culprit is notifier: its crash caused the failure.",
     "the cause seen in the Summary, a decoy blamed"),
    ("12", "cart requests fail.", "cart broke and answers 404; Deployment/shop-12/cart is the culprit.", "cart"),
    ("12", "cart requests fail. The ConfigMap storefront-config was changed.", "The cause could not be determined.", "a change seen, the cause left open"),
    ("13", "orders reportedly fail.", "thumbnailer crashed (exit 143), which caused the order failures.", "a made-up cause"),
    ("13", "No evidence of errors in the logs now.", "The thumbnailer restart caused the order failures.", "no errors, and a made-up cause"),
    ("13", "orders reportedly fail.", "No evidence of another cause; the thumbnailer crash caused the order failures.", "other causes denied, one made up"),
    ("13", "orders reportedly fail.", "The most likely explanation is the thumbnailer restart.", "a guess offered as the cause"),
    ("13", "orders reportedly fail.", "Deployment/shop-13/thumbnailer keeps crashing and breaks the orders.", "a made-up cause by another verb"),
    ("14", "orders got slow.", "The rollout of Deployment/shop-14/orders to 4.18.1 is the culprit and made order processing slow.", "a made-up rollout"),
    ("14", "orders got slow.", "Order processing slowed after the 4.18.1 release.", "says neither"),
    ("14", "orders got slow.", "The cause is the rollout of Deployment/shop-14/orders; no errors were found.", "a made-up rollout with no-error words"),
    ("14", "No fault found in the pods.", "The 4.18.1 rollout made order processing slow.", "a made-up rollout that names no object"),
    ("16", "storefront payments failing.", "No fault found: everything is running now.", "nothing is wrong"),
    ("16", "storefront payments failing.", "Deployment/shop-16/storefront is the culprit; it broke.", "the caller"),
    ("16", "storefront payments failed for five minutes.", "The cause could not be determined: nothing in the cluster shows it now.", "cannot tell"),
    ("17", "invoices slow.", "orders-db is slow and times out; Deployment/shop-17/feed-builder uses most CPU and caused it.", "the top CPU user"),
    ("17", "invoices slow.", "orders-db is the slow dependency: it has a deep disk queue.", "the database without what loads it"),
    ("17", "invoices slow. CronJob reminder-sender was changed.", "The cause is Deployment/shop-17/feed-builder, which made orders-db slow.",
     "the cause seen, the top CPU user blamed"),
    ("19", "www 404.", "Deployment/shop-19/storefront is the culprit; it returns 404.", "the backend"),
    ("19", "www 404. The config edge-routes was read.", "Deployment/shop-19/edge-legacy is the culprit; it broke.", "the cause seen, the old edge blamed"),
    ("20", "shop-web down.", "Deployment/shop-20/preview-web is the culprit: it broke the release.", "preview-web"),
    ("20", "shop-web down.", "The shop-web pods crash on startup with a fatal error.", "the crash, no change"),
    ("21", "search down.", "StatefulSet/shop-21/search pods were OOMKilled, so the memory limit is too low.", "what the pod states show"),
    ("21", "search down.", "report-builder is the culprit: its heavy query caused the OOM.", "report-builder"),
    ("22", "API drops.", "shop-api pods are OOMKilled; raise the memory limit of Deployment/shop-22/shop-api.", "raise the limit"),
    ("22", "API drops.", "session-cache is the culprit: it is at 80% of its memory limit.", "session-cache"),
]

# The review's wrong reports (2026-11-25), by a reader who had not written the rules: the right object in view, another
# mechanism told. Some pass the first scoring.
WRONG_REPORTS_OF_THE_REVIEW = [
    ("09", "storefront is slow.", "A bug in the new catalog code is the problem: it loops. Deployment/shop-09/catalog is not held back by its CPU limit."),
    ("09", "storefront is slow.", "Deployment/shop-09/catalog has a lock contention bug in its code. The CPU limit of catalog is generous and throttling is zero."),
    ("09", "storefront is slow.", "Deployment/shop-09/catalog lost its cache, so every request is computed. I also looked at the CPU limit: 25m."),
    ("01", "checkouts fail.", "The cart code has a bug that makes valkey-cart commands malformed. valkey-cart has endpoints and is Running, but cart sends bad commands."),
    ("01", "checkouts fail.", "cart cannot log in to valkey-cart because a password in cart's Secret was changed; valkey-cart itself answers on its port and has ready endpoints."),
    ("04", "storefront cannot reach catalog.", "storefront's client has a bug in its timeout. The NetworkPolicy allow-from-gateway is there but allows storefront."),
    ("04", "storefront cannot reach catalog.", "The catalog image was replaced and listens on a wrong port. The NetworkPolicy allow-from-gateway admits it."),
    ("05", "storefront lookups fail.", "storefront was rolled out with a wrong URL in its code. The dnsPolicy of its pods is ClusterFirst."),
    ("05", "storefront lookups fail.", "storefront was rolled out and its new code has a bug. DNS works from its pods: names resolve."),
    ("05", "storefront lookups fail.", "storefront's new code has a bug. DNS names resolve in every pod."),
    ("06", "checkout 500", "ConfigMap pricing-settings-9b2c1 was created and is identical to the old one. The new image of pricing has a bug in its rounding code."),
    ("10", "lists fail", "product-catalog leaks connections: it opens too many to astronomy-db, so astronomy-db refuses connections and is slow."),
    ("16", "payments failed", "payments lost its database password. Its Service had endpoints all the time and payments pods were up; it is dependency: the bank gateway is down."),
    ("17", "slow", "CronJob reminder-sender was changed yesterday, long before. orders-db is slow because its disk failed."),
    ("19", "404", "ConfigMap edge-routes was changed, but only a comment. Service frontdoor points at edge, whose image has a bug and drops the host header."),
    ("20", "down", "shop-web was rolled out to 2.4.0; the image of 2.4.0 cannot be pulled."),
    ("21", "search down", "ConfigMap search-indexes-2 is new and only renames a label. A heavy query from users OOMKilled the search pods."),
    ("22", "API drops", "ConfigMap shop-api-settings was changed: a new LOG_LEVEL. The shop-api pods leak memory since release 5."),
    ("22", "API drops", "A memory leak in the code of shop-api. ConfigMap shop-api-settings was changed too."),
    ("12", "cart requests fail.", "ConfigMap storefront-config was edited, but only its log level; cart's image dropped the v1 route."),
    ("03", "slow", "Node/kubeast-b-control-plane has a failing disk: node pressure slows everything."),
    ("03", "slow", "The kernel on Node/kubeast-b-control-plane was upgraded and is broken; CPU is idle."),
    # of the same kind, written here
    ("04", "storefront cannot reach catalog.", "NetworkPolicy allow-from-gateway exists and lets storefront in; catalog's certificate expired."),
    ("05", "storefront lookups fail.", "Deployment storefront uses DNS as before and resolves names; its stock password is wrong."),
    ("09", "storefront is slow.", "Deployment/shop-09/catalog never hits its CPU limit. It waits on a lock."),
    ("12", "cart requests fail.", "ConfigMap storefront-config was changed, a comment only. cart was rolled out without its v1 route."),
    ("16", "payments failed", "payments kept all its replicas. Its token expired and the bank is down."),
    ("21", "search down", "ConfigMap search-indexes-2 was added and is cosmetic. Users' queries grew and the search pods were OOMKilled."),
    ("22", "API drops", "ConfigMap shop-api-settings was edited, but only a label. The workers of shop-api leak memory."),
    ("17", "slow", "CronJob reminder-sender was changed, only its label. orders-db's disk is failing."),
]
# Wrong controls of the review: a cause told in other words beside "no evidence of X".
WRONG_CONTROLS_OF_THE_REVIEW = [
    ("14", "orders got slow.", "A noisy neighbour on the node slowed order processing. No evidence of errors in the pods."),
    ("14", "orders got slow.", "The 4.18.1 release slowed order processing; no evidence of errors."),
    ("14", "orders got slow.", "The new image added a retry loop, so each order now takes longer. I found no evidence of errors."),
    ("14", "orders got slow.", "The database connection pool ran out, so orders queued up. There is no evidence of a network fault."),
    ("14", "orders got slow.", "Rolling back 4.18.1 will fix the slowdown. No errors were found in the pods."),
    ("14", "orders got slow.", "The root cause: a slow upstream. No evidence of pod errors."),
    ("13", "orders reportedly fail.", "Orders failed while thumbnailer restarted; roll it back. No evidence of other problems."),
    ("13", "orders reportedly fail.", "thumbnailer went down and orders failed with it. No errors now."),
    ("13", "orders reportedly fail.", "A memory leak in thumbnailer made it exit, and orders depend on it. No evidence of network problems."),
]

# Wrong reports the first scoring passes (it reads a ConfigMap's name beside "config" or "settings" as its change, and the
# cause with one guess beside it as right): the first scoring is kept as it is; the second fails them.
WRONG_REPORTS_THE_FIRST_PASSES = [
    ("21", "search down.", "StatefulSet search mounts the config search-indexes-2. The search pods were OOMKilled because the memory limit is too low.",
     "the object mentioned beside the symptom"),
    ("22", "API drops.", "shop-api reads its settings from shop-api-settings. Its pods are OOMKilled: raise the memory limit.",
     "the object mentioned beside the symptom"),
    ("12", "cart requests fail.", "The cause is either the change of the ConfigMap storefront-config or notifier's crash loop.", "the cause or a decoy"),
    ("12", "cart requests fail.", "Possible causes: the ConfigMap storefront-config was changed, notifier crashes, Deployment/shop-12/cart is broken.", "a list of guesses in a line"),
    ("12", "cart requests fail.", "Possible causes:\n- the ConfigMap storefront-config was changed\n- notifier crashes\n- Deployment/shop-12/cart has an old image",
     "a list of guesses"),
]

# One right report per shown incident, written from the case's NOTES.md ("What the AI has to notice"), with the decoys
# seen and set aside as an investigator writes them.
RIGHT_REPORTS = {
    "01": ("Checkouts in otel-demo fail because checkout cannot read the cart.",
           "Deployment/otel-demo/valkey-cart was scaled to 0 replicas, so its Service has no endpoints. This made cart fail with \"Can't access cart storage\", "
           "which caused checkout to fail at its first step, leading to errors at frontend. payment gets no calls; it is not failing."),
    "03": ("search, pricing and thumbnails in shop-03 slowed at the same moment.",
           "CPU 1 of Node/kubeast-b-control-plane is saturated by the Job monthly-report-run in reports, which has no CPU limit. The busy CPU made the three "
           "services slow together. search is the busiest of them, as before, and unchanged."),
    "04": ("storefront cannot reach catalog; its calls to reviews work.",
           "The NetworkPolicy allow-from-gateway selects every backend pod and admits only the gateway. It caused storefront's requests to catalog to time out; "
           "catalog is Running and Ready. The older allow-same-namespace still admits reviews."),
    "05": ("storefront's stock lookups fail.",
           "storefront was rolled out with dnsPolicy None and a dnsConfig whose search list lacks shop-05.svc.cluster.local, so the short name of the callee no "
           "longer resolves. CoreDNS resolves the full name of catalog. "
           f"{CALLEE} has ready endpoints."),
    "06": ("About a third of checkout's pricing calls get HTTP 500.",
           "A new ConfigMap pricing-settings-9b2c1 sets TAX_RATE_BP to 0.10, and the paused rollout of pricing runs two new pods with it. Those pods answer 500, "
           "which caused a third of checkout's calls to fail. The four old pods still read pricing-settings-7d4f8 and answer."),
    "07": ("Product pages are slow.",
           "frontend's calls to product-catalog got 700 ms of latency on the way: the client spans in frontend are slow while product-catalog's own server spans "
           "stay short. recommendation and checkout call product-catalog at normal speed, and astronomy-db answers in milliseconds."),
    "09": ("storefront's catalog calls take a second or more; nothing fails.",
           "Deployment/shop-09/catalog is throttled: its CPU limit of 25m leaves most CFS periods throttled, which made storefront's calls slow. recommender uses the "
           "most CPU but is under its limit. No evidence of a node problem."),
    "10": ("Product lists, recommendations and checkouts fail in otel-demo.",
           "astronomy-db is stuck: its queries wait on locks a schema change holds in an open transaction, and past the role's limit it refuses new connections, so "
           "everything behind it times out. product-catalog's queries wait on it, which caused frontend, checkout and recommendation to fail. accounting's inserts wait too."),
    "12": ("storefront's cart calls get HTTP 404.",
           "ConfigMap storefront-config was edited in place: cart_url changed from /api/v1/cart to /api/v2/cart. storefront re-reads it and calls a path cart never served. "
           "notifier has crash-looped with a DNS error since long before; it is a separate issue. No evidence of a DNS problem in storefront."),
    "16": ("storefront's payment calls failed for five minutes earlier; every call succeeds now.",
           "Deployment payments was scaled to 0 replicas and back to 1; while it was at 0 its Service had no endpoints, which caused storefront's payment calls to fail. "
           "There is no current problem, and no action is needed now."),
    "17": ("Order history and invoices got slow together.",
           "CronJob reminder-sender was pointed at the new ConfigMap reminder-sender-v2, which has no LAST_SENT_ID, so each run reads the whole reminders table. The reads "
           "fill orders-db's disk queue, which made storefront and invoices slow. feed-builder is the top CPU user and never calls orders-db."),
    "19": ("Every visit to www.shop.example gets 404.",
           "Service frontdoor's selector was switched from edge-legacy to edge, and the ConfigMap edge-routes has no entry for www.shop.example. This caused every request "
           "for that host to get 404. storefront is healthy and sees fewer requests."),
    "20": ("Every request to shop-web fails.",
           "shop-web was rolled out to release 2.4.0, which reads asset_host; production.conf in shop-web-config has no asset_host, so boot stops with a fatal error. "
           "preview-web runs the same release with the staging settings and is healthy; assets answers."),
    "21": ("storefront's searches fail.",
           "StatefulSet search was pointed at the new ConfigMap search-indexes-2, which adds a third index. With it the cluster has no room to lose a node, and the rolling "
           "update removed one, so the others were OOMKilled in turn. report-builder's queries are small and unchanged."),
    "22": ("shop-api drops out every few minutes.",
           "ConfigMap shop-api-settings raised WEB_WORKERS from 3 to 6. Six workers do not fit in the 64Mi limit, so each shop-api pod is OOMKilled about 90 s after its "
           "start. session-cache sits at 80 % of its limit as before and was never killed."),
}


def test_wrong_blocks_fail_under_both_scorings():
    for case, block, prose, why in WRONG_BLOCKS:
        first, now = both_block(case, block, prose)
        assert not first["pass"], ("first", case, why)
        assert not now["pass"], ("second", case, why, now)


def test_a_kind_the_notes_do_not_give_fails_under_both_scorings():
    for case, resource, kind in KINDS_THE_NOTES_DO_NOT_GIVE:
        first, now = both_block(case, blk((resource, kind)), "the change of the limit and the memory; dnsPolicy None")
        assert not first["pass"] and not now["pass"], (case, resource, kind)
        assert now["miss"] == "kind", (case, now)


def test_wrong_reports_fail_under_both_scorings():
    for case, summary, likely, why in WRONG_REPORTS:
        first, now = both_text(case, report(summary, likely))
        assert not first["pass"], ("first", case, why, first)
        assert not now["pass"], ("second", case, why, now)
        assert not second.score_text(report(summary, likely), TRUTHS[case], WORDS[case])["pass"], ("the words alone", case, why)


def test_the_reviews_wrong_reports_fail_under_the_second():
    left = [(case, likely[:70]) for case, summary, likely in WRONG_REPORTS_OF_THE_REVIEW + WRONG_CONTROLS_OF_THE_REVIEW
            if second.score_text(report(summary, likely), TRUTHS[case], RULES[case])["pass"]]
    assert left == []


def test_a_right_cause_in_a_list_of_guesses_fails_in_every_incident():
    """The guesses are named like the path's hops, as a list written to match them would be: the names a hop's accept
    would take, under kinds and prefixes of their own."""
    for case, truth in TRUTHS.items():
        if truth["control"]:
            continue
        right = [(as_answered(tc["resource"]), tc["kind"]) for tc in truth["causes"]]
        names = {as_answered(h["resource"]).rsplit("/", 1)[1]: (as_answered(h["resource"]).split("/") + ["x"])[1] for h in truth["path"]}
        guesses = [(f"{kind}/{ns}/{name}-x", said) for name, ns in names.items() for kind, said in
                   (("ConfigMap", "config_change"), ("Secret", "crash"), ("NetworkPolicy", "network_policy"), ("ServiceAccount", "image"))]
        first, now = both_block(case, blk(*right, *guesses))
        assert not first["pass"] and not now["pass"], (case, now)
        for hop in {as_answered(h["resource"]) for h in truth["path"]}:  # one hop under every kind is a list of guesses too
            if not any(rca._is_truth_cause(tc, hop) for tc in truth["causes"]):
                first, now = both_block(case, blk(*right, *[(hop, k) for k in ("crash", "oom", "dns", "image")]))
                assert not now["pass"] or first["pass"], (case, hop, now)  # also_ok is free in both
    shotgun = blk(("NetworkPolicy/shop-04/allow-from-gateway", "network_policy"), ("Deployment/shop-04/storefront", "crash"),
                  ("ConfigMap/shop-04/storefront-config", "config_change"), ("Pod/shop-04/storefront-1", "oom"),
                  ("NetworkPolicy/shop-04/storefront-egress", "network_policy"), ("Secret/shop-04/storefront-db", "dns"))
    first, now = both_block("04", shotgun)
    assert not first["pass"] and not now["pass"] and len(now["extras"]) == 4, now
    # a hop whose name is a pattern (a generated suffix) is one hop, not one for each name that fits
    first, now = both_block("06", blk(("ConfigMap/shop-06/pricing-settings-9b2c1", "config_change"),
                                      *[(f"ReplicaSet/shop-06/pricing-{x}", "image") for x in ("a1", "b2", "c3")]))
    assert not now["pass"], now


def test_the_cause_again_under_two_other_kinds_is_two_guesses():
    for case, truth in TRUTHS.items():
        for tc in truth["causes"]:
            right = [(as_answered(o["resource"]), o["kind"]) for o in truth["causes"]]
            wrong = [k for k in ("image", "quota", "storage", "dns", "crash") if k not in (tc["kind"], *(tc.get("accept_kinds") or []))][:2]
            now = both_block(case, blk(*right, *[(as_answered(tc["resource"]), k) for k in wrong]))[1]
            assert not now["pass"] and len(now["extras"]) == 2, (case, now)


def test_the_words_the_truth_uses_of_its_chain_are_no_guesses():
    words = ("ConfigMap search-indexes-2 adds a third index and the pods are OOMKilled, restart in a crash loop, hit the 48Mi limit and the node takes their memory down, "
             "so storefront's calls time out.")
    now = second.score_text(report("search down.", words), TRUTHS["21"], WORDS["21"])
    assert now["pass"], now
    assert {"oom", "crash"} & second._chain_kinds(TRUTHS["21"])


def test_the_reviews_right_reports_the_words_take():
    """20 of the 22 the review wrote; the other two (06 and 20 in other words) are misses the README owns to."""
    for case, likely in (
            ("12", "storefront-config's cart_url was edited from /api/v1/cart to /api/v2/cart, which cart does not serve. notifier's crash loop did not cause this."),
            ("12", "storefront-config's cart_url was edited to /api/v2/cart. The failures are caused by that path, not by notifier."),
            ("12", "storefront-config's cart_url was edited to /api/v2/cart. notifier has been crash looping for days, so it cannot have caused this."),
            ("12", "The ConfigMap storefront-config now points cart_url at /api/v2/cart, a path cart does not have."),
            ("01", "valkey-cart has no running pods: its Deployment was scaled to 0. The cart failures were caused by this, rather than by checkout or payment."),
            ("01", "valkey-cart was scaled down to zero. checkout fails as a result of cart failing."),
            ("10", "astronomy-db is blocked by a long transaction. product-catalog and checkout only fail as a consequence: product-catalog caused nothing. Queries wait."),
            ("10", "The root cause is in astronomy-db: an idle-in-transaction session holds a lock on the products table, so all queries hang."),
            ("09", "The CPU limit (25m) of Deployment/shop-09/catalog throttles it. The slowness was not caused by recommender."),
            ("09", "catalog is CPU-throttled (25m limit), which is what makes storefront wait. recommender, although the biggest CPU consumer, is not responsible."),
            ("16", "payments was scaled to 0 at 12:05 and back to 1 at 12:10. It has recovered; no fault remains."),
            ("16", "payments was scaled to 0 at 12:05 and back to 1 at 12:10. Everything is healthy now, nothing is wrong at present."),
            ("22", "WEB_WORKERS in shop-api-settings went from 3 to 6, so the six workers exceed the 64Mi memory limit and the pods are OOMKilled."),
            ("21", "search was switched to search-indexes-2, with one more index than before; the memory no longer fits, and pods are OOMKilled."),
            ("19", "edge-routes does not list www.shop.example, and frontdoor now selects edge."),
            ("17", "reminder-sender now reads all of the reminders table, because reminder-sender-v2 does not have LAST_SENT_ID. orders-db's disk is saturated by it."),
            ("04", "allow-from-gateway blocks storefront -> catalog since 12:00, only the gateway may call backends."),
            ("03", "The Job monthly-report-run uses a full CPU of the node kubeast-b-control-plane, so search, pricing and thumbnails compete for it."),
            ("07", "The network path from frontend to product-catalog has 700 ms of added latency; product-catalog itself answers quickly and astronomy-db is fine."),
            ("05", f"storefront's new pods have dnsPolicy: None and a search list without shop-05, so the short name {CALLED} is not found.")):
        now = second.score_text(report("It fails.", likely), TRUTHS[case], RULES[case])
        assert now["pass"], (case, likely[:60], now)
    for case, likely in (("13", "I found no fault. The thumbnailer restart did not cause any order failures."),
                         ("13", "There is no fault to explain. thumbnailer restarted at 12:00 (exit 143), which is unrelated to the orders."),
                         ("13", "No fault. orders answered every call. The thumbnailer restart had a benign cause: a rollout."),
                         ("14", "I see no fault. The rollout of orders to 4.18.1 completed without errors and the rollout isn't the cause of anything."),
                         ("14", "No degradation: p95 of orders was 40 ms before and 41 ms after the rollout. Nothing to fix.")):
        now = second.score_text(report("reported.", likely), TRUTHS[case], RULES[case])
        assert now["pass"] and now["outcome"] == "no_fault", (case, likely[:60], now)


def test_the_words_rules_one_by_one():
    def passes(case, likely, summary="It fails."):
        return second.score_text(report(summary, likely), TRUTHS[case], WORDS[case])["pass"]

    right = "ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart."
    # a blame taken back after its verb, and a passive is no blame of what stands before it
    assert passes("12", f"{right} notifier caused nothing.") and not passes("12", f"{right} notifier caused the failures.")
    assert passes("12", f"{right} notifier could have caused failures, yet no evidence supports that.")
    assert passes("12", f"{right} cart's alert was triggered by it.") and passes("12", f"{right} notifier was broken before.")
    for likely in ("Deployment/shop-13/thumbnailer keeps crashing and breaks the orders.", "Deployment/shop-13/thumbnailer triggered the failures."):
        assert second.score_text(report("orders reportedly fail.", likely), TRUTHS["13"], WORDS["13"])["outcome"] == "cause", likely
    now = second.score_text(report("orders reportedly fail.", "The probes of thumbnailer were triggered twice."), TRUTHS["13"], WORDS["13"])
    assert now["outcome"] == "unread", now
    # a sentence that goes on: what it says did not happen, or is only the type's name, says no kind
    assert passes("20", "All pods of Deployment shop-web exit at start. The failure began with the 2.4.0 rollout.")
    assert not passes("20", "All pods of Deployment shop-web exit at start. They fail without a rollout.")
    assert not passes("04", "allow-from-gateway is there. The network policy failed no check.")
    assert not passes("04", "The NetworkPolicy allow-from-gateway is there.") and passes("04", "The NetworkPolicy allow-from-gateway denies storefront's calls.")
    assert not passes("03", "The node kubeast-b-control-plane is the only one.") and passes("03", "The node kubeast-b-control-plane is saturated.")
    # a limit said not to be, a state said to be well, another thing's "down"
    assert not passes("09", "Deployment/shop-09/catalog is not held back by its CPU limit.")
    assert not passes("09", "The CPU limit of catalog is generous and throttling is zero.")
    assert passes("09", "Deployment/shop-09/catalog is held back by its CPU limit.")
    assert not passes("16", "payments lost its token, and the bank is down.") and passes("16", "payments lost its pods, so payments is down.")
    # a change of no account
    assert not passes("12", "ConfigMap storefront-config was changed, but only a comment.") and passes("12", "ConfigMap storefront-config was changed, but only for cart.")
    # the Likely cause must speak of the kind of a cause that stands only in the Summary
    summary = "cart requests fail. ConfigMap storefront-config was changed to /api/v2/cart."
    assert passes("12", "The change of the path in the config.", summary) and not passes("12", "cart is not answering.", summary)
    # a setting whose change the words could not find is no change
    assert not second.says("I could not find that storefront's dnsConfig changed.", TRUTHS["05"]["causes"][0], "dnsConfig")
    assert second.says("The rollout changed storefront's dnsConfig.", TRUTHS["05"]["causes"][0], "dnsConfig")


def test_the_guess_limits_of_the_words():
    right = "ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart"
    one = report("cart requests fail.", f"{right}. Deployment/shop-12/a caused errors.")
    two = report("cart requests fail.", f"{right}. Deployment/shop-12/a caused errors. Deployment/shop-12/b caused errors.")
    assert second.score_text(one, TRUTHS["12"], WORDS["12"])["pass"]
    now = second.score_text(two, TRUTHS["12"], WORDS["12"])
    assert not now["pass"] and now["miss"] == "guesses" and now["extras"] == 2, now
    kinds = report("cart requests fail.", f"{right}, and it crashed, was OOMKilled, hit its memory quota, has a bad image, a DNS error and a full disk.")
    now = second.score_text(kinds, TRUTHS["12"], WORDS["12"])
    assert not now["pass"] and now["miss"] == "guesses" and now["extras"] > 1, now


def test_a_cause_only_in_the_summary_needs_a_likely_cause_that_does_not_leave_it_open():
    summary = "cart requests fail. The ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart."
    assert second.score_text(report(summary, "The change of the cart URL in the config."), TRUTHS["12"], WORDS["12"])["pass"]
    for likely in ("A config change is possible, but the cause could not be determined.", "The cause is unknown; a change of the config cannot be excluded."):
        now = second.score_text(report(summary, likely), TRUTHS["12"], WORDS["12"])
        assert not now["pass"] and now["miss"] == "cause_not_named", (likely, now)


def test_a_denial_of_one_thing_is_no_controls_answer():
    for likely in ("No evidence of errors in the pods.", "I found no evidence of a network fault.", "No evidence that orders fail.", "No errors were found."):
        now = second.score_text(report("orders reportedly fail.", likely), TRUTHS["13"], RULES["13"])
        assert now["outcome"] == "unread" and not now["pass"], (likely, now)


def test_a_malformed_cause_is_a_cause_named_on_a_control():
    for cause in ("Deployment/shop-13/thumbnailer crash", {"name": "thumbnailer", "kind": "crash"}, {"resource": "", "kind": "crash"}):
        now = second.score_block({"no_fault": True, "causes": [cause]}, "ok", TRUTHS["13"], CALLS, "", RULES["13"])
        assert now["outcome"] == "cause" and not now["pass"], (cause, now)
    now = second.score_block({"no_fault": True, "causes": [{"name": "thumbnailer", "kind": "none"}]}, "ok", TRUTHS["13"], CALLS, "", RULES["13"])
    assert now["outcome"] == "no_fault"


def test_a_report_without_the_cases_facts_does_not_pass():
    """The facts are the case's expect (NOTES.md: the prose check asks for ...)."""
    words = "ConfigMap shop-api-settings was changed and rolled out, so the pods are OOMKilled."
    assert not second.score_text(report("API drops.", words), TRUTHS["22"], RULES["22"])["pass"]
    now = second.score_text(report("API drops.", words.replace("was changed", "raised WEB_WORKERS")), TRUTHS["22"], RULES["22"])
    assert now["pass"], now
    assert second.score_text(report("API drops.", words), TRUTHS["22"], {})["pass"]  # a case without facts asks none
    assert RULES["22"]["facts"] == CASES["22"][1]["expect"]


def test_wrong_reports_the_first_scoring_passes_fail_under_the_second():
    for case, summary, likely, why in WRONG_REPORTS_THE_FIRST_PASSES:
        first, now = both_text(case, report(summary, likely))
        assert first["pass"], ("the first scoring changed", case, why)
        assert not now["pass"], (case, why, now)
        assert not second.score_text(report(summary, likely), TRUTHS[case], WORDS[case])["pass"], ("the words alone", case, why)


def test_every_shown_incident_has_wrong_answers_here():
    incidents = {n for n, t in TRUTHS.items() if not t["control"]}
    assert {c for c, *_ in WRONG_BLOCKS} == set(TRUTHS)
    assert incidents - {"07"} <= {c for c, *_ in WRONG_REPORTS + WRONG_REPORTS_THE_FIRST_PASSES}
    assert set(RIGHT_REPORTS) == incidents


def test_wrong_answers_stay_wrong_written_as_one_report_without_headings():
    for case, summary, likely, why in WRONG_REPORTS:
        if "seen" in why or "left open" in why:  # these differ by where the words stand
            continue
        assert not second.score_text(f"{summary} {likely}", TRUTHS[case], WORDS[case])["pass"], (case, why)


# How a report says each kind of a cause (as test_ai_eval_cases.KIND_PHRASES), and how it blames an object.
KIND_PHRASES = {"crash": "keeps crashing", "oom": "is OOMKilled", "config_change": "was changed", "rollout": "was rolled out",
                "network_policy": "is a NetworkPolicy that blocks the calls", "dns": "has wrong DNS settings", "resource_limit": "is held back by its CPU limit",
                "node": "is saturated", "dependency_down": "had no endpoints", "dependency_slow": "is slow", "storage": "has a full volume"}
BLAMES = ("The cause is {0}.", "{0} is the culprit.", "The failures were caused by {0}.", "{0} caused the failures.", "The failures are due to {0}.",
          "The most likely explanation is {0}.", "This stems from {0}.")


def as_answered(resource):
    return re.sub(r"<[^>]*>", "7f9c4", resource).replace("*", "kind-worker")


def test_a_decoy_blamed_beside_the_right_cause_fails_in_any_of_these_words():
    for case, truth in TRUTHS.items():
        right = " ".join(f"{as_answered(tc['resource'])} {KIND_PHRASES[tc['kind']]}." for tc in truth["causes"])
        for x in truth["decoys"]:
            for blame in BLAMES:
                words = blame.format(as_answered(x["resource"]))
                for text in (report("It fails.", f"{right} {words}"), report(f"It fails. {right}", words)):
                    now = second.score_text(text, truth, WORDS[case])
                    assert not now["pass"] and now["outcome"] == "cause", (case, words, now)


def test_a_hop_of_the_path_alone_is_not_the_cause_under_any_kind():
    for case, truth in TRUTHS.items():
        kinds = {k for tc in truth["causes"] for k in (tc["kind"], *(tc.get("accept_kinds") or []))}
        for name in {as_answered(x) for x in [*(h["resource"] for h in truth["path"]), *truth["also_ok"]]}:
            if any(rca._is_truth_cause(tc, name) for tc in truth["causes"]):
                continue
            for kind in kinds:
                text = report("It fails.", f"The cause is {name}: it {KIND_PHRASES[kind]}.")
                assert not second.score_text(text, truth, WORDS[case])["pass"], (case, name, kind)
                assert not both_block(case, blk((name, kind)))[1]["pass"], (case, name, kind)


def test_a_cause_ruled_out_in_words_is_not_found():
    for case, truth in TRUTHS.items():
        for tc in truth["causes"]:
            name = as_answered(tc["resource"])
            for words in (f"{name} {KIND_PHRASES[tc['kind']]}, but it is unrelated.", f"{name} is not the cause.", f"{name} is unchanged and healthy."):
                assert not second.score_text(report("It fails.", words), truth, WORDS[case])["pass"], (case, words)


# --- right answers ---

def test_right_reports_pass_under_the_second_scoring():
    for case, (summary, likely) in RIGHT_REPORTS.items():
        now = second.score_text(report(summary, likely), TRUTHS[case], RULES[case])
        assert now["pass"] and now["outcome"] == "cause", (case, now)
        assert now["section"] == "summary+likely_cause"


def test_right_blocks_pass_under_both_scorings():
    for case, truth in TRUTHS.items():
        block = blk(no_fault=True) if truth["control"] else blk(*[(tc["resource"], tc["kind"]) for tc in truth["causes"]])
        first, now = both_block(case, block)
        assert first["pass"] and now["pass"], (case, now)
        assert now["outcome"] == ("no_fault" if truth["control"] else "cause")


def test_the_second_scoring_takes_every_block_the_first_takes():
    """The block rules only widen: a kind the NOTES give, and a hop of the truth's own path not counted as a guess."""
    for case, truth in TRUTHS.items():
        for tc in truth["causes"]:
            for kind in [tc["kind"], *tc.get("accept_kinds", [])]:
                causes = [(o["resource"], kind if o is tc else o["kind"]) for o in truth["causes"]]
                for extra in [None, *truth["also_ok"], "Deployment/elsewhere/other"]:
                    first, now = both_block(case, blk(*causes, *([(extra.replace("<hash>", "7f9c4").replace("<n>", "1"), "crash")] if extra else [])))
                    assert now["pass"] >= first["pass"], (case, kind, extra)


def test_the_summary_is_read_with_the_likely_cause():
    text = report("ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart, and cart answers 404 since.",
                  "The change of the cart URL in the config.")
    first, now = both_text("12", text)
    assert not first["pass"] and now["pass"], now
    only_next = "## Summary\ncart fails.\n\n## Likely cause\nUnclear.\n\n## Next steps\n1. roll back the change of the ConfigMap storefront-config\n"
    assert not second.score_text(only_next, TRUTHS["12"], RULES["12"])["pass"]  # the other headings are not read
    ruled_out = "## Summary\ncart fails.\n\n## Likely cause\nUnclear.\n\n## Ruled out\n- the ConfigMap storefront-config changed\n"
    assert not second.score_text(ruled_out, TRUTHS["12"], RULES["12"])["pass"]


def test_a_mention_of_a_decoy_is_not_blame_and_blame_is():
    ok = report("cart requests fail.", "ConfigMap storefront-config was edited: cart_url changed. notifier also crash-loops and Deployment/shop-12/cart returns 404.")
    assert second.score_text(ok, TRUTHS["12"], WORDS["12"])["pass"]
    blamed = report("cart requests fail.", "ConfigMap storefront-config was edited: cart_url changed. The failures are caused by notifier.")
    now = second.score_text(blamed, TRUTHS["12"], WORDS["12"])
    assert not now["pass"] and now["decoys_named"] == ["notifier"]


def test_a_denial_of_something_else_is_not_a_no_fault_answer():
    right = "ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart."
    for words in ("No evidence of a DNS problem.", "Found no errors in catalog.", "This is not a false alarm.", "No problems in the other workloads."):
        assert second.score_text(report("cart requests fail.", f"{right} {words}"), TRUTHS["12"], WORDS["12"])["pass"], words
    for words in ("No fault found.", "Nothing is wrong.", "This is a false alarm.", "No action is needed."):
        now = second.score_text(report("cart requests fail.", f"{right} {words}"), TRUTHS["12"], WORDS["12"])
        assert not now["pass"] and now["outcome"] == "no_fault", (words, now)


def test_the_present_of_a_past_outage_is_not_a_denial():
    right = "Deployment payments was scaled to 0 replicas for five minutes, so its Service had no endpoints."
    for words in ("There is no current problem.", "No action is needed now.", "No ongoing outage."):
        assert second.score_text(report("payments failed.", f"{right} {words}"), TRUTHS["16"], WORDS["16"])["pass"], words
    assert not second.score_text(report("payments failed.", f"{right} No fault found."), TRUTHS["16"], WORDS["16"])["pass"]
    # only a case whose fault was over: elsewhere the same words are the answer
    now = second.score_text(report("cart fails.", "ConfigMap storefront-config was edited: cart_url changed. There is no current problem."),
                            TRUTHS["12"], WORDS["12"])
    assert not now["pass"]


def test_a_chain_through_the_path_is_not_blame():
    right = "Deployment/otel-demo/valkey-cart was scaled to 0 replicas and has no endpoints"
    for rest in ("; this caused cart to fail, which caused checkout to fail.", ", which made cart and then checkout fail, leading to errors at frontend."):
        assert second.score_text(report("Orders fail.", right + rest), TRUTHS["01"], WORDS["01"])["pass"], rest
    for rest in (". The cause is checkout.", ". checkout is the culprit.", ". The errors are caused by checkout's new release."):
        assert not second.score_text(report("Orders fail.", right + rest), TRUTHS["01"], WORDS["01"])["pass"], rest


def test_because_blames_its_own_subject_only():
    right = "ConfigMap storefront-config was edited: cart_url changed to /api/v2/cart."
    for words in ("storefront fails because it sends cart a path cart never served.", "notifier is not reachable because its relay's name is missing.",
                  "The 404s are caused by a path mismatch on the cart calls.", "catalog still answers because its pods are older.",
                  "I guess, because the proxy that routes to cart is not visible.",
                  "It happens because it cannot read the address of cart, so its calls fail."):
        assert second.score_text(report("cart requests fail.", f"{right} {words}"), TRUTHS["12"], WORDS["12"])["pass"], words
    for words in ("storefront fails because cart broke.", "The 404s are due to a crash in notifier.", "It fails because the cart service returns a wrong path.",
                  "It fails because storefront depends on notifier, which keeps crashing.", "It fails because of the notifier crash loop."):
        now = second.score_text(report("cart requests fail.", f"{right} {words}"), TRUTHS["12"], WORDS["12"])
        assert not now["pass"] and now["miss"] == "decoy", (words, now)


def test_a_kind_written_beside_a_name_is_read_with_it():
    for words in ("The new `pricing` ReplicaSet was rolled out with TAX_RATE_BP 0.10.", "The rollout of Deployment `pricing` set TAX_RATE_BP to 0.10.",
                  "The new revision of the pricing deployment was rolled out with a bad value.", "The new `pricing` revision was rolled out with a bad value."):
        now = second.score_text(report("checkout sees 500s.", words), TRUTHS["06"], WORDS["06"])
        assert now["pass"], (words, now)
    for words in ("The pricing Deployment crashes.", "The pricing pods were rolled out.", "pricing was rolled out to every pod.", "The checkout Deployment was rolled out."):
        assert not second.score_text(report("checkout sees 500s.", words), TRUTHS["06"], WORDS["06"])["pass"], words


def test_a_sentence_that_names_nothing_goes_on_with_the_one_before():
    ok = report("Every request to shop-web fails.", "All pods of Deployment shop-web exit at start. The failure began with the 2.4.0 rollout.")
    assert second.score_text(ok, TRUTHS["20"], WORDS["20"])["pass"]
    ok = report("cart requests fail.", "storefront-config holds the v2 path. It was edited by hand after it was applied.")
    assert second.score_text(ok, TRUTHS["12"], WORDS["12"])["pass"]
    for likely in ("The shop-web pods crash on startup with a fatal error. I read the config and found nothing.",
                   "The shop-web pods crash on startup with a fatal error. No rollout happened.",
                   "The shop-web pods crash on startup. preview-web is older. A rollout began at noon.",  # goes on with preview-web
                   "The shop-web pods crash on startup with a fatal error in the config reader."):
        assert not second.score_text(report("shop-web down.", likely), TRUTHS["20"], WORDS["20"])["pass"], likely
    for likely in ("shop-api reads its settings from shop-api-settings. Its pods are OOMKilled since the last rollout.",
                   "shop-api reads shop-api-settings. The memory limit is too low."):
        assert not second.score_text(report("API drops.", likely), TRUTHS["22"], WORDS["22"])["pass"], likely


def test_blame_taken_back_is_no_blame():
    for likely in ("No cause is shown for the orders failures.", "The cause of the failures of orders is not known.", "I could not find a fault in orders that explains it.",
                   "The orders failures are not explained by a fault.", "I set the orders rollout aside as a likely cause; the cause is not known.",
                   "The thumbnailer restart is not due to orders; the cause is unknown.", "There is no explanation for the orders failures; the cause is not known.",
                   "This is a guess, not a confirmed cause: there is no metric of orders.", "Likely cause: none; every call works as expected."):
        now = second.score_text(report("orders reportedly fail.", likely), TRUTHS["13"], WORDS["13"])
        assert now["decoys_named"] == [] and now["outcome"] != "cause", (likely, now)


def test_kind_words_of_the_sentences_that_go_on_are_no_guesses():
    likely = ("Deployment/shop-09/catalog runs under a CPU limit of 25m. It was rolled out at noon. It has no volume. Its DNS lookups work. "
              "The node is idle.")
    now = second.score_text(report("storefront is slow.", likely), TRUTHS["09"], WORDS["09"])
    assert now["pass"] and now["extras"] == 0, now


# --- three outcomes ---

def test_a_controls_block_is_one_of_three_outcomes_by_its_own_cause_list():
    cases = [(blk(no_fault=True), "no_fault", True), (blk(("Deployment/shop-13/thumbnailer", "none"), no_fault=True), "no_fault", True),
             (blk(), "cannot_tell", False), ({"causes": [], "no_fault": None}, "cannot_tell", False),
             (blk(("Deployment/shop-13/thumbnailer", "crash")), "cause", False),
             (blk(("Deployment/shop-13/thumbnailer", "crash"), no_fault=True), "cause", False),
             (blk(("Deployment/elsewhere/any", "rollout")), "cause", False)]  # any named cause, a decoy or not
    for block, outcome, passes in cases:
        now = second.score_block(block, "ok", TRUTHS["13"], CALLS, "", RULES["13"])
        assert (now["outcome"], now["pass"]) == (outcome, passes), (block, now)
    none = second.score_block(None, "missing", TRUTHS["13"], CALLS, "", RULES["13"])
    assert none["outcome"] == "no_block" and not none["pass"]


def test_an_incidents_block_has_the_outcome_too():
    assert second.score_block(blk(no_fault=True), "ok", TRUTHS["12"], CALLS, "", None)["outcome"] == "no_fault"
    assert second.score_block(blk(), "ok", TRUTHS["12"], CALLS, "", None)["outcome"] == "cannot_tell"
    assert second.score_block(blk(("Deployment/shop-12/notifier", "crash")), "ok", TRUTHS["12"], CALLS, "", None)["outcome"] == "cause"


# --- the outcome the server keeps (features.alertInvestigation.verdict) ---

def stored_result(block, outcome=None, said=None, why=()):
    """A stored result as ai-service writes it, with a verdict when there is an outcome to hold."""
    out = {"version": 1, "status": "ok", "path": [], "ruled_out": [], **block,
           "causes": [{**c, "evidence": [{"call": n, "tool": "timeline"} for n in c["evidence"]]} for c in block["causes"]]}
    if outcome is not None:
        out["verdict"] = {"outcome": outcome, "said": said or outcome, "why": list(why), "looked_at": [], "checked_normal": [],
                          "not_looked_at": []}
    return out


def test_the_kept_outcome_is_read_from_a_stored_results_verdict_only():
    block = blk(("Deployment/shop-13/thumbnailer", "crash"))
    for said, outcome in (("cause_found", "cause"), ("no_fault", "no_fault"), ("cannot_tell", "cannot_tell")):
        assert second.kept_outcome(stored_result(block, said)) == outcome
    unread = stored_result(block, "cannot_tell")
    unread["verdict"].update(outcome=None, said=None)  # the block could not be read: the server keeps no outcome
    for result in (None, {}, [], "cause_found", stored_result(block), unread, {"verdict": "cause_found"}, {"verdict": {}},
                   {"verdict": {"outcome": "cause"}}, {"verdict": {"outcome": ["cause_found"]}}, {"outcome": "cause_found"}):
        assert second.kept_outcome(result) is None, result


def test_a_controls_kept_outcome_is_its_outcome():
    made_up = blk(("Deployment/shop-13/thumbnailer", "crash"))
    cases = [(made_up, "cause", "cause", "made_up"), (made_up, "cannot_tell", "cannot_tell", "cannot_tell"),  # the server does not hold it
             (blk(no_fault=True), "no_fault", "no_fault", None), (blk(no_fault=True), "cannot_tell", "cannot_tell", "cannot_tell"),
             (blk(), "cannot_tell", "cannot_tell", "cannot_tell")]
    for block, kept, outcome, miss in cases:
        now = second.score_block(block, "ok", TRUTHS["13"], CALLS, "", RULES["13"], kept)
        assert (now["outcome"], now["pass"], now["miss"]) == (outcome, outcome == "no_fault", miss), (block, kept, now)
        own = second.score_block(block, "ok", TRUTHS["13"], CALLS, "", RULES["13"])
        assert now["block_outcome"] == own["outcome"] and "block_outcome" not in own  # what the block says by itself stays readable
    assert second.score_block(made_up, "ok", TRUTHS["13"], CALLS, "", RULES["13"])["miss"] == "made_up"  # without one: by the block
    # a kept no_fault beside a cause the block names is no right answer on a control, whatever the cause's shape
    for block in (made_up, {"no_fault": True, "causes": ["checkout"]}):
        now = second.score_block(block, "ok", TRUTHS["13"], CALLS, "", RULES["13"], "no_fault")
        assert (now["outcome"], now["pass"], now["miss"]) == ("cause", False, "made_up"), now


def test_an_incident_passes_only_with_a_kept_cause():
    right = blk(("ConfigMap/shop-12/storefront-config", "config_change"))
    for kept, passes, miss in (("cause", True, None), ("cannot_tell", False, "cannot_tell"), ("no_fault", False, "no_fault")):
        now = second.score_block(right, "ok", TRUTHS["12"], CALLS, "", RULES["12"], kept)
        assert (now["outcome"], now["pass"], now["miss"]) == (kept, passes, miss), now
    assert second.score_block(right, "ok", TRUTHS["12"], CALLS, "", RULES["12"])["pass"]  # without one, as before
    wrong = blk(("Deployment/shop-12/notifier", "crash"))
    now = second.score_block(wrong, "ok", TRUTHS["12"], CALLS, "", RULES["12"], "cause")
    assert not now["pass"] and now["outcome"] == "cause" and now["miss"] == "cause_not_named"  # a kept cause is not the right one


def test_a_row_is_classified_by_the_outcome_the_server_keeps_and_read_again_with_it():
    out = Path(tempfile.mkdtemp(prefix="ai-eval-kept-"))
    (out / "1-truth").mkdir()
    rows = []
    # (case, block, the server's outcome, what the report said, the row's outcome, whether it passes)
    wanted = []
    for case, block, kept, said, outcome, passes in (
            ("13", blk(("Deployment/shop-13/thumbnailer", "crash")), "cannot_tell", "cause_found", "cannot_tell", False),
            ("13", blk(no_fault=True), "no_fault", "no_fault", "no_fault", True),
            ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change")), "cause_found", "cause_found", "cause", True),
            ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change")), "cannot_tell", "cause_found", "cannot_tell", False),
            ("12", blk(("ConfigMap/shop-12/storefront-config", "config_change")), None, None, "cause", True)):  # the switch off
        stored = stored_result(block, kept, said, ["no_symptom"] if kept == "cannot_tell" else [])
        truth = TRUTHS[case]
        (out / "1-truth" / f"{truth['id']}.json").write_text(json.dumps(truth))
        words = report(*RIGHT_REPORTS["12"])
        read, status = rca.block_of_result(stored)
        second_row = second.score_report(words, read, status, truth, CALLS, None, RULES[case], second.kept_outcome(stored))
        assert (second_row["by"], second_row["outcome"], second_row["pass"]) == ("block", outcome, passes), second_row
        assert second_row["text"] == second.score_text(words, truth, RULES[case])  # the words are not read for the outcome
        rows.append({"id": truth["id"], "hidden": False, "form": "alert", "answer": words, "calls": CALLS, "error": None,
                     "pass": rca.score_text(words, truth)["pass"], "text": rca.score_text(words, truth), "stored_result": stored})
        wanted.append(second_row)
    path = out / "1-m.json"
    path.write_text(json.dumps(rows))
    again, differs = second.rescore(path, HARD)
    assert [r["second"] for r in again] == wanted and differs == 0


def test_the_servers_note_under_a_report_leaves_the_words_scoring_as_it_is():
    note = "\n\n---\n\nOutcome kept by the server: cannot tell. What the report concludes does not hold.\n- no call shows any of its causes"
    words = report(*RIGHT_REPORTS["12"])
    for scored in (rca.score_text, lambda text, truth: second.score_text(text, truth, RULES["12"])):
        assert scored(words + note, TRUTHS["12"]) == scored(words, TRUTHS["12"])


def test_a_controls_report_in_words_is_one_of_three_outcomes():
    cases = [("No fault found: every call works as expected.", "no_fault"),
             ("No evidence that orders fail; the thumbnailer restart is unrelated.", "unread"),  # a denial of one thing
             ("No fault: no evidence that orders fail, and the thumbnailer restart is unrelated.", "no_fault"),
             ("Nothing is wrong. thumbnailer restarted once (exit 143) and runs normally.", "no_fault"),
             ("The cause could not be determined from the data; thumbnailer restarted once.", "cannot_tell"),
             ("There is not enough evidence to say why; the cause remains unknown.", "cannot_tell"),
             ("The thumbnailer crash caused the order failures.", "cause"),
             ("The reported failures were most likely caused by the thumbnailer restart.", "cause"),
             ("The cause is unknown, but the thumbnailer restart may have led to the failures.", "cause"),
             ("The likely explanation is the start-up probes that were refused at first.", "cause"),  # a guess that names no object
             ("thumbnailer restarted once and finished.", "unread")]
    for likely, outcome in cases:
        now = second.score_text(report("orders reportedly fail.", likely), TRUTHS["13"], RULES["13"])
        assert now["outcome"] == outcome and now["pass"] == (outcome == "no_fault"), (likely, now)


def test_an_incident_left_open_is_not_a_cause_answer():
    now = second.score_text(report("cart requests fail.", "The cause could not be determined."), TRUTHS["12"], RULES["12"])
    assert now["outcome"] == "cannot_tell" and not now["pass"]
    now = second.score_text(report("cart requests fail.", "No fault found."), TRUTHS["12"], RULES["12"])
    assert now["outcome"] == "no_fault" and not now["pass"]


# --- the kinds a case takes besides its truth's: next to the truth, from its NOTES ---

def test_a_case_takes_more_kinds_only_as_its_notes_say():
    with_rules = {n for n, r in RULES.items() if r.get("accept_kinds")}
    assert with_rules == {"05"}
    for n in with_rules:
        d = CASES[n][0]
        truth, notes = json.loads((d / "truth.json").read_text()), (d / "NOTES.md").read_text()
        assert second.check_rules(second.read_rules(d), truth, notes) == [], n
        for entry in RULES[n]["accept_kinds"]:
            assert entry["notes"] in notes and all(f"`{k}`" in entry["notes"] for k in entry["kinds"]), n


def test_rules_the_notes_do_not_carry_are_a_problem():
    d = CASES["05"][0]
    truth, notes = json.loads((d / "truth.json").read_text()), (d / "NOTES.md").read_text()
    good = RULES["05"]["accept_kinds"][0]
    bad = [({"accept_kinds": [{**good, "notes": "`crash` counts too"}]}, "not in NOTES.md"),
           ({"accept_kinds": [{**good, "kinds": ["crash"]}]}, "does not name"),
           ({"accept_kinds": [{**good, "kinds": ["typo"]}]}, "unknown kind"),
           ({"accept_kinds": [{**good, "cause": f"Deployment/shop-05/{CALLED}"}]}, "no cause"),
           ({"accept_kinds": [{**good, "needs": "("}]}, "needs"),
           ({"accept_kinds": [{k: v for k, v in good.items() if k != "notes"}]}, "notes"),
           ({"accept_kinds": [{**good, "notes": "`rollout` or `config_change` alone does not count: the case is about recognising DNS."}]}, "does not say"),
           ({"accept_kinds": [{**good, "notes": "The second scoring takes neither `rollout` nor `config_change`."}]}, "does not say"),
           ({"accept_kinds": [{**good, "notes": "`rollout` and `config_change` are seen."}]}, "does not say"),
           ({"accept_kind": []}, "unknown field"), ([], "not an object")]
    notes += "\nThe second scoring takes neither `rollout` nor `config_change`.\n`rollout` and `config_change` are seen.\n"
    for rules, why in bad:
        problems = second.check_rules(rules, truth, notes)
        assert problems and any(why in p for p in problems), (why, problems)
    root = Path(tempfile.mkdtemp(prefix="ai-eval-rules-"))
    for name, hidden in (("90_shown", False), ("91_kept", True)):
        (root / name).mkdir()
        case = {**json.loads((d / "case.json").read_text()), "id": name, "hidden": hidden}
        (root / name / "case.json").write_text(json.dumps(case))
        (root / name / "truth.json").write_text(json.dumps({**truth, "id": name}))
        (root / name / "NOTES.md").write_text("nothing")
        (root / name / "scoring.json").write_text(json.dumps(second.read_rules(d)))
    _, problems = AI_EVAL.load_cases(root, [], True)
    shown, kept = [p for p in problems if p.startswith("90_shown")], [p for p in problems if p.startswith("91_kept")]
    assert len(shown) == 1 and "scoring.json" in shown[0] and "NOTES.md" in shown[0], problems
    assert len(kept) == 1 and "storefront" not in kept[0] and "config_change" not in kept[0], problems  # a hidden case's line says nothing of it


def test_05_takes_the_change_only_when_the_answer_names_the_dns_settings():
    for prose, passes in (("storefront's pods run with dnsPolicy None and a dnsConfig without shop-05.", True),
                          ("storefront의 dnsConfig 검색 도메인에 shop-05가 빠졌습니다.", True),
                          ("storefront's search list lacks shop-05.svc.cluster.local", True),
                          ("The rollout of storefront changed its dnsPolicy.", True),
                          ("the search list lacks shop-05.svc.cluster.local", False),  # of whom
                          ("storefront was changed and its lookups fail", False),
                          ("storefront's dnsPolicy is unchanged; the new release broke it", False),
                          ("storefront's dnsConfig is set", False)):
        for kind in ("config_change", "rollout"):
            first, now = both_block("05", blk(("Deployment/shop-05/storefront", kind)), prose)
            assert not first["pass"] and now["pass"] == passes, (prose, kind, now)


def test_a_namespace_suffix_moves_the_rules_with_the_case():
    d, c = CASES["05"]
    root = Path(tempfile.mkdtemp(prefix="ai-eval-second-suffix-"))
    moved_dir, _ = AI_EVAL.with_suffix(d, c, "zz9", root)
    moved = rca.fill_placeholders(json.loads((moved_dir / "truth.json").read_text()), MARKS)
    block = blk(("Deployment/shop-05-zz9/storefront", "rollout"))
    for rules in (second.load_rules(moved_dir), RULES["05"]):  # the copied folder's, and the folder's own for a saved run
        assert second.score_block(block, "ok", moved, CALLS, "storefront's dnsConfig lacks its namespace", rules)["pass"]


def test_a_path_hop_is_not_a_guess_but_a_decoy_hop_is():
    right = ("ConfigMap/shop-12/storefront-config", "config_change")
    others = [("Deployment/shop-12/storefront", "dependency_down"), ("Deployment/shop-12/storefront", "config_change")]
    first, now = both_block("12", blk(right, *others))
    assert not first["pass"] and now["pass"], now  # storefront is the truth's own via and symptom, not a decoy
    assert not both_block("12", blk(right, ("Deployment/shop-12/cart", "crash")))[1]["pass"]  # a hop that is a decoy
    assert not both_block("12", blk(right, ("Deployment/x/a", "crash"), ("Deployment/x/b", "crash")))[1]["pass"]


# --- the number of the rules ---

# Made-up truths, so a change of a case does not change what is pinned: a ConfigMap, a NetworkPolicy, a node, a workload
# whose fault is over, the two ends of one call, a workload with a kind of its own rules, a control.
def _hop(resource, role, required=True, accept=()):
    return {"resource": resource, "role": role, "required": required, "accept": list(accept)}


PINNED = {
    "config": {"causes": [{"resource": "ConfigMap/shop-x/settings-b", "kind": "config_change", "accept_resources": ["settings-b"], "accept_kinds": ["rollout"]}],
               "path": [_hop("ConfigMap/shop-x/settings-b", "cause"), _hop("Deployment/shop-x/api", "via", False), _hop("Deployment/shop-x/web", "symptom")],
               "also_ok": ["Deployment/shop-x/api"], "decoys": ["Deployment/shop-x/web", "Deployment/shop-x/noisy", "Node/*"]},
    "policy": {"causes": [{"resource": "NetworkPolicy/shop-x/allow-a", "kind": "network_policy", "accept_resources": ["allow-a"], "accept_kinds": []}],
               "path": [_hop("NetworkPolicy/shop-x/allow-a", "cause"), _hop("Deployment/shop-x/api", "via", False, ["api"]), _hop("Deployment/shop-x/web", "symptom")],
               "also_ok": [], "decoys": ["Deployment/shop-x/api", "NetworkPolicy/shop-x/allow-old"]},
    "node": {"causes": [{"resource": "Node/n1", "kind": "node", "accept_resources": ["batch-job"], "accept_kinds": ["resource_limit"]}],
             "path": [_hop("Node/n1", "cause"), _hop("Deployment/shop-x/web", "symptom")], "also_ok": [], "decoys": ["Deployment/shop-x/api"]},
    "over": {"causes": [{"resource": "Deployment/shop-x/pay", "kind": "dependency_down", "accept_resources": ["^pay"], "accept_kinds": ["config_change"]}],
             "path": [_hop("Deployment/shop-x/pay", "cause"), _hop("Deployment/shop-x/web", "symptom")], "also_ok": ["Service/shop-x/pay"],
             "decoys": ["Deployment/shop-x/web"], "fault_end": "2026-01-01T00:10:00Z"},
    "segment": {"causes": [{"resource": "Deployment/shop-x/web", "kind": "dependency_slow", "accept_resources": ["web.*api"], "accept_kinds": []},
                           {"resource": "Deployment/shop-x/api", "kind": "dependency_slow", "accept_resources": ["web.*api"], "accept_kinds": []}],
                "path": [_hop("Deployment/shop-x/api", "cause"), _hop("Deployment/shop-x/web", "symptom")], "also_ok": [], "decoys": ["Deployment/shop-x/noisy"]},
    "kinds": {"causes": [{"resource": "Deployment/shop-x/web", "kind": "dns", "accept_resources": ["^web"], "accept_kinds": []}],
              "path": [_hop("Deployment/shop-x/web", "cause"), _hop("Service/shop-x/stock", "symptom", False)], "also_ok": [],
              "decoys": ["Service/shop-x/stock", "Deployment/kube-system/coredns"]},
    "control": {"causes": [], "path": [], "also_ok": [], "decoys": ["Deployment/shop-x/web", "ReplicaSet/shop-x/web-<new>"], "control": True},
}
PINNED_RULES = {"kinds": {"accept_kinds": [{"cause": "Deployment/shop-x/web", "kinds": ["config_change", "rollout"], "needs": "dns ?config|search list",
                                            "notes": "takes `config_change` or `rollout`"}], "facts": [["dns"]]},
                "config": {"facts": [["settings-b"], ["changed", "edited", "lacks"]]}}
PINNED_WORDS = ("{0} was changed.", "{0} {1}.", "{0} {1}, which caused the failures.", "The cause is {0}: it {1}.", "The failures are due to {0}.", "{0} is unrelated and healthy.",
                "No evidence that {0} {1}.", "The cause could not be determined; {0} {1}.", "No fault found: {0} {1}.", "The failures are caused by {0} or settings-b.",
                "Possible causes:\n- {0} {1}\n- settings-b was changed", "{0} {1}. No fault remains. It was edited by hand.", "{0} lacks the key and {1}, but only a comment.",
                "web's dnsConfig lacks shop-x, and {0} {1}.")


def what_the_rules_say() -> str:
    """The sha256 of what the rules say of a fixed set of blocks, answers and reports: each one's pass, outcome and miss."""
    said = []

    def keep(*key_and_result):
        *key, r = key_and_result
        said.append([*key, r.get("pass"), r.get("outcome"), r.get("miss"), r.get("by")])

    for name, made in PINNED.items():
        truth = {"id": name, "control": False, "fault_start": "2026-01-01T00:00:00Z", "fault_end": None, "symptom": "web fails and is slow", **made,
                 "decoys": [{"resource": d, "why": "x"} for d in made["decoys"]]}
        rules = PINNED_RULES.get(name, {})
        objects = sorted({as_answered(x) for x in [*(c["resource"] for c in truth["causes"]), *(h["resource"] for h in truth["path"]), *made["also_ok"], *made["decoys"],
                                                   "Deployment/elsewhere/other", "web-x"]})
        right = [(as_answered(c["resource"]), c["kind"]) for c in truth["causes"]]
        blocks = [blk(), blk(no_fault=True), blk(*right), blk(*right, no_fault=True), {"no_fault": False, "causes": ["words only"]}]
        blocks += [blk((o, k)) for o in objects for k in rca.KINDS] + [blk(*right, (o, "crash")) for o in objects]
        blocks += [blk(*right, *[(o, k) for k in kinds]) for o in objects for kinds in (("crash", "oom"), ("crash", "oom", "dns"))] + [blk(*right, *[(f"Secret/shop-x/{o.rsplit('/', 1)[-1]}-x", "dns") for o in objects])]
        for i, block in enumerate(blocks):
            for prose in ("", "web's dnsConfig lacks the namespace.", "The dnsConfig lacks the namespace.", "web was changed. Its dnsConfig is fine.", "web's dnsConfig is set."):
                keep(name, "block", i, second.score_block(block, "ok", truth, CALLS, prose, rules))
            for kept in ("cause", "no_fault", "cannot_tell"):
                keep(name, "kept", i, second.score_block(block, "ok", truth, CALLS, "", rules, kept))
        keep(name, "no block", second.score_block(None, "missing", truth, CALLS, "", rules))
        phrases = list(KIND_PHRASES.values())
        for n, o in enumerate(objects):
            for j, words in enumerate(PINNED_WORDS):
                for phrase in (phrases[(n + j) % len(phrases)], phrases[(n + j + 5) % len(phrases)]):
                    said_words = words.format(o.rsplit("/", 1)[-1], phrase)
                    keep(name, "words", second.score_text(report("web fails.", said_words), truth, rules))
                    keep(name, "summary", second.score_text(report(said_words, "A change of the config."), truth, rules))
        # an answer without a block: a chat's is a miss, an investigation's has no pass, in both arms and after an error
        fence = "words\n\n```rca\n" + json.dumps(blk(*right)) + "\n```\n"
        for error in (None, "timed out"):
            for answer in ("", "settings-b was changed.", fence, "words\n\n```rca\n{\n```\n"):
                keep(name, "chat", second.score_answer(answer, truth, CALLS, error, rules))
            for status in ("missing", "invalid", "cut"):
                keep(name, "alert", status, second.score_report("settings-b was changed.", None, status, truth, CALLS, error, rules))
            keep(name, "alert", "ok", second.score_report("settings-b was changed.", blk(*right), "ok", truth, CALLS, error, rules))
    return hashlib.sha256(json.dumps(said, sort_keys=True).encode()).hexdigest()


# What each number of the rules says. A change of the rules that changes it goes up one number and adds its line here; a
# line already here is not changed, since saved answers were scored under it.
THE_RULES_SAY = {3: "71df489db2bf3dc5b070c293007298f3f90ca4a4a103869f4965bca0f3dcebae"}


def test_the_number_of_the_rules_goes_up_when_what_they_say_changes():
    assert second.RULES == 3 and set(THE_RULES_SAY) == set(range(3, second.RULES + 1))
    assert what_the_rules_say() == THE_RULES_SAY[second.RULES]


def test_an_answer_without_a_block_under_rules_3():
    """What the number 3 says of an answer without a block (README "An answer without a block"): a chat's is a miss; an
    investigation's has no pass, whatever the arm, whether it timed out or left its block out, and is counted as a run
    without a block."""
    truth, words = TRUTHS["12"], report(*RIGHT_REPORTS["12"])
    for answer in ("", "The ConfigMap storefront-config was changed.", "x\n\n```rca\n{\n```\n"):
        s = second.score_answer(answer, truth, CALLS, None, RULES["12"])
        assert (s["by"], s["pass"], s["outcome"]) == ("block", False, "no_block"), answer
    s = second.score_answer("", truth, CALLS, "request failed: timed out", RULES["12"])
    assert (s["by"], s["pass"], s["outcome"]) == ("block", False, "error")
    for status in ("missing", "invalid", "cut"):  # off has no block at all ("missing"); on may lose it in three ways
        s = second.score_report(words, None, status, truth, CALLS, None, RULES["12"])
        assert (s["by"], s["pass"], s["outcome"]) == ("text", None, "cause"), status
    s = second.score_report("", None, "missing", truth, CALLS, "investigation failed: timed out after 300s", RULES["12"])
    assert (s["by"], s["pass"], s["outcome"]) == ("text", None, "error")
    rows = [{"id": "12_x", "pass": False, "second": s}, {"id": "12_x", "pass": True, "second": second.score_report(
        words, blk(("ConfigMap/shop-12/storefront-config", "config_change")), "ok", truth, CALLS, None, RULES["12"])}]
    c = second.counts(rows)
    assert (c["runs"], c["blocks"], c["second"], c["other"]) == (2, 1, 1, 1)  # out of 블록 있는 회, not of 회


# --- what a run records ---

def test_score_answer_reads_the_block_and_score_report_the_words_without_one():
    truth = TRUTHS["12"]
    answer = "cart_url changed.\n\n```rca\n" + json.dumps(blk(("ConfigMap/shop-12/storefront-config", "config_change"))) + "\n```\n"
    s = second.score_answer(answer, truth, CALLS, None, RULES["12"])
    assert s["rules"] == 3 and s["by"] == "block" and s["pass"] and s["outcome"] == "cause"
    s = second.score_answer(answer, truth, CALLS, "HTTP 502", RULES["12"])
    assert not s["pass"] and s["outcome"] == "error"
    s = second.score_answer("The ConfigMap storefront-config was changed.", truth, CALLS, None, RULES["12"])
    assert not s["pass"] and s["outcome"] == "no_block"  # a chat answer is asked for its block

    words = report(*RIGHT_REPORTS["12"])
    s = second.score_report(words, None, "missing", truth, CALLS, None, RULES["12"])
    assert s["by"] == "text" and s["pass"] is None and s["text"]["pass"] and s["outcome"] == "cause" and "block" not in s  # words decide nothing
    wrong = blk(("Deployment/shop-12/notifier", "crash"))
    s = second.score_report(words, wrong, "ok", truth, CALLS, None, RULES["12"])
    assert s["by"] == "block" and s["pass"] is False and s["text"]["pass"]  # the words are reported beside it
    s = second.score_report(words, None, "invalid", truth, CALLS, "investigation failed", RULES["12"])
    assert s["pass"] is None and s["outcome"] == "error"
    assert second.score_report(words, wrong, "ok", truth, CALLS, "investigation failed", RULES["12"])["pass"] is False


def test_the_first_scoring_does_not_read_the_rules_file():
    source = (HERE / "ai_eval_rca.py").read_text()
    assert "scoring.json" not in source and "ai_eval_second" not in source


# --- the tables ---

def row(cid, passed, outcome, **extra):
    base = {"id": cid, "title": "t", "form": "question", "ask_after": 300, "run": 1, "missing": [], "forbidden": [], "tools_missing": [],
            "calls": [], "tokens": 0, "seconds": 1.0, "error": None, "model": "m", "pass": passed,
            "second": {"rules": second.RULES, "by": "block", "control": False, "pass": outcome == "cause", "outcome": outcome}}
    control = extra.pop("control", False)
    base["second"].update(control=control, **({"pass": outcome == "no_fault"} if control else {}))
    return {**base, **extra}


def test_incidents_and_controls_are_in_separate_tables():
    rows = [row("04_a", True, "cause"), row("04_a", False, "cause", run=2), row("12_b", False, "cannot_tell"),
            row("13_c", False, "cause", control=True), row("13_c", True, "no_fault", control=True), row("14_d", False, "cannot_tell", control=True)]
    text = AI_EVAL.table(rows)
    incidents, controls = text.split("대조군(새 채점)")
    assert "사고(새 채점)" in incidents and "04_a | 2 | 1 | 2 | 2 | - |" in incidents and "12_b | 1 | 0 | 1 | 0 | - |" in incidents
    assert "13_c" not in incidents.split("사고(새 채점)")[1]
    assert "13_c | 2 | 1 | 2 | 1 | 1 | 0 |" in controls and "14_d | 1 | 0 | 1 | 0 | 0 | 1 |" in controls and "04_a" not in controls
    assert "정답 2/6" in text  # the first scoring's total line is as it was
    words = row("04_a", True, "cause")  # a run without a block: no count of the second scoring's, its words only reported
    words["second"].update(by="text", **{"pass": None}, text={"pass": True})
    table = AI_EVAL.table([words, words]).split("사고(새 채점)")[1]
    assert "04_a | 2 | 2 | 0 | - | 2 | 2 | 0 | 0 | 0 |" in table, table


def test_rows_without_the_second_scoring_get_no_second_table():
    plain = row("04_a", True, "cause")
    del plain["second"]
    assert "새 채점" not in AI_EVAL.table([plain, {"id": "05_x", "setup_error": "boom"}])


def test_the_second_tables_give_no_hidden_cases_score():
    shown, kept = row("04_a", True, "cause"), row("92_h", False, "cause", hidden=True)
    control = row("93_h", True, "no_fault", hidden=True, control=True)
    text = AI_EVAL.table([shown, kept, control])
    assert "92_h" not in text and "93_h" not in text
    line = next(x for x in text.splitlines() if x.startswith("숨김 사례 2개"))
    assert "정답 1/2" in line and "새 채점 정답 2/2" in line
    table = [x for x in text.split("사고(새 채점)")[1].splitlines() if x.startswith("|")]
    assert [x.split(" | ")[1] for x in table[2:]] == ["1", "1"], table  # runs  # 04_a and the sum: the hidden rows are not in it
    assert "대조군(새 채점)" not in text  # a hidden control alone makes no control table
    for rows in ([shown, kept], [shown, kept, dict(kept, run=2)]):  # one hidden case: no total of it in either scoring
        text = AI_EVAL.table(rows)
        assert "새 채점 정답" not in text, text
    assert "새 채점 정답" not in AI_EVAL.table([shown, kept, control], final=False)
    words = dict(kept, second={**kept["second"], "by": "text", "pass": None, "text": {"pass": True}})
    assert "새 채점 정답" not in AI_EVAL.table([shown, words, control])  # words decide nothing, for a hidden case too
    assert "새 채점" not in AI_EVAL.table([kept, control])


# --- scoring a saved report again ---

def test_a_saved_report_is_scored_again_without_its_hidden_rows():
    out = Path(tempfile.mkdtemp(prefix="ai-eval-rescore-"))
    truth = TRUTHS["12"]
    (out / "1-truth").mkdir()
    (out / "1-truth" / "12_decoy_quiet_config.json").write_text(json.dumps(truth))
    answer = "x\n\n```rca\n" + json.dumps(blk(("ConfigMap/shop-12/storefront-config", "config_change"))) + "\n```\n"
    chat = {"id": truth["id"], "hidden": False, "form": "question", "answer": answer, "calls": CALLS, "error": None, "pass": True,
            "rca": rca.score_rca(answer, truth, CALLS)}
    alert = {"id": truth["id"], "hidden": False, "form": "alert", "answer": report(*RIGHT_REPORTS["12"]), "calls": CALLS, "error": None,
             "pass": rca.score_text(report(*RIGHT_REPORTS["12"]), truth)["pass"], "text": rca.score_text(report(*RIGHT_REPORTS["12"]), truth)}
    kept = {"id": "92_h", "hidden": True, "form": "question", "answer": answer, "calls": CALLS, "error": None, "pass": False}
    (out / "1-truth" / "92_h.json").write_text(json.dumps(truth))  # its truth copy is there: only `hidden` keeps the row out
    path = out / "1-m.json"
    path.write_text(json.dumps([chat, alert, {**kept, "rca": chat["rca"]}, {"id": "12_decoy_quiet_config", "hidden": False, "setup_error": "x"}]))
    rows, differs = second.rescore(path, HARD)
    assert [r["second"]["pass"] for r in rows] == [True, None] and rows[1]["second"]["text"]["pass"]
    assert differs == 0 and all(r["id"] != "92_h" for r in rows)
    chat["pass"], chat["rca"]["pass"] = False, False  # a stored value the first scoring does not give
    path.write_text(json.dumps([chat, alert]))
    assert second.rescore(path, HARD)[1] == 1
    screen = io.StringIO()
    with redirect_stdout(screen):
        code = second.main(["score", str(path), "--cases", str(HARD)])
    assert code == 1 and "92_h" not in screen.getvalue() and "12_decoy_quiet_config" in screen.getvalue()


def test_a_saved_row_with_its_stored_block_is_scored_by_the_block():
    out = Path(tempfile.mkdtemp(prefix="ai-eval-rescore-block-"))
    truth = TRUTHS["12"]
    (out / "1-truth").mkdir()
    (out / "1-truth" / "12_decoy_quiet_config.json").write_text(json.dumps(truth))
    stored = {"version": 1, "status": "ok", "no_fault": False, "path": [], "ruled_out": [],
              "causes": [{"resource": "Deployment/shop-12/notifier", "kind": "crash", "started_at": None, "evidence": [{"call": 1, "tool": "timeline"}]}]}
    words = report(*RIGHT_REPORTS["12"])
    r = {"id": truth["id"], "hidden": False, "form": "alert", "answer": words, "calls": CALLS, "error": None,
         "pass": rca.score_text(words, truth)["pass"], "text": rca.score_text(words, truth), "stored_result": stored}
    path = out / "1-m.json"
    path.write_text(json.dumps([r]))
    rows, _ = second.rescore(path, HARD)
    assert rows[0]["second"]["by"] == "block" and not rows[0]["second"]["pass"] and rows[0]["second"]["text"]["pass"]
    # an older alert row with a scored block but not the block itself: the words, and said so
    older = {k: v for k, v in r.items() if k != "stored_result"}
    older["rca"] = rca.score_block(*rca.block_of_result(stored), truth, CALLS)
    path.write_text(json.dumps([older]))
    rows, _ = second.rescore(path, HARD)
    assert rows[0]["second"]["by"] == "text" and rows[0]["second"]["block_not_saved"] is True


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as e:  # an error the scorer raises fails the test it came from, not the whole run
            failed += 1
            print(f"FAIL {name}: {e!r}")
    print(f"{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
