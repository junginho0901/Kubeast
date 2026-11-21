**English** | [한국어](ko/high-availability.md)

# Running more than one replica

Every Kubeast service runs one pod by default.
This page says which services can run more, what they need, how to set the count or let a HorizontalPodAutoscaler (HPA) set it, and what changes for the people using the console.

## Which services can run more than one

| Service | More than one pod | What a pod keeps | What it needs |
| --- | --- | --- | --- |
| gateway | yes | nothing; a WebSocket stays on the upstream connection it opened | — |
| frontend | yes | nothing (static files) | — |
| auth-service | yes | nothing; its background jobs take turns through database locks, and retention finds nothing left after another pod's run | `migrations.mode: job` (below) |
| session-service | yes | nothing; sessions and messages are in the database | — |
| ai-service | yes | its answer streams; a queued alert investigation is a database row one pod takes; Claude Code runs have a cap per pod (`ai.providers.claudeCode.maxConcurrent`) and one for the install | — |
| k8s-service | yes, with Redis | the lists and watches of the clusters it serves, in its own memory; the list, YAML and Helm caches are in Redis; a cluster's change reaches every pod within 10 s; a node drain's progress is in the database | `redis.enabled: true` |
| tool-server | yes, with Redis | a cluster's kubeconfig for up to 10 s; it hears of a cluster's change through Redis | `redis.enabled: true` |
| ModelConfig controller | no, one pod | nothing; one pod works at a time (leader election), so the chart runs one | — |
| postgres (the chart's) | no, one pod | the data | for a database that outlives a node, use an external PostgreSQL (`postgresql.enabled: false`) |
| redis (the chart's) | no, one pod | caches and change notices only; a new pod starts empty and the caches fill again. While it does not answer, k8s-service's screens read the cluster: a cache command gives up within 0.5 s, and the cache then leaves Redis out for 3 s; a removal of cached entries Redis did not take is made up for by a flush before the cache reads Redis again | — |

The chart refuses `replicas.k8sService` or `replicas.toolServer` above 1 with `redis.enabled: false`, and says why.
It refuses more than one k8s-service pod (`replicas.k8sService` above 1, or `autoscaling.k8sService` with `maxReplicas` above 1) with `sessionRecording.storage: file` too: every pod would mount the one file volume, so record to `s3` or `database` ([Operations](operations.md#terminals-and-followed-logs-on-their-own-server) has the file store's rollout).
`values-minimal.yaml` turns Redis off, so it runs one of each.

## Before you start

- **Redis**: keep `redis.enabled: true` (the chart's default) for more than one k8s-service or tool-server pod.
- **Nodes**: the chart spreads a service's pods across zones and nodes (`topologySpread.enabled`), softly (`ScheduleAnyway`). Two pods land on two nodes only when two nodes can take them; with one node they share it.
- **Migrations**: with two or more auth-service pods, or a large database, set `migrations.mode: job`. With `startup`, pods that start together wait for one another's migration lock, and a wait longer than the 180 s startup probe restarts the waiting pod.
- **Load balancer**: behind one that sends to pod IPs (the AWS Load Balancer Controller in IP mode), label the namespace `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` so a new pod takes traffic only once its target is healthy. Keep `podShutdown.preStopSeconds` longer than the load balancer takes to stop sending new requests to a leaving pod (docs/configuration.md). Behind an AWS Application Load Balancer, set `podShutdown.preStopSeconds: 25` and the target group's deregistration delay to 20 s (`alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=20` in `ingress.annotations`, added to any attributes already listed there): with these no request failed in 18 gateway pod replacements on two days, with one gateway pod and with two, nor in one drain of a node with two pods of each service, which evicted only Kubeast pods. A drain with the defaults had failed requests, but the node it emptied also held the only pod of the AWS Load Balancer Controller, and the gateway target became draining 38 s after its pod was deleted ([Measured on EKS](#measured-on-eks)). Run two or more controller pods (its Helm chart's default `replicaCount` is 2): with one, the load balancer's targets are not updated from the moment that pod is evicted until it runs again on another node. With the defaults (5 s, deregistration delay 300 s) the load balancer still sent new requests to a leaving gateway pod after its wait had ended, its target already draining, up to about 8 s after the pod was deleted, in 3 of 18 replacements (none in 12 more with the readiness gate on), and a third to half of the requests in those 2–3 s failed with 502 or 504. With the readiness gate, no second went by without a healthy gateway target (EKS 1.35, AWS Load Balancer Controller v3.6.2).
- **Database connections**: each pod opens its own pool. Add up the pods you run with the table below and keep the sum under the database's `max_connections`.

| Service | Connections per pod, at most | Where the number comes from |
| --- | --- | --- |
| auth-service | 20 | `postgresql.pool.authService.maxConns` |
| session-service | 20 | `postgresql.pool.sessionService.maxConns` |
| k8s-service | 10, plus 1 | `postgresql.pool.k8sService.maxConns`, and the health status lock (`internal/pglock`), which holds a connection of its own outside the pool; k8s-service-stream has the pool only |
| ai-service | 15 | `postgresql.pool.aiService.maxConns` |
| ModelConfig controller | 4 | `postgresql.pool.modelConfigController.maxConns`; one pod |
| migrations | 4, while they run | the migration pool (`dbsession.MigrationPoolMaxConns`) |
| tool-server, frontend, gateway | 0 | — |

The chart's postgres sets `max_connections` to `postgresql.maxConnections` (300), and an install stops when the pods could hold more: each pool times the pods while a rollout runs (one more than the count, each Deployment's `maxSurge` being 1, and autoscaling's `maxReplicas` where it is on), plus 4 for the migrations and 10 kept for psql and PostgreSQL's superuser slots (`templates/checks/db-connections.yaml`).
An external database has its own limit, which the chart cannot read: NOTES prints the same sum to compare with it. When the Kubeast user is not a superuser, 3 of its connections are kept for superusers by default.
For example, one pod of each service can hold up to 154 connections with a rollout's extra pod counted, and three pods of each 286; `streams.enabled` adds k8s-service's pool for the stream server and its rollout's extra pod (20 by default), 306 with three pods of each, past the default 300.
Raise `postgresql.maxConnections`, lower the pools or the pod counts, or use a database that takes more connections.

## Set the count

```yaml
replicas:
  k8sService: 2
  toolServer: 2
  gateway: 2
  frontend: 2
```

- `pdb.enabled` (on by default) gives each service that runs two or more pods, or whose autoscaling keeps `minReplicas` 2 or more, a PodDisruptionBudget that lets `pdb.maxUnavailable` (1) of its pods be evicted at once; a service of one pod gets none, so it never blocks a drain.
- A service of one pod has nothing to answer from the moment that pod is deleted or evicted (a node drain too) and its preStop wait ends until the new pod is ready, since a deleted pod is not replaced first as a rollout's is: measured on kind, about 1 s for auth-service, k8s-service and session-service and about 6 s for ai-service, the frontend and the gateway, whose readiness probe asks every 10 s (about 16 s when the new pod's first probe comes before it is up); screens get 502, 503 or 504 meanwhile. With two or more pods the others answer while the new one starts, and the PDB keeps a drain from taking them together.

## Let an HPA set the count

```yaml
autoscaling:
  k8sService:
    enabled: true
    minReplicas: 2
    maxReplicas: 3
    targetCPUUtilizationPercentage: 80
```

- One `autoscaling/v2` HorizontalPodAutoscaler per service turned on, off by default. The keys are those of `replicas`.
- While it is on, the chart leaves `spec.replicas` out of that Deployment, so the HPA and the chart do not set the count in turn. `replicas.<service>` is not read.
- It scales on CPU only, as a share of `resources.<service>.requests.cpu`. The chart refuses autoscaling for a service without a CPU request, since the HPA then does nothing.
- There is no memory target: each k8s-service pod holds the lists of the clusters it serves, so more pods do not lower the memory of each.
- 80 is Kubernetes' own default target. Set yours from a load test of your install.
- `maxReplicas` above 1 for k8s-service or tool-server needs `redis.enabled: true`, as `replicas` does.
- The cluster needs metrics-server (`kubectl top pods` answers when it is there).
- The HPA sets a new pod's CPU aside until the pod is ready, so the CPU a k8s-service pod spends on its first lists does not count.

`behavior` goes into the HPA as written. Empty, Kubernetes scales down after 300 s of lower use.
A pod that leaves closes the WebSockets it holds, so for k8s-service you may want slower scale-down, for example:

```yaml
autoscaling:
  k8sService:
    enabled: true
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 600
        policies:
          - type: Pods
            value: 1
            periodSeconds: 300
```

Turning autoscaling on in a running release removes `spec.replicas` from the Deployment.
Kubernetes then sets the count to its default of 1 until the HPA's first sync (every 15 s by default) raises it to `minReplicas`, so all pods but one start to stop.
Turn it on at a quiet time, or follow "Migrating Deployments and StatefulSets to horizontal autoscaling" in the Kubernetes HPA documentation first.
Turning it off puts `replicas.<service>` back.

Check it with `kubectl -n <namespace> get hpa`.

## What changes with more than one pod

- No sticky sessions: any pod answers any request, and the gateway and a load balancer in front need no session affinity.
- A WebSocket (the live lists, a terminal) stays on the pod it opened. When that pod leaves — a rollout, a scale-down, a node drain — the browser connects again and reads the lists again; a followed log goes on after the last line it showed; a terminal ends, as it does on a restart with one pod.
- A node shell's pod is written in the database (`node_shells`) with the k8s-service pod that opened it, which writes every 15 s that it is alive, over one connection it keeps from its pool while it holds a node shell. When that pod is killed (out of memory, a node lost), another k8s-service pod, or the restarted container of the same pod, deletes the shell's pod once the row has had no such write for a minute, looking every 30 s. A shell whose k8s-service pod is alive and reaches the database is never deleted by another: a pod that cannot write the heartbeat for 45 s (the database down, or its own way to it cut) closes its node shells itself first.
- An approved AI write runs on the ai-service pod that took the approval. When that pod is killed, or its shutdown cuts the run, before the outcome is written, the card says "running" until 10 minutes after the approval; then the first ai-service pod to look (a new approval card, the card opened, a pod's first database use) ends it failed as interrupted with an `ai.tool.interrupt` row, one pod for each approval since each ends it, with that row, in one transaction that holds the approval's row. A run takes far less than 10 minutes, so no pod ends a run another pod is still on. Whether the write changed the cluster is not known; nothing runs it again.
- Each k8s-service pod watches the clusters for itself, so two requests that land on two pods can be a watch event apart for a moment.
- Each k8s-service pod keeps the policy reports it read in its own memory for 60 s. A new policy report can take up to a minute to show in a drawer or a list read from the other pod; Refresh on the Policy Reports page reads them again on the pod it reaches.
- Each k8s-service pod lists and watches the clusters it serves: the API server sees that once per pod.
- Each k8s-service pod takes the memory one pod takes; the total grows with the pods.
- Each k8s-service pod answers Cluster View's node boxes from its own informers and keeps the answers it gave the people who may see every namespace: at most 256 nodes and 8 MiB of answers (about 300 bytes a pod), and no pod row. A node's box is made once in each pod while the node's pods stay the same.
- Each k8s-service pod makes its own reads for everyone asking at one moment (a drawer's events, a node's pods, the Timeline's and the events API's events, the Timeline's rollouts): a crowd makes about two of them in each pod, the one under way and one more for those who came during it, so up to about 2N over N pods.
- Limits that protect a pod — memory, work at once, live watches (`multicluster.wsMaxSubscriptions`) and their openings (`multicluster.wsWatchOpeningConcurrency`) — are per pod. So is the client rate to a cluster (`multicluster.clientQPS`): N pods can send N times as much.
- Each k8s-service pod counts the terminals (pod exec, node shell) and followed logs each account holds open on it, and refuses one past `multicluster.maxTerminalsPerAccount` or `multicluster.maxFollowedLogsPerAccount` (20 each). The count is not shared: with N pods taking them (k8s-service, or k8s-service-stream with `streams.enabled`) an account may hold up to N times as many, as the Service spreads them. A pod that leaves (a rollout, a scale down, a node lost) sends its followed logs to the pods that stay, where one past the cap is refused: count on the cap, not on N times it.

## Measured on EKS

These were measured on an EKS 1.35 cluster of three t3.medium on-demand nodes, behind an internal AWS Application Load Balancer that sends to pod IPs (AWS Load Balancer Controller v3.6.2), with the chart's and the load balancer's defaults and no pod readiness gate.
The same cluster's numbers for the upgrade from 0.7.7 are in [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#2-upgrade), and those for the `preStop` wait in [What changes by itself](upgrade-0.7.8.md#4-what-changes-by-itself).

- **Node drain**: on 2026-11-17, with two pods of each of the seven services that can run more than one, and their PodDisruptionBudgets, draining a node that held one pod of each and the Redis pod (the chart's PostgreSQL was on another node) with `kubectl drain` took 10 s, and the PodDisruptionBudgets held back no eviction. While the node was drained and its instance replaced by a new node, no request through the load balancer failed, reading `/healthz` and the dashboard overview through it once a second had no second without an answer, and the live list was back within 1.1 s. On 2026-11-21, on another EKS 1.35 cluster behind an AWS Application Load Balancer, a drain with the same defaults had 4 s without an answer, requests through the load balancer that failed and the live list cut for 23.1 s, but the node it emptied also held the only pod of the AWS Load Balancer Controller (that cluster ran one, so the targets were not updated until it ran again; its Helm chart's default `replicaCount` is 2) and pods of CoreDNS, the EBS CSI controller and metrics-server, and the gateway target became draining 38 s after its pod was deleted, so these numbers are not those of the defaults alone. A drain with `podShutdown.preStopSeconds: 25` and a 20 s deregistration delay evicted only Kubeast pods, its gateway target was draining within 1 s, and it had none of these. The two settings compare in the gateway pod replacements of [Before you start](#before-you-start).
- **HPA**: with an HPA on k8s-service and gateway at the chart's autoscaling defaults (2 to 3 pods at 80 % CPU, `behavior` empty), 32 clients in the cluster reading lists through the gateway for 240 s took both to 3 pods within 58 s, and both were back to 2 pods 337 s after the load ended. Turning the HPAs on took each Deployment to one pod until the HPA's first sync, as above, and closed the live list once, which was back within 1.2 s. No request through the load balancer failed while pods were added and removed, nor when the HPAs were turned on and off.

## Sizing

The rows below were measured on 2026-11-21 the same way as "Many users" in [Architecture](architecture.md#many-users): on kind with one node, KWOK with 50 000 pods and 1 001 nodes, and k8s-service at the chart's 512 Mi.
They compare pod counts with each other; on a real cluster the seconds differ.
T3 is the run of 500 different people keeping the Dashboard, Pods and Cluster View open for 6 minutes, then 100 of them opening those screens at the same instant; its p95 is that of the 6 minutes.

| k8s-service pods | Memory per pod, idle / busy | Memory in total | Watches the API server holds for Kubeast | p95 of 500 people's usual use | Answers other than 200 during a rollout |
| --- | --- | --- | --- | --- | --- |
| 1 | idle p90 113 / busy max 416 MiB | 416 MiB (most at one second of T3, all pods) | informers 7 · at most 1731 during T3 | 17 ms (T3) | 0 of 656 (none) |
| 2 | idle p90 112 · 109 / busy max 322 · 289 MiB | 603 MiB (most at one second of T3, all pods) | informers 14 · at most 1738 during T3 | 31 ms (T3) | 0 of 730 (none) |
| 3 | idle p90 107 · 106 · 103 / busy max 239 · 245 · 265 MiB | 736 MiB (most at one second of T3, all pods) | informers 21 · at most 1745 during T3 | 33 ms (T3) | 0 of 806 (none) |
