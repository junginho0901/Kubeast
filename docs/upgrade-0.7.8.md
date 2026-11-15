**English** | [한국어](ko/upgrade-0.7.8.md)

# Upgrading from 0.7.7 to 0.7.8

This page is for an install of 0.7.7 going to 0.7.8: what to check first, what changes by itself, which values to change, what the upgrade does once, and how to go back.
The upgrade command is the one in [Getting started](getting-started.md#upgrade), with `--version 0.7.8`.
Each item names the pull request that made the change.

The commands below use the release name `kubeast` in the namespace `kubeast`; put yours in their place.

## In short

- Run the dry run in [1.2](#12-rehearse-with-a-dry-run) first. Every check that can stop the upgrade stops it there, and nothing changes.
- The cluster that runs Kubeast needs Kubernetes 1.30 or later, or `podShutdown.preStopSeconds: 0` (#856).
- Finish node drains started from Kubeast before you upgrade (#858).
- Many replicas: the database connections must fit `postgresql.maxConnections` (300) or the upgrade stops (#868).
- Custom roles whose names make the same role group as another role are renamed and lose their cluster grants, with an audit row for each change. Account levels of `Pending`'s group (`PENDING`) move to the built-in `Pending` (#865).
- Role names with characters outside ASCII get groups of their own (`운영팀` acts as `kubeast:role:~c6b4~c601~d300`; in 0.7.7 it was `kubeast:role:---`), so RBAC bound to the old group on your clusters stops applying to them (#865).
- Besides the services, the chart's PostgreSQL and Redis restart once: the database pauses for a moment and the cache starts empty (#866, #868).
- Back up the database first: a rollback does not undo the role renames.

## 1. Before you upgrade

### 1.1 Where you are

```bash
helm list -n kubeast                          # CHART kubeast-0.7.7
helm get values kubeast -n kubeast -o yaml    # the values you set yourself
```

From a version before 0.7.7, also read the release notes of each version in between.

### 1.2 Rehearse with a dry run

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

It renders 0.7.8 with your values and changes nothing. A check that stops it makes Helm print an error saying what to change; the table in [3](#3-values-you-must-change) lists them. `--dry-run=server` (Helm 3.13 or later) lets the chart read your Secrets, so the Redis users check in [1.7](#17-secretsexistingsecret-and-the-redis-users) runs too.

To see the install notes, for example the connection sum for an external database ([1.6](#16-database-connections)), run it without `> /dev/null` and read `NOTES:` at the end.

### 1.3 Kubernetes version

```bash
kubectl version    # Server Version: v1.30 or later
```

The chart's pods behind a Service now wait `podShutdown.preStopSeconds` (5 s) in `preStop` before SIGTERM, with the native `sleep` action (beta and on by default in 1.30, GA in 1.34). On an older cluster set `podShutdown.preStopSeconds: 0` (#856).

### 1.4 Node drains

A node drain started from Kubeast runs inside k8s-service. In 0.7.7 its progress is in that process's memory, so the upgrade, which replaces k8s-service, ends it where it is and the node stays cordoned (#858).

- Let every drain finish first. A node's drawer says "Drain in progress" while one runs.
- On each registered cluster, see which nodes are still cordoned:

```bash
kubectl get nodes    # STATUS Ready,SchedulingDisabled
```

From 0.7.8 a drain's progress is in the database, and one cut short reads "Interrupted", with Start again (#858).

### 1.5 Role names

The upgrade renames the custom roles whose names make the same role group as another role or a built-in's (`ADMIN` beside `Admin`, ` read `, `a-b` beside `a b`, `OPS-팀` beside `Ops 팀`), and removes what they held on clusters ([5](#5-one-time-effects-of-this-upgrade), #865).
A character outside ASCII now keeps its code point in the group, so Korean names of one length (`운영팀`, `개발팀`) make different groups, are not renamed and keep their grants.

[Getting started](getting-started.md#upgrade) "Upgrade" has a query that reads only and lists the roles the upgrade will rename: the role whose group each shares (`same_group_as`), and how many grants, restores of a temporary grant, pending or approved access requests and account levels each holds.
Copy it into `preview.sql` and run it:

```bash
kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast < preview.sql
```

No rows: nothing is renamed. With rows, note who holds those roles on which cluster (Admin → Users → Cluster access), so you can grant them again after.
The account levels of a row whose `same_group_as` is `Pending` move to the built-in `Pending`; the others stay on the renamed role.

A custom role whose name holds a character outside ASCII acts as a new group: 0.7.7 wrote each such character as `-` (`운영팀` was `kubeast:role:---`), 0.7.8 writes `~` and its code point (`kubeast:role:~c6b4~c601~d300`).
RBAC bound to the old group stops applying to the role. On each registered cluster, list the bindings of Kubeast's role groups and note those whose group has a `-` where the name has such a character:

```bash
kubectl get clusterrolebindings,rolebindings -A -o wide | grep 'kubeast:role:'
```

The chart settings that name roles, and what each does with a renamed role's old name, are in [6](#6-after-you-upgrade):

```bash
helm get values kubeast -n kubeast -o yaml | grep -n -A6 -E 'roleMapping|defaultRole|clusterGroupMapping|accessRequests|customRoles'
```

### 1.6 Database connections

Each service now has a pool of its own size, and the chart's PostgreSQL starts with `max_connections` from `postgresql.maxConnections` (300; PostgreSQL's own default is 100). With the chart's PostgreSQL the render stops when the pods could open more (#868).

The sum the chart checks:

| Part | Connections |
| --- | --- |
| auth-service | `postgresql.pool.authService.maxConns` (20) × rolling pods |
| session-service | `postgresql.pool.sessionService.maxConns` (20) × rolling pods |
| k8s-service | (`postgresql.pool.k8sService.maxConns` (10) + 1 for the health status lock) × rolling pods (#858) |
| ai-service, with the AI on | `postgresql.pool.aiService.maxConns` (15) × rolling pods |
| ModelConfig controller, with the AI on | `postgresql.pool.modelConfigController.maxConns` (4) × 2 |
| k8s-service-stream, with `streams.enabled` | `postgresql.pool.k8sService.maxConns` × (`streams.replicas` + 1) |
| migrations and kept | 4 + 10 |

"pods" is `replicas.<service>`, or `autoscaling.<service>.maxReplicas` while its HPA is on. "Rolling pods" adds one for a rollout, which starts one extra pod at a time (`maxSurge: 1`, #901): 2 for one pod, 5 for four.
The health status lock holds a connection of its own outside k8s-service's pool, on each k8s-service pod; k8s-service-stream holds none (#858).
One pod of each service with the AI on: 20 × 2 + 20 × 2 + 11 × 2 + 15 × 2 + 4 × 2 + 14 = 40 + 40 + 22 + 30 + 8 + 14 = 154.
auth-service, session-service and ai-service at 4 pods each: 20 × 5 + 20 × 5 + 11 × 2 + 15 × 5 + 4 × 2 + 14 = 100 + 100 + 22 + 75 + 8 + 14 = 319, past 300, and the upgrade stops; the message names the sum.

If your install runs that many pods, change one of these with the upgrade:

- Raise `postgresql.maxConnections` to the sum or a little more. PostgreSQL gives each connection a process of its own, so check `resources.postgres` too.
- Or lower the pools, for example `postgresql.pool.authService.maxConns: 10`, when more pods each need fewer connections.

With an external database (`postgresql.enabled: false`) the chart cannot read its limit. The install notes print the sum; keep the database's `max_connections` above it:

```bash
psql "<your database URL>" -c 'SHOW max_connections'
```

Behind a pooler:

- RDS Proxy: a `SET` pins the client connection. Set `postgresql.sessionLimits.statementTimeoutMs`, `lockTimeoutMs` and `idleInTransactionTimeoutMs` to `0`, and put the limits in the proxy's initialization query or on the database role (#868).
- PgBouncer: use session pooling, or connect directly. Transaction pooling is not supported: it hands a server connection to other clients between transactions, so the `SET` of the limits and the session advisory locks (the migrations', the audit sinks', the health status lock) do not stay with the client that made them. Limits on the database role do not change that (#858, #868).

### 1.7 `secrets.existingSecret` and the Redis users

The chart's Redis now gives k8s-service, tool-server and the probes a user each, and turns the `default` user off. The passwords are generated into the Secret `kubeast-redis-users` (#866).

With `secrets.existingSecret`, nothing changes on this upgrade: Redis keeps the one password (`REDIS_PASSWORD`) until you turn the users on, and the install notes say so. To turn them on, now or later, take one of these:

- Put `REDIS_K8S_SERVICE_PASSWORD`, `REDIS_PROBE_PASSWORD` and, with the AI on, `REDIS_TOOL_SERVER_PASSWORD` in a Secret of their own and set `redis.acl.existingSecret` to its name. Each service then reads only its own key.
- Or add them to the main Secret and set `redis.acl.existingSecretHasKeys: true`. Every backend reads that Secret whole, so each then holds every user's password, and the install notes say so.

An upgrade that can read the Secret stops when a key is missing or empty, and names it. `helm template` and Argo CD cannot read it; there the redis pod's `acl` container stops and names the key.

With `images.redis` set to an image of your own, it must be Valkey, or Redis 6.2 or later: a command of the rules that the image does not know stops it at start.

[Redis users](configuration.md#redis-users) has the users' rules.

### 1.8 Claude Code provider

With `ai.providers.claudeCode.enabled: true`:

- `maxConcurrent` goes from 1 to 2 per ai-service server, unless you set it (#859).
- ai-service's memory limit becomes the larger of `resources.aiService.limits.memory` (1Gi) and the new `ai.providers.claudeCode.memoryLimit` (2Gi). `""` keeps the limit as `resources.aiService.limits.memory` sets it (#859).

If the namespace has a ResourceQuota or a LimitRange, check that ai-service fits:

```bash
kubectl -n kubeast get resourcequota,limitrange
```

### 1.9 Back up the database

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.8.dump
```

With an external database, use its own backup. [Database: TLS, backup and restore](database-backup-restore.md#backing-up-the-in-cluster-database) has both ways and the restore.

## 2. Upgrade

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-then-reuse-values
```

- auth-service applies the migrations at boot, or the migration Job does with `migrations.mode: job`. The Job runs each try in a pod of its own and ends at 10 minutes (#829, #834).
- The pods 0.7.7 started stop as 0.7.7 pods do. The `preStop` wait, the notice a terminal gets before it closes, and putting a running alert investigation back in the queue start with the pods 0.7.8 starts (#856, #901). Terminals and followed logs open during the upgrade end, so pick a quiet time.
- Turn on new features (`autoscaling`, `streams.enabled`) in a later upgrade, once this one has settled. [Running more than one replica](high-availability.md) says what each service needs before a second pod (#867).

## 3. Values you must change

Only the rows that match your install. A row marked "stops" stops the upgrade, with a message, until the value is changed.

| When | 0.7.7 | 0.7.8 | PR |
| --- | --- | --- | --- |
| Your values set `pdb.minAvailable` | `pdb.minAvailable: 1` | Stops. Take `pdb.minAvailable` out; `pdb.maxUnavailable` (1) says how many pods of one service a node drain may evict at once | #901, #908 |
| Kubernetes older than 1.30 | — | `podShutdown.preStopSeconds: 0` | #856 |
| Behind a load balancer that sends to pod IPs | — | `podShutdown.preStopSeconds`: its deregistration delay plus a few seconds | #856 |
| Many replicas with the chart's PostgreSQL ([1.6](#16-database-connections)) | PostgreSQL's `max_connections` 100 | Stops past `postgresql.maxConnections` (300): raise it, or lower `postgresql.pool.<service>.maxConns` | #868 |
| External database | — | Its `max_connections` above the sum the install notes print | #868 |
| Behind RDS Proxy | — | `postgresql.sessionLimits.*: 0`, limits in the proxy or on the role | #868 |
| Behind PgBouncer in transaction pooling | — | Not supported: session pooling, or a direct connection | #858, #868 |
| `secrets.existingSecret` ([1.7](#17-secretsexistingsecret-and-the-redis-users)) | `REDIS_PASSWORD` | The users' three keys, then `redis.acl.existingSecret` or `redis.acl.existingSecretHasKeys: true`; until then one password | #866 |
| `images.redis` of your own | any Redis | Valkey, or Redis 6.2 or later | #866 |
| Claude Code on, keep the memory limit | `resources.aiService.limits.memory` | `ai.providers.claudeCode.memoryLimit: ""` | #859 |
| Claude Code on, keep one turn per server | `maxConcurrent: 1` (default) | `ai.providers.claudeCode.maxConcurrent: 1` (default 2) | #859 |
| A chart setting names a renamed role ([1.5](#15-role-names)) | old name | The name of the role you mean: the new name, a name you give the role, or a built-in | #865 |
| `auth.accessRequests.roles` spells a built-in in other capitals (`WRITE`) | a custom role of that name | Read as the built-in (`Write`): write the name of the role you mean | #865 |
| `replicas` or `autoscaling` with a key other than the seven services | ignored | Stops. The keys are `authService`, `aiService`, `k8sService`, `sessionService`, `frontend`, `toolServer`, `gateway` | #867 |
| A value 0.7.8 no longer reads | ignored | Stops and says what to set instead | #908 |
| A values file holding `chartVersion` or a release's `global.imageTag` | stops on `chartVersion` | Also stops on a release's `global.imageTag`: leave both out | #818 |
| Upgrading with `--reuse-values` | stops | Stops, as in 0.7.7: use `--reset-then-reuse-values` | — |

To take a value out, upgrade from a file of your values without it, with `--reset-values` instead of `--reset-then-reuse-values`:

```bash
helm get values kubeast -n kubeast -o yaml > my-values.yaml    # then delete the line from it
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.8 \
  -n kubeast --reset-values -f my-values.yaml
```

New values whose defaults need nothing from you: `podShutdown.preStopSeconds` (5), `pdb.maxUnavailable` (1), `streams.*` (off), `autoscaling.<service>` (off), `redis.acl.*` (on), `postgresql.sessionLimits.*`, `postgresql.pool.<service>.maxConns`, `postgresql.maxConnections` (300), `ai.providers.claudeCode.maxConcurrentTotal` (0), `queueWaitSeconds` (60), `memoryLimit` (2Gi), `gateway.accessLog.upstreamTimes` (off). [Configuration](configuration.md) describes each.

## 4. What changes by itself

**Pods and rollouts**

- Pods behind a Service wait `podShutdown.preStopSeconds` before SIGTERM. Their grace period is that wait, what the service waits for after SIGTERM, and 5 s: 35 s with the defaults. k8s-service also gives open terminals `streams.drainSeconds` (60) to end and 5 s to close, so its grace period is 100 s with the defaults (#856, #824, #825).
- Liveness asks `/livez`, which reads nothing else. Readiness asks `/readyz`, which answers 503 from SIGTERM on and never asks the database (#901).
- A rollout starts one new pod and stops an old one only once the new one is ready (`maxSurge: 1`, `maxUnavailable: 0`), so it needs room for one more pod of each Deployment. PostgreSQL keeps `Recreate`, and Redis stops its old pod before the new one starts (`maxSurge: 0`) (#901, #860).
- `pdb.enabled` is now `true`. A Deployment that can be down to two pods or more (`replicas`, or `autoscaling.<service>.minReplicas` while its HPA is on) gets a PodDisruptionBudget with `unhealthyPodEvictionPolicy: AlwaysAllow`; a Deployment of one pod gets none (#901).
- A pod that stops closes its long-lived connections: live lists and followed logs connect again to a pod that stays; a terminal ends with a line saying the server is restarting (close code 1001, `server_shutdown`) (#901).

**Database**

- Each service sets `statement_timeout` 30 s, `lock_timeout` 15 s and `idle_in_transaction_session_timeout` 5 min on its connections, with `SET` once connected; the migrations run without the first two. `0` sets nothing and leaves the database's setting (#868).
- Pools per service: auth-service 20, session-service 20, k8s-service 10 (a fixed number instead of one per node CPU), ai-service 15, ModelConfig controller 4 (#868).
- New tables or columns: recording owners (#851), signed-out sign-ins (#849), cluster versions (#857), node drains (#858), Claude Code slots (#859), investigation requeues (#901).
- A unique index on the group each role name makes: the database refuses a name that makes another role's group (#865).

**Redis**

- One user per service, the Secret `kubeast-redis-users` (kept on uninstall, like `kubeast-secrets`), and `default` off (#866).
- `maxmemory` at 80 % of `resources.redis.limits.memory`, with `volatile-lru`: only keys with a TTL are evicted (#866).
- Cache keys move under `kubeast:cache:`, and a cluster change deletes only those keys, not the whole Redis database (#857).

**Sign-in, roles and AI**

- Signing out ends the sign-in on the server: its tokens are refused and cannot be refreshed (#849).
- A built-in role is known by its exact name (`Pending`, `Member`, `Read`, `Write`, `Admin`), and so is the `Pending` account level everywhere: the services' middleware, the API key exchange, ai-service and Admin Users. A grant, an approval or an OIDC group sync of a role sharing another role's group is refused (400 `role_same_group`); after the upgrade no such role is stored, so this is a second check (#865).
- A role's group keeps ASCII as before and writes any other character as `~` and its code point in four hex digits (`~~` and six above U+FFFF): `운영팀` is `kubeast:role:~c6b4~c601~d300`, `개발팀` `kubeast:role:~ac1c~bc1c~d300`. Two names share a group only when they differ in `A`–`Z` letter case, spaces or ASCII punctuation (`Ops 팀`, `OPS-팀`). The role window shows the group a name makes (#865).
- The chart hands auth-service the names in `auth.impersonation.customRoles` (`IMPERSONATION_CUSTOM_ROLES`, a comma in a name written as `-`) instead of their groups, and auth-service makes each group itself. Your values need no change (#865).
- auth-service logs a warning at start for each role name in `auth.oidc.roleMapping`, `auth.oidc.defaultRole`, `auth.oidc.clusterGroupMapping`, `auth.accessRequests.roles` and `auth.impersonation.customRoles` that no role holds as written (for `customRoles`, whose group no role makes). A sign-in whose `roleMapping` or `defaultRole` names no role fails as `oidc_role_missing`; 0.7.7 failed it as `oidc_provision` (#865).
- An `auth.accessRequests.roles` entry that is a built-in's name in other capitals (`WRITE`) stands for the built-in (`Write`) (#865).
- Claude Code turns take install-wide slots in the database (`maxConcurrentTotal`); a turn waits up to `queueWaitSeconds` for one (#859).
- An alert's `startsAt` is stored in UTC, whatever offset the sender writes (#909).

**Other**

- New live lists wait while what k8s-service holds against its Go memory limit (the live heap, the goroutine stacks and the runtime's own) is past 80 % of it, with a notice on the page; open ones go on. Lists that open with every object there is take one of eight places for the whole server (`multicluster.wsWatchOpeningConcurrency`) before they start and until those objects are through — one at a time for a cluster until its API server has answered, half of them while another cluster waits — so after a restart they come back a few at a time and a cluster that does not answer keeps no other waiting; each list's HTTP/2 window is 1 MiB (`multicluster.wsWatchStreamWindowKiB`); they are asked as a watch list (`sendInitialEvents`), and a cluster whose API server refuses that (1.33, or 1.27–1.31, by default) gets the earlier watch. If you see the notice often, raise `resources.k8sService.limits.memory` (#896).
- The S3 digest object key of an audit anchor ends with the first 8 hex digits of its hash (`…-<from>-<to>-<hash8>.json`). A script that reads digests by name should take the new form (#852).
- New chart objects: the Secret `kubeast-redis-users`, the PodDisruptionBudgets past one pod, and, when you turn them on, the HPAs and the `k8s-service-stream` Deployment, Service, PodDisruptionBudget and NetworkPolicy. No new ClusterRole or Role.

## 5. One-time effects of this upgrade

- **Roles renamed** (#865). A custom role whose name makes a built-in's group (`ADMIN`, ` read `, `PENDING`) or another role's group (`a-b` beside `a b`, `OPS-팀` beside `Ops 팀`) is renamed `<name>-renamed-<id>`; of the roles of one group, the built-in, else the oldest, keeps its name. Korean names of one length make different groups and keep their names. A renamed role loses its cluster grants and open access requests: its grants are removed (a temporary grant goes back to the role it would restore), a temporary grant that would bring it back ends with nothing to restore, and pending and approved requests end with `role_renamed`. The people whose grants changed and the accounts whose account level is such a role sign in again. An account level stays on the renamed role, except one of `Pending`'s group (`PENDING`), which moves to the built-in `Pending` (stored then if it is not yet) and still waits for approval. Each change is an audit row by `system` / `migration` (`admin.roles.update`, `user.cluster_role.unset`, `access.request.expire`, `user.role.update`). From then on the database refuses such a name. What to do next is in [6](#6-after-you-upgrade); [Features](features.md) "Role names" has the details.
- **New groups for role names outside ASCII** (#865). A custom role whose name holds a character outside ASCII acts on clusters as a new group (`운영팀`: `kubeast:role:---` → `kubeast:role:~c6b4~c601~d300`), and RBAC bound to the old group no longer applies to it until the new group is bound ([6](#6-after-you-upgrade)). With such a name in `auth.impersonation.customRoles`, the upgrade replaces the bindings of the old group with those of the new one on the cluster Kubeast runs in; other registered clusters keep the old ones until you apply the 0.7.8 render.
- **PostgreSQL restarts once** (#868). Its pod now starts with `max_connections`, so the database pauses while the new pod starts. Writes and sensitive reads answer 503 `audit unavailable` until it is back, as on any restart of the database.
- **Redis and k8s-service restart, and the cache starts empty** (#866, #857). Until the 0.7.7 k8s-service pod has gone, its requests to the new Redis are refused and read as cache misses.
- **Alerts from a sender that writes another zone** (#909). Up to 0.7.7 the offset of `startsAt` was dropped. Such an alert still firing after the upgrade gets a new inbox row, and the old row reads Status unknown after `inbox.staleAfterHours`.
- **Drains cut short** (#858). A drain still running when the 0.7.7 k8s-service stops leaves its node cordoned and is not shown afterwards. Run `kubectl uncordon <node>`, or drain it again.
- **Session recordings in progress** (#851). A recording the 0.7.7 pod was writing has no owner. A 0.7.8 pod leaves it for its first 5 minutes, then takes it: it uploads it if it holds the spool file, and otherwise marks it interrupted.
- **Claude Code slots** (#859). For the few minutes of the rolling update, the 0.7.7 ai-service pods do not count the install-wide slots, so the total can pass `maxConcurrentTotal`.

## 6. After you upgrade

```bash
helm list -n kubeast                 # CHART kubeast-0.7.8
kubectl -n kubeast get pods          # every pod Running and ready
helm get notes kubeast -n kubeast    # the install notes, as 1.2 showed them
```

**Renamed roles** (#865). The audit log holds an `admin.roles.update` row by `system` / `migration` for each one, and this lists them:

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- \
  psql -U kubeast -d kubeast -c "SELECT id, name FROM roles WHERE name LIKE '%-renamed-%' ORDER BY id"
```

A 0.7.7 pod keeps serving while the migration runs, and a grant it writes in the moment before the migration commits stays on the renamed role.
Right after the upgrade, before anyone grants a renamed role again, this query (the one in [Getting started](getting-started.md#upgrade) "Upgrade") lists such grants; it lists none in the usual case. Remove one in Cluster access unless the role is wanted:

```bash
kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast <<'SQL'
SELECT g.user_id, g.cluster_id, r.name
  FROM user_cluster_roles g JOIN roles r ON r.id = g.role_id
 WHERE r.id IN (SELECT target_id::int FROM auth_audit_logs
                 WHERE actor_user_id = 'system' AND actor_email = 'migration' AND action = 'admin.roles.update');
SQL
```

- If a renamed role is still wanted, grant it again on its clusters; the list you made in [1.5](#15-role-names) says to whom. Its new name is already unique, so it need not be renamed first.
- An account whose account level was a renamed role signs in again and keeps that role, except one of `Pending`'s group, which is now on the built-in `Pending` and waits for approval in Admin → Users as before. The `Pending` account level is matched by its exact name everywhere.

**Chart settings that name roles** (#865). auth-service logs a warning at start for each role name a setting gives that no role holds as written (for `auth.impersonation.customRoles`, whose group no role makes), with the setting, the role, what follows (`outcome`) and the role whose group the name makes (`same_group_as`):

```bash
kubectl -n kubeast logs deploy/auth-service | grep 'a chart setting names a role not stored as written'
```

Until you change it, a setting naming a renamed role by its old name works out as follows:

- `auth.oidc.roleMapping`, `auth.oidc.defaultRole`: the sign-in of a person it applies to fails with `oidc_role_missing` ([OIDC](oidc.md) §6).
- `auth.oidc.clusterGroupMapping`: that cluster grant is skipped with a warning in the log, and the sign-in goes on.
- `auth.accessRequests.roles`: an entry that is a built-in's name in other capitals (`WRITE`) stands for the built-in (`Write`), whose permissions may be wider than the renamed custom role's. Any other old name is refused as `Unknown role`.
- `auth.impersonation.customRoles`: the chart binds the group the name makes, which the role that kept its name now holds, or no role.

Change each to the name of the role you mean and upgrade again with `--reset-then-reuse-values`.

**Groups of role names outside ASCII** (#865). Role Management's role window shows the group each role now makes.
On each registered cluster, allow the impersonator that group and bind it where the old group was bound (the bindings you listed in [1.5](#15-role-names)); [Cluster requirements](cluster-requirements.md) §1 has both.
For names in `auth.impersonation.customRoles`, apply the 0.7.8 render (`scripts/render-target-rbac.sh`) to each registered cluster other than the one Kubeast runs in, and delete the old group's bindings there, named `kubeast-role-<old slug>-<ClusterRole>` (`kubeast-role-----view` for `운영팀` bound to `view`). `helm upgrade` replaced them only on the cluster Kubeast runs in.

**Cordoned nodes** (#858). On each registered cluster, `kubectl get nodes`; run `kubectl uncordon <node>` for a node a drain cut short left cordoned.

**Redis users** (#866). With `secrets.existingSecret`, the install notes say Redis still runs with one password until you turn the users on ([1.7](#17-secretsexistingsecret-and-the-redis-users)).

## 7. Rolling back to 0.7.7

```bash
helm history kubeast -n kubeast                        # the revision of 0.7.7
helm rollback kubeast <revision> -n kubeast
```

- **Database**: the 0.7.8 tables and columns stay, and 0.7.7 still starts. Its migrations find nothing to apply on a database that is ahead, and its services wait for schema 22 or later.
- **Roles** (#865): the renames, the removed grants and the account levels moved to `Pending` stay, and so does the index that refuses a name making another role's group. Only restoring the dump from [1.9](#19-back-up-the-database) brings the old names and grants back, and it takes the whole database back to that moment.
- **Role groups** (#865): 0.7.7 makes the old groups again (`운영팀` acts as `kubeast:role:---`), so a binding made for a new group does not apply under it.
- **Sign-outs** (#849): 0.7.7's auth-service does not read the signed-out sign-ins, so a token whose sign-in was signed out is taken again until it expires (`auth.tokenTTLMinutes`, 15 minutes by default).
- **Redis** (#866): 0.7.7's Redis comes back with one password (`REDIS_PASSWORD`, still in `kubeast-secrets`), and its k8s-service signs in with it. A 0.7.7 k8s-service pod that starts before that Redis answers keeps its cache in memory until it restarts. `kubeast-redis-users` stays (`helm.sh/resource-policy: keep`), and the next upgrade reads its passwords again.
- **PostgreSQL** (#868) restarts again and goes back to `max_connections` 100.
- **PodDisruptionBudgets and HPAs** go with 0.7.7's values (#901, #867).
- **Alerts** (#909): 0.7.7 drops a `startsAt` offset again, so an alert from a sender that writes another zone gets a new row again.
- **Drains** (#858): a drain running at the rollback ends where it is and its node stays cordoned; 0.7.7 does not read `node_drains`.

## 8. Docker Compose

Upgrade from the checkout. The script keeps the passwords and keys in `.env`; give it the gateway port you use, since it writes `--port` (8000 when left out) into `.env`:

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.8.dump
git fetch --tags && git checkout v0.7.8
./install-docker.sh --port <your port>
```

If you set `KUBEAST_TAG`, set it to `v0.7.8` or unset it.

What differs from the chart:

- **Stop wait**: the seven Kubeast services and Redis get 35 s to stop (`stop_grace_period`; Docker's default is 10 s), what the chart gives a service with the defaults. `docker compose stop` and the upgrade can take that long per container. There is no `preStop` wait, terminal drain, PodDisruptionBudget or HPA (#856).
- **Redis**: as before, with no users and no password, reachable only on the Compose network (#866 changes the chart only).
- **Database limits**: the same session limits and pools apply by default. To change them, set `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (`0` sets nothing) or `DB_POOL_MAX_AUTH`, `DB_POOL_MAX_SESSION`, `DB_POOL_MAX_K8S`, `DB_POOL_MAX_AI` in `.env`. Compose's PostgreSQL keeps its default `max_connections` (100), which one container of each service fits (#868).
- **Custom role bindings**: `IMPERSONATION_CUSTOM_ROLES` in `.env` takes role names, as before. Bind the new group of a name outside ASCII on your clusters ([6](#6-after-you-upgrade)).
- **The same as the chart**: the migrations, the role renames (run the queries of [1.5](#15-role-names) and [6](#6-after-you-upgrade) with `docker compose exec -T postgres psql -U kubeast -d kubeast` in place of `kubectl -n kubeast exec -i deploy/postgres -c postgres -- psql -U kubeast -d kubeast`), the alert times in UTC, the cache starting empty and the drains ([1.4](#14-node-drains)).
- **Rollback**: `git checkout v0.7.7 && ./install-docker.sh --port <your port>`. The notes in [7](#7-rolling-back-to-077) apply, Redis aside.
