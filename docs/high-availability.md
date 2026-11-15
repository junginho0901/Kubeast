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
| redis (the chart's) | no, one pod | caches and change notices only; a new pod starts empty and the caches fill again | — |

The chart refuses `replicas.k8sService` or `replicas.toolServer` above 1 with `redis.enabled: false`, and says why.
`values-minimal.yaml` turns Redis off, so it runs one of each.

## Before you start

- **Redis**: keep `redis.enabled: true` (the chart's default) for more than one k8s-service or tool-server pod.
- **Nodes**: the chart spreads a service's pods across zones and nodes (`topologySpread.enabled`), softly (`ScheduleAnyway`). Two pods land on two nodes only when two nodes can take them; with one node they share it.
- **Migrations**: with two or more auth-service pods, or a large database, set `migrations.mode: job`. With `startup`, pods that start together wait for one another's migration lock, and a wait longer than the 180 s startup probe restarts the waiting pod.
- **Load balancer**: behind one that sends to pod IPs (the AWS Load Balancer Controller in IP mode), label the namespace `elbv2.k8s.aws/pod-readiness-gate-inject: enabled` so a new pod takes traffic only once its target is healthy, and set `podShutdown.preStopSeconds` to the deregistration delay plus a few seconds (docs/configuration.md).
- **Database connections**: each pod opens its own pool. Add up the pods you run with the table below and keep the sum under the database's `max_connections`.

| Service | Connections per pod, at most | Where the number comes from |
| --- | --- | --- |
| auth-service | 20 | `MaxConns = 20` in `services/auth-service-go/cmd/server/main.go` |
| session-service | 20 | `MaxConns = 20` in `services/session-service-go/cmd/server/main.go` |
| k8s-service | the larger of 4 and the CPUs the node gives the process, plus 1 | pgx's default pool size (`runtime.NumCPU()`; the chart sets no CPU limit, so the node's count, not the request) and the health check's lock, which holds a connection of its own |
| ai-service | 15 | SQLAlchemy's default pool: 5, and 10 more under load |
| ModelConfig controller | a few | `database/sql` with no cap; one pod |
| migration Job | a few, while it runs | `migrations.mode: job` |
| tool-server, frontend, gateway | 0 | — |

PostgreSQL's default `max_connections` is 100, and the chart's postgres keeps it.
An external database has its own; when the Kubeast user is not a superuser, 3 of them are kept for superusers by default.
For example, one pod of each service on a node of 8 CPUs can open about 20 + 20 + 9 + 15 = 64 connections, and two pods of each of those four about 128, which is more than 100.
Raise the count of the services that need it (tool-server, the gateway and frontend open none, k8s-service about one per node CPU), or use a database that takes more connections.

## Set the count

```yaml
replicas:
  k8sService: 2
  toolServer: 2
  gateway: 2
  frontend: 2
```

- `pdb.enabled: true` keeps `pdb.minAvailable` pods of every service during a node drain. Turn it on only when every service runs two or more pods: for a service of one pod it blocks the drain.

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
- Each k8s-service pod lists and watches the clusters it serves: the API server sees that once per pod.
- Each k8s-service pod takes the memory one pod takes; the total grows with the pods.
- Limits that protect a pod — memory, work at once, live watches (`multicluster.wsMaxSubscriptions`) — are per pod. So is the client rate to a cluster (`multicluster.clientQPS`): N pods can send N times as much.

## Sizing

The rows below are filled from load runs measured the same way as "Many users" in [Architecture](architecture.md#many-users).
Until then, take one pod's numbers there and multiply them by the pods.

| k8s-service pods | Memory per pod, idle / busy | Memory in total | Watches the API server holds for Kubeast | p95 of 500 people's usual use | Answers other than 200 during a rollout |
| --- | --- | --- | --- | --- | --- |
| 1 | [Resource usage](architecture.md#resource-usage), [Many users](architecture.md#many-users) | same | to be measured | to be measured | to be measured |
| 2 | to be measured | to be measured | to be measured | to be measured | to be measured |
| 3 | to be measured | to be measured | to be measured | to be measured | to be measured |
