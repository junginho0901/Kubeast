# Fault tests (opt-in)

The v0.7.8 fault tests (step 4 §5 "(마)"): each one breaks one thing on the dev install — kills a pod, stops Redis or
PostgreSQL for a while, replaces a server while requests are in flight — and holds what users get to the pass line
with values read from kubectl, the database or the API. They belong to the W4 and W5 pull requests named below and run
once those are merged; until then a test whose prerequisite is missing skips with the reason.

They are **not part of the default run** and must not run beside other work on the cluster: they restart and stop
the install's own Deployments.

```bash
cd e2e
E2E_FAULT=1 npx playwright test --project=fault                          # every file
E2E_FAULT=1 npx playwright test --project=fault cluster-versions         # one file
E2E_FAULT=1 npx playwright test --project=fault -g "F-8"                 # by name
```

`E2E_FAULT=1` adds the `fault` project (`testDir: ./fault`, depends on `setup` for `.auth/user.json`). Without it
`playwright.config.ts` is unchanged. The admin login is the regular suite's (`E2E_USER_EMAIL`, `E2E_USER_PASSWORD`),
the gateway `E2E_BASE_URL` (default `http://localhost:30080`).

## What every file shares (`shared.ts`)

- kubectl takes the kubeconfig from `kind get kubeconfig --name kubeast` (`E2E_FAULT_KIND`), never from the shell's
  `KUBECONFIG`; `kind`, `kubectl` on the PATH.
- A request meant for one server goes through `kubectl port-forward pod/<name>`, so the answer is that server's.
- `Probe` sends a request about every 100 ms through the gateway (step 3 §6 "about 10 a second") and keeps every
  answer: status 0 = no answer within its timeout or a broken connection. Each test attaches the answers as JSON.
  The Probe sends and times its requests on the worker's event loop, which `kubectl()` (synchronous) holds until it
  returns: nothing is sent meanwhile and the request already started is timed with the wait added. kubectl run while a
  Probe sends goes through `kubectlAsync` (`rolledOutAsync`, `killPodAsync`, `podsOfAsync`, `readyPodsAsync`,
  `podLogAsync`; `takeDown` and `stopFor` use it throughout), and `expectProbeKeptSending` holds the longest time
  between two of its requests (`longestGap`) to `SEND_GAP_MS` (2 s) in `pod-shutdown`, `force-kill`, `redis-users`
  F-8 and `drain-in-db` F-9.
