# 08 — ResourceQuota used up, new pods cannot start

Group: hidden cause, in the hidden set (`hidden: true`). Cluster `self` (events and logs only).

Asks (EN gloss): specific "settlement data hasn't updated for several minutes — why?"; vague "something seems off in shop-08, see what's wrong".

The fault: namespace quota `compute` allows 1 CPU of requests. ledger (100m) + search-indexer (1 × 200m) + the per-minute export Job pod (150m) fit. The runner scales search-indexer to 4 (800m); from the next minute the export Job's pod would take the namespace to 1050m, so the Job controller gets `FailedCreate: exceeded quota` and no export reaches ledger. ledger, the visible service, is healthy and only says its data is getting old.

What the AI has to notice:
- The symptom (stale data) is in ledger, but ledger itself is fine.
- The feeder is the CronJob `settlement-export`: its newest Job has no pods (and later fails on its 240 s deadline).
- The Job's Warning events say exceeded quota; the quota is full because search-indexer was scaled up.

The trap: stop at ledger, or at "the CronJob is failing", or blame search-indexer's scale-up without naming the quota.

How the scorer judges: cause = ResourceQuota `compute`, kind `quota`. search-indexer and the CronJob may be named next to it without penalty (`also_ok`), but alone they miss the cause. Path: quota → export → ledger in that order (indexer optional before the quota). Start time ±2 min of the scale-up.

Why stale data and not latency: a quota that blocks an HPA scale-up needs a CPU-bound app, metrics-server and load tuning, and the latency would depend on laptop speed. A blocked batch makes the same chain (quota → new pod not created → delay) with no timing to tune. A latency version can be added on `default` if wanted.

Unsure:
- Pod creation can race once (an export pod running at the scale-up moment delays the 4th indexer pod by a few seconds); the decoy list notes it.
- busybox `$RANDOM` and `wget --post-data` are assumed to exist in this image.
