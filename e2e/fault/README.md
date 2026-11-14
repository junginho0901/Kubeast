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
- "Server restarts 0" compares the container restart counts of the pods present before and after.
- `stopFor(deploy, seconds)` scales a Deployment to 0 and back to what it had, waiting for the rollout, also when the
  test fails.
- Passwords (the Redis users') are read from their Secret and given to `valkey-cli` on stdin, never on a command line.

## Files

| File | Pull request | Step 4 / step 3 rows | Needs | Changes and puts back |
| --- | --- | --- | --- | --- |
| `pod-shutdown.spec.ts` | #856 `podShutdown.preStopSeconds` | F-6 on one replica; the PR's "four rollout restarts of each service with a request right after each" | nothing beyond the install; tool-server's case needs `mcp.enabled` | four `rollout restart`s of each of the eight Service-backed Deployments, one deleted pod each; waits for every rollout |
| `cluster-versions.spec.ts` | #857 cluster versions in the database | step 3 test 6; F-8 for M-2 | two ready `k8s-service` pods; kind clusters `kubeast-b` and `test2` | registers a cluster `e2e-w6-sync-*`, replaces its kubeconfig, deletes it; the second case stops Redis for about 20 s |
| `drain-in-db.spec.ts` | #858 drain progress in the database | step 3 tests 4 and 5, F-7, F-9 | `test2` registered; tests 4 and 5 two ready `k8s-service` pods; F-9 a PostgreSQL with a PersistentVolumeClaim | namespace `e2e-w6-drain*` / `e2e-w6-pgoff-*` on test2 (a pod under a PDB that refuses eviction), drains its node (test2's other pods are evicted and wait for the uncordon, as the action suite's `node-drain` leaves them), kills or stops one k8s-service pod, stops PostgreSQL 60 s; deletes the namespace and uncordons the node |
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
- Depends on: `node_drains` (migration 00025 of #858), the 5 s heartbeat / 20 s stale rule, `cordoned_nodes` in
  `GET /api/v1/nodes/{name}/drain/status`, `audit.failClosed` (refused writes while the audit store is down).

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

## Not here, and why

- F-4 (the recording store cut) and F-16 (a token expiring under an open connection): step 4 asks to see what the
  install does now before a pass line is set.
- F-2's "recording loses at most its last part": needs a per-session count of parts uploaded before and after the
  replacement; left to W7.
- F-5, F-10, F-12 – F-14 (two api servers, a slow cluster API, tool-server / ai-service / gateway killed): rows of W5
  that none of the pull requests above changes; F-11 is W2's, F-15 runs on EKS.
- A server that dies with no shutdown at all (a node lost): the kubelet always sends SIGTERM first; the stale
  heartbeat paths are held by the unit tests of #858 and #859 and by F-15.

## After a run that stopped half way

Each test puts back what it changed in `finally`. If a run was cut (the laptop slept, the process was killed):

- `kubectl -n kubeast get deploy redis postgres` — scale back to 1 if 0.
- `kubectl --context kind-test2 get ns | grep e2e-w6` — delete them, then `kubectl --context kind-test2 uncordon <node>`.
- Clusters named `e2e-w6-*` in the cluster list — delete them.
- `UPDATE claude_code_slots SET owner = '', heartbeat_at = NULL WHERE owner LIKE 'e2e-w6-%'` on the dev database.
- Pods `e2e-w6-seq-*` / `e2e-w6-after-*` in `default` on `self` — delete them.
