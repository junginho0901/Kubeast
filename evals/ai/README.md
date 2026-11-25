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
`<time>-<model>.json` (every tool call with its arguments and the first 4,000 characters of its result, the answer,
usage) and `<time>-<model>.md` (the table). Reports from before kept 400 characters: the planted cases' `reached`
(`scripts/ai_eval_planted.py`) looks for its canary in the saved results, so it finds it more often now, and its counts are
not read beside the older ones.

The runner signs in again before its token's lifetime is over (the token's `exp` less its `iat`, counted on this
machine's clock from the sign-in, so no server time is compared with this machine's) and once more on a 401, sending
that call again. It writes both files again after each case. So one call can run a round longer than the token lasts
(120 minutes on the dev install), and a run that stops keeps the cases it finished.

## Recorded tool answers

To compare two models or two instructions on the same cluster data, one run can record each read tool's answer and
later runs get the same answers back (`services/ai-service/app/services/ai/tool_replay.py`). ai-service reads three
environment variables at start; they are not chart values and are off by default:

| Variable | |
|---|---|
| `AI_TOOL_REPLAY_MODE` | `off` (default), `record` or `replay` |
| `AI_TOOL_REPLAY_DIR` | the directory of recordings, one `<tool>-<key>.json` per call, made when missing |
| `AI_TOOL_REPLAY_TEST_INSTALL` | must be `true` for `record` or `replay`, or ai-service does not start, so a normal install never serves recorded answers |

The key is the SHA-256 of the cluster, the tool and the arguments with sorted keys, after dropping the model's
`cluster` argument (the call is pinned to the chat's cluster), empty (`null`) values and the spaces around strings.
Nothing else is normalized: a PromQL written another way or another time is another key. `record` runs each call as
usual, masks the answer again with the shared rules (on whatever `REDACTION_ENABLED` says) and writes it; the model
reads that same text, so a replay returns what the recording run saw. `replay` returns the recording without calling
tool-server; a call with no recording gets an error answer (`status: replay_miss`) and never runs live, and write and
action tools are not recorded and are refused in replay. The chat (both loops and Claude Code) and the alert
investigator all go through it. Each call's `ai.tool.call` audit row is written as before, with `replay: true` and
`replay_hit`, and with no `access` or `requests` since no cluster was reached; the chat's tool result event and an
investigation's tool call carry the same two fields, so a run can count its hits — measure the hit rate first, and
compare with replay only when it is high.

The variables go on the ai-service Deployment of the dev install (record, then replay with the same user and cluster).
Its `/tmp` is an `emptyDir` and a new pod starts with it empty: copy the directory out of the recording pod before
switching modes and into the replaying pod once it runs. A call reads its file when it comes, so the copy needs no
restart; the start line in the log says how many recordings the directory held then.

An investigation's row holds its calls' arguments and lengths, not their results. With `record` on,
`--alerts --alert-tool-results` keeps them: right after each investigation the runner reads each call's recording from
the running ai-service pods (`kubectl exec`, by the key of its cluster, tool and arguments, which it takes from
`tool_replay.py` itself) and adds its first 4,000 characters to the call (`result`, `recorded_chars`, `recorded_at`),
and `tool_results` to the row (`kept` of `of`, and `error` when a pod did not answer). A repeat the investigator refused
(`repeat_of`) has no result of its own. The run does not start when ai-service is not recording. What the model reads is
the masked text it would read anyway in `record`. It has not run on a cluster yet.

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
| `question_vague` | the same problem without the symptom named, asked as its own chat; the two forms take turns and swap their order every other run (specific, vague, vague, specific, …) |
| `answer_format` | `rca_block_v0`: each question asks for a fenced `rca` JSON block at the end, scored against `truth.json` |
| `baseline_seconds` | normal running after `wait` (and `settle_seconds`), before the fault |
| `inject_cmds` | shell steps that make the fault (`$NS`, and `$CASE_DIR` the case folder); `INJECT_TIME` is taken before the first; a failing step is a setup failure |
| `inject_wait`, `inject_wait_seconds` | a condition polled until the fault shows (240 s by default); still false, a setup failure |
| `fault_start_at` | `inject` (default) or `setup`: where `ask_after_seconds` counts from |
| `ask_after_seconds` | a number or a list of seconds after the fault start; at each, every question form `--repeat` times |
| `fault_duration_seconds` | `undo_cmds` this long after the injection (`UNDO_TIME`), the namespace kept |
| `undo_cmds` | shell steps that take the fault back; otherwise run after the last question |
| `cooldown_seconds` | a pause after the teardown |
| `not_right_after` | ids of cases this one does not run right after: where the order would put it there, it goes before that case (`--list` shows the order). 07 after 01: what 01 leaves in the demo's metrics and logs is still in 07's window. It orders one call of the runner; a script that runs a case per call keeps the order itself |
| `hidden` | `true`: run only with `--hidden`, and the table shows only the total |
| `group` | `chain`, `hidden_cause`, `trap`, `control` or `past`, for people reading the results; the runner does not read it |
| `alert` | the alert that starts an investigation in `--alerts` runs ("The alert path" below); the chat path does not read it |

Order: namespace, `setup.yaml` (`SETUP_TIME`), `setup_cmds`, `wait`, `settle_seconds` + `baseline_seconds`,
`inject_cmds`, `inject_wait`, the asks (a `fault_duration_seconds` undo at its time), `undo_cmds`, the namespace
deleted, `cleanup_cmds`, `cooldown_seconds`. `--keep` leaves a case as it ends: no undo, no deletion. A failing
`setup_cmds` step, a `wait` still false at `wait_seconds` and an `inject_wait` still false are a setup failure with
the end of the output (400 characters), and the case is not asked. Each answer's `late_seconds` is how long after its
ask time it was asked.

The account and earlier runs:

- A hard case asks as a member the runner makes for it with Read on the case's cluster (the whole cluster), deleted
  when the case ends, with a password made for it and kept in memory; `--user admin` asks as the admin instead. A member holds no `admin.audit.read` or
  `admin.investigations.read`, so the chat's `audit_search` and `investigations` refuse it
  (`scripts/test_ai_eval_runner.py` reads that from the seeded roles and the tool permission tables).
- Read still opens the Alerts inbox and an alert's investigation report (`alerts_inbox` with `with_report`, for
  whoever reads the whole cluster). For a chat round, keep `features.alertInvestigation.enabled` off (the inbox then
  answers 404), so a fault of the round (01, 07 and 10 can fire the demo's rules) starts no investigation the model
  could read and none takes the model's one Claude Code place. A run with hard cases stops before the first case when
  a cluster's inbox answers at the start (the investigation list answers whether or not the switch is on, its earlier
  reports staying listed, so the runner does not read it for this); `--alert-investigation-on` runs it anyway, with a
  warning and `alert_investigation_on: true` in the round's record.
