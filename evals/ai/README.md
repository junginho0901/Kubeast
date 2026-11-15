# AI analysis evaluation

The e2e suite checks the AI tools' form, permissions, audit rows and charts. Whether the AI finds the cause is
measured here: twelve problems made on purpose on the kind dev clusters, each asked as an operator would ask it, the
answer checked for the facts it must contain.

```bash
export PATH=/opt/homebrew/bin:$PATH        # kubectl, kind
python3 scripts/ai-eval.py --out /tmp/ai-eval           # every case, the dev install's default model
python3 scripts/ai-eval.py --out /tmp/ai-eval 05 10     # cases whose id starts with 05 or 10
python3 scripts/ai-eval.py --out /tmp/ai-eval --repeat 3 03
```

The model is the dev install's default: `scripts/kind-model-subscription.sh up <token-file>` (Claude subscription,
`SUBSCRIPTION_MODEL=claude-sonnet-5-5` for Sonnet), `scripts/kind-model-subscription.sh down` and
`deploy/kind/modelconfig-ollama.yaml` for the local model. Run once per model; each run writes
`<time>-<model>.json` (every tool call with its arguments, the answer, usage) and `<time>-<model>.md` (the table).

## A case

`<NN>_<name>/case.json`:

| Field | |
|---|---|
| `question` | what the operator asks (Korean, as typed) |
| `cluster`, `namespace` | where the problem is made — `self` (kind `kubeast`) or `default` (kind `kubeast-b`); the namespace is created and deleted by the runner |
| `expect` | facts the answer must contain: a list of groups, each a list of regular expressions of which one must match (case-insensitive) |
| `forbid` | expressions the answer must not contain (a secret's value) |
| `tools` | groups of tools of which at least one must be called |
| `user` | `read` asks as a member with Read on the cluster (default: the admin) |
| `wait`, `wait_seconds`, `settle_seconds` | a shell condition (with `KUBECONFIG` set, `$NS` the namespace) polled until true, then a pause for metrics and logs to land |
| `setup_cmds` | shell steps after `setup.yaml` is applied |

`setup.yaml` holds the objects applied in the namespace. A case passes when every `expect` group matches, nothing in
`forbid` does, every `tools` group was used and the chat ended without an error.

| Case | Problem | Needs on dev |
|---|---|---|
| 01 | a pod burning CPU | the second cluster's Prometheus (cAdvisor) |
| 02 | OOMKilled at 24 Mi | |
| 03 | CrashLoopBackOff, the cause in the log | |
| 04 | 5xx lines from one pod | `scripts/kind-logsearch.sh up` |
| 05 | a slow route in traces | `scripts/kind-tracing.sh up` |
| 06 | a firing alert, read from its rule | the rules group `kubeast-e2e` (`deploy/kind/second-cluster.yaml`) |
| 07 | Pending: not enough CPU | |
| 08 | Pending: no node matches the node selector | |
| 09 | ImagePullBackOff on a missing tag | |
| 10 | a Read user asks for a Secret's value | |
| 11 | a rollout stuck on a readiness probe | |
| 12 | a PVC Pending on a missing StorageClass | |

## Hard cases

A case with any of these fields runs in stages in one setup (`scripts/ai_eval_rca.py`); a case without them runs
as above.

| Field | |
|---|---|
| `question_vague` | the same problem without the symptom named, asked as its own chat after `question` |
| `answer_format` | `rca_block_v0`: each question asks for a fenced `rca` JSON block at the end, scored against `truth.json` |
| `baseline_seconds` | normal running after `wait` (and `settle_seconds`), before the fault |
| `inject_cmds` | shell steps that make the fault (`$NS`, and `$CASE_DIR` the case folder); `INJECT_TIME` is taken before the first; a failing step is a setup failure |
| `inject_wait`, `inject_wait_seconds` | a condition polled until the fault shows (240 s by default); still false, a setup failure |
| `fault_start_at` | `inject` (default) or `setup`: where `ask_after_seconds` counts from |
| `ask_after_seconds` | a number or a list of seconds after the fault start; at each, every question form `--repeat` times |
| `fault_duration_seconds` | `undo_cmds` this long after the injection (`UNDO_TIME`), the namespace kept |
| `undo_cmds` | shell steps that take the fault back; otherwise run after the last question |
| `cooldown_seconds` | a pause after the teardown |
| `hidden` | `true`: run only with `--hidden`, and the table shows only the total |
| `group` | `hidden_cause`, `trap`, `control` or `past`, for people reading the results; the runner does not read it |

Order: namespace, `setup.yaml` (`SETUP_TIME`), `setup_cmds`, `wait`, `settle_seconds` + `baseline_seconds`,
`inject_cmds`, `inject_wait`, the asks (a `fault_duration_seconds` undo at its time), `undo_cmds`, the namespace
deleted, `cleanup_cmds`, `cooldown_seconds`. `--keep` leaves a case as it ends: no undo, no deletion.

`truth.json` holds `control`, `fault_start` and `fault_end` (`{{SETUP_TIME}}`, `{{INJECT_TIME}}`, `{{UNDO_TIME}}`,
filled into `<out>/<time>-truth/<id>.json`), `time_tolerance_seconds`, `causes` (`resource` as
`Kind/namespace/name`, `kind`, `accept_resources` and `accept_kinds`), `path` (`resource`, `role`, `required`,
`accept`), `also_ok` and `decoys` (`*` and `<…>` stand for a generated part of a name). The last `rca` block passes
when it names every truth cause with an accepted kind and no decoy as a cause; a control passes only with
`no_fault` and no cause other than kind `none`. Its score is 1 less 0.25 for each other cause outside `also_ok`.
Reported beside it: `started_at` within the tolerance, the required path hops in order, and the causes whose
`evidence` points at no call that answered. `expect` is still checked, as `prose_pass`. A truth's `symptom`,
`distractor_at`, `variants_note` and a hop's `note` are for people.

`evals/ai-hard/` holds sixteen cases made of plain Kubernetes objects. Each folder has `case.json`, `truth.json`, the
manifests it applies and `NOTES.md`: what the AI has to notice, the trap, how it is scored and what is unsure. None
has run on a cluster yet, so their sizes and waits are first guesses for the first run to measure. They use only
`docker.io/library/busybox:1.38.0`, namespaces `shop-NN` (and `edge`, `members`), business names and no
Secret. The fault comes from data or settings, never from a branch in the code, and nothing a case applies names it
(`scripts/test_ai_eval_cases.py`); case 20's new release is a boot script in a ConfigMap, the stand-in for a new
image. Their answers lean on logs: run `scripts/kind-logsearch.sh up` first. The numbers leave room for the cases that
need the OpenTelemetry demo or Chaos Mesh (01–03, 07, 10, 11), not written yet. Cases 17–22 follow outage shapes
common in production — a batch read that saturates a database, a stale in-cluster address, a route without its
hostname, a release that boots in one environment only, an OOM cascade, workers past the memory limit — each rebuilt
small; the scripts whose behaviour they depend on (headers through busybox httpd, memory held per worker or shard and
where the OOM kill lands) were checked in a local busybox 1.38.0 container, not on kind.

A truth's cause is what changed or what has to change, not where the symptom shows: where a fault is a change (a
rollout, a ConfigMap, a selector, a scale), the workload that only shows the symptom is in `also_ok`, or is taken only
with a kind that says a change (`config_change`, `rollout`), so the symptom's workload with the symptom's kind (`crash`,
`oom`, `dependency_down`) is a miss; each NOTES.md says which and why. `scripts/test_ai_eval_cases.py` holds such
answers to a miss.

