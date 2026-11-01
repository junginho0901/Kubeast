# AI dashboard builder evaluation

What a person asks the AI dashboard builder for, and how its answer is graded. The builder itself comes with the dashboards module's first version; the requests, the grader and a reference answer for each are here first, so the builder is built against them.

```bash
cd services/dashboards-service-go
go run ./cmd/dasheval -cases ../../evals/dashboards                       # the reference answers, checks that need no store
go run ./cmd/dasheval -cases ../../evals/dashboards -answers <dir>          # a builder's answers: <dir>/<case id>.json
go run ./cmd/dasheval -cases ../../evals/dashboards -prometheus <URL> 01 05 # also run every query there; cases by id prefix
```

The cases ask about the dev install's second cluster (`default`, kind `kubeast-b`), whose Prometheus scrapes cAdvisor, kube-state-metrics and node-exporter and holds the always-firing rule of `deploy/kind/second-cluster.yaml`. To run the queries there from the laptop:

```bash
KUBECONFIG=<(kind get kubeconfig --name kubeast-b) kubectl -n monitoring port-forward svc/prometheus 19090:9090 &
go run ./cmd/dasheval -cases ../../evals/dashboards -prometheus http://127.0.0.1:19090
```

## A case

`<NN>_<name>/case.json`, and `reference.json` beside it: a dashboard (`kubeast.io/dashboards/v1alpha1`) that passes.

| Field | |
|---|---|
| `question` | what a person asks (Korean, as typed) |
| `cluster` | the dev cluster it is asked on |
| `vars` | values the grader puts in for dashboard variables (else the variable's current value, then its first option; All is its `allValue` or `.*`) |
| `panels` | `min` and `max` panels that show data (text panels not counted) |
| `expect` | panels the answer must have: each with `metrics` (one must be queried), and when given `functions` (one must be used), `kinds` and `units` (the panel's must be one of them) |
| `scope` | every selector of a metric with one of `prefixes` must keep to `label` = `value`: a matcher that takes the value and refuses others (`=~".*"` does not keep to it) |

## The checks

Without a store:

1. The answer is a valid dashboard document (unknown fields refused, then the model's validation).
2. The panel count is within `panels`.
3. Every PromQL query parses, with the variables put in (`$__rate_interval` as 5m).
4. Every panel has a query.
5. Counters (`_total`, `_count`, `_sum`, `_bucket`) are read through a rate (`rate`, `irate`, `increase`, `resets`, `changes`) or counted (`count`), not drawn as raw values.
6. `histogram_quantile` over an aggregation keeps `le`.
7. No `cluster` matcher: Kubeast adds the cluster to every query itself.
8. Each `expect` panel is there, and each `scope` is kept.

With `-prometheus`, execution:

9. Every panel query returns data: an error fails, and so does an empty answer, naming the literal `label="value"` matchers no series of the metric has (values the answer did not take from the store).
10. Every query variable (`label_values`, `query_result`) has values.

An answer passes when every check does. The checks follow what an AI builder must do: plan, try each query on the store and leave no empty panel (Grafana Assistant's dashboard creation), grade by running the query rather than by likeness to a reference, and use only values the store has (execution-based text-to-query benchmarks, Agentic Jackal 2026).

| Case | Asks for |
|---|---|
| 01 | a namespace's CPU and memory (kept to `kube-system`) |
| 02 | nodes: CPU, memory, disk, network |
| 03 | pods that restart often |
| 04 | deployments: desired against available replicas |
| 05 | containers near their memory limit |
| 06 | CPU requested against used |
| 07 | pods by phase |
| 08 | node conditions |
| 09 | network by namespace |
| 10 | firing alerts |

## Results

2026-11-01, the reference answers: 10/10 without a store, and 10/10 with every query run on the dev second cluster's Prometheus (3.15.1) — every panel returned data, every variable had values.

Builder runs go here, one row per model, once the builder exists.