- The round's record `<stamp>-round.json`, and the table's last line, give the account, the namespace suffix and how
  many investigations and inbox rows each cluster had before and after the round.
- `--namespace-suffix random` (or a value of up to eight lowercase letters and digits) runs each case in
  `<namespace>-<suffix>`: the runner copies the case folder and writes the new name wherever the old one stands as a
  whole name (`case.json`, `truth.json`, the manifests), so the investigations, alerts and audit rows of earlier runs
  name another namespace. Other namespaces a case makes (`edge`, `members`) keep their names.

A request error of one chat turn — an HTTP error, a timeout, a dropped connection — is kept as that answer's `error`
(`request_error`, `error_status`) and the case goes on; a 429 or 5xx is tried once more after 20 s. Three in a row
end the case's asks (the undo and teardown still run). The report and the table are written after each case, so a
run that stops keeps the cases it finished.

`truth.json` holds `control`, `fault_start` and `fault_end` (`{{SETUP_TIME}}`, `{{INJECT_TIME}}`, `{{UNDO_TIME}}`,
filled into `<out>/<time>-truth/<id>.json`), `time_tolerance_seconds`, `causes` (`resource` as
`Kind/namespace/name`, `kind`, `accept_resources` and `accept_kinds`), `path` (`resource`, `role`, `required`,
`accept`), `also_ok` and `decoys` (`*` and `<…>` stand for a generated part of a name). The last `rca` block passes
when it names every truth cause with an accepted kind and no decoy as a cause; a control passes only with
`no_fault` and no cause other than kind `none`, and a fault case fails with `no_fault`. Its score is 1 less 0.25 for
each other cause outside `also_ok`, the same resource named again under a kind its truth cause does not take
included, and more than one such cause fails it (`EXTRAS_ALLOWED`): a right cause in a list of guesses is not a right
answer. Reported beside it: `started_at` within the tolerance, the required path hops in order, the causes whose
`evidence` points at no call that answered, and `pass_grounded` (pass with none of those). `expect` is still checked,
as `prose_pass`. A truth's `symptom`, `distractor_at`, `variants_note` and a hop's `note` are for people; the second
scoring reads the symptom and the notes for the kind words of the truth's own chain.

