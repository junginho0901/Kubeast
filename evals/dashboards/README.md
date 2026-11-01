# AI dashboard builder evaluation

What a person asks the AI dashboard builder for, and how its answer is graded. The builder itself comes with the dashboards module's first version; the requests, the grader and a reference answer for each are here first, so the builder is built against them.

```bash
cd services/dashboards-service-go
go run ./cmd/dasheval -cases ../../evals/dashboards                    # the reference answers, checks that need no store
go run ./cmd/dasheval -cases ../../evals/dashboards -answers <dir>       # a builder's answers: <dir>/<case id>.json, or <case id>.<n>.json per run
go run ./cmd/dasheval -cases ../../evals/dashboards -prometheus <URL> \
  -loki <URL> -tempo <URL> -seed -tempo-otlp <URL> 01 21                # also run every query there; cases by id prefix
```

The cases ask about the dev install's second cluster (`default`, kind `kubeast-b`): its Prometheus scrapes cAdvisor, kube-state-metrics and node-exporter and holds the always-firing rule of `deploy/kind/second-cluster.yaml`; the Loki of `scripts/kind-logsearch.sh up` holds both clusters' pod logs (labels `k8s_namespace_name`, `k8s_pod_name`, `k8s_container_name`, `service_name`); the Tempo of `scripts/kind-tracing.sh up` takes OTLP. To run the queries there from the laptop:

```bash
export KUBECONFIG=$(mktemp); kind get kubeconfig --name kubeast-b > $KUBECONFIG
kubectl -n monitoring port-forward svc/prometheus 19090:9090 &
kubectl -n loki port-forward svc/loki 13100:3100 &
kubectl -n tempo port-forward svc/tempo 13200:3200 14318:4318 &
go run ./cmd/dasheval -cases ../../evals/dashboards -prometheus http://127.0.0.1:19090 \
  -loki http://127.0.0.1:13100 -tempo http://127.0.0.1:13200 -seed -tempo-otlp http://127.0.0.1:14318
```

`-seed` first sends the evaluation's own data, service `kubeast-eval-shop` in namespace `kubeast-eval`, and waits 30 s for the stores to serve it. The data is 60 traces over the last 90 seconds: /cart takes 80 ms, /checkout 1.1–1.5 s and /pay 300 ms, and one /pay in three fails. Each trace has a server span with `http.route` and a database child. It also sends logfmt lines, `level=… route=… msg=…`:

- 120 over the last ten minutes, 14 of them at `level=ERROR`;
- one inside each trace's server span, carrying that trace's `trace_id` and `span_id` as structured metadata, as an OpenTelemetry SDK writes them (7 at `level=ERROR`). A trace-to-logs link finds them with `| trace_id="…"`.

The seeded cases (22, 24–27) read only this data. Tempo searches a span by its time only within `ingestion_time_range_slack` (2m) of its arrival, hence the 90 seconds; each run's trace ids carry its time. Kill the port-forwards afterwards.

## A case

`<NN>_<name>/case.json`, with `reference.json` beside it, an answer that passes. An edit case also has `base.json`, the dashboard the builder is given with the question.