The namespace a case makes besides its own (`edge` for 15, `members` for 18) carries no case number and no
`kubeast.io/ai-eval` label, so a namespace list does not tie it to the case; the case's `setup_cmds` and
`cleanup_cmds` make and delete it by name. Run the cases only on the dev clusters: a namespace of that name already
there would be deleted with the case.

The hidden cases (08, 15, 18) measure whether a change to the prompts, the rule cards or the tool
descriptions fits the cases it was tried on. Whoever writes those — a person or an agent — does not open these
folders, their NOTES.md or their truth, nor a run's rows, table or log of a hidden case; the results are read as the
round's total.

| Case | Group | Problem | Needs on dev besides logs |
|---|---|---|---|
| 04 | hidden cause | a new NetworkPolicy leaves one caller with no allow to one backend; both sides look healthy | `self`, whose kindnet enforces NetworkPolicy |
| 05 | hidden cause | one workload is rolled out with its own `dnsConfig`; only its short-name calls fail | |
| 06 | hidden cause | a rollout to a new ConfigMap with a bad value, held at 4 old and 2 new pods; asked at 5 and 65 minutes | |
| 08 | hidden cause, hidden | a scale-up fills the ResourceQuota; a CronJob's pods cannot be created and the data goes stale | |
| 09 | hidden cause | a 25m CPU limit makes one service slow with no error; a busier pod is the decoy | the second cluster's Prometheus (cAdvisor, kube-state-metrics) |
| 12 | trap | an old crash-looping pod with a DNS-looking error, and a quiet in-place ConfigMap edit | |
| 13 | control | no fault; one unrelated container restart five minutes before the question | |
| 14 | control | no fault; a clean rollout four minutes before the question | |
| 15 | control, hidden | no fault; traffic from another namespace rises fivefold and the HPA scales out | the second cluster's metrics-server and Prometheus |
| 16 | past | a Deployment scaled to 0 for five minutes, then back; asked at 6 and 70 minutes | the second cluster's Prometheus |
| 17 | trap | a CronJob loses its cursor setting and reads a whole table every minute; the database's disk queue slows every caller while its CPU stays low | the second cluster's Prometheus (cAdvisor), for the CPU part |
| 18 | hidden cause, hidden | a service's old namespace is emptied after a move; the frontend still calls the old address and treats the failure as signed out | |
| 19 | hidden cause | the front Service is switched to a new edge whose routes lack the main hostname: 404 for one site, the backend healthy | |
| 20 | hidden cause | a release that needs a setting only staging has is rolled out with `Recreate`; production is down; asked at 5 and 65 minutes | |
| 21 | hidden cause | a bigger index leaves a three-node StatefulSet no room to lose a node; its rolling update starts an OOM cascade | the second cluster's Prometheus, for the memory steps |
| 22 | hidden cause | the worker count raised past what the memory limit holds; OOMKilled every time the workers warm up | the second cluster's Prometheus, for the memory climb |

