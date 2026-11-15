# 03 — a batch job takes the node's CPU, unrelated services slow together

Group: chain. Cluster `default`: the node's and the containers' CPU come from the dev Prometheus (node-exporter, cAdvisor) and metrics-server; the services' slowness is in their callers' logs.

Asks (EN gloss): specific "search, price lookups and thumbnail making all got slow at once in shop-03 — why?"; vague "every service in shop-03 is slow, find the cause".

Setup: `search`, `pricing` and `thumbnails` hash a few megabytes per request (CGI on busybox httpd, kept on the node's CPU 1 with `taskset`; 20m requests, 1-CPU limits, so nothing throttles them); `storefront` calls search and pricing every 2 s and `image-worker` calls thumbnails every 3 s, each logging the duration. None of the three services calls another. A second namespace `reports` (the case's `setup_cmds` and `cleanup_cmds` make and remove it by name; no case number and no `kubeast.io/ai-eval` label) holds a suspended monthly CronJob `monthly-report`, standing in for another team's batch work on the same node.

The fault: a Job is run by hand from that CronJob (`kubectl create job --from`). It starts two busy processes on CPU 1, the one the shop services' servers run on, with a 500m request and no CPU limit. That CPU goes to 100 %; under contention each container gets CPU by its request, so the 20m services get a sliver and their calls go from tens of milliseconds to most of a second. Nothing fails.

What the AI has to notice:
- The three slow services share no call, so no one of them is the cause; what they share is the node.
- The CPU they run on is saturated from the moment they slowed (node-exporter's per-CPU series; the node's total rises by one CPU's share); the top consumer is the Job in `reports`, with no CPU limit.
- The services are not throttled (their limits are far away) and used less CPU while slow, not more.

The trap: blame each service in turn, or `search` (the busiest of shop-03 all along), or a caller; look for a CPU limit (case 09's shape) and find none; or stay inside the asked namespace and miss the Job.

How the scorer judges: cause = the node (`Node/kubeast-b-control-plane`) with kind `node`, or the Job, its pods or its CronJob (kind `node` or `resource_limit`). search, thumbnails and storefront are decoys. Path: the node (or the Job), then a slow service. Start time ±2 min of the Job.

The alert path: the cause is in `reports` and on the node, outside a token limited to `shop-03`, so the alert is sent with an empty `namespace` label, which the webhook reads as none: the investigator gets a token for the whole cluster (its ClusterRole reads nodes, Jobs and CronJobs) and the annotations name `shop-03`. `match` holds the same empty namespace; the case has no `rule`, so it runs only with `--alert-source auto` or `synthetic`.

Unsure:
- Not run on kind. The dev clusters have one node each, so the case cannot contrast pods on the saturated node with pods on another; it keeps the grouping by what the services share.
- A kind node is a container on the Docker VM, so its CPUs are the VM's. CPU 1 must exist (a VM of two CPUs or more). Other processes leave the busy CPU, so the first cluster and the second cluster's Prometheus lose about one CPU, not half the VM.
- Why one CPU: the Job used to start one busy process per CPU of the Docker VM (`nproc`), which also slowed the first cluster, Kubeast and the second cluster's Prometheus. With two processes and nothing kept to a CPU, the services' requests would run on the other CPUs and not slow at all, so the services' servers and the Job share CPU 1 (`taskset`, which an unprivileged process may set for itself), standing in for a small node. The case now takes one of the VM's CPUs. The pin is in both specs, so a model that compares them can see the shared CPU without the metrics.
- Measured in local busybox 1.38.0 containers (not on kind) with the same scripts, weights 512 and 20 as the requests give: search (6 MB) answered in 60–70 ms alone and in 640–830 ms with the Job, which used one CPU; `inject_wait` waits for a search call of 500 ms or more. pricing (2 MB) and thumbnails (4 MB) slow in proportion.
- Whether cAdvisor on this kind version exposes CPU pressure (PSI) per container was not checked; without it the evidence is usage against the node's capacity.