How an answer is read: a fence whose info words hold `rca` in any case (```` ```rca ````, ```` ```RCA ````,
```` ```json rca ````) is the block (`block: ok`); with none, a ```` ```json ```` or untagged block holding `causes`
or `no_fault` is scored as `block: loose`. A kind is read as `KINDS` writes it (`ConfigChange`, `config-change` and
`config change` are `config_change`). `namespace/name` without a kind is read as such when the first part is no kind
(a namespace is lowercase, with no dot). A decoy whose name is only `*` (`Node/*`) is taken only by an answer that
gives its kind: a bare name — a table, an index, a setting — is an extra cause, not a node.

The table leaves hidden cases out, and a hidden case's line on screen says `done` instead of pass or FAIL. Their total
(of the first scoring, and of the second, never parted into incidents and controls, since one of the two may hold one
hidden case) is written only in the run's last table, once the run ends, and only when two or more hidden cases have a scored row
(a case whose setup failed has none): the tables written after each case, and a run of hidden cases only, say the
results are in the JSON, so no `.md` or screen line, and no change between two tables, gives one hidden case's score.
No test file holds a hidden case's answer either: the hidden truths are run from their folders, the scorer's own
checks use made-up truths, and `scripts/test_ai_eval_cases.py` fails on a test file naming a hidden cause.

`evals/ai-hard/` holds twenty-two cases. Each folder has `case.json`, `truth.json`, the manifests it applies and
`NOTES.md`: what the AI has to notice, the trap, how it is scored and what is unsure (and, where the second scoring
takes more kinds than `truth.json`, `scoring.json`). None has run on a cluster yet, so
their sizes and waits are first guesses for the first run to measure. Nineteen are made of plain Kubernetes objects:
they use only `docker.io/library/busybox:1.38.0`, namespaces `shop-NN` (and `edge`, `members`, `reports`),
business names and no Secret. The fault comes from data or settings, never from a branch in the code, and nothing a
case applies names it (`scripts/test_ai_eval_cases.py`); case 20's new release is a boot script in a ConfigMap, the
stand-in for a new image. Their answers lean on logs: run `scripts/kind-logsearch.sh up` first. Cases 01, 07 and 10
run on the OpenTelemetry demo (`scripts/kind-otel-demo.sh up`, metrics on), so their evidence is in traces and the
call graph: their own namespace holds only `uptime-check`, which asks the shop through `frontend-proxy` and logs what
it got, and the fault is made in `otel-demo` — a scale (01), a Chaos Mesh NetworkChaos in `chaos-mesh` (07,
`scripts/kind-chaos.sh up`) and a schema change left open in the demo's database through `kubectl exec` (10). The
demo's collector writes the service graph metrics (`traces_service_graph_*`, with the namespace on both sides) that
the AI's call graph reads; a store the demo does not instrument is a node named by the calling span's
`server.address`. Cases 17–22 follow outage shapes common in production — a batch read that saturates a database, a
route without its hostname, a release that boots in one environment only, an OOM cascade, workers past the memory
limit, and 18, which is hidden — each rebuilt small; the scripts whose behaviour they depend on (headers through
busybox httpd, memory held per worker or shard and where the OOM kill lands) were checked in a local busybox 1.38.0
container, not on kind. Every group of more than one case has a hidden one: 02 (chain), 08 and 18 (hidden cause), 11
(trap), 15 (control); `scripts/test_ai_eval_cases.py` holds it.

A truth's cause is what changed or what has to change, not where the symptom shows: where a fault is a change (a
rollout, a ConfigMap, a selector, a scale), the workload that only shows the symptom is in `also_ok`, or is taken only
with a kind that says a change (`config_change`, `rollout`), so the symptom's workload with the symptom's kind (`crash`,
`oom`, `dependency_down`) is a miss; each NOTES.md says which and why. `scripts/test_ai_eval_cases.py` holds such
answers to a miss.

