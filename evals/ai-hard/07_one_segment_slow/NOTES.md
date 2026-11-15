# 07 — one call between two services slows down

Group: hidden cause. Cluster `default`, on the OpenTelemetry demo (`scripts/kind-otel-demo.sh up`, metrics on) with Chaos Mesh (`scripts/kind-chaos.sh up`): the evidence is in the traces only — client and server spans of the same call (Tempo), the span metrics and the call graph in the second cluster's Prometheus. Pods, events, logs and container metrics stay as they were.

Asks (EN gloss): specific "product pages of the otel-demo shop got slow — why?"; vague "something is a bit off with the otel-demo shop, take a look".

Setup: the demo with its load generator. The runner's namespace `shop-07` holds only `uptime-check`, which asks the shop for one product and an empty cart every 10 s and logs the duration — the runner waits on its lines.

The fault: a Chaos Mesh NetworkChaos (in namespace `chaos-mesh`, where the controller runs) holds every packet product-catalog's pods send to frontend's pods for 700 ms. product-catalog answers as fast as ever, and its server spans say so; frontend's client spans of the same calls are 700 ms longer. product-catalog's other callers (checkout, recommendation) and frontend's other calls (cart, currency, recommendation) are untouched. Nothing fails.

What the AI has to notice:
- The slow requests are frontend's product calls; in a trace, frontend's client span to product-catalog is long while product-catalog's server span inside it is short — the time is between them.
- product-catalog is fast for checkout and recommendation, and its database spans are fast, so the server is not slow.
- No pod restarted, nothing rolled out, no container's CPU or memory moved.

The trap: name product-catalog as the slow service (its span metrics' server latency says otherwise); name frontend alone; blame its database; or find nothing because no metric of a pod moved.

How the scorer judges: the segment is scored as its two ends — causes frontend and product-catalog, both kind `dependency_slow`, named as two causes or as one ("frontend → product-catalog"). Either alone misses the other. recommendation, checkout, astronomy-db, currency and the node are decoys. Path: product-catalog, then frontend (or frontend-proxy). Start time ±2 min of the experiment.

Unsure:
- Not run on kind. Chaos Mesh's delay needs the netem queueing discipline in the kind node's kernel (the Docker VM's), not checked.
- Why the delay sits on product-catalog's side: frontend calls the Service's cluster IP, which kube-proxy rewrites outside frontend's network namespace, so a filter on product-catalog's pod addresses there would see no packet; product-catalog's replies carry frontend's pod address as written. Read from how kube-proxy and Chaos Mesh's `direction`/`target` work, not tested.
- Delaying product-catalog's ACKs too makes frontend resend early; the client spans may grow by more than 700 ms.
- The experiment object sits in `chaos-mesh`; a model that lists that namespace's objects reads the answer there. It has a 30-minute `duration` in case the undo does not run.
- The call graph reads the server side of each call for its latency (`traces_service_graph_request_server_seconds_bucket`), so its p90 for this edge does not move and its failing list stays empty; the case measures whether the traces themselves are read.
