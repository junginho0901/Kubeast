# 21 — an OOM cascade through a search cluster

Group: hidden cause. Cluster `default`: the memory steps are clearest in the dev Prometheus (cAdvisor working set, kube-state-metrics restarts and limits); the logs and pod states alone are enough.

Asks (EN gloss): specific "product search doesn't work — why?"; vague "the product pages in shop-21 are acting strange, find the cause".

Setup: `search` is a StatefulSet of three index nodes (`Parallel`, headless Service `search-peers` that also lists pods not yet ready). Each node holds its share of the indexes in memory: the sizes in `INDEXES` (66 MB) divided by the nodes that hold shards, found by asking each peer's `/cgi-bin/state`. A node that loses a peer takes over its share at once and logs `node left, taking over its shards`; a node starting while no peer holds shards forms the cluster with the peers that answer. It is Ready (`/cgi-bin/health`) only once loaded. With 66 MB a node holds 22 MB of three and 33 MB of two, under its 48Mi limit, so it survives one loss. `storefront` searches every 2 s; `report-builder` runs an aggregate query every two minutes.

The fault: a third index (`questions:39`) in a new ConfigMap `search-indexes-2`, and the StatefulSet pointed at it. The rolling update replaces `search-2` (it loads 35 MB of three) and then deletes `search-1`: `search-2` now needs 53 MB of two and is OOMKilled; `search-0`, still on the old settings, needs 66 MB alone and is OOMKilled; each restart finds too few nodes holding shards and dies again. Search stays down.

What the AI has to notice:
- Every search pod restarts with `OOMKilled`, the old-revision pod too, one after another, each right after a `node left, taking over its shards` line with a larger `shard_memory_mb`.
- The change: the StatefulSet's new revision reads `search-indexes-2`, which adds 39 MB to what three 48Mi nodes hold; with it the cluster has no room to lose one node, and its own rolling update removes one.
- `report-builder`'s queries are small and steady; the node is not short of memory.

The trap: blame the last pod to die, the "heavy" periodic report, or "the new pods fail" (the old one died too); or call it a crash without the memory arithmetic.

How the scorer judges: cause = what changed, the new ConfigMap `search-indexes-2` (the third index), with kind `config_change` or `rollout`. The StatefulSet, its pods and its Service may be named beside it (`also_ok`); alone they miss the cause: `search` with `oom` is what the pod states show, and `search` with `rollout` stops at "the new pods fail", which the old pod's death contradicts. `report-builder`, `storefront` and the node are decoys. Path: `search-indexes-2`, then `search`, then `storefront`. Start time ±2 min of the patch.

Why not the StatefulSet with a change kind, as in case 20: there the release alone breaks the new pods; here the rollout only removes a node, and what leaves no room for that is the bigger index, which only the ConfigMap names.

Unsure:
- Checked in local busybox 1.38.0 containers with a 48m limit (not on kind): three nodes form at 22 MB each (about 26 MB in the cgroup), survive a loss at 33 MB (38 MB), and with the third index a node at 35 MB of three is OOMKilled at 53 MB of two, after which the old node dies at 66 MB alone. kind's kubelet, the StatefulSet controller's timing and the restart back-off were not part of that check.
- Whether search ever comes back by itself before the question depends on the back-off timing: it needs all three nodes up at once. The OOMKilled states and the log lines stay either way.
- Shards and memory are a model in the shell, not a search engine.
