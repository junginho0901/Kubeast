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
- "Kill" is `kubectl delete pod --grace-period=0 --force`; "stop" is a plain `kubectl delete pod` (preStop, SIGTERM).
  A force delete still gives the process a SIGTERM about 2 s before SIGKILL (the kubelet's shortest grace), so a
  server can still run part of its shutdown; where that changes what is read, the test says so.
- "Kill with no signal" (`killNoSignal`) is `crictl stop --timeout 0 <container>` on the pod's kind node
  (`docker exec <node>`): SIGKILL with no SIGTERM, as a crash or the OOM killer ends a process; the kubelet starts the
  container again in the same pod.
- "Freeze" (`freeze`) is `ctr -n k8s.io task pause` of a container on its kind node (`docker pause` for a database
  container outside kind, `E2E_FAULT_PG_DOCKER`): every process stops, open connections stay open and nothing answers.
- What a test breaks below the API is put back on the worker's exit and on Ctrl-C (`atExit`), and a frozen container
  also by a detached process `seconds` + 30 s after the freeze, so a worker killed outright leaves no paused database.
  The drain tests' namespace on test2 and its cordon are put back the same way.
- `wsSubscriptions` reads a k8s-service pod's `kubeast_ws_subscriptions` through its port-forward: the pod whose count
  went up when a page opened its live list is the one that holds it. `watchListSockets` keeps each `/wsMultiplexer`
  socket the page opens (opened, first frame, closed) for `listSocketBack`.
- "Server restarts 0" compares the container restart counts of the pods present before and after.
- `stopFor(deploy, seconds)` scales a Deployment to 0 and back to what it had, waiting for the rollout, also when the
  test fails.
- Passwords (the Redis users') are read from their Secret and given to `valkey-cli` on stdin, never on a command line.

## Files

| File | Pull request | Step 4 / step 3 rows | Needs | Changes and puts back |
| --- | --- | --- | --- | --- |
| `pod-shutdown.spec.ts` | #856 `podShutdown.preStopSeconds` | F-6 on one replica; the PR's "four rollout restarts of each service with a request right after each" | nothing beyond the install; tool-server's case needs `mcp.enabled` | four `rollout restart`s of each of the eight Service-backed Deployments, one deleted pod each; waits for every rollout |
| `cluster-versions.spec.ts` | #857 cluster versions in the database | step 3 test 6; F-8 for M-2 | two ready `k8s-service` pods; kind clusters `kubeast-b` and `test2` | registers a cluster `e2e-w6-sync-*`, replaces its kubeconfig, deletes it; the second case stops Redis for about 20 s |
| `drain-in-db.spec.ts` | #858 drain progress in the database | step 3 tests 4, 5 and 11, F-7, F-9, W6-1, Q-52 | `test2` registered; tests 4, 5 and W6-1 two ready `k8s-service` pods; W6-1 and Q-52 `docker exec` into the kind node; F-9 a PostgreSQL with a PersistentVolumeClaim; Q-52 the chart's PostgreSQL or `E2E_FAULT_PG_DOCKER` | namespace `e2e-w6-drain*` / `e2e-w6-nosig-*` / `e2e-w6-pgoff-*` / `e2e-w6-pgfreeze*` on test2 (a pod under a PDB that refuses eviction), drains its node (test2's other pods are evicted and wait for the uncordon, as the action suite's `node-drain` leaves them), kills or stops one k8s-service pod (W6-1: with no signal, a busybox pod `e2e-w6-nosig-*` in `default` for its terminal), stops PostgreSQL 60 s, freezes it 20 s and 30 s; deletes the namespace and uncordons the node |
| `force-kill.spec.ts` | — (W5 rows no pull request changes) | F-5, F-14 | F-5 two ready `k8s-service` pods; F-14 one or two ready gateway pods | force-kills one k8s-service pod or one gateway pod, a busybox pod `e2e-w6-gw-*` in `default` (deleted); waits for the rollout |
| `claude-code-slots.spec.ts` | #859 Claude Code slots | M-4 "the cap holds on two servers; a server killed → its slot free within 60 s" | two ready `ai-service` pods (`replicas.aiService: 2`); the default model on provider `claude-code` (`scripts/kind-model-subscription.sh up`); table `claude_code_slots` | rows of `claude_code_slots` owned `e2e-w6-*` (set free after), conversations of the run (deleted), kills one ai-service pod; up to five short chat turns of the subscription |
| `redis-users.spec.ts` | #866 Redis users per service | M-6b "ACL refusal test" and "test 6 (tool-server 10 s)"; F-8 | the chart's Redis with `redis.acl` on; tool-server cases `mcp.enabled` and kind clusters `kubeast-b`, `test2`; the last case also #857 | one `kubeast:cache:e2e-w6-*` key (30 s TTL), clusters `e2e-w6-tool-*` (deleted), Redis stopped 60 s and about 20 s, one `rollout restart` of k8s-service while Redis is stopped |
| `w4-stream-split.spec.ts` | #823 `SERVER_ROLE`, #824 the stream server's drain, #825 `streams.enabled` | F-1, F-2 (the part `stream-server.spec.ts` does not hold), F-3 | `streams.enabled: true` (Deployment `k8s-service-stream`); F-3 one `k8s-service` replica | a busybox pod `e2e-w6-seq-*` in `default` (deleted), kills the stream server and the api server, one `rollout restart` of the stream server |

### Pass lines and what each test depends on

`pod-shutdown.spec.ts`
- Every answer during the rollouts is 200 and comes within 5 s (`E2E_FAULT_HANG_MS`); the bug held one for 30 s.
- Depends on: the preStop sleep and grace of #856 on all eight Deployments (the test records the preStop it found);
  `ROUNDS` = `E2E_FAULT_ROLLOUTS` (4).

`cluster-versions.spec.ts`
- Each k8s-service pod answers from the new kubeconfig within 10 s of the PATCH's answer, and no pod answers from the
  old one after it switched or after 10 s; the same with Redis stopped.
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
  slot; one slot set free is taken by exactly one turn within 5 s; slots held never pass `maxConcurrentTotal`.
- With every slot held for the whole wait, a turn ends with `error_key: claudeCodeBusy` between `queueWaitSeconds` − 1
  and + 10 s.
- A slot whose heartbeat stopped is taken by a waiting turn on another server when it is 59–62 s old, never before.
- A server killed while its run holds a slot: the other server's turn has that slot at most 62 s after the dead run's
  last heartbeat and is not busy (the test notes whether the shutdown set it free first).
- Depends on: `claude_code_slots` (migration 00025 of #859), `AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL` /
  `AI_CLAUDE_CODE_QUEUE_WAIT` in the ConfigMap, slot owners starting with the pod's host name, the stream's `queued`
  events, `POST /api/v1/ai/sessions/{id}/chat` with a JSON body.

`redis-users.spec.ts`
- The default user gets NOAUTH; probe may PING and nothing else; tool-server is refused GET, SET, FLUSHDB, PUBLISH,
  KEYS and SCAN and may PING; k8s-service may SET, GET and PUBLISH under `kubeast:` and is refused keys and channels
  outside it, FLUSHALL, FLUSHDB, KEYS, CONFIG, EVAL, HSET and ACL.
- tool-server answers from the new kubeconfig on every call later than 10 s after the change, with the change notice
  and with Redis stopped (its 10 s keep alone).
- F-8: every screen read answers 200 while Redis is off for 60 s and while it comes back, no restart of the pods that
  stayed, `kubeast:cache:` keys are in Redis again afterwards.
- F-8 for #857: a k8s-service started while Redis was down logs that it runs on the in-memory cache, logs within 15 s
  of Redis answering that its cache moves to Redis, and reads answer 200 throughout.
- Depends on: the ACL file of #866 (`kubeast.redisUsersAcl`), the Secret `kubeast-redis-users` (or the one the redis
  pod's `REDISCLI_AUTH` names), tool-server's 10 s kubeconfig keep and change notice listener, the log lines of #857's
  `cache.Reconnect`, and #856's preStop for the restart without Redis.

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
scripts/kind-fault-shape.sh start   # note the revision and its values' hashes (the first switch does it too)
scripts/kind-fault-shape.sh s2      # … the tests of that shape …
scripts/kind-fault-shape.sh back    # roll back to the noted revision; its two hashes must match
```

Every upgrade and rollback runs with `--history-max 0` and `--wait`; each step prints the revision and the hashes of
`helm get values` and `helm get values --all` before and after, never the values. A shape the chart refuses stops at
the server render (`--dry-run=server`) with nothing changed; a helm error, a failed check or Ctrl-C during the upgrade
rolls back to the revision before it and checks its hashes (`ROLLBACK_BROKEN` and exit 3 when they differ). Another
script's upgrade (`kind-model-subscription.sh`, `rebuild-kind.sh`) keeps helm's 10 revisions and can drop the noted
one: `back` then takes the newest revision with the same two hashes. The claude-code model for `claude-code-slots`
stays `scripts/kind-model-subscription.sh up` / `down`.

## What a run leaves for the record

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=<raw>/<case>/report.json E2E_FAULT=1 npx playwright test --project=fault <file> -g "<case>" \
  --reporter=line,json --output <raw>/<case>/artifacts
```

The JSON report holds each test's annotations (who was killed, reasons, what was not checked) and the paths of its
attachments: `answers.json` (every probe answer) in every case; `timeline.json` (kill, thaw and recovery times in ms,
the error window, the live list's sockets, the recording row before and after, how the killed container ended) in
W6-1, Q-52, F-5 and F-14; `killed-container-previous-log.txt` in W6-1; `drain-status.json` in Q-52;
`reads-by-route.json` in F-9; `gateway-502-and-worker-lines.txt` in F-14. Print `scripts/kind-fault-shape.sh status`
before and after each shape into the same folder.

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

Each test puts back what it changed in `finally`. If a run was cut (the laptop slept, the process was killed):

- `kubectl -n kubeast get deploy redis postgres` — scale back to 1 if 0.
- `docker exec kubeast-control-plane ctr -n k8s.io task ls | grep PAUSED` — `ctr -n k8s.io task resume <id>` (a frozen
  PostgreSQL resumes by itself 30 s after its freeze time; `docker unpause` for `E2E_FAULT_PG_DOCKER`).
- `scripts/kind-fault-shape.sh status` — `back` while the values are not the start's.
- `kubectl --context kind-test2 get ns | grep e2e-w6` — delete them, then `kubectl --context kind-test2 uncordon <node>`.
- Clusters named `e2e-w6-*` in the cluster list — delete them.
- `UPDATE claude_code_slots SET owner = '', heartbeat_at = NULL WHERE owner LIKE 'e2e-w6-%'` on the dev database.
- Pods `e2e-w6-seq-*` / `e2e-w6-after-*` / `e2e-w6-nosig-*` / `e2e-w6-gw-*` in `default` on `self` — delete them.