- "Kill" is `kubectl delete pod --grace-period=0 --force`; "stop" is a plain `kubectl delete pod` (preStop, SIGTERM).
  A force delete still gives the process a SIGTERM about 2 s before SIGKILL (the kubelet's shortest grace), so a
  server can still run part of its shutdown; where that changes what is read, the test says so.
- "Kill with no signal" (`killNoSignal`) is `crictl stop --timeout 0 <container>` on the pod's kind node
  (`docker exec <node>`): SIGKILL with no SIGTERM, as a crash or the OOM killer ends a process; the kubelet starts the
  container again in the same pod.
- "Freeze" (`freeze`) is `ctr -n k8s.io task pause` of a container on its kind node (`docker pause` for a database
  container outside kind, `E2E_FAULT_PG_DOCKER`): every process stops, open connections stay open and nothing answers.
- What a test changes and must put back (a Deployment scaled to 0, a frozen container, the drain tests' namespace and
  cordon on test2, a pod it made) is registered with `atExit` as it is changed. A test's `finally` does not run when
  Playwright interrupts it (Ctrl-C, a test timeout: the body is left where it waits), so the list also runs in each
  file's `afterEach` (`undoPending`), on the worker's exit and on SIGINT, SIGTERM and SIGHUP. For a worker killed
  outright, a detached process that waits for the worker to be gone (`whenGone`) scales a Deployment back and deletes
  the drain tests' namespace on test2 and uncordons its node, and a frozen container is resumed by one `seconds` + 30 s
  after the freeze. Port-forwards run under a
  shell that ends them when the worker is gone, and the kubeconfig copy is removed on exit.
- `wsSubscriptions` reads a k8s-service pod's `kubeast_ws_subscriptions` through its port-forward: the pod whose count
  went up when a page opened its live list is the one that holds it. `watchListSockets` keeps each `/wsMultiplexer`
  socket the page opens (opened, first frame, closed) for `listSocketBack`.
- "Server restarts 0" compares the container restart counts of the pods present before and after.
- `takeDown(deploy)` scales a Deployment to 0 and waits until none of its pods is left — `podsOf` counts a pod being
  deleted, which still answers through its preStop and grace (the bundled Redis has no preStop, only the 30 s default
  grace) — so what a test does with it "off" starts only then; `stopFor(deploy, seconds)` keeps it off `seconds` from
  that moment and brings it back, waiting for the rollout, and returns when it went off and came back for the test's
  `timeline.json`. A Deployment already at 0 replicas (left by an interrupted run) stops the test: it would "bring it
  back" to 0.
- Passwords (the Redis users') are read from their Secret and given to `valkey-cli` on stdin, never on a command line.

## Files

| File | Pull request | Step 4 / step 3 rows | Needs | Changes and puts back |
| --- | --- | --- | --- | --- |
| `pod-shutdown.spec.ts` | #856 `podShutdown.preStopSeconds` | F-6 on one replica; the PR's "four rollout restarts of each service with a request right after each" | nothing beyond the install; tool-server's case needs `mcp.enabled` | four `rollout restart`s of each of the eight Service-backed Deployments, one deleted pod each; waits for every rollout |
| `cluster-versions.spec.ts` | #857 cluster versions in the database | step 3 test 6; F-8 for M-2 | two ready `k8s-service` pods; a cluster for the credential change (below) | registers a cluster `e2e-w6-sync-*` with the admin kubeconfig, replaces it with the ServiceAccount's, deletes it; the second case stops Redis for about 20 s |
| `drain-in-db.spec.ts` | #858 drain progress in the database | step 3 tests 4, 5 and 11, F-7, F-9, W6-1, Q-52 | `test2` registered; tests 4, 5 and W6-1 two ready `k8s-service` pods; W6-1 and Q-52 `docker exec` into the kind node; F-9 a PostgreSQL with a PersistentVolumeClaim; Q-52 the chart's PostgreSQL or `E2E_FAULT_PG_DOCKER` | namespace `e2e-w6-drain*` / `e2e-w6-nosig-*` / `e2e-w6-pgoff-*` / `e2e-w6-pgfreeze*` on test2 (a pod under a PDB that refuses eviction), drains its node (test2's other pods are evicted and wait for the uncordon, as the action suite's `node-drain` leaves them), kills or stops one k8s-service pod (W6-1: with no signal, a busybox pod `e2e-w6-nosig-*` in `default` for its terminal), stops PostgreSQL 60 s, freezes it 20 s and 30 s; deletes the namespace and uncordons the node |
| `force-kill.spec.ts` | — (W5 rows no pull request changes) | F-5, F-14 | F-5 two ready `k8s-service` pods; F-14 one or two ready gateway pods | force-kills one k8s-service pod or one gateway pod, a busybox pod `e2e-w6-gw-*` in `default` (deleted); waits for the rollout |
| `claude-code-slots.spec.ts` | #859 Claude Code slots | M-4 "the cap holds on two servers; a server killed → its slot free within 60 s" | two ready `ai-service` pods (`replicas.aiService: 2`); the default model on provider `claude-code` (`scripts/kind-model-subscription.sh up`); table `claude_code_slots` | rows of `claude_code_slots` owned `e2e-w6-*` (set free after), conversations of the run (deleted), kills one ai-service pod; up to five short chat turns of the subscription |
| `redis-users.spec.ts` | #866 Redis users per service | M-6b "ACL refusal test" and "test 6 (tool-server 10 s)"; F-8 | the chart's Redis with `redis.acl` on; tool-server cases `mcp.enabled` and a cluster for the credential change (below); the last case also #857 | one `kubeast:cache:e2e-w6-*` key (30 s TTL), clusters `e2e-w6-tool-*` registered with the admin kubeconfig, then the ServiceAccount's (deleted), Redis stopped 60 s and about 20 s, one `rollout restart` of k8s-service while Redis is stopped |
| `w4-stream-split.spec.ts` | #823 `SERVER_ROLE`, #824 the stream server's drain, #825 `streams.enabled` | F-1, F-2 (the part `stream-server.spec.ts` does not hold), F-3 | `streams.enabled: true` (Deployment `k8s-service-stream`); F-3 one `k8s-service` replica | a busybox pod `e2e-w6-seq-*` in `default` (deleted), kills the stream server and the api server, one `rollout restart` of the stream server |
| `node-shell-cleanup.spec.ts` | threat model v0.7.8 row 1.9 (`node_shells`) | F-1 with a node shell open; PostgreSQL frozen and stopped with one open | `nodeShell.enabled` on the server that opens terminals (`NODE_SHELL_ENABLED`); NS-2 two ready servers of that Deployment; NS-3a a PostgreSQL to freeze (the chart's or `E2E_FAULT_PG_DOCKER`), NS-3b the chart's PostgreSQL with a PersistentVolumeClaim; `docker exec` into the kind node | node shells on the first node of self (only the pods it made are deleted after), kills one server with no signal, freezes PostgreSQL 20 s, stops it 60 s; waits for the rollouts |

### Pass lines and what each test depends on

`pod-shutdown.spec.ts`
- Every answer during the rollouts is 200 and comes within 5 s (`E2E_FAULT_HANG_MS`); the bug held one for 30 s.
- A pod deleted by hand: with two or more pods, the same. With one, nothing answers from its SIGTERM (after the preStop
  wait) until the new pod is ready — a pod deleted is not replaced first — so the answers other than 200, from the
  start of the first to the end of the last, are held to the readiness probe's `initialDelaySeconds` + 2 ×
  `periodSeconds` + 5 s (the new pod is ready at its first probe, or at the next one when the server was not up yet
  for the first), none slower than 5 s; the test writes the gap, the limit, the count and the statuses down per
  Deployment. Measured on kind: about 1 s for auth-service, k8s-service and session-service, about 6 s for ai-service
  and frontend, and up to 15.5 s for the gateway when its first readiness probe came too early (readiness every 10 s).
- The gateway's own pod is read from inside the kind node (`NodeProbe`: curl through `docker exec` to the gateway's
  NodePort), the other Deployments through the gateway as before. From the laptop, Docker Desktop's published port
  takes the request while no gateway pod answers and passes it on once one does, a 200 after 5 s or more, where the
  node's own NodePort refuses at once (at most 1.7 ms) — a kind-on-Docker-Desktop effect, not the gateway's.
- Depends on: the preStop sleep and grace of #856 on all eight Deployments (the test records the preStop it found);
  `ROUNDS` = `E2E_FAULT_ROLLOUTS` (4).

`cluster-versions.spec.ts`
- Each k8s-service pod answers from the new kubeconfig (the cluster's 403 naming the ServiceAccount) within 10 s of the
  PATCH's answer, and no pod answers from the old one (a node list) after it switched or after 10 s; the same with
  Redis stopped.
- Depends on: `clusters.config_version` set by auth-service in the same statement as the kubeconfig (#857
  `services/pkg/cluster`), the 5 s version read in every replica (`internal/clustersync`), `GET /api/v1/nodes?cluster=`.

`drain-in-db.spec.ts`
- Test 4: the drain status read on server B equals the one on server A, `status: draining`.
- Test 5 / F-7: after server A is killed, B answers `status: interrupted` within 30 s (step 3/4 line; the PR's own
  figure is about 21 s), the message names the server that went, `cordoned_nodes` is `[node]`, the node is still
  cordoned, the PDB-held pod is still there (nothing evicts), exactly one finished audit row
  (`k8s.node.drain`, `after.phase: finished`, `after.status: interrupted`, result failure), and Start again on B
  is accepted and drains.
- F-7 planned: a plain delete of A marks the drain interrupted within its grace, message "shut down".
- F-9: no restart of the pods that stayed, a drain start while PostgreSQL is off answers 503, every read answers 200
  again within 120 s without a reload or restart, each ConfigMap delete answered 2xx has its audit row and its
  ConfigMap is gone, each refused one (503) left its ConfigMap, no other status. What each read route answered during
  the outage is attached (`reads-by-route.json`), not held: step 4 asks to write it down first.
- W6-1 (two replicas; the server killed is the one holding the page's live list, and a drain and a terminal are opened
  on it): no read through the gateway fails before the kill, none from 3 s after it; the live list's socket closes and
  a new one is open within 5 s; the other server reads the drain `interrupted` within 30 s with the reason "stopped
  answering" (no shutdown marked it), `cordoned_nodes` `[node]` and the node still cordoned; the killed container ended
  with 137, started again once in its pod and is ready (the time is written down), and its previous log has no
  "shutting down server"; the other pods' restarts 0; exactly one finished drain audit row (`interrupted`) and no
  `k8s.session.end` of the terminal with `server_shutdown`; the terminal's recording row leaves `recording` /
  `uploading` for `interrupted` or `uploaded` within 150 s (another process takes a row whose beat is 60 s old,
  looking every 30 s; skipped with the reason when recording is off).
- Q-52 (20 s, then 30 s, with a drain open through the gateway): the drain never reads `interrupted` while or after
  PostgreSQL is frozen and ends `success` once its PDB is removed; restarts 0 (PostgreSQL included); every read 200
  within 30 s of the thaw; no read still unanswered 10 s after the thaw (a first line, to be set again from the first
  run); `clusters.last_healthcheck_at` written after the thaw within the health check interval + 30 s.
- Depends on: `node_drains` (migration 00025 of #858), the 5 s heartbeat / 20 s stale rule, `cordoned_nodes` in
  `GET /api/v1/nodes/{name}/drain/status`, `audit.failClosed` (refused writes while the audit store is down); for
  W6-1 the recording heartbeat of #851, the `k8s.session.end` row and k8s-service's SIGTERM log line; for Q-52 the
  "database paused" rule of #858's review fixes and #901's probes that do not ask the database.

`force-kill.spec.ts`
- F-5 (two replicas; the server killed is the one holding the page's live list): no read fails before the kill, none
  from 3 s after it; the live list's socket closes and a new one is open within 5 s; the other pods' restarts 0.
- F-14 with one gateway: how long nothing answered is written down (no line); the Pods list, never reloaded, shows a
  pod made after the new gateway is ready within 30 s; no 502; restarts 0.
- F-14 with two gateways: every answer 200 (no 502) while one is killed and replaced; restarts 0.
- Depends on: #856's preStop and grace, the gateway's upstream keepalive (#883) for the 502 line.

`claude-code-slots.spec.ts`
- With every slot held by rows the test writes, a turn on each server says `{"queued": true}` and no server takes a
  slot; one slot set free is taken by exactly one turn within 5 s. Read about every 250 ms until both turns end: the
  two servers never hold more than the one row given back; a turn still getting answer text a second later holds a
  row of its server (a run without one would be past the cap); each turn that started had its server's row at its
  start (`slot-samples.json`).
- With every slot held for the whole wait, a turn ends with `error_key: claudeCodeBusy` between `queueWaitSeconds` − 1
  and + 10 s.
- A slot whose heartbeat stopped is taken by a waiting turn on another server when it is 59–62 s old, never before.
- A server killed with no SIGTERM (`killNoSignal`) while its run holds a slot: the slot is not set free before the
  other server's turn takes it, 59–62 s after the dead run's last heartbeat, and that turn is not busy.
- Depends on: `claude_code_slots` (migration 00025 of #859), `AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL` /
  `AI_CLAUDE_CODE_QUEUE_WAIT` in the ConfigMap, slot owners starting with the pod's host name, the stream's `queued`
  events, `POST /api/v1/ai/sessions/{id}/chat` with a JSON body.

`redis-users.spec.ts`
- The default user gets NOAUTH; probe may PING and nothing else; tool-server is refused GET, SET, FLUSHDB, PUBLISH,
  KEYS and SCAN and may PING; k8s-service may SET, GET and PUBLISH under `kubeast:` and is refused keys and channels
  outside it, FLUSHALL, FLUSHDB, KEYS, CONFIG, EVAL, HSET and ACL.
- tool-server answers from the new kubeconfig (kubectl's Forbidden naming the ServiceAccount) on every call later than
  10 s after the change, with the change notice and with Redis stopped (its 10 s keep alone): right before the change
  Redis has no pod, terminating ones included, and no ready endpoint. Before the change every call lists a node the
  API lists with the admin kubeconfig.
- F-8: every screen read answers 200 while Redis is off for 60 s (from the moment its last pod is gone) and while it
  comes back, no restart of the pods that stayed, `kubeast:cache:` keys are in Redis again afterwards.
- F-8 for #857: a k8s-service started while Redis was down logs that it runs on the in-memory cache, logs within 15 s
  of Redis answering that its cache moves to Redis, and reads answer 200 throughout.
- Depends on: the ACL file of #866 (`kubeast.redisUsersAcl`), the Secret `kubeast-redis-users` (or the one the redis
  pod's `REDISCLI_AUTH` names), tool-server's 10 s kubeconfig keep and change notice listener, the log lines of #857's
  `cache.Reconnect`, and #856's preStop for the restart without Redis.

`node-shell-cleanup.spec.ts`
- NS-1: the node shell pod of a server killed with no SIGTERM is gone within 150 s of the kill and not before 40 s (the
  sweep, not the server's own cleanup), its `node_shells` row is gone, and exactly one `k8s.session.end` row names the
  pod with `after.reason: server_gone`.
- NS-2: with two servers each holding a shell, the killed server's shell pods go within 150 s; each shell of the other
  server, paired with its own socket, stays Running with that socket open and its row's owner the same through the
  whole 150 s.
- NS-3a: PostgreSQL frozen 20 s (under the 30 s a break may last with no shell closed): through the freeze and 150 s after it the shell's pod stays Running, its socket open
  and its row's owner the same.
- NS-3b: PostgreSQL stopped 60 s: the shell's own server closes it while PostgreSQL is off, not before 30 s after the
  stop was asked (45 s from its last saved beat), with the terminal's notice and the close reason `heartbeat_lost`; its
  pod goes, and its row is gone within 150 s of PostgreSQL coming back.
- Depends on: `node_shells` (migration 00030), its 15 s heartbeat on a connection kept from the pool, the owner's own
  stop at 45 s, the 60 s stale rule with a sweep every 30 s, the pod label `kubeast.io/node-shell-id` and annotation
  `kubeast.io/node-shell-owner` (the owner's host name first), the `k8s.session.end` rows of the sweep and of the
  owner's stop.

`w4-stream-split.spec.ts`
- F-1: list reads through the gateway all 200; the raw terminal socket closes within 5 s of the kill and the terminal
  window shows `pods.exec.disconnected` within 5 s; a line printed after the kill reaches the Logs tab within 10 s,
  with no line missing or shown twice.
- F-2: after the replacement's notice (`this terminal closes in`), `exit` closes the terminal with no `server_shutdown`
  reason or 1001 code and no "server was replaced" line, and no `k8s.session.end` row of the pod says
  `server_shutdown`.
- F-3: the terminal socket stays open and runs a command after the api server is back, the Logs tab has no gap, and
  the Pods list page, never reloaded, shows a pod made after the server came back within 30 s.
- Depends on: `SERVER_ROLE` stream/api (#823), `STREAM_DRAIN_SECONDS` and the notice text (#824), the gateway sending
  the four stream locations to `k8s-service-stream` (#825), `Last-Event-ID` resume of the followed log.

## A cluster for the credential change

`cluster-versions.spec.ts` and the tool-server cases of `redis-users.spec.ts` change the kubeconfig of a cluster they
register. auth-service answers 409 to a registration of a cluster already registered and to a new kubeconfig that
points at another cluster, both told by the kube-system namespace UID (`services/auth-service-go/internal/handler/clusters.go`
`RegisterCluster`, `UpdateCluster`). So the change is one cluster's credential: a cluster the install has not
registered is registered with an admin kubeconfig, then given the same cluster's ServiceAccount, which may get the
namespace `kube-system` (the probe reads its UID) and nothing else. The admin credential's answer is the node list; the
ServiceAccount's is the cluster's 403 naming it. The tests take three values and skip with the reason without them:

| Value | What |
| --- | --- |
| `E2E_FAULT_ROTATE_ADMIN_KUBECONFIG` | a file: the cluster's kubeconfig with an admin credential, its server as the install's pods reach it |
| `E2E_FAULT_ROTATE_SA_KUBECONFIG` | a file: the same cluster and server with the ServiceAccount's token |
| `E2E_FAULT_ROTATE_SA_USER` | the ServiceAccount's user name, `system:serviceaccount:<namespace>:<name>` |

With the kind cluster `kubeast-np`, which the dev install does not register (`docker start kubeast-np-control-plane`
first when it is stopped):

```bash
d=$(mktemp -d); kind get kubeconfig --name kubeast-np > "$d/ext"; kind get kubeconfig --internal --name kubeast-np > "$d/admin"
k() { kubectl --kubeconfig "$d/ext" --context kind-kubeast-np "$@"; }
k -n default create serviceaccount e2e-w6-rotate
k create clusterrole e2e-w6-rotate --verb=get --resource=namespaces --resource-name=kube-system
k create clusterrolebinding e2e-w6-rotate --clusterrole=e2e-w6-rotate --serviceaccount=default:e2e-w6-rotate
k -n default create token e2e-w6-rotate --duration=2h > "$d/token"
kubectl config view --kubeconfig "$d/admin" --raw -o json \
  | jq --rawfile t "$d/token" '.users = [{name: "e2e-w6-rotate", user: {token: ($t | rtrimstr("\n"))}}] | .contexts[0].context.user = "e2e-w6-rotate"' > "$d/sa"
rm "$d/token"
export E2E_FAULT_ROTATE_ADMIN_KUBECONFIG=$d/admin E2E_FAULT_ROTATE_SA_KUBECONFIG=$d/sa E2E_FAULT_ROTATE_SA_USER=system:serviceaccount:default:e2e-w6-rotate
```

Afterwards `k delete clusterrolebinding,clusterrole e2e-w6-rotate`, `k -n default delete serviceaccount e2e-w6-rotate`,
`rm -rf "$d"`, and stop the kind node again if it was stopped.

## How the faults are made (checked on a throwaway kind cluster)

On a kind cluster of its own (kind 0.33, node v1.37.0, containerd 2.3.4, cgroup v2), with a busybox shell that traps
TERM and writes a line to a hostPath file, and a PostgreSQL 18 Deployment with the chart's probes:

- `crictl stop --timeout 0` (also `crictl stop` with no flag, whose default is 0, and `ctr task kill -s SIGKILL`): no
  TERM line; containerd logs "Kill container" only; exit 137, the container started again in the same pod.
- `kubectl delete pod --grace-period=0 --force`: a TERM line, then SIGKILL; containerd logs "Stop container … with
  signal terminated" and "Kill container" 2 s later. `crictl rm -f` sends no TERM either but leaves the old container's
  state `ContainerStatusUnknown`, so the tests use `crictl stop --timeout 0`.
- `ctr -n k8s.io task pause` of the PostgreSQL container for 20 s and 30 s: containerd says `PAUSED`, the kubelet still
  reads `CONTAINER_RUNNING`; an open connection gets no answer until the resume and then answers the queries it was
  sent; a new connection waits and is answered after the resume; the pod stays ready, no restart. A detached
  `sleep; ctr task resume` resumes a task whose pausing process is gone. `docker pause` of a PostgreSQL container
  outside kind behaves the same (`pg_isready` no response, then accepting connections).
- The helpers themselves (`killNoSignal`, `killPod`, `freeze`): Ctrl-C of the run resumed a frozen container at once,
  and a worker killed with SIGKILL left it to the detached process, which resumed it once the freeze's seconds + 30 s
  had passed.

## Install shapes (`scripts/kind-fault-shape.sh`)

| Shape | Sets | For |
| --- | --- | --- |
| `s1` | every replica 1, `mcp.enabled` | `pod-shutdown`, `redis-users`, F-9, F-14 with one gateway |
| `s2` | `replicas.k8sService`, `aiService`, `toolServer` 2 (needs #867: the script stops with the reason without `autoscaling.*` in the chart) | `cluster-versions`, drain tests 4, 5, F-7, W6-1, Q-52, `claude-code-slots`, F-5, `pod-shutdown -g k8s-service` |
| `s2-gateway` | `s2` and `replicas.gateway` 2 | F-14 with two gateways |
| `s3` | every replica 1, `streams.enabled` (needs #825) | `w4-stream-split` |

```bash
scripts/kind-model-subscription.sh up <token-file>   # first: claude-code-slots needs it, and it upgrades the release itself
scripts/kind-fault-shape.sh start   # note the start (the first switch does it too)
scripts/kind-fault-shape.sh s1      # … the tests of that shape …, then s2, s2-gateway, s3
scripts/kind-fault-shape.sh back    # roll back to the noted revision; its two hashes must match
scripts/kind-model-subscription.sh down              # last
```

`start` first prints the installed chart's name, version and app version (`helm get metadata`) and stops when this
checkout's chart does not render what is installed: the release's manifest against a server dry run of the same upgrade
(so `lookup` reads what is installed), Secrets left out of both, the differing documents listed
(`FAULT_SHAPE_ACCEPT_CHART=1` starts anyway). It notes the revision, its time in `helm history`, the hashes of
`helm get values` and `helm get values --all`,
a hash of the chart directory's files, and a copy of the values (a 0600 file next to the start, under the git-ignored
`.kind-data/`, for `back-values`). Every upgrade and rollback runs with `--history-max 0` and `--wait`; each upgrade is
described `kind-fault-shape <shape> chart=<hash>`, and each step prints the revision and both hashes before and after,
never the values. A shape the chart refuses stops at the server render (`--dry-run=server`) with nothing changed.

Between `start` and `back` nothing else may upgrade the release: a switch and `back` stop when a revision after the
start was made by something else (another script's upgrade — `kind-model-subscription.sh`, `rebuild-kind.sh` — would
be undone by the rollback, and keeps only 10 revisions), when the noted revision is no longer the one noted (pruned,
or the release installed again), and a switch also when this checkout's chart files differ from the start's (the
templates would change too). `back-values` is the way back then: `helm upgrade --reset-values -f <the copy>` with this
checkout's chart, if its files are the start's, and the same hash check; it needs only the start file and the copy, so
it also works when the noted revision is gone.

helm runs in the background of the script, so Ctrl-C, TERM or a closed terminal (HUP) reaches its trap at once: it
stops helm (SIGINT, which helm ends as a failed upgrade; SIGTERM if it is still there 30 s later), rolls back to the revision before the switch and checks the hashes (`ROLLBACK_BROKEN` and exit 3 when they
differ, the start's files kept). The rollbacks, there and in `back`, ignore those signals until they end; after a
closed terminal the rollback writes to `<start file>.log`. Each revision the script makes is listed (`<start>.made`)
before helm runs, and taken off again when helm made none, so a release it left `pending-upgrade` or
`pending-rollback` (its shell killed outright) is put back with `back`; one left so by something else is refused like
any other revision the script did not make.

## What a run leaves for the record

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=<raw>/<case>/report.json E2E_FAULT=1 npx playwright test --project=fault <file> -g "<case>" \
  --reporter=line,json --output <raw>/<case>/artifacts
```

The JSON report holds each test's annotations (who was killed, reasons, what was not checked) and the paths of its
attachments: every probe answer (`answers.json`; `reads.json`, `reads-during-outage.json`, `list-reads.json`,
`tool-answers.json` or `seen.json` in the cases that name them so); `timeline.json` (kill, thaw and recovery times in
ms, the error window, the live list's sockets, the recording row before and after, how the killed container ended) in
W6-1, Q-52, F-5 and F-14; `killed-container-previous-log.txt` in W6-1; `drain-status.json` in Q-52;
`reads-by-route.json` in F-9; `gateway-502-and-worker-lines.txt` in F-14; `errors-around-kill.json` (the failed
answers before, in the 3 s after and after the kill) in W6-1 and F-5; `slot-samples.json` in the first
`claude-code-slots` case; Redis's and PostgreSQL's off and on times in the `timeline.json` of every case that stops
them. Print `scripts/kind-fault-shape.sh status` before and after each shape into the same folder.

The fault project records no trace (`trace: 'off'`: a trace would hold the admin password, tokens and the kind
clusters' kubeconfigs the requests carry). The `--output` folder holds the attachments above, a screenshot of a page
test that failed and Playwright's `error-context.md` (the page's accessibility snapshot); none of them holds a
credential.

### First runs

The 3 s line of W6-1 and F-5 and the 5 s line of their live list sit near times of the system itself: the gateway's
nginx has one upstream (the Service) and does not send a failed request to the other server, a dead pod leaves the
endpoints after the kubelet sees it (about a second) and kube-proxy rewrites its rules (at least another), and the
list reconnects after 0.5–1 s, then 1–2 s, then 2–4 s. A first run that misses a line is judged from
`errors-around-kill.json` and the sockets in `timeline.json` before anything changes; the test is not loosened to make
it green (step 4 §4-3), and a line set again after the first measurement says why in the matrix.

## Not here, and why

- F-4 (the recording store cut) and F-16 (a token expiring under an open connection): step 4 asks to see what the
  install does now before a pass line is set.
- F-2's "recording loses at most its last part": needs a per-session count of parts uploaded before and after the
  replacement; left to W7.
- F-10, F-12, F-13 (a slow cluster API, tool-server or ai-service killed mid-call): rows of W5 that none of the pull
  requests above changes; F-11 is W2's, F-15 (a node replaced) runs on EKS.
- A whole node lost: kind's node is the laptop's Docker; W6-1 kills one server with no signal instead, and F-15 covers
  the node.

## After a run that stopped half way

Each test puts back what it changed in `finally`, and an interrupted one through `atExit` (above). If the worker or
the laptop went away before that could run:

- `kubectl -n kubeast get deploy redis postgres` — scale back to 1 if 0.
- `docker exec kubeast-control-plane ctr -n k8s.io task ls | grep PAUSED` — `ctr -n k8s.io task resume <id>` (a frozen
  PostgreSQL resumes by itself 30 s after its freeze time; `docker unpause` for `E2E_FAULT_PG_DOCKER`).
- `scripts/kind-fault-shape.sh status` — `back` while the values are not the start's or the release is `pending-*`
  (`back-values` when it names revisions made by something else).
- `ps -ef | grep 'kubectl.*port-forward'` — a port-forward left by a worker killed within the second before its shell
  looked.
- `$TMPDIR/e2e-fault-*` — the kubeconfig copy of a worker killed outright (any other run removes its own on exit).
- `kubectl --context kind-test2 get ns | grep e2e-w6` — delete them, then `kubectl --context kind-test2 uncordon <node>`.
- Clusters named `e2e-w6-*` in the cluster list — delete them.
- ServiceAccount, ClusterRole and ClusterRoleBinding `e2e-w6-rotate` on the cluster of the credential change — delete
  them.
- AI Chat conversations titled `e2e-w6-slots-*` — delete them.
- `UPDATE claude_code_slots SET owner = '', heartbeat_at = NULL WHERE owner LIKE 'e2e-w6-%'` on the dev database.
- Pods `e2e-w6-seq-*` / `e2e-w6-after-*` / `e2e-w6-nosig-*` / `e2e-w6-gw-*` in `default` on `self` — delete them.
