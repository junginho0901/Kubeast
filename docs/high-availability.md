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
| redis (the chart's) | no, one pod | caches and change notices only; a new pod starts empty and the caches fill again. While it does not answer, k8s-service's screens read the cluster: a cache command gives up within 0.5 s, and the cache then leaves Redis out for 3 s | — |

The chart refuses `replicas.k8sService` or `replicas.toolServer` above 1 with `redis.enabled: false`, and says why.
`values-minimal.yaml` turns Redis off, so it runs one of each.

## Before you start

- **Redis**: keep `redis.enabled: true` (the chart's default) for more than one k8s-service or tool-server pod.
- **Nodes**: the chart spreads a service's pods across zones and nodes (`topologySpread.enabled`), softly (`ScheduleAnyway`). Two pods land on two nodes only when two nodes can take them; with one node they share it.
- **Migrations**: with two or more auth-service pods, or a large database, set `migrations.mode: job`. With `startup`, pods that start together wait for one another's migration lock, and a wait longer than the 180 s startup probe restarts the waiting pod.
- **Load balancer**: behind one that sends to pod IPs (the AWS Load Balancer Controller in IP mode), label the namespace `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` so a new pod takes traffic only once its target is healthy. Keep `podShutdown.preStopSeconds` longer than the load balancer takes to stop sending new requests to a leaving pod (docs/configuration.md). Behind an AWS Application Load Balancer with its default deregistration delay (300 s), the default 5 s let no request fail while one or two gateway pods were replaced, with the readiness gate and without it; with it, no second went by without a healthy gateway target (EKS 1.35, AWS Load Balancer Controller v3.6.2).
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
- Each k8s-service pod watches the clusters for itself, so two requests that land on two pods can be a watch event apart for a moment.
- Each k8s-service pod keeps the policy reports it read in its own memory for 60 s. A new policy report can take up to a minute to show in a drawer or a list read from the other pod; Refresh on the Policy Reports page reads them again on the pod it reaches.
- Each k8s-service pod lists and watches the clusters it serves: the API server sees that once per pod.
- Each k8s-service pod takes the memory one pod takes; the total grows with the pods.
- Each k8s-service pod answers Cluster View's node boxes from its own informers and keeps the answers it gave the people who may see every namespace: at most 256 nodes and 8 MiB of answers (about 300 bytes a pod), and no pod row. A node's box is made once in each pod while the node's pods stay the same.
- Limits that protect a pod — memory, work at once, live watches (`multicluster.wsMaxSubscriptions`) and their openings (`multicluster.wsWatchOpeningConcurrency`) — are per pod. So is the client rate to a cluster (`multicluster.clientQPS`): N pods can send N times as much.

## Measured on EKS

These were measured on an EKS 1.35 cluster of three t3.medium on-demand nodes, behind an internal AWS Application Load Balancer that sends to pod IPs (AWS Load Balancer Controller v3.6.2), with the chart's and the load balancer's defaults and no pod readiness gate.
The same cluster's numbers for the upgrade from 0.7.7 are in [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#2-upgrade), and those for the `preStop` wait in [What changes by itself](upgrade-0.7.8.md#4-what-changes-by-itself).

- **Node drain**: with two pods of each of the seven services that can run more than one, and their PodDisruptionBudgets, draining a node that held one pod of each and the Redis pod (the chart's PostgreSQL was on another node) with `kubectl drain` took 10 s, and the PodDisruptionBudgets held back no eviction. While the node was drained and its instance replaced by a new node, no request through the load balancer failed, reading `/healthz` and the dashboard overview through it once a second had no second without an answer, and the live list was back within 1.1 s.
- **HPA**: with an HPA on k8s-service and gateway at the chart's autoscaling defaults (2 to 3 pods at 80 % CPU, `behavior` empty), 32 clients in the cluster reading lists through the gateway for 240 s took both to 3 pods within 58 s, and both were back to 2 pods 337 s after the load ended. Turning the HPAs on took each Deployment to one pod until the HPA's first sync, as above, and closed the live list once, which was back within 1.2 s. No request through the load balancer failed while pods were added and removed, nor when the HPAs were turned on and off.

## Sizing

The rows below are filled from load runs measured the same way as "Many users" in [Architecture](architecture.md#many-users).
Until then, take one pod's numbers there and multiply them by the pods.

| k8s-service pods | Memory per pod, idle / busy | Memory in total | Watches the API server holds for Kubeast | p95 of 500 people's usual use | Answers other than 200 during a rollout |
| --- | --- | --- | --- | --- | --- |
| 1 | [Resource usage](architecture.md#resource-usage), [Many users](architecture.md#many-users) | same | to be measured | to be measured | to be measured |
| 2 | to be measured | to be measured | to be measured | to be measured | to be measured |
| 3 | to be measured | to be measured | to be measured | to be measured | to be measured |
