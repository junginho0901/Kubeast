# 10 — the shared database stalls, several services fail

Group: trap. Cluster `default`, on the OpenTelemetry demo (`scripts/kind-otel-demo.sh up`, metrics on): the evidence is in the traces (Tempo: product-catalog's and accounting's database spans), the call graph and the PostgreSQL receiver's metrics in the second cluster's Prometheus, the database's and the services' logs (Loki), and kafkametrics' consumer lag.

Asks (EN gloss): specific "product lists, recommendations and checkout all fail at once in the otel-demo shop — why?"; vague "errors here and there in the otel-demo shop, find the cause".

Setup: the demo with its load generator. `astronomy-db` (PostgreSQL) is shared: product-catalog reads the products, accounting writes the orders it takes from Kafka. Setup gives the application role a connection limit of 15 (`ALTER ROLE … CONNECTION LIMIT`, as a DBA would), so a pile-up ends in a refusal rather than at the database's 100 Mi memory limit; cleanup takes it off. The runner's namespace `shop-10` holds only `uptime-check`, which asks the shop for the product list and an empty cart every 10 s.

The fault: a schema change run as the database's superuser (`migration.sql`, through `kubectl exec` into the database pod) adds a column to `catalog.products` and one to `accounting.orderitem` inside one transaction that then stays open. Both tables are locked. product-catalog's queries wait, each holding its connection (its pool has no limit, its callers no deadline); once the role's 15 connections are taken the database refuses new ones (`too many connections for role`), and product-catalog answers errors at once. frontend, checkout and recommendation fail through it; accounting's inserts wait and its Kafka lag grows. The database's CPU stays low; no pod restarts, nothing rolls out.

What the AI has to notice:
- Every failing service fails through the same database: product-catalog's errors and its long database spans, accounting's waiting inserts.
- The database's own lines (`FATAL: too many connections for role`) and its metrics (backends at the limit, commits stopped) say it is the one stuck; it does not log the lock waits themselves (`log_lock_waits` is off by default).
- product-catalog changed nothing; the cart, which does not use the database, keeps working.

The trap: blame product-catalog (it returns the errors), or frontend, checkout or recommendation (where users see them), or accounting (its lag); or call the database "fine" because its CPU is low.

How the scorer judges: cause = `astronomy-db` (Deployment, ReplicaSet, pod or Service) with kind `dependency_slow`, `dependency_down` or `config_change`. product-catalog, frontend, checkout, recommendation and accounting are decoys. Path: the database, then product-catalog (or accounting), then where the symptom shows. Start time ±2 min of the schema change.

The alert path: the alert carries `namespace: otel-demo` (and `match` the same), where the cause is, so the investigator's token, which is limited to the alert's namespace, reads it; `job: uptime-check` says what measured the failures, since `uptime-check` itself sits in the case's own namespace, outside that token. The case has no `rule`, so it runs with `--alert-source auto` or `synthetic`; the demo's own rules can fire on the same fault and start investigations of their own.

Unsure:
- Not run on kind. The order of events (waits first, refusals once 15 connections are held) depends on the demo's traffic; at five load-generator users the refusals may take a minute or two to begin.
- The open session is the database's own (the superuser through a local socket); Kubernetes shows no object for it, so the database is the deepest place the AI can name. The `kubectl exec` that runs it stays in the background on the machine running the case until the undo ends the session.
- In a local `postgres:18.4` container (Docker, not kind; the demo's command and 100 MiB limit, the two tables made by hand, a limit of 20 then): the setup step went through the local socket without a password; with `migration.sql` open, 20 sessions of the role waited on the lock and the next ones were refused with `too many connections for role "astronomy_user"`, logged at FATAL; `log_lock_waits` is off; the undo ended the one session, the 20 reads then finished, and neither column was left. The container used 44 MiB idle and 77 MiB with the 20 waiting (about 1.6 MiB a session, clients in another container), so the case sets 15 to leave room for the demo's own connections and data; whether the demo's database stays under its limit was not seen.
- Requests that were waiting when the undo ends the session finish then; frontend and checkout calls held that long may end in the frontend proxy's timeout.
