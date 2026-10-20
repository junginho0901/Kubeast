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

What changed after the first run: case 06 failed because an empty alert store ended the answer ("no alert fires")
while Prometheus was firing the rule — the dev Prometheus sends to no Alertmanager. `alerts_list`'s empty results,
its description and the chat instruction now say to check `prometheus_rules` with `active_only=true` before saying
nothing fires. The 3B model's misses (an answer written without calling the tool it names, a kubectl command instead
of saying the Secret is not readable) are the model's limits; the instructions were not changed for it.

2026-10-20: the chat instruction asks for one sentence before a tool call and no repeated results (answers now keep
their text between tool calls); Haiku stayed at 12/12.