| Field | |
|---|---|
| `question` | what a person asks, as typed (Korean; 15 in English) |
| `cluster` | the dev cluster it is asked on |
| `kind` | `build` (the default), `edit` (change `base.json` as asked) or `decline` (the data is not there: the answer is `{"declined": "<why>"}` instead of a dashboard) |
| `vars` | values the grader puts in for dashboard variables. Without one, it uses the variable's current value, then its first option. All is its `allValue` or `.*` |
| `panels` | `min` and `max` panels that show data (text panels not counted) |
| `expect` | panels the answer must have. Each panel has a query on `store` (`prometheus` when empty) that meets every field given: <br>• `metrics`: reads one of them (PromQL) <br>• `functions`: uses one of them <br>• `labels`: has each one in its selector (LogQL labels, TraceQL attributes) <br>• `contains`: contains a string of each group, ignoring case <br>• `uses_var`: refers to that variable <br>• `kinds`, `units`: the panel's kind and unit are among them <br>With `same_as` and a Prometheus, one of the queries meeting the expectation must sum to what the reference panel's query sums to, within `tolerance`, a share of it (0.1 if not given) |
| `expect_any` | a request with more than one right answer: at least `need` of the panels in `of` |
| `scope` | every selector of a metric with one of `prefixes` must keep to `label` = `value`: a matcher that takes the value and refuses others (`=~".*"` does not keep to it) |
| `variables` | variables the answer must define |
| `forbid` | metric name prefixes no query may read: data that is not there, or the panel an edit was asked to remove. A decline case names the missing data here, and grading with a Prometheus checks it is missing |
| `keep` | (edit) panels of `base.json` whose kind and queries must stay as they were |
| `may_be_empty` | metrics with series only while a condition holds (kube-state-metrics' `…_waiting_reason`): an empty query reading one passes |
| `seed` | the case reads the `-seed` data |

## The checks

Without a store:

1. The answer is a valid dashboard document (unknown fields refused, then the model's validation). A decline case instead passes a declined answer with a reason and fails a dashboard. Any other case fails a declined answer.
2. The panel count is within `panels`.
3. Every PromQL query parses, with the variables put in (`$__rate_interval` as 5m).
4. Every panel has a query.
5. Counters (`_total`, `_count`, `_sum`, `_bucket`) are read through a rate (`rate`, `irate`, `increase`, `resets`, `changes`) or counted (`count`), not drawn as raw values.
6. `histogram_quantile` over an aggregation keeps `le`.
7. No cluster matcher (`cluster`, Loki's `k8s_cluster_name`, Tempo's `resource.k8s.cluster.name`): Kubeast adds the cluster to every query itself.
8. Every LogQL and TraceQL query has a selector. A query of log lines or traces is in a logs or traces panel (traces may also be in a table), and a metric query is in a panel that draws numbers.
9. The case's fields hold: `expect`, `expect_any`, `scope`, `variables`, `forbid` and `keep`.

LogQL and TraceQL are read by their surface. Loki and Tempo are AGPL, so their parsers are not imported, and the store judges the rest when the query runs.

With the stores, execution:

10. Every panel query returns data. An error fails. An empty answer fails too, and the grader names why: the literal `label="value"` matchers no series of the metric has (values not taken from the store), or the labels Loki does not have. Two kinds of empty answer pass: one whose query compares series with a number (`> 0`) and returns data without the comparison, meaning nothing passes it now, and one that reads a `may_be_empty` metric.
11. Every query variable (`label_values`, `query_result`) has values.
12. Each `same_as` number matches the reference's.
13. A decline case's `forbid` metrics have no series in the store, so the case still holds there.

An answer passes when every check does. The checks follow what an AI builder must do:

- plan, try each query on the store and leave no empty panel (Grafana Assistant's dashboard creation);
- grade by running the query rather than by likeness to a reference;
- use only values the store has, and say when the data is not there (execution-based text-to-query benchmarks, Agentic Jackal 2026).

| Case | Asks for |
|---|---|
| 01 | a namespace's CPU and memory (kept to `kube-system`, numbers compared) |
| 02 | nodes: CPU, memory, disk, network |
| 03 | pods that restart often |
| 04 | deployments: desired against available replicas (numbers compared) |
| 05 | containers near their memory limit |
| 06 | CPU requested against used |
| 07 | pods by phase (number compared) |
| 08 | node conditions |
| 09 | network by namespace |
| 10 | firing alerts (number compared) |
| 11–14 | open requests: the cluster's health (3 of 6), workload problems (2 of 5), "what uses a lot of memory" (pods or nodes), "is the network odd" (node or pod errors and drops) |
| 15–16 | 01 in English; "파드 재시작", two words |
| 17–19 | data that is not there: CPU throttling, PVC usage, API server latency |
| 20 | node CPU and GPU: CPU only, no GPU panel made up |
| 21–24 | logs: a namespace's logs, the shop's errors and their count, log volume by namespace, requests by route parsed from the lines |
| 25–27 | traces: the shop's traces over a second, failed traces and their rate, rate and p95 by route |
| 28–30 | edits: average latency to p99, a namespace variable for a fixed namespace, remove the network panel |

## How sure a score is

`dasheval` prints the pass rate with its 95% Wilson interval, and per case when answers are repeated. Over 30 answers, 27 passing reads as 74–97%. Three runs of each case (90 answers), 81 passing, read as 82–95%. To compare two models or two prompts, run each case three times, since a builder's answers vary.

## Results

2026-11-01, the reference answers:

- 30/30 without a store.
- 30/30 with every query run on the dev second cluster's Prometheus 3.15.1, Loki 3.7.9 and Tempo v3.1.1 after `-seed`. Every panel returned data, every variable had values, the compared numbers matched, and the three declines' data was missing. The 12 problems panel (`> 0`) was empty only by its comparison, and the waiting reasons were empty.
- Tempo served this run's traces as seeded: 60, of which 20 took over a second and 7 failed.
- After the trace ids were added to the logs (2026-11-01 18:03), 30/30 again. Loki held the 60 lines carrying a `trace_id`. An error line's `trace_id` found its one line in Loki and its trace in Tempo (`GET /pay`, error "card declined", the same span id).

Six wrong answers failed live, each on the check named for its fault:

- lowercase `error` searched in `level=ERROR` lines;
- a service name that is not there;
- `resource="mem"`;
- one namespace's ready count, 4 against 26;
- a dashboard for the PVC case;
- requests grouped by a label they do not have.

Builder runs go here, one row per model, once the builder exists.
