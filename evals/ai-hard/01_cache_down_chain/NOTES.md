# 01 — the cart's store stops, checkouts fail two calls up

Group: chain. Cluster `default`, on the OpenTelemetry demo (`scripts/kind-otel-demo.sh up`, metrics on): the evidence is in the demo's traces (Tempo), its call graph (the collector's `traces_service_graph_*` in the second cluster's Prometheus), its logs (Loki) and the cluster's objects and events.

Asks (EN gloss): specific "checkout (payment) does not work in the otel-demo shop — why?"; vague "the otel-demo shop is acting up, find the cause".

Setup: the demo as `kind-otel-demo.sh` installs it, its load generator placing orders. The runner's namespace `shop-01` holds only `uptime-check`, which asks the shop through `frontend-proxy` for the product list and an empty cart every 10 s and logs the status and duration — the runner waits on its lines; the demo's own load is the traffic.

The fault: `valkey-cart`, the cart service's store, is scaled to 0. Its Service has no endpoints; `cart` cannot connect, so every cart call fails (`Can't access cart storage`), and checkout's PlaceOrder fails at its first step, reading the cart. The product pages keep working.

What the AI has to notice:
- The failing requests share one path: frontend → checkout → cart → valkey-cart. Checkout's error names the cart; cart's error names its store.
- `valkey-cart` has 0 replicas since the moment the errors began; nothing else changed.
- `payment` is not failing: its calls stop because checkout never gets that far.
- In the call graph the failing edges end at cart, whose own calls go to `valkey-cart` (a node named by the calling span's `server.address`, the store sends no spans).

The trap: stop at checkout (where the order fails) or at cart (where the errors start); take "결제" literally and blame `payment`; read cart's errors as a cart fault.

How the scorer judges: cause = `valkey-cart` (Deployment, ReplicaSet, pod, Service or Endpoints) with kind `dependency_down`. `cart` may be named beside it (`also_ok`); alone it misses the cause. checkout, payment and frontend are decoys. Path: valkey-cart, then cart, then where the symptom shows (checkout, frontend or frontend-proxy). Start time ±2 min of the scale.

Unsure:
- Not run on kind. How long a cart call takes to fail (the client's connect retries) and whether cart's errors come as spans with the exception or only as status was read from the demo's source (`ValkeyCartStore.cs`, 3.1.0), not measured.
- The `server.address` of cart's store spans (StackExchange.Redis instrumentation) is expected to be `valkey-cart`; if it is missing, the call graph names the store by `db.system` instead.
- The scale shows as an event and in kube-state-metrics' replica series, so a view of recent changes finds it quickly; the case measures whether the answer still follows the calls to it.
- A new `valkey-cart` pod after the undo starts empty: carts placed before the fault are gone, which the cooldown absorbs.
- `uptime-check`'s status parsing (busybox `wget -S`: 200, 404 and 502 read from the status line) was run in a local busybox 1.38.0 container against busybox httpd, not against the demo.
- The collector's configuration with the `service_graph` connector passed `otelcol-contrib validate` of the demo's collector image (0.160.0, with its `service.profilesSupport` gate); the series it writes were not seen.
