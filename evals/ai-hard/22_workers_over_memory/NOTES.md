# 22 — more workers than the memory limit holds

Group: hidden cause. Cluster `default`: the memory climb before each kill is clearest in the dev Prometheus (cAdvisor working set, kube-state-metrics restarts and the limit); pod states, events and logs alone are enough.

Asks (EN gloss): specific "the API drops out every few minutes — why?"; vague "people say the shop-22 service is unstable, find the cause".

Setup: `shop-api` (2 pods, 64Mi limit) starts `WEB_WORKERS` worker processes from its ConfigMap `shop-api-settings` next to its HTTP server. Each worker fills a page cache of `WORKER_CACHE_MB` (12 MB) one megabyte every 8 s, then holds it. If any worker is gone the server logs `worker exited, stopping all workers` and exits, as a service manager that stops the whole unit when one process is killed. With 3 workers a pod settles at about 40 MB. `session-cache` holds 38 MB under a 48Mi limit, steady. `visitor` calls the API every 2 s.

The fault: `WEB_WORKERS` 3 → 6 in the ConfigMap and a `rollout restart` (settings sized for a larger machine). Six caches need about 78 MB; about 90 s after each start the kernel kills a worker (or the whole container), the pod restarts with `OOMKilled`, warms up and is killed again, with the restart back-off growing in between. Both pods do it at nearly the same rhythm, so the API drops out for stretches.

What the AI has to notice:
- Both `shop-api` pods restart repeatedly with `OOMKilled`, each about a minute and a half after starting, not at random.
- The restarts began with the rollout that followed the ConfigMap change; the startup line says `workers=6`.
- Memory climbs steadily from each start to the limit: workers × cache, not a sudden spike; 3 workers fit.

The trap: name `session-cache` (the highest memory use against its limit), the node, or just "raise the limit" without the worker count; or call it a crash loop without the change.

How the scorer judges: cause = `shop-api` (Deployment, its ReplicaSet or pods, or `shop-api-settings`) with kind `oom`, `config_change` or `resource_limit`; the prose check asks for the worker setting. `session-cache`, the visitor and the node are decoys. Path: the ConfigMap, `shop-api`, then the visitor. Start time ±2 min of the change.

Unsure:
- In a local busybox 1.38.0 container with a 64m limit (not on kind), six workers of 12 MB were killed near the 64 MiB limit with the container's `OOMKilled` set and the master's exit 1; three workers settled at about 40 MB. On kind the kubelet may set `memory.oom.group`, in which case the whole container is killed at once (exit 137) and the master's line is not printed.
- The scorer cannot tell "limit too low" from "too many workers" at the resource level; the prose check carries that difference.