```bash
scripts/kind-logsearch.sh up && scripts/kind-tracing.sh up   # the stores the demo writes to
scripts/kind-chaos.sh up                                     # Chaos Mesh in kubeast-b
scripts/kind-otel-demo.sh up                                 # the OpenTelemetry demo in kubeast-b, and its alert rules
python3 scripts/ai-eval.py --cases evals/ai-hard --list      # the cases and what is wrong with their fields; no cluster
python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/ai-eval-hard 06
python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/ai-eval-hard --repeat 3 --hidden
python3 scripts/test_ai_eval_rca.py                          # the scoring checks, or pytest on that file
python3 scripts/test_ai_eval_cases.py                        # the case folders and the demo's alert rules; no cluster
scripts/kind-otel-demo.sh down && scripts/kind-chaos.sh down
```

The demo's alert rules (`deploy/kind/otel-demo-rules.json`) are each service's error rate and 95th percentile
latency from the span metrics, and container restarts in `otel-demo`. With metrics on, `kind-otel-demo.sh up` puts
them into the second cluster's Prometheus and `down` takes them out. They carry `kubeast_eval="otel-demo"`, the only
alerts that Prometheus sends to Alertmanager (`deploy/kind/second-cluster.yaml`), whose default route posts them to
the webhook for `default`, so a firing rule starts an investigation (severity `warning`). The e2e specs pick alerts by
`kubeast_e2e`, `e2e_run` or names of their own and do not see these. The thresholds (5 %, 1000 ms) are not measured
on kind yet.

## Results

2026-10-19, the dev install, one run per case unless noted. Tokens are the turn's sum as the provider reports it (the
Claude subscription counts cached input too, so its numbers are large and do not compare with an API's).

| Model | Correct | Tool calls per case | Seconds per case |
|---|---|---|---|
| Claude Haiku 5.5 (subscription), before the fix below | 11/12 | 3.6 | 13.4 |
| Claude Haiku 5.5 (subscription) | 12/12 (case 06 three more times: 3/3) | 3.6 | 15.3 |
| Claude Sonnet 5.5 (subscription) | 12/12 | 2.8 | 13.9 |
| granite4.1:3b (Ollama, 4 cases only: 02 03 07 10) | 1/4 | 0.5 | 28.7 |
| Claude Haiku 5.5 (subscription), 2026-10-20, after the one-sentence-before-a-tool instruction | 12/12 | 3.5 | 13.0 |
| Claude Haiku 5.5 (subscription), 2026-10-26, after `network_flows` named Calico's Whisker | 12/12 | 3.7 | 11.9 |
| Claude Haiku 5.5 (subscription), 2026-10-26, after the `network_top_flows` tool was added | 12/12 | 3.3 | 11.1 |
| Claude Haiku 5.5 (subscription), 2026-11-08, the v0.7.6 code (new read tools, tool permission tables) | 12/12 | 3.8 | 11.5 |

What changed after the first run: case 06 failed because an empty alert store ended the answer ("no alert fires")
while Prometheus was firing the rule — the dev Prometheus sends to no Alertmanager. `alerts_list`'s empty results,
its description and the chat instruction now say to check `prometheus_rules` with `active_only=true` before saying
nothing fires. The 3B model's misses (an answer written without calling the tool it names, a kubectl command instead
of saying the Secret is not readable) are the model's limits; the instructions were not changed for it.

2026-10-20: the chat instruction asks for one sentence before a tool call and no repeated results (answers now keep
their text between tool calls); Haiku stayed at 12/12.

2026-10-26: `network_flows`' description and the chat instruction name Calico's Whisker as a source next to the Hubble
Relay. No case calls that tool; the run checks that the change leaves the others as they were (12/12).

2026-10-26: the tool `network_top_flows` (Network Flow Monitor top talkers) and its lines in the chat instruction were
added. No case calls it either; the other answers stayed at 12/12.

2026-11-08: the v0.7.6 code, with the read tools that answer what each screen reads and the tables that hold a tool to
its screen's permission, stayed at 12/12. In case 08 `k8s_tabular_query` refused columns holding a JSONPath filter
and a negative index, which kubectl takes, and the model read the nodes again with `k8s_jq_query`; the check now takes
them.
