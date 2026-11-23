# 17 — a periodic job reads a whole table, the database's disk queue slows everyone

Group: trap. Cluster `default`: the CPU part of the trap is read from the dev Prometheus (cAdvisor); the cause itself is in logs and object specs.

Asks (EN gloss): specific "order history and invoices are both slow — why?"; vague "the services in shop-17 are slow overall, find the cause".

Setup: `orders-db` is a database stand-in (busybox httpd on 5432). Its four numbers are in a mounted file (`orders-db-conf`, `storage.conf`) under plain names rather than in environment variables that would spell out the mechanism: a query that names `since_id` reads `row_count - since_id` rows at 20 000 rows/s; while it runs it keeps 8 reads in the disk queue (`io_depth`), and every query waits 40 ms per queued read (`io_latency_ms`). It logs a `slow query` line (client, the query, `rows_examined`, `io_wait_ms`) for anything over 500 ms and a `storage stats` line every 15 s (range reads running, disk queue depth, read IOPS, the oldest running query and its client). The CronJob `reminder-sender` runs every minute and reads reminders since `LAST_SENT_ID` from its ConfigMap (6 599 880: 120 rows, a few ms). `storefront` and `invoices` make point reads every 2 and 3 s; `feed-builder` hashes 30 MB every 3 s and never talks to the database.

The fault: a new ConfigMap `reminder-sender-v2` without `LAST_SENT_ID`, and the CronJob pointed at it. The job falls back to `since_id=0`, so each run reads all 6.6 million rows (330 s). A new run starts every minute while the older ones are still reading; after five or six minutes the disk queue holds 40–48 reads and every point read waits 1.6–2 s. CPU stays where it was.

What the AI has to notice:
- Both callers slowed down at the same moment, and both call `orders-db`; their own logs show only the duration.
- `orders-db`'s CPU is near zero, so "the database is fine" is the wrong reading; its `storage stats` lines show the disk queue, and the oldest running queries belong to `reminder-sender`.
- The slow query log is full of the callers' point reads (`rows_examined=1`, almost all of it `io_wait_ms`) and a few reads by `reminder-sender` with millions of rows examined and `id > 0`.
- The job's own log says `since_id=0`; its ConfigMap reference changed to one without `LAST_SENT_ID`.

The trap: blame the callers, or `feed-builder` (the busiest pod by CPU), or call the database "slow" without what loads it; or look for a CPU alert and find nothing.

How the scorer judges: cause = the CronJob `reminder-sender` (its Jobs, pods and the new ConfigMap count as the same cause) with kind `config_change`, or `storage` or `rollout`. `orders-db` may be named beside it (`also_ok`); alone it misses the cause. Path: the job, then `orders-db`, then a caller. Start time ±2 min of the change (the first full read starts at the next minute).

Unsure:
- The disk is a model, not a disk: the wait per queued read is a formula in the CGI, so kind's real disk and the laptop do not change the numbers. cAdvisor's disk counters for the pod stay flat, which a real database would not show; the stats line stands in for the database's own metrics.
- The CGI that sleeps through a 330 s read keeps one shell and one httpd child per running read; about six at once. Not measured on kind.
- The callers' point reads are slow only while range reads run; the first slow line comes about a minute after the change. `inject_wait` waits for a queue of 16 (two range reads at once). On the first kind runs it never came true, at 300 s or at 480 s: Kubernetes reduces `$$` to `$` in a container's `args`, so every range read marked itself in the same file `/tmp/running/$`, each point read removed it, and the stats lines showed a queue of 0. The CGI's two lines write `$$$$`, which the shell gets as `$$`, its own process ID.
- Whether busybox httpd keeps a CGI running after the client (the job pod) has gone was not checked; the read is meant to go on, as a database query does.
