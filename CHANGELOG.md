# Changelog

What changed in each Kubeast release, newest first, in the form of [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). This file starts at 0.7.8. Earlier releases are described on the [GitHub releases page](https://github.com/junginho0901/Kubeast/releases), and each release's notes there list every change with its pull request.

## [0.7.8] - Unreleased

Kubeast can run more than one pod of a service. k8s-service and tool-server run several replicas with the chart's Redis, every service can have an HPA, and what one server kept in its memory (cluster changes, node drain progress, Claude Code runs, session recordings, the audit anchor) moves to PostgreSQL, so another server reads the same. Pods being replaced finish what they hold before they stop.

### Upgrading from 0.7.7

Read [Upgrading from 0.7.7 to 0.7.8](docs/upgrade-0.7.8.md) first. Some installs have to act:

- The cluster Kubeast runs in needs Kubernetes 1.30 or later for the pod shutdown wait. On an older one, set `podShutdown.preStopSeconds: 0`.
- `pdb.minAvailable` is no longer read. An upgrade that still sets it stops and says to set `pdb.maxUnavailable`.
- With auth-service, session-service and ai-service at 4 pods each, the database connections add up to 319, past the chart PostgreSQL's 300, and the upgrade stops at the render check. Raise `postgresql.maxConnections` or lower `postgresql.pool.<service>.maxConns` before you upgrade.
- A custom role whose name makes another role's group (`a-b` beside `a b`, `ADMIN` beside the built-in `Admin`) is renamed and loses its cluster grants. Role names outside ASCII get new groups (`운영팀` acts as `kubeast:role:~c6b4~c601~d300`, it was `kubeast:role:---`), so RBAC bound to the old group on registered clusters has to be bound to the new one. Back up the database first: a rollback does not undo the renames.
- Finish node drains in progress before you upgrade.
- The default model is `gpt-6-luna`. Saved model settings, an `ai.model` in your values and a Compose `.env` keep their model; change those that name `gpt-4o-mini`, which OpenAI shuts down on 2027-01-14, before then.
- With `secrets.existingSecret`, Redis keeps one password until the per-service Redis users' passwords are in a Secret (`redis.acl.existingSecret`, or the main Secret with `redis.acl.existingSecretHasKeys: true`).
- Upgrade with `--reset-then-reuse-values`. `--reuse-values` stops with that hint, as in 0.7.7.

### Added

- More than one replica: `replicas.k8sService` and `replicas.toolServer` above 1 with `redis.enabled: true`; `autoscaling.<service>`, an HPA on CPU for each of the seven services, off by default; a PodDisruptionBudget for each Deployment that can be down to two pods or more (`pdb.enabled` is now `true`, `pdb.maxUnavailable` 1). See [Running more than one replica](docs/high-availability.md).
- A shutdown wait before SIGTERM for pods behind a Service (`podShutdown.preStopSeconds`, 5 s). `/livez` and `/readyz` on every Go service. When a pod stops, live lists and followed logs reconnect to a pod that stays, and a terminal ends with a line saying the server is restarting.
- A stream server of its own for terminals, node shells and followed logs (`streams.enabled`, off by default). Open terminals get `streams.drainSeconds` (60) when it is replaced.
- One Redis user per service on the chart's Redis (`redis.acl.enabled`, on by default; passwords in the Secret `kubeast-redis-users`).
- Database session limits on every service's connections (`postgresql.sessionLimits`, on by default), a pool size per service (`postgresql.pool.<service>.maxConns`) and a render check of their sum against `postgresql.maxConnections` (300). Behind PgBouncer, use session pooling.
- Install-wide Claude Code slots in the database (`ai.providers.claudeCode.maxConcurrentTotal`, `queueWaitSeconds`, `memoryLimit`). A chat turn waits for a slot and says so.
- Node drain progress in the database: a drain cut short reads "Interrupted", with Start again.
- Live lists come back a few at a time after a restart (`multicluster.wsWatchOpeningConcurrency`, 8) and are asked as watch lists; each list's HTTP/2 window is `multicluster.wsWatchStreamWindowKiB` (1 MiB).
- Allowed read checks of the screens served from Kubeast's shared cache can be asked once per group set instead of once per person (`sharedReadChecks.enabled` in the chart's `auth` settings, beside `customRoles`, off by default). Turn it on only where every authorizer of the cluster answers by groups as RBAC does; [Cluster requirements](docs/cluster-requirements.md) §1 has the commands that check it.
- Metrics on k8s-service's `/metrics`: `kubeast_k8s_client_rate_wait_seconds`, `kubeast_k8s_client_rate_waits_total`, `kubeast_k8s_access_reviews_total`, `kubeast_terminals_open` and `kubeast_followed_logs_open`. `gateway.accessLog.upstreamTimes` adds each request's upstream times to the gateway's access log.
- GPT-6 Sol and GPT-6 Luna (`gpt-6-sol`, `gpt-6-luna`) in the OpenAI model list, sent with `reasoning_effort: "none"` so their tool calls go through.
- Cluster View pages its node boxes, ten a page with up to twelve pod cards each, and opens a node's own view with all its pods. The node map can be used with a screen reader.
- The floating chat opens and closes with ⌘/ on a Mac and Ctrl+/ elsewhere.
- [Upgrading from 0.7.7 to 0.7.8](docs/upgrade-0.7.8.md) and a [threat model page](docs/threat-model/v0.7.8.md) for this release.
- For development: `scripts/upgrade-rehearsal.sh`, which upgrades the previous release to the checkout on a kind cluster of its own, and the opt-in e2e projects `fault`, `rollout` and `ai-layers`.

