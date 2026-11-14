# 09 — CPU limit too low (throttling, no errors)

Group: hidden cause. Cluster `default`: it needs the dev Prometheus that scrapes cAdvisor (`container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_cpu_usage_seconds_total`) and kube-state-metrics (limits).

Asks (EN gloss): specific "the product list is slow, no errors — why?"; vague "the site in shop-09 is slow, find the cause".

The fault: catalog hashes 3 MB per request with a CPU limit of 25m, set from the start (no change to find). Each request needs a few ms of CPU per 100 ms period, so it waits out several periods.

What the AI has to notice:
- Only catalog calls are slow (storefront logs `duration_ms` per upstream; reviews stays fast). No errors, restarts or Warning events.
- catalog's CPU use sits at its limit and most of its CFS periods are throttled; the node is mostly idle.

The trap: "nothing is failing" → no cause, or the top CPU user `recommender` (~20% of a core, under a 1-core limit, not throttled), or the node, or "the app is just slow".

How the scorer judges: cause = catalog with kind `resource_limit`. Start time = when setup was applied, ±3 min (the fault has no onset of its own; see below).

Unsure:
- The numbers are not measured: 3 MB per request and 25m are guesses for "about one second". Tune on the first run so catalog takes 0.5–3 s and never hits storefront's 20 s timeout.
- With the limit set from the start there is no "before" window, which is the point (no change, no error), but it makes the start-time check weak. A variant could start at 500m and patch to 25m after a baseline; then `timeline` shows the change and the case gets easier.
- The node decoy is written `Node/*` (any node); the scorer reads `*` as any one name part.
