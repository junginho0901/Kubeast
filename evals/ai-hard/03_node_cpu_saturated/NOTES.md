# 03 — a batch job takes the node's CPU, unrelated services slow together

Group: chain. Cluster `default`: the node's and the containers' CPU come from the dev Prometheus (node-exporter, cAdvisor) and metrics-server; the services' slowness is in their callers' logs.

Asks (EN gloss): specific "search, price lookups and thumbnail making all got slow at once in shop-03 — why?"; vague "every service in shop-03 is slow, find the cause".

Setup: `search`, `pricing` and `thumbnails` hash a few megabytes per request (CGI on busybox httpd; 20m requests, 1-CPU limits, so nothing throttles them); `storefront` calls search and pricing every 2 s and `image-worker` calls thumbnails every 3 s, each logging the duration. None of the three services calls another. A second namespace `reports-03` (the runner makes and removes it) holds a suspended monthly CronJob `monthly-report`, standing in for another team's batch work on the same node.

The fault: a Job is run by hand from that CronJob (`kubectl create job --from`). It starts one busy process per CPU the node has (`nproc`), with a 500m request and no CPU limit. The node's CPU goes to 100 %; under contention each container gets CPU by its request, so the 20m services get a sliver and their calls go from tens of milliseconds to seconds. Nothing fails.

What the AI has to notice:
- The three slow services share no call, so no one of them is the cause; what they share is the node.
- The node's CPU is saturated from the moment they slowed; the top consumer is the Job in `reports-03`, with no CPU limit.
- The services are not throttled (their limits are far away) and used less CPU while slow, not more.

The trap: blame each service in turn, or `search` (the busiest of shop-03 all along), or a caller; look for a CPU limit (case 09's shape) and find none; or stay inside the asked namespace and miss the Job.

How the scorer judges: cause = the node (`Node/kubeast-b-control-plane`) with kind `node`, or the Job, its pods or its CronJob (kind `node` or `resource_limit`). search, thumbnails and storefront are decoys. Path: the node (or the Job), then a slow service. Start time ±2 min of the Job.

Unsure:
- Not run on kind. The dev clusters have one node each, so the case cannot contrast pods on the saturated node with pods on another; it keeps the grouping by what the services share.
- A kind node is a container on the Docker VM, so its CPU is the VM's, shared with the first cluster's node. Docker gives the two node containers equal weight, so Kubeast's own cluster keeps at least half the VM's CPU, but it slows too. The second cluster's Prometheus (50m request) gets a small share and may scrape late while the Job runs.
- `nproc` in a container without a CPU limit is the VM's CPU count. The sizes (6, 2 and 4 MB per request) are guesses for 30–80 ms before and seconds after; `inject_wait` waits for a search call over 800 ms.
- Whether cAdvisor on this kind version exposes CPU pressure (PSI) per container was not checked; without it the evidence is usage against the node's capacity.