A namespace a case makes besides its own (`reports` for 03, and `edge` and `members`) carries no case number and no
`kubeast.io/ai-eval` label, so a namespace list does not tie it to the case; the case's `setup_cmds` and
`cleanup_cmds` make and delete it by name. Run the cases only on the dev clusters: a namespace of that name already
there would be deleted with the case.

The hidden cases (02, 08, 11, 15, 18) measure whether a change to the prompts, the rule cards or the tool
descriptions fits the cases it was tried on. Whoever writes those — a person or an agent — does not open these
folders, their NOTES.md or their truth, nor a run's rows, table or log of a hidden case; the results are read as the
round's total. A hidden case's answer stays in its folder: the table below gives no problem for it, the tests use
made-up truths (`shop-x`) and read the hidden truths from their folders without printing a name, and no test file,
PR description or commit message names a hidden case's cause or the shape of its fault.

A case's alert names the namespace where its cause is, since the investigator's token is limited to the alert's
namespace: 01, 07 and 10 carry `namespace: otel-demo` (with `match` the same, and `job: uptime-check` for what
measured it), and 03, whose cause is a Job in `reports` and the node, an empty `namespace`, which the webhook reads as
none, so its investigator reads the whole cluster. 07's NetworkChaos in `chaos-mesh` holds the answer: the account
that asks and the investigator must not read the `chaos-mesh.org` group, which 07's NOTES.md says how to check.