### Changed

- The default AI model is `gpt-6-luna`, in place of `gpt-4o-mini`. Docker Compose without `.env` runs it too, in place of `gpt-4`.
- Cluster requests go as the signed-in person: the server version and API discovery reads a screen opens now name the person in the target cluster's audit log, and a request whose context names no person is not sent unless it is Kubeast's own.
- Signing out ends the sign-in on the server: its tokens are refused and cannot be refreshed, and its open connections in other tabs close.
- No two roles share a group, and role names outside ASCII get distinct groups. A grant, an approval or an OIDC group sync of a role sharing another role's group is refused (400 `role_same_group`).
- The chart's PostgreSQL starts with `max_connections` from `postgresql.maxConnections` and restarts once on this upgrade. The chart's Redis has a memory cap (80 % of its memory limit, `volatile-lru`).
- Service Deployments roll one new pod at a time and stop an old one only once the new one is ready.
- The migration Job runs each try in a pod of its own and ends at 10 minutes.
- k8s-service's cluster breaker tries one request again after `multicluster.breakerOpenSec`, `multicluster.breakerConsecutiveFails: 0` turns it off, and only a request whose calls could not reach the API server counts as a failure. Its health check reads each cluster's `/version` behind none of the people's requests, and an answer below 500 closes the breaker.
- New live lists wait while k8s-service is short of memory, past 80 % of its Go memory limit, with a notice on the page.
- A grant limited to namespaces opens the Dashboard with fewer requests to the cluster, and an idle live-list socket holds 18 KiB instead of 47 KiB.
- Cluster View's node boxes are answered from the pod rows k8s-service keeps, once its informers run, instead of a list of the node's pods, and a pod's window opened from a box reads the pod before it shows its containers.
- Cache keys move under `kubeast:cache:`, and a cluster change deletes only those keys.
- Alert start times are kept in UTC, whatever offset the sender writes.
- Docker Compose gives the Kubeast services 35 s to stop and PostgreSQL and Redis 30 s (Docker's default is 10 s).
- API answers: a Deployment row carries `current_replicas`, event frames carry `involved_object.uid`, `/cluster/api-resources` lists resources in kubectl's order, `GET /auth/roles` adds `same_group_as`, and `GET /cluster/pods/on-node` answers a box row per pod: the full row's `name`, `namespace`, `node_name`, `pod_ip`, `status`, `phase`, `restart_count`, `created_at` and `labels`, with `health` and `health_reason`, and no containers.

### Deprecated

- `gpt-4o` and `gpt-4o-mini` are marked deprecated in the OpenAI model list.

### Removed

- `pdb.minAvailable`. Set `pdb.maxUnavailable` instead.
- `o4-mini`, `gpt-5` and `gpt-5-mini` from the OpenAI model list. A saved setting naming one still opens, as a custom model name.

### Fixed

- No list, window or drawer draws one read's rows as another's after a switch of filter, tab, namespace, object or cluster.
- A list on Fit holds the rows that end inside its table, each measured at its own height, where 0.7.7 took the first row's height for every row: a list whose rows wrap holds another number of rows a page, and on the page it is counted on, no last row sticks out past the table's bottom.
- A live socket that connects again reads its lists again, so rows deleted while it was closed go; frames that come while a list is read are applied to its answer; the Helm releases stream goes on from the last version it saw.
- Session-end audit rows are written even when the browser has already closed the connection.
- The floating chat is told what a screen says for a read that was refused, failed or is not installed, instead of zero.
- Monitoring's Nodes and Pods tabs no longer ask every 5 s on a cluster without metrics-server, and show a refused metrics read in the cluster's words.
- Prometheus sections say when the cluster's Prometheus does not answer, and that no longer marks the whole cluster unreachable.
- Secret files stay readable with `podSecurity.enabled: false`.
- A values file copied from 0.7.6 or earlier stops on its release image tag instead of keeping that release's images.
- A chat answer whose stream was cut is saved once, under its question.
- Teams says under the name field why Add did not add a team with no name, where it only moved the focus to the field.
- For development: tests that failed now and then on a busy runner, or read one pod where a service can run two, wait on what they check, and the guard's build to compare with (`scripts/before-stack.sh up <tag>`) takes the probes of that tag's chart.

[0.7.8]: https://github.com/junginho0901/Kubeast/compare/v0.7.7...v0.7.8
