# 05 — one service's DNS is broken

Group: hidden cause. Cluster `default` (only logs are needed; any kind cluster works).

Asks (EN gloss): specific "storefront can't look up stock — why?"; vague "part of the shop-05 service doesn't work, find the cause".

The fault: storefront is rolled out with `dnsPolicy: None` and a hand-written `dnsConfig` (the cluster DNS address, `ndots: 2`, search list `svc.cluster.local cluster.local`). The search list lacks `shop-05.svc.cluster.local`, so the short name `inventory` no longer resolves from storefront, while the full name it uses for catalog still does. This is the plain-object stand-in for Chaos Mesh's DNSChaos on one workload.

What the AI has to notice:
- storefront logs `wget: bad address 'inventory:8080'` for inventory only; catalog calls from the same pod succeed.
- inventory is healthy: Ready, endpoints present, and `reports` reads it every 5 s without errors. Cluster DNS is fine.
- The difference is in storefront's own pod spec (dnsPolicy / dnsConfig), visible in its new ReplicaSet and with `k8s_get_resource_yaml`.

The trap: blame the callee (inventory "unreachable"), the Service, or CoreDNS.

How the scorer judges: the cause is storefront (Deployment, or its ReplicaSet / pod) with kind `dns`. `rollout` or `config_change` alone does not count: the case is about recognising DNS. inventory, its Service or CoreDNS named as causes are decoys. Start time ±2 min of the patch. The second scoring takes storefront with kind `rollout` or `config_change` when the answer says, in a sentence that names storefront, that its DNS settings changed or lack the namespace. A change told without that is still a miss (`scoring.json`).

Unsure:
- The patch is a rollout, so `timeline` shows it; an AI can get there from "what changed" without reading the DNS error. That is realistic, but it makes the case easier than DNSChaos (no spec change).
- Exact busybox wget wording for an NXDOMAIN ("bad address") and that busybox's resolver honours the search list and ndots were not checked on this image.
- `kube-system/kube-dns` is the Service name on kind; the inject step reads its address instead of assuming 10.96.0.10.