| Case | Group | Problem | Needs on dev besides logs |
|---|---|---|---|
| 01 | chain | the cart's store is scaled to 0: cart calls fail, checkouts fail two calls up | the OpenTelemetry demo |
| 02 | chain, hidden | in its folder only | |
| 03 | chain | a batch Job in another namespace with no CPU limit saturates the node CPU the services run on; three services that share no call slow together | the second cluster's Prometheus (node-exporter, cAdvisor) and metrics-server |
| 04 | hidden cause | a new NetworkPolicy leaves one caller with no allow to one backend; both sides look healthy | `self`, whose kindnet enforces NetworkPolicy |
| 05 | hidden cause | one workload is rolled out with its own `dnsConfig`; only its short-name calls fail | |
| 06 | hidden cause | a rollout to a new ConfigMap with a bad value, held at 4 old and 2 new pods; asked at 5 and 65 minutes | |
| 07 | hidden cause | the packets from one service to one caller are held 700 ms: both ends look healthy, only the traces show where | the OpenTelemetry demo and Chaos Mesh |
| 08 | hidden cause, hidden | in its folder only | |
| 09 | hidden cause | a 25m CPU limit makes one service slow with no error; a busier pod is the decoy | the second cluster's Prometheus (cAdvisor, kube-state-metrics) |
| 10 | trap | a schema change left open locks two tables of the shared database; its callers fail, then the role's connections run out | the OpenTelemetry demo |
| 11 | trap, hidden | in its folder only | |
| 12 | trap | an old crash-looping pod with a DNS-looking error, and a quiet in-place ConfigMap edit | |
| 13 | control | no fault; one unrelated container restart five minutes before the question | |
| 14 | control | no fault; a clean rollout four minutes before the question | |
| 15 | control, hidden | in its folder only | the second cluster's metrics-server and Prometheus |
| 16 | past | a Deployment scaled to 0 for five minutes, then back; asked at 6 and 70 minutes | the second cluster's Prometheus |
| 17 | trap | a CronJob loses its cursor setting and reads a whole table every minute; the database's disk queue slows every caller while its CPU stays low | the second cluster's Prometheus (cAdvisor), for the CPU part |
| 18 | hidden cause, hidden | in its folder only | |
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
python3 scripts/ai-eval.py --cases evals/ai-hard --out /tmp/ai-eval-hard --repeat 3 --hidden --namespace-suffix random
python3 scripts/test_ai_eval_rca.py                          # the scoring checks, or pytest on that file
python3 scripts/test_ai_eval_second.py                       # the second scoring: wrong answers that must fail, right ones that must pass
python3 scripts/test_ai_eval_cases.py                        # the case folders and the demo's alert rules; no cluster
python3 scripts/test_ai_eval_runner.py                       # the runner against a stand-in API; no cluster
scripts/kind-otel-demo.sh down && scripts/kind-chaos.sh down
```

The demo's alert rules (`deploy/kind/otel-demo-rules.json`) are each service's error rate and 95th percentile
latency from the span metrics, and container restarts in `otel-demo`. With metrics on, `kind-otel-demo.sh up` puts
them into the second cluster's Prometheus and `down` takes them out. They carry `kubeast_eval="otel-demo"`, the only
alerts that Prometheus sends to Alertmanager (`deploy/kind/second-cluster.yaml`), whose default route posts them to
the webhook for `default`, so a firing rule starts an investigation (severity `warning`). The e2e specs pick alerts by
`kubeast_e2e`, `e2e_run` or names of their own and do not see these. The thresholds (5 %, 1000 ms) are not measured
on kind yet.

## The alert path

`--alerts` measures the alert investigation — the webhook, the worker, the report — on the same hard cases instead of
the chat. Only the cases with an `alert` run. Each runs in stages as above, with the alert in place of the questions:
before the fault the runner notes the cluster's investigations, then sends or waits for the alert, waits for its
investigation to end, reads its report and scores it.

```bash
python3 scripts/ai-eval.py --cases evals/ai-hard --alerts --list --hidden    # the cases with an alert; no cluster
python3 scripts/ai-eval.py --cases evals/ai-hard --alerts --out /tmp/ai-eval-alerts --repeat 3
```

| Field of `alert` | |
|---|---|
| `labels`, `annotations` | the alert as Alertmanager would send it; `namespace` is the case's and `severity` `warning` unless given (`"namespace": ""` sends none) |
| `rule` | the test Prometheus rule whose alert this is (its `alertname`); an add-on puts it into the second cluster's Prometheus, as `scripts/kind-otel-demo.sh` does its rules |
| `match` | labels the fired alert must carry (default: the case's namespace; `""` for a label it does not carry) |
| `after_seconds` | when the runner posts the alert, from the fault start (default: the case's first ask time) |
| `fire_wait_seconds`, `investigation_wait_seconds` | how long to wait for the rule to fire (600) and for the investigation to end (900) |

The webhook gives the investigator a token for the alert's `namespace` label (none: the whole cluster), so a case whose
alert names one namespace while a truth cause is in another is a field problem (`check_alert_scope`; a cause of a kind
with no namespace, such as a Node, is not held). `--list` names it and a run does not start; for a hidden case the
line names nothing of its truth.

`--alert-source` picks where the alert comes from:

- `auto` (the default): real where the case's rule is loaded, posted where it is not.
- `real`: the rule fires and Alertmanager posts it to the webhook. The runner waits for a new firing row of that alert
  in the Alerts inbox. A case whose rule is not loaded, or that names none, is not run and says why. Runs 2 to N send
  that alert again — its labels, annotations and start — under a fingerprint of their own (`alert_source: replay`):
  Alertmanager sends a firing alert once, and the webhook folds a repeat into the first investigation for
  `dedupeHours`.
- `synthetic`: always posted.

The real path is what an install runs: the rule's own labels, its generator URL, a rule `prometheus_rules` finds by the
alert's name. A posted alert needs no rule, no metric that shows the fault and no wait for a rule's `for`. The
twenty-two cases of `evals/ai-hard/` have no rule: most of their faults show only in logs, and ten run on `self`, which
has no Alertmanager. The only test rules today are the OpenTelemetry demo's; the three cases on the demo (01, 07, 10)
carry an `uptime-check` alert (`job: uptime-check`), not one of those rules. So the twenty-two are posted, and their
alert repeats what the question says.

A posted alert is one alert in Alertmanager's message (version 4), sent with the cluster's own webhook token (the HMAC
of `ALERT_WEBHOOK_TOKEN` from `kubeast-secrets`, which `webhookClusterTokensOnly` also takes), receiver `ai-eval`, a
fingerprint per run and a start a minute before it is sent, never before the fault. The webhook must count it
`accepted`; any other answer (duplicate, filtered, skipped, automatic off) is a setup failure with the counts. A post
answered 429 or 5xx is sent once more after 20 s. At the
end of the case each alert the runner posted is sent again as resolved, so its inbox row is closed before the next
case's investigator can read it with `alerts_inbox`.

The investigation of an alert is a new one of the alert's fingerprint that holds the inbox row's `starts_at`, the match
of #909, made by the alert's own start and never by comparing a received time with it, since the server and this
machine keep different clocks. Without one, the newest new one of that fingerprint is taken, and given up for one that
holds the start if that comes while it runs (`matched_by` says which). The runner reads the detail of each new investigation of the alert once to match it and polls the
investigations list every 5 s until the one it matched is done, failed or skipped, then reads that detail again; each
detail read writes an `ai.investigation.view` row, the list none. A read the runner waits on (the inbox, the list, a
detail) that fails — an HTTP error, a timeout, a dropped connection — is read again 5 s later; six failures in a row
end that run of the case as a setup failure, and the next run and case go on. A failed or skipped investigation is a
row with `error`, not scored. A hidden case's line on screen says `done`.

How a report is scored, the same with v0.7.9's switches off and on:

- `text` (`score_text`): the report's "Likely cause" section, or the whole report without that heading. A sentence
  (a line and a bullet are one too) parts into clauses at `;`, `,`, while, but, and, though, -고, -지만 and -며, a
  part that names no object going on the one before it ("restarted and caused the errors", "busier but unrelated").
  In a clause, `NO_FAULT_WORDS` ("no fault", "found no evidence of", "nothing points at", "찾지 못했", "장애가 없") and
  `CLEAR_WORDS` ("not changed", "looks normal", "unrelated", "not the cause", "정상", "무관") rule out the one object
  named nearest before them (else after); the others named there stay. `NO_FAULT_WORDS` in a clause, or its part
  before or after a colon, naming no object is the report saying there is no fault (`no_fault`) — unless it speaks of
  the others ("No problems elsewhere", "no issues in the other workloads", `OTHERS_WORDS`), which rules them out. A
  blame word blames one object: `CAUSE_WORDS` ("caused", "the culprit", "원인", "때문") and `FAIL_WORDS` ("broke",
  "fails", "is down", "실패") the one named nearest before them, `CAUSED_BY_WORDS` ("because of", "due to") the one
  nearest after; `FAIL_WORDS` blame no object of the truth's path, whose failure is the symptom ("so checkout fails").
  - A fault case passes when the report does not say there is no fault, names each truth cause — its resource's name
    or an `accept_resources` form — where it is not ruled out, gives it a word of its kind or an accepted kind
    (`KIND_WORDS`; for a ConfigMap or Secret cause a change, `CHANGE_WORDS` such as "raised", "edited", "바뀌", is
    `config_change`), blames no decoy (`decoys_named`) and holds at most one extra. A kind word counts in a sentence
    that names a cause, outside the ruling-out words and the clauses whose every object is ruled out, read with the
    objects' own names taken out (a name ends at Hangul, so a particle does not keep it). One stretch of words is one
    kind ("memory limit" is `oom`). A kind word speaks of one cause: the one its clause names, else the one named
    nearest before it, else after it.
  - As the block's extras, each costs 0.25 (`extras`): another object the section names without ruling it out, in any
    sentence — a decoy or a `Kind/name`, not a truth cause, `also_ok` or a hop of `path` (`extra_objects`) — and each
    kind word a cause is given beyond its own kinds and one more (the symptom's, `other_kinds`). More than one
    (`EXTRAS_ALLOWED`, the block's too) reads as a list of guesses and does not pass.
  - A control passes when the report says there is no fault and blames no decoy and no other `Kind/name` (`suspects`).
    "X is normal" alone is not a no-fault answer. `decoys_ruled_out` lists those it cleared.
  - `pass` and `score` are this check's, so an off round and an on round compare. It is weaker than the block's.
- `rca` (`score_block`): with `features.alertInvestigation.evidenceCheck` or `ledger` on, the server takes the rca
  block off the report and keeps it as the investigation's `result`, which is scored as the chat's block is. A report
  that still ends in a block is read from the report. With both off the row has no `rca`.
- `prose_pass`: the case's `expect`, as in the chat path. A control's row also has `wrong_suspect`: the text check did
  not pass.

Each row is in the same files as the chat's, with `form` `alert`: `alert_source`, `ask_after` and `late_seconds` for a
posted alert, `alert_after_seconds` (fault start to the alert), `waited_seconds` (the alert to the end of the
investigation), the fingerprint and `starts_at`, `investigation_id`, the report as `answer`, `calls` (each tool's
arguments, `failed`, `result_chars` and `requests`), `tokens`, `model_calls` (the investigation's iterations) and
`seconds` (its run time).

Before a round: `features.alertInvestigation` on with a webhook token and `maxPerHour: 0` and `dailyTokenBudget: 0`
(the dev values have all three), the investigation's model set (`features.alertInvestigation.model`, else the default),
and `scripts/kind-logsearch.sh up`. For the real path, the add-on with the rules, and the second cluster's Prometheus
and Alertmanager as `deploy/kind/second-cluster.yaml` and `deploy/kind/alertmanager.yaml` have them. With
`dedupeHours` at its 24, a real alert whose labels already fired in that window folds into the earlier investigation,
which the row says; posted alerts never fold. The alert path's first round on the kind dev install, of hard cases with
posted alerts, ended on 2026-11-24; its waits and the words of the text check are the first guesses from before it.

## The second scoring

A hard case's row holds two scorings. The first is what is described above: `pass`, `score`, `rca`, `text` and
`prose_pass`, and the table's first parts, are its numbers and stay as they are. The second (`scripts/ai_eval_second.py`)
is the row's `second`. `rules` in it is the number of the rules; numbers are read together only under one number, and a
comparison gives both scorings.

**A decision is made on blocks.** `second.pass` is a block's: true or false for an answer that has an rca block to score
(a chat answer, with or without it, and an investigation whose block the server kept or left in its report), and null for
a report without one ("An answer without a block" below). The words' scoring (`second.text`) is reported and decides
nothing; of a block, an answer's words decide one thing, whether a kind its case's `scoring.json` lets in by `needs` is
taken. Words that name the right object beside another mechanism pass
it, and right ones told another way do not: of the review's 22 wrong incident reports the rules of before passed 17 (the
first scoring 13) and of its 22 right ones 12 (8). The rules now in place fail all 22 and take 20, but they were written on
those; of 20 wrong and 17 right reports written after them and scored once, they passed 6 of the wrong (the first 5) and 15
of the right (12). An off round of investigations has no blocks, so off and on are not compared on this scoring at all:
they are read by judges (a rubric from `truth.json`, the arm hidden), and the numbers here stand beside that.

### An answer without a block

What the number 3 says of it (`scripts/test_ai_eval_second.py` holds it):

| Answer | First scoring | Second scoring |
|---|---|---|
| A chat answer without its block, or with one that cannot be read | `rca.block` missing or invalid, `pass` false | `by` block, `pass` false, `outcome` no_block: a miss |
| A chat turn that ended in an error or a timeout | `pass` false | `pass` false, `outcome` error |
| An investigation of an off round (no switch that makes a block) | `pass` is its words' | `by` text, `pass` null, `outcome` its words' |
| An investigation of an on round whose block is missing, invalid or cut | `pass` is its words', `rca` with that status and `rca.pass` false | the same: `pass` null |
| An investigation that failed or timed out, in either arm | `pass` false | `pass` null, `outcome` error; false when it stored a block first |
| A run whose setup failed | a row without scores | none |

The tables count the second's passes out of `블록 있는 회` and show `회` beside it: the two differ by the investigations
without a block, in an off round all of them, in an on round those that lost theirs. The number 3 says neither that such a
run failed nor that it did not; a comparison that needs one of the two says which before the round, for both arms, and a
saved row is scored again (`score`) rather than read by its number: on 2026-11-25 two earlier states of the rules also
carried the number 3 and say other things of some answers.

It was added because a reading of 72 saved incident reports (by a model, the rounds shuffled) took 57 as right where the
first scoring had passed 38, no wrong one among them: the first reads one section, counts an object as a guess when it is
mentioned, and reads "no evidence of X" as a no-fault answer.

What the second scoring reads of a block:

| Rule | From |
|---|---|
| A control's answer is one of three outcomes: it names a cause, says no fault, or says the cause cannot be told — by the block's own list of causes (one of kind other than `none` is a cause, whatever `no_fault` says and in whatever shape it stands) | 13 and 14's NOTES.md: a made-up cause is the number to watch, and only `no_fault` is right |
| An incident's answer has the same outcome, so one left open is not counted with the wrong ones | the same |
| An investigation with the server's outcome in its stored result (`verdict`, with `features.alertInvestigation.verdict` on) has that outcome, `cause_found` being a cause: a cause the server keeps as "cannot tell" is neither made up nor found, and an incident's block passes only with a kept cause | the server holds the outcome to the run's calls, and the report says so |
| A cause may have a kind its case's `scoring.json` gives beside `truth.json`'s, where the answer says what that asks for | that case's NOTES.md, quoted in the entry |
| Each hop of the truth's path that is no decoy may be named once without being a guess, by its resource; a name that is only like it, or the hop again under another kind, is one, and more than one fails (`EXTRAS_ALLOWED`), as in the first scoring | `path` |

And of a report's words, which are only reported (its Summary and Likely cause, else the whole report):

| Rule | From |
|---|---|
| The case's facts (`expect`) are in it | the NOTES.md lines on the prose check |
| An object is a guess, and a decoy taken, when it is blamed ("X caused", "the cause is X", "because X ...", "either A or X", an item under "Possible causes:"), not when it is mentioned | `decoys`: named "as a cause" |
| A hop told as a link of the chain from the cause is not blamed | `path` |
| Only the whole report saying there is no fault is a no-fault answer; "no evidence of X" rules X out and is no control's answer, and for a fault that is over (`fault_end`) nothing wrong now is true | 13, 14 and 16's NOTES.md |
| `config_change` is said by a change, a lack or a wrong value that is of account (not a comment or a label), not by the words "config" or "settings"; a NetworkPolicy's and a Node's kind by what they do, not by their type's name; a limit or a kill not by saying it is not so or is well | 04, 12, 21, 22: the cause is what changed or blocks |
| A cause that stands only in the Summary needs a Likely cause that speaks of its kind and does not leave the cause open | a change seen is not a cause (14) |
| A kind written beside a name ("the pricing ReplicaSet") is read with it; a sentence that names nothing and says that something failed or changed goes on with the cause before it; a cause of two ends takes one kind word for both | `accept_resources`; 07's `variants_note` |

`second` holds `by` (`block`, or `text` for a report without one), `pass`, `outcome` (`cause`, `no_fault`,
`cannot_tell`; `unread` for words that say none of them, `no_block` for a chat answer without the block it was asked
for, `error`) and `miss`, why it does not pass. The investigation's stored block is in the row (`stored_result`), so a
later scoring can read it. A row with the server's
outcome also says the block's own (`block_outcome`).

A control passes only with `no_fault`, as in the first scoring; its three counts are what to read, the made-up causes
first, and of a report in words they are an undercount: a cause told without a name or a blame word is `unread`. The table
ends with two parts, the incidents and the controls, each with both scorings' counts, how many runs had a block, and the
outcomes.

`scoring.json`, beside `truth.json`:

| Field of an `accept_kinds` entry | |
|---|---|
| `cause` | the truth cause it is for |
| `kinds` | the kinds it takes besides the truth's |
| `needs` | what the answer must say changed or is missing, in a sentence that names the cause and a clause that does not take it back (an expression of that thing; optional) |
| `notes` | the NOTES.md sentence that takes them, as it stands there, with each of the kinds in backquotes |

A kind no NOTES.md sentence takes is not taken: `--list` names an entry whose sentence is not in NOTES.md, does not name
its kinds, does not say they are taken or takes them back ("does not count", "alone"), and the run does not start. Only 05
has one. The right object under a kind with no such sentence stays wrong until a person writes it: in the saved answers
that was `resource_limit` in 10 (twelve times), `rollout` in 09 (three) and 16, and `dependency_slow` in 17 (once each).
`scripts/test_ai_eval_second.py` holds these and a few more (`KINDS_THE_NOTES_DO_NOT_GIVE`). The filled truth copy of a
run holds the entries and the facts it was scored with (`scoring`).

```bash
python3 -I scripts/ai_eval_second.py score /tmp/ai-eval-hard/<stamp>-<model>.json    # both scorings of a saved report
```

It reads the run's own truth copies and leaves hidden rows out, says how many rows the first scoring now scores another
way than the report holds (exit 1 when any), and prints the second's tables. A saved alert row from before
`stored_result` has no block to score (`block_not_saved`), so only its words are reported.

The words are English, with the first scoring's Korean words and a few more; no Korean report has been tried.

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
