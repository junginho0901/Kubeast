# 02 — the order queue slows its consumers down, nothing fails

Group: chain, in the hidden set (`hidden: true`). Cluster `self` (logs, objects and their managedFields only).

Asks (EN gloss): specific "order confirmation mails and loyalty points arrive minutes late in shop-02; no errors, they say — why?"; vague "something is off with the shop-02 services, find the cause".

Setup: `order-events` is a message queue stand-in (busybox httpd on 9092): `checkout` publishes about 20 orders a second (about 620 bytes each), and two consumer groups fetch them — `mailer`, which hands each batch to `smtp-relay`, and `points`. A fetch costs a segment read (`SEGMENT_SEEK_SECONDS`, 50 ms) and returns up to 500 orders within the topic's `fetch.max.bytes` (1 MiB), read again on every fetch from the mounted ConfigMap `order-events-config`, as a broker applies a dynamic topic config. The queue logs `topic stats` every 15 s (orders produced, fetches and orders per group, each group's lag) and `topic config reloaded` when its config changes; each consumer logs every 10 s how many orders it handled, its fetches, the oldest order's age and its average fetch time.

The fault: `order-events-config` is applied again with `fetch.max.bytes=1024`. No rollout, no restart. Within the kubelet's ConfigMap sync each fetch returns one order (the first message is always returned whole); a consumer makes ten to fifteen fetches a second, so both groups get ten to fifteen orders a second while about twenty come in. Their lag grows by several orders a second, the oldest order gets minutes old, and nothing fails.

What the AI has to notice:
- Both consumers fall behind together, and they share nothing but the queue; mailer's mail server answers in milliseconds.
- Each consumer now handles one order per fetch with many more fetches; the queue's stats say the same (fetches up, orders per fetch 1, lag growing) and it logged a topic config reload at the moment it began.
- The ConfigMap's data and its managedFields time say what changed; checkout publishes at the rate it always did.

The trap: blame the consumers (they look slow; "add consumers"), the mail server, or the producer; or find nothing because no pod errs, restarts or rolls out.

How the scorer judges: cause = `order-events` (Deployment, ReplicaSet, pod, Service or its ConfigMap) with kind `dependency_slow` or `config_change`. mailer, points, smtp-relay and checkout are decoys. Path: the queue, then a consumer. Start time ±2 min of the apply (the change lands within the kubelet's ConfigMap sync, up to about a minute later).

Unsure:
- Not run on kind. In local busybox 1.38.0 containers (Docker, the same scripts, the config file changed in place): before, checkout published 22 orders a second and each group kept up with a lag of 2; 150 s after the change mailer handled 12 orders a second and points 10 (one per fetch, about 64 ms a fetch), the lags were 1 452 and 1 046 and growing by about 10 and 7 a second, mailer's oldest order 64 s old, no error line in any container, the queue at 38 % of a CPU. On a faster machine a consumer may come closer to the producer; then raise the producer rate (`sleep 0.04`) or the read.
- The queue keeps its messages in the container's file system; a restart of `order-events` empties it and every group starts again at the end.
- The kubelet's ConfigMap refresh delay on kind was not measured; `inject_wait` waits for mailer's oldest order to be 30 s old.
