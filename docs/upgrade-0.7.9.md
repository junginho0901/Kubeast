**English** | [한국어](ko/upgrade-0.7.9.md)

# Upgrading from 0.7.8 to 0.7.9

**Changes you must act on: yes, on some installs.** On Kubernetes older than 1.30, the render stops while `podShutdown.preStopSeconds` is above 0 (5 by default), `gateway.preStopSeconds` is above 0 or `streams.enabled` is on: set `podShutdown.preStopSeconds: 0`, leave `gateway.preStopSeconds` empty or 0 and turn `streams.enabled` off, or move to Kubernetes 1.30 or later ([1.3](#13-kubernetes-version)). On Helm 4.0.0 or Helm 3.14 and older, `helm template` without `--kube-version` stops the same way, since their own default Kubernetes is older than 1.30: pass your cluster's version ([1.3](#13-kubernetes-version)). With the chart's alert rules on (`metrics.prometheusRule.enabled`) and the AI on, the upgrade adds up to two alerts: route them first ([1.5](#15-alert-rules)). A key you put in the main Secret for k8s-service is no longer read unless k8s-service reads it by name ([1.4](#14-what-k8s-service-reads-from-the-main-secret)). With the chart's PostgreSQL, a `postgresql.maxConnections` set to 0.7.8's connection sum stops the render, since 0.7.9 counts one more connection per auth-service pod: raise it first ([1.6](#16-database-connections)). With an external database, keep its `max_connections` above the new sum the install notes print ([1.6](#16-database-connections)). A script that reads one of the API answers in [4](#4-what-changes-by-itself) "API answers" may have to change. An SSO account (one that single sign-on made, `auth_source` `oidc`) no longer signs in with a password, also one an admin's reset gave it, and a self sign-up single sign-on reached while it waited for approval becomes one at the upgrade ([1.7](#17-single-sign-on-accounts-and-passwords)). With `auth.passwordLogin: admin-only`, the password form opens to `admin.email` as written, so an account under an address that differs from it only in letter case gets 403 there: write `admin.email` in the letters that account is stored under, or use the account stored under `admin.email` as written ([4](#4-what-changes-by-itself)). Where a proxy in front of a cluster's API server drops the `Audit-ID` header, its error statuses no longer count as the API server's answer and the health check's `/version` answered so opens the breaker: let the proxy pass `Audit-ID` ([3](#3-values-you-must-change), [4](#4-what-changes-by-itself)). A custom role that lists the AI tools one by one gets the new tool `anomaly_rank` only when `ai.tool.anomaly_rank` is added to it. The other items below apply only to the installs they name.

This page is for an install of 0.7.8 going to 0.7.9: what to check first, what changes by itself, which values to change, what the upgrade does once, and how to go back.
The upgrade command is the one in [Getting started](getting-started.md#upgrade), with `--version 0.7.9`.
Each item names the pull request that made the change.

The commands below use the release name `kubeast` in the namespace `kubeast`; put yours in their place.

## In short

- Run the dry run in [1.2](#12-rehearse-with-a-dry-run) first. Every check that can stop the upgrade stops it there, and nothing changes.
- From 0.7.7 or earlier, upgrade to 0.7.8 first ([1.1](#11-where-you-are)).
- Below Kubernetes 1.30 the render stops while a pod would get a preStop sleep, and below 1.33 while k8s-service-stream would get one of 0 seconds; 0.7.8 applied the other objects first and the API server then refused the Deployments (#1072).
- Every Kubeast server gets a startup probe asked every second and readiness every 3 s (`podStartup.quickReady`, on by default), so the upgrade rolls each of their pods, and a pod that replaces the only one is ready about a second after it listens. `false` keeps 0.7.8's probes (#1072).
- The database goes from schema 30 to 33, and the services wait for 33: migration 00031 (#882), 00032, which makes the self sign-ups single sign-on reached SSO accounts (#1077), and 00033, two indexes on `tool_approvals` (#1077).
- k8s-service and k8s-service-stream read only the keys they use from the main Secret ([1.4](#14-what-k8s-service-reads-from-the-main-secret), #1072).
- A read of a cluster that gets no answer in 20 s answers 503 (#1060), and the cluster breaker reads an error status as the API server's only when it carries `Audit-ID` (#1060).
- API answers change: Change password, an admin's password reset, password sign-in with `admin-only`, network flows, cluster reads, cluster features, log and trace metrics, the Resource Graph, four AI tools, the alert webhook and the retention purge's audit row ([4](#4-what-changes-by-itself)).
- The retention purge's lock holds a connection of its own outside auth-service's pool, so the connection sum the chart checks against `postgresql.maxConnections` counts one more per rolling auth-service pod: 156 for one pod of each service with the AI on (was 154), 290 for three of each (was 286). A value set to 0.7.8's sum stops the render with the new one ([1.6](#16-database-connections), #1072).
- Behind PgBouncer, session pooling stays required: the retention purge now holds a session advisory lock while it runs ([1.6](#16-database-connections), #1072).
- Behind an AWS Application Load Balancer that sends to pod IPs, the gateway pods wait 25 s before they stop and the Ingress asks for a 20 s deregistration delay. Unless the install already runs 0.7.8 with the values 0.7.8 asked for behind such a load balancer, the first upgrade's replacement of the gateway pods can still have 502 and 504 ([4](#4-what-changes-by-itself), #1072).
- An SSO account no longer signs in with a password, also one an admin's reset gave it before 0.7.9, and a self sign-up that single sign-on reached while it waited for approval becomes one ([1.7](#17-single-sign-on-accounts-and-passwords), #1077).
- Each k8s-service (k8s-service-stream with `streams.enabled`) refuses a terminal or followed log past 443 open on it for all accounts together, as at an account's cap (`multicluster.maxStreamsPerServer`, `0` sets no cap; [4](#4-what-changes-by-itself), #1060).
- The AI's new reads and checks are switches. `features.anomalyRank.enabled` is on by default, so AI Chat, the floating chat and the MCP server get the tool `anomaly_rank` ([4](#4-what-changes-by-itself), #1088). `ai.ruleCards.investigations` and `features.alertInvestigation.rules`, `changesFirst`, `narrowFirst`, `ledger`, `evidenceCheck` and `verdict` are on by default too and change only alert investigations, which stay off (`features.alertInvestigation.enabled`). The others are off. Set a switch to `false` to keep 0.7.8's behaviour. These changes to the AI have no switch: an image in AI-written text is a link (#917), an alert reaches the model as its rule's expression (#1087), a chat question is held to one output form's tools only when it asks for that form (#1078), with a Gemini model each tool call goes back with its thought signature (#1087), with a Claude model (provider `anthropic`) a call after a tool loop keeps the loop's tools and calls none (#1082), on a Claude subscription an alert investigation's closing call and second ask hold the tool results between markers (#1087), a chat answer may make 20 model calls, the last of which calls no tool and answers (`ai.chat.maxSteps`, #1084), the request for the rest of a chat answer cut at its length is in other words (#1084), Claude Code receives every prompt as written (#1086), and what the AI tools `get_pod_metrics` and `issues` (#1088), `logsearch` (#1077), `alerts_inbox` and `investigations` (#1087), and `k8s_get_pod_logs` (#1094) answer changed ([4](#4-what-changes-by-itself)).
- The built-in Read role gets `ai.tool.anomaly_rank` at start-up (the tool is on by default), and Write holds `ai.tool.*`. A custom role that lists the AI tools one by one gets the new tool only when `ai.tool.anomaly_rank` is added to it ([3](#3-values-you-must-change), #902).
- Back up the database first. 〔What a rollback keeps: after the rehearsal.〕

## 1. Before you upgrade

### 1.1 Where you are

```bash
helm list -n kubeast                          # CHART kubeast-0.7.8
helm get values kubeast -n kubeast -o yaml    # the values you set yourself
```

From 0.7.7 or earlier, upgrade to 0.7.8 first with [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md), and let it settle. 〔Confirm after the rehearsal from 0.7.8.〕

### 1.2 Rehearse with a dry run

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.9 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

It renders 0.7.9 with your values and changes nothing. A check that stops it makes Helm print an error saying what to change; the table in [3](#3-values-you-must-change) lists them. From 0.7.9 the Kubernetes version in [1.3](#13-kubernetes-version) is one of these checks.

It does not send the objects to the API server. To have the API server check them too, run the `kubectl apply --server-side --dry-run=server` of [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#12-rehearse-with-a-dry-run) with `--version 0.7.9`.

### 1.3 Kubernetes version

```bash
kubectl version    # Server Version
```

A preStop sleep needs Kubernetes 1.30 (`PodLifecycleSleepAction`, on by default from 1.30), and a sleep of 0 seconds needs 1.33 (`PodLifecycleSleepActionAllowZero`, on by default from 1.33). 0.7.9 stops the render, before Helm applies anything, when a pod would get one the cluster refuses (#1072):

- below 1.30, while `podShutdown.preStopSeconds` is above 0 (5 by default), `gateway.preStopSeconds` is above 0, or `streams.enabled` is on. k8s-service-stream sleeps `streams.preStopSeconds` whatever `podShutdown.preStopSeconds` is, so `podShutdown.preStopSeconds: 0` alone does not take its sleep out. An empty `gateway.preStopSeconds` follows `podShutdown.preStopSeconds`, raised to 25 behind an AWS Application Load Balancer that sends to pod IPs only while that is above 0.
- below 1.33, with `streams.enabled` and `streams.preStopSeconds: 0`.

0.7.8 applied the other objects and the API server then refused those Deployments, so an install whose upgrade to 0.7.8 went through already has values that pass. The message names the values to set. `helm template`, with `--show-only` too (as `scripts/render-target-rbac.sh` runs it), reads the version given with `--kube-version`, else Helm's own default, which is v1.20.0 on Helm 4.0.0 and 1.29 or older on Helm 3.14 and older: pass your cluster's version there.

### 1.4 What k8s-service reads from the main Secret

k8s-service and k8s-service-stream took the main Secret (`kubeast-secrets`, or the Secret of `secrets.existingSecret`) whole as their environment. From 0.7.9 they read only these keys from it, by name (#1072):

- `DATABASE_URL` and `INTERNAL_API_TOKEN`.
- `REDIS_PASSWORD` while the Redis users are off. With them on, k8s-service reads its own user's password, as in 0.7.8.
- `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, when the Secret holds them.

The other services still take the main Secret whole, and every service still takes `kubeast-config` whole.
A key you added to `secrets.existingSecret` for k8s-service, other than those, is no longer read.
That includes a key named as one of `kubeast-config`, whose value it took the place of (the Secret came after `kubeast-config` in `envFrom`; k8s-service now reads `kubeast-config`'s value), and a lower-case `http_proxy`, `https_proxy` or `no_proxy`. This prints the Secret's key names, not their values:

```bash
kubectl -n kubeast get secret <your secrets.existingSecret> -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
```

Write a lower-case proxy key there in upper case, as k8s-service takes `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` only by those names.
For a key named as one of `kubeast-config`, set the chart value that writes that key, if there is one; the chart has no value that gives k8s-service a variable of your own.

With the Redis users' keys in that Secret (`redis.acl.existingSecretHasKeys: true`), the install notes now say that every backend but k8s-service holds every Redis user's password.

### 1.5 Alert rules

With `metrics.enabled` (on by default) and `metrics.prometheusRule.enabled`, the chart's PrometheusRule gains up to two alerts, both `severity: warning` (#1060):

| Alert | Rendered with | Fires when |
| --- | --- | --- |
| `KubeastAIModelUnreachable` | `ai.enabled` | over 10 minutes, 3 or more model requests failed and none was answered, for 10 minutes |
| `KubeastAIInvestigationsFailing` | `ai.enabled` and `features.alertInvestigation.enabled` | over an hour, 3 or more alert investigations failed and more than half of those that ended, for 15 minutes |

With the other values at their defaults (`ai.enabled` on, `features.alertInvestigation.enabled` off), that is the first only: six alerts, not five.
Route them in Alertmanager before you upgrade. A model provider that stops answering ends each chat inside a 200 stream, so `KubeastHighErrorRate` did not see it.

ai-service's HTTP metrics no longer count the kubelet's probes of `/api/v1/ai/health`, 8 to 22 requests a minute per pod, so `KubeastHighErrorRate` and `KubeastSlowRequests` read ai-service's requests without them, and after the upgrade they can fire for ai-service where they did not before (#1060).

### 1.6 Database connections

The retention purge now holds its advisory lock on a connection of its own, outside auth-service's pool, while a purge runs, as k8s-service's health status lock does (#1072).
The sum the chart checks against `postgresql.maxConnections` ([Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#16-database-connections)) counts it: one more connection per rolling auth-service pod.
One pod of each service with the AI on can hold up to 156 connections (was 154), three pods of each 290 (was 286), and 310 with `streams.enabled` (was 306).

With the chart's PostgreSQL, a `postgresql.maxConnections` set to 0.7.8's sum, or above it by less than the rolling auth-service pods, stops the render. The dry run in [1.2](#12-rehearse-with-a-dry-run) shows it with `the pods can hold up to <sum> database connections`.
Before you upgrade, raise `postgresql.maxConnections` to that sum or more, or lower the pools or the pod counts.
A new `postgresql.maxConnections` changes the bundled PostgreSQL's `max_connections` argument, so its pod is replaced during the upgrade and the database pauses while the new pod starts; writes and sensitive reads answer 503 `audit unavailable` until it is back, as in [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#5-one-time-effects-of-this-upgrade).

With an external database (`postgresql.enabled: false`) the chart does not check: the install notes print the new sum, and the database's `max_connections` has to stay above it.

Behind PgBouncer, use session pooling, or connect directly, as in 0.7.8.
The retention purge's lock is a session advisory lock, beside the migrations', the audit sinks' and k8s-service's health status lock; under transaction pooling it does not stay with the client that took it (#1072).

### 1.7 Single sign-on accounts and passwords

An admin's password reset of an SSO account (`auth_source` `oidc`) is refused with 400 and a `user.password.reset` failure row (`single_sign_on_account`), and User Management shows "SSO account" in place of Reset password (#1077).
A self sign-up that single sign-on reached while it waited for approval is such an account: from 0.7.9 that sign-in makes it `oidc`, and the upgrade (migration 00032) makes those reached before so, also one an admin approved or gave a password since, keeping a password it holds (#1077).
The upgrade knows a self sign-up by its `user.register` audit row, so one whose row the retention purge already removed stays a password account ([5](#5-one-time-effects-of-this-upgrade)).
Of those, the accounts still waiting for approval (Pending) that single sign-on already reached, holding no password or named by a `user.account.link` row, are listed by this read, which leaves out an account a `user.create` row names:

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- psql -U kubeast -d kubeast -c \
  "SELECT u.id, u.email, u.created_at FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Pending' AND u.auth_source = 'password' AND (u.password_hash = '' OR EXISTS (SELECT 1 FROM auth_audit_logs a WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id)) AND NOT EXISTS (SELECT 1 FROM auth_audit_logs c WHERE c.action IN ('user.register', 'user.create') AND c.result = 'success' AND c.target_user_id = u.id) ORDER BY u.created_at"
```

An admin checks each account it lists and then tidies it up.

An account an admin made stays a password account whatever its account level, Pending included, and so does a self sign-up an admin approved before single sign-on reached it while it holds a level past Pending, so a person who signs in both ways keeps both.
The chart's admin account is the account stored under `admin.email` as written, and it can be reset whatever made it; an account whose address differs from `admin.email` only in letter case is another account. When the provider made it, User Management shows "SSO account" for it and the Account page shows no Change password; `reset-admin` recovers it as before, `POST /api/v1/auth/admin/users/{user_id}/reset-password` resets it, and once it holds a password `POST /api/v1/auth/change-password` changes it.
`auth.passwordLogin: admin-only` opens the password form to the chart's admin account only, so an account whose address differs from `admin.email` only in letter case gets 403 `Password login is disabled; use single sign-on` there ([4](#4-what-changes-by-itself)).

Such an account no longer signs in with a password, also one a reset gave it before 0.7.9: the answer is a wrong password's 401 `Invalid credentials`, the `user.login.failed` row says `single_sign_on_account`, and no failure counts toward the lockout. Its `POST /api/v1/auth/change-password` answers 400 as well, so a script that changed its password through the API stops there. The chart's admin account still signs in with its password, whatever made it. Whoever signs in that way has to use single sign-on from then on. This prints how many accounts will stop signing in with a password they hold, and nothing else:

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- psql -U kubeast -d kubeast -c \
  "SELECT count(*) FROM auth_users u WHERE u.password_hash <> '' AND u.email <> '<admin.email>' AND (u.auth_source = 'oidc' OR (u.auth_source = 'password' AND EXISTS (SELECT 1 FROM auth_audit_logs r WHERE r.action = 'user.register' AND r.result = 'success' AND r.target_user_id = u.id) AND EXISTS (SELECT 1 FROM auth_audit_logs a WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id)))"
```

A session already open goes on until `auth.sessionAbsoluteHours` (8 by default), unless an admin ends that account's sessions sooner by setting its role (`role_id` in `PATCH /api/v1/auth/admin/users/{user_id}`), which ends them also when the role stays the same; the upgrade ends those of the self sign-ups it changes that hold a password.
`reset-admin --email` on such an account, other than the chart's admin account, gives it the Admin role, clears its locks and ends its sessions but writes no password, and its last line says the account signs in through the provider; `reset-admin` without `--email` recovers the chart's admin account, the password way in while the provider is down.

### 1.8 Back up the database

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.9.dump
```

With an external database, use its own backup. [Database: TLS, backup and restore](database-backup-restore.md#backing-up-the-in-cluster-database) has both ways and the restore.

## 2. Upgrade

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.9 \
  -n kubeast --reset-then-reuse-values
```

- auth-service applies the migrations at boot, or the migration Job does with `migrations.mode: job`: 00031 (#882), 00032 (#1077) and 00033 (#1077). 00032 adds `auth_users.self_signed_up` (a constant default, no table rewrite), marks the self sign-ups from `auth_audit_logs` through its action index, once, and changes the `auth_users` rows of the self sign-ups single sign-on reached. 00033 builds its two indexes in the migration's transaction, as the other migrations build theirs, so writes to `tool_approvals` wait until it ends (about 1.5 s per million rows). 〔How long it took: after the rehearsal.〕 The 0.7.9 services wait for schema 33.
- Every Kubeast server's Deployment changes, with its image and, with `podStartup.quickReady`, its probes, and rolls one pod at a time; the 0.7.8 pods stop with their `preStop` wait. Terminals and followed logs open on a pod that stops end as in 0.7.8 ([Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#4-what-changes-by-itself)).
- No 0.7.9 change touches the bundled PostgreSQL and Redis: the chart renders their pods as 0.7.8's does. A `postgresql.maxConnections` you raise for [1.6](#16-database-connections) replaces the PostgreSQL pod.
- 〔What requests saw during the upgrade (failures, sign-ins, seconds): after the rehearsal.〕

## 3. Values you must change

Only the rows that match your install. A row marked "stops" stops the upgrade, with a message, until the value is changed.

| When | 0.7.8 | 0.7.9 | PR |
| --- | --- | --- | --- |
| Kubernetes older than 1.30, with `podShutdown.preStopSeconds` above 0, `gateway.preStopSeconds` above 0 or `streams.enabled` ([1.3](#13-kubernetes-version)) | The API server refused the Deployments after the other objects were applied | Stops. `podShutdown.preStopSeconds: 0`, `gateway.preStopSeconds` empty or 0 and `streams.enabled` off, or Kubernetes 1.30 or later | #1072 |
| Kubernetes older than 1.33, with `streams.enabled` and `streams.preStopSeconds: 0` | The API server refused k8s-service-stream | Stops. `streams.preStopSeconds` 1 or more, or Kubernetes 1.33 or later | #1072 |
| A key in `secrets.existingSecret` that k8s-service read, other than those in [1.4](#14-what-k8s-service-reads-from-the-main-secret) | read | not read | #1072 |
| `metrics.prometheusRule.enabled` with the AI on ([1.5](#15-alert-rules)) | — | Up to two new alerts: route them | #1060 |
| Keep 0.7.8's probes | — | `podStartup.quickReady: false` | #1072 |
| Behind an AWS Application Load Balancer that sends to pod IPs, keep 0.7.8's gateway wait and deregistration delay ([4](#4-what-changes-by-itself)) | — | `gateway.preStopSeconds: 5`, and `deregistration_delay.timeout_seconds=300` in `alb.ingress.kubernetes.io/target-group-attributes` | #1072 |
| A proxy in front of a cluster's API server drops the `Audit-ID` header | Its 4xx counted as the API server's answer | Its error statuses no longer count as the API server's answer, and the health check's `/version` answered so opens the breaker: let the proxy pass `Audit-ID` | #1060 |
| Behind PgBouncer in transaction pooling | Not supported | Not supported, for the retention purge's lock too: session pooling, or a direct connection | #1072 |
| The chart's PostgreSQL with `postgresql.maxConnections` below the new connection sum ([1.6](#16-database-connections)) | Fit 0.7.8's sum | Stops: one more connection per rolling auth-service pod. Raise it to the sum the message names, or lower the pools or the pod counts | #1072 |
| External database | — | Its `max_connections` above the new sum the install notes print | #1072 |
| People who sign in with a password on an SSO account, or on a self sign-up single sign-on reached ([1.7](#17-single-sign-on-accounts-and-passwords)) | Signed in | Refused: sign in through single sign-on | #1077 |
| `auth.passwordLogin: admin-only`, with a password account under an address that differs from `admin.email` only in letter case ([4](#4-what-changes-by-itself)) | Earlier versions let it through | 403 `Password login is disabled; use single sign-on`: write `admin.email` in the letters that account is stored under, or use the account stored under `admin.email` as written | #1077 |
| Upgrading with `--reuse-values` | stops | Stops, as in 0.7.8: use `--reset-then-reuse-values` | — |
| Keep 0.7.8's limit of 10 model calls a chat answer ([4](#4-what-changes-by-itself)) | 10 | 20 unless set: `ai.chat.maxSteps: 10` | #1084 |
| A custom role that lists the AI tools one by one | — | Add `ai.tool.anomaly_rank` to give it the new tool, which is on by default | #902, #1088 |
| Keep the AI as 0.7.8 had it ([4](#4-what-changes-by-itself)) | — | `features.anomalyRank.enabled: false`. With alert investigations on, also `ai.ruleCards.investigations` and `features.alertInvestigation.rules`, `changesFirst`, `narrowFirst`, `ledger`, `evidenceCheck` and `verdict` `false` | #1088 |
| A script or an MCP client that reads `generator_url` or `alertmanager_url` from the AI tools `alerts_inbox` or `investigations` | Given | Not given: `expr` holds the rule's expression. The routes and the screens keep both | #1087 |
| `networkPolicy.aiEgress.allowListOnly: true` (off by default) with the AI on | — | Stops while `networkPolicy.enabled` is off, `networkPolicy.allowExternalEgressCIDRs` is empty, `networkPolicy.aiEgress.clusterAPIs` and `networkPolicy.apiserverCIDR` are both empty, or tool-server holds an IRSA role and `networkPolicy.aiEgress.stsEndpoints` is empty | #917 |

To take a value out, do as in [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#3-values-you-must-change), with `--version 0.7.9`.

New values whose defaults need nothing from you: `podStartup.quickReady` (true), `gateway.preStopSeconds` (empty: the gateway waits `podShutdown.preStopSeconds`, and at least 25 s behind an AWS Application Load Balancer that sends to pod IPs while that is above 0; `0` leaves the wait out, a negative or non-whole value stops the render, and above 0 it is a `preStop` sleep, which needs Kubernetes 1.30 or later; behind such a load balancer keep it above the target group's deregistration delay), `gateway.servedByHeader` (false, alpha: with it on, every answer the gateway sends carries `X-Kubeast-Gateway` with the gateway pod's name, for rollout tests; clients then see the pod names, so leave it off elsewhere), `multicluster.maxStreamsPerServer` (443: a cap on the terminals and followed logs each k8s-service holds open for all accounts together; `0` sets no cap; the chart reads it with that default, so values without it, 0.7.8's too, render 443, and `--reuse-values` does not stop for want of it; [4](#4-what-changes-by-itself)), `ai.chat.maxSteps` (20: the model calls one chat answer may make, 1 to 100; the chart reads it with that default, so values without it, 0.7.8's too, render 20; [4](#4-what-changes-by-itself)), `ai.timelineChanges`, `ai.timelineChangesMore`, `ai.causeQuestions`, `ai.refuseRepeatedReads`, `ai.toolResultDetails`, `ai.toolResultsJSON` and `ai.redaction.numbered` (false), `ai.ruleCards.investigations` (true), `ai.ruleCards.chat` and `ai.ruleCards.symptoms` (false, with `ai.ruleCards.cards` and `ai.ruleCards.remove` empty), `features.alertInvestigation.rules`, `changesFirst`, `narrowFirst`, `ledger`, `evidenceCheck` and `verdict` (true, with `window.metricsMinutes` 15, `window.logsMinutes` 5 and `window.changesHours` 4; read only while alert investigations are on), `features.anomalyRank.enabled` (true, with `maxQueries` 12, `checkTimeoutSeconds` 5, `timeoutSeconds` 20, `concurrency` 4, `cacheSeconds` 60 and `logMaxBytes` 10737418240), `features.nodeNeighbors.enabled` (false), `features.logSearch.queryMaxBytes` (0), `features.callGraph.enabled` (false) and `networkPolicy.aiEgress.allowListOnly` (false, with `clusterAPIs` and `stsEndpoints` empty). [Configuration](configuration.md) describes each.

## 4. What changes by itself

**Pods**

- With `podStartup.quickReady` (true), each Kubeast server (not the bundled PostgreSQL and Redis) has a startup probe asked every second for up to 180 s, and readiness every 3 s with no initial delay, so a pod that replaces the only one (deleted, or evicted by a node drain) is ready about a second after it listens. 0.7.8 gave auth-service, k8s-service and session-service a startup probe every 5 s and the others none, with readiness every 10 s after a delay; on kind, with one pod, nothing answered for about 6 s while ai-service, the frontend or the gateway was replaced, and for about 1 s while auth-service, k8s-service or session-service was. 〔Numbers: recheck with 0.7.9's measurement.〕 The kubelet now asks each Kubeast server pod 22 times a minute, where it asked 8. `false` renders 0.7.8's probes byte for byte (#1072).
- k8s-service and k8s-service-stream take only their keys of the main Secret ([1.4](#14-what-k8s-service-reads-from-the-main-secret), #1072).

**Cluster requests**

- A read of a cluster (a GET, a HEAD or a review, such as an access review) waits 20 s for the API server to start its answer, then answers 503; the body is read as long as it takes. Once one read of a request ran out its wait, the request sends that cluster no other read. Watches, followed logs, exec, attach, port-forward, the proxy subresource and writes are not timed. In 0.7.8 a silent API server held a request for about 55 s, and a request that asked more than once could end in the gateway's 504 with no reason (#1060).
- The cluster breaker reads a response as the API server's answer when its status is below 400 or it carries `Audit-ID`, which kube-apiserver writes on every answer. The API server's own 503 or 504 (an aggregated API right after a control plane restart, a big list) now closes a trial; an error status a proxy in front of it writes no longer closes one or clears a closed breaker's count, and the health check's `/version` so answered opens the breaker (#1060).
- A cluster that names its own log store (Admin → Clusters → Edit) is in `features.logSearch.clusters` of `/api/v1/cluster/features` without being listed in the chart's `features.logSearch.clusters` (#1072).
- The Timeline and the events API, for a grant limited to namespaces, ask those namespaces' access checks side by side, eight at a time, before the first read; a check the API server could not answer reads only that namespace as the person. A drawer's Events section whose check cannot be answered lists the events as the person, where it failed with "events not listed" (#1060).

**Gateway**

- Behind an AWS Application Load Balancer that sends to pod IPs (`alb.ingress.kubernetes.io/target-type: ip` on the chart's Ingress), the gateway pods wait 25 s before they stop (`podShutdown.preStopSeconds` when that is 0 or above 25), in a 55 s grace period, and the Ingress gets `deregistration_delay.timeout_seconds=20` in `alb.ingress.kubernetes.io/target-group-attributes` (after the attributes written there; a delay written there stays), which the AWS Load Balancer Controller sets on the target group. To keep 0.7.8's, set `gateway.preStopSeconds: 5` and write `deregistration_delay.timeout_seconds=300` in that annotation ([Running more than one replica](high-availability.md#before-you-start)). While the chart sets both, the install notes say so under "Behind an AWS ALB that sends to pod IPs" and ask for two or more AWS Load Balancer Controller pods, since with one the targets are not updated while its node is drained (#1072).
- The first upgrade from 0.7.8 to 0.7.9 replaces the gateway pods (their wait goes from 5 s to 25 s), and the pods that leave then are 0.7.8's, which wait 5 s, so behind an AWS Application Load Balancer that sends to pod IPs that one replacement can still have the 502 and 504 described in [Running more than one replica](high-availability.md#before-you-start). An install that already runs 0.7.8 with the values 0.7.8 asked for there (`podShutdown.preStopSeconds: 25` and `deregistration_delay.timeout_seconds=20` in `alb.ingress.kubernetes.io/target-group-attributes`, [Upgrading from 0.7.7 to 0.7.8](upgrade-0.7.8.md#3-values-you-must-change)) does not have it: its leaving gateway pods already wait 25 s, as in the 18 replacements with no failure. An install that set `podShutdown.preStopSeconds: 25` and a 20 s delay by hand as 0.7.8 asked can keep them, or set `podShutdown.preStopSeconds` back to 5: the gateway waits 25 s either way.

**API answers**

- `POST /api/v1/auth/change-password` answers a wrong current password with 403 `{"detail": "Invalid current password", "reason": "password_mismatch"}`, where it answered 401. The console keeps the sign-in and says "The current password is wrong." under the field (#1077).
- `POST /api/v1/auth/admin/users/{user_id}/reset-password` answers 400 for an SSO account, and goes through for the chart's admin account whatever made it ([1.7](#17-single-sign-on-accounts-and-passwords), #1077).
- `POST /api/v1/auth/change-password` answers 400 for an SSO account, before it checks the current password, and leaves a `user.password.change` failure row `single_sign_on_account`; the chart's admin account changes its password whatever made it ([1.7](#17-single-sign-on-accounts-and-passwords), #1077).
- With `auth.passwordLogin: admin-only`, `POST /api/v1/auth/login` opens to `admin.email` as written: an address that differs from it only in letter case, which earlier versions let through, gets 403 `Password login is disabled; use single sign-on` and a `user.login.failed` row `password_login_disabled`, so a password account under such an address no longer signs in there, and the account stored under `admin.email` as written still does. An install that later wrote `admin.email` in other letters keeps its old admin account under the old letters, and that account is refused: write `admin.email` in the letters that account is stored under (boot makes the account under `admin.email` as written when it is missing, and `reset-admin` recovers it) (#1077).
- A network flows read answers 502 for a 401 or 403 that a Hubble Relay or Calico Whisker writes itself (a body that is no Kubernetes Status, or any body from a Relay registered by address) and for the Relay's gRPC status 7 or 16 (PermissionDenied, Unauthenticated), where it answered 403. Through the API server proxy, a Kubernetes Status stays the cluster's refusal (#1077).
- A cluster read past its 20 s wait answers 503 (#1060).
- The AI tools `alerts_inbox` (with `alert_id`) and `investigations` (with `investigation_id`) give an alert's rule expression as `expr` in place of `generator_url` and `alertmanager_url`, for MCP callers too. The screens and the routes keep both links (#1087).
- The alert webhook stores a `generatorURL` or `externalURL` that is not an absolute http or https address as empty, and logs its scheme once per message. Rows stored before keep theirs, and the alert windows show such an address as text (#1060).
- The `admin.retention.purge` row adds `failed_windows` and is a failure when any window failed; a window that fails no longer stops the windows after it (#1072).
- `GET /api/v1/cluster/features` names `anomalyRank`, `callGraph` (#902) and `nodeNeighbors` (#1088).
- The metric answers of `/logsearch/logql` and `/traces/metrics` carry `seriesTotal`, the number of series the store answered before the 100 kept (#886). With `features.logSearch.queryMaxBytes` set, `/logsearch/logql` gives `estimatedBytes`, and a query past the limit is answered 400 (#902).
- `GET /api/v1/namespaces/{namespace}/resource-graph` takes `include=calls` with `range`, or `start` and `end`, and answers 400 for any other `include` (#902).
- New routes: `GET /api/v1/timeline/changes`, `GET /api/v1/namespaces/{namespace}/timeline/changes`, `GET /api/v1/namespaces/{namespace}/anomalies` (#902) and `GET /api/v1/nodes/{name}/neighbors` (#1088). They answer 404 while their switches are off, and the anomalies route answers on a default install.
- An alert investigation's answer holds `result` once it ran with `features.alertInvestigation.evidenceCheck` or `ledger` on (#882), and the result holds `verdict` with `features.alertInvestigation.verdict` on too (#1088). The `ai.investigation.run` row then adds `after.verdict`.
- The AI tool `get_pod_metrics` answers `[]` for a namespace with no pods, where it answered one row made from kubectl's sentence. The AI tool `issues`, narrowed to a namespace or a severity, adds `not_read` and `not_read_note` with the lists it could not read, and has no `hint` that nothing is failing then; with every list read its answer is the same (#1088).
- The AI tool `k8s_get_pod_logs` answers `{"status": "no_log"}` with the kubelet's words in `reason` and where else to look in `hint` for a log the node no longer has (a `previous: true` read whose container was removed, most often), where it gave the kubelet's one line, `unable to retrieve container logs for …`, as the log. Its other answers are the same (#1094).

**Audit log**

- Approve and Reject refused before anything runs (the approval missing or not the caller's, no longer pending, the approval token not signed, the model setting not usable) write an `ai.tool.approve` or `ai.tool.reject` failure row. The `ai.tool.interrupt` row carries the masked fields of the run's arguments, as `ai.tool.execute` does. An approved write whose run comes back after its approval was ended as interrupted stays failed, and its `ai.tool.execute` row carries `after.late_after_interrupt: true` (#1077).
- The end of an approved run and its `ai.tool.execute` row are written in one transaction (#1077).
- The `k8s.session.end` row (`heartbeat_lost`) of a node shell closed because its server could not save its heartbeat is kept until the database and the audit store take rows again, at most 256 held, and its `after` gains `ended_at` (#1060).
- With more than one auth-service replica, the retention purge runs on one replica at a time: a replica whose turn comes while another runs skips it, writes no row and logs `retention: another replica is purging; this turn is left to it`. A replica lost with its node during a run holds the lock until PostgreSQL ends its connection, and the turns until then are skipped (#1072).
- The retention purge (`retention.chatDays`) deletes each expired conversation's tool approvals, contexts and messages before the conversation, in one transaction per batch of up to 5,000, so it runs where the chat tables have no `ON DELETE CASCADE` (tables the ai-service ORM made before the migrations); there every 0.7.8 run failed at the first expired conversation (#1072).
- An audit row is stored whatever text it holds. A row with bytes that are not UTF-8, 0x00, half a surrogate pair in JSON or an index entry past 2,704 bytes, which PostgreSQL refuses, was missing from the database. Such text is stored with U+FFFD in its place, 0x00 dropped (U+FFFD in JSON), and the first 2,692 bytes of an indexed column (`service`, `action`, `actor_user_id`, `target_id`). A row PostgreSQL refuses for its text all the same is logged with its action (`audit: row refused for its text`) and does not mark the audit store as broken (#1093).
- `user.login.failed` gains the reason `single_sign_on_account` (#1077).
- `user.account.link` adds `before.auth_source` and `after.auth_source` (`oidc`), and its `password_removed` is false for an account that held no password (#1077).
- `server reset-admin --email` gives an SSO account, other than the chart's admin account, the Admin role, an unlock and ended sessions but no password; `user.account.recover` adds `after.password_set` (#1077).

**Metrics**

- New metrics: the cluster breakers, the live lists' waits, the node drains and the Redis refusals on k8s-service (#1060); `limiter="cache"` and the read places' waits (#1072); the database pools (#1060); Claude Code's runs and waits (#1060); model requests and alert investigations by outcome (#1060); the waits of big shared answers for a write place on k8s-service (#1072). [Metrics](metrics.md) lists them.
- ai-service's HTTP metrics leave out the kubelet's probes of `/api/v1/ai/health` ([1.5](#15-alert-rules), #1060).

**Screens**

- Cluster View's pod window shows its Exec tab, and a box's menu its Exec entry, only when the person may open a terminal in that pod, as the Pods drawer asks: the Write role no longer sees them (#1077).
- An image in AI-written text (chat answers, alert investigation reports, the optimization answer) is not loaded when the text is drawn. An image at another host's http or https address becomes a link to that address, opened in a new tab, with its alt text (or else the address) as the link's words; any other image, one on the console's own host or at a `data:` address included, shows its alt text only. Behind the gateway, whose Content-Security-Policy lets images load from the console's own host and `data:` only, an image on another host did not load before either (#917).
- Log search narrowed to a workload (the Log search section of its drawer, and the AI tool `logsearch`) matches the pod names its controller gives: a workload whose name starts with the same words is left out, and the pods of a CronJob's Job started from Kubeast, or of a workload with a long name, are found (#1077).
- A dot in a workload's name matches only a dot in its drawer's Prometheus charts (#1079).

**Other**

- With alert investigations on (`features.alertInvestigation.enabled`), the first message gives the model only the rule's expression of an alert's `generatorURL`, as `expr`: the address of the server that sent the alert (scheme, host, port, path, and any user or password in it) is left out, and a link with no expression, such as a Grafana-managed rule's page, adds nothing. The Alerts inbox, the report window and the stored row keep the link as it came (#1087).
- With a Gemini model (provider `google` or `gemini`), a function call's thought signature goes back with the call in the chat and in alert investigations, which Gemini 3 and later ask for from a turn's second tool step on; the calls the server makes before the first model call carry Google's placeholder signature (#1087).
- With provider `anthropic`, the calls after a tool loop that may call no tool (an alert investigation's last call, its second ask with `evidenceCheck` or `ledger` on, and the rest of a chat answer cut at its length) send the loop's tools with `tool_choice` `none`, where 0.7.8 sent such a call without tools. Claude Fable 5.2, Mythos 5.2 and Mythos 5.1 answer 400 to thinking sent back without the tools it was made with, and Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 can: there an investigation that used its last step failed, and a cut chat answer stopped at the cut (#1082).
- A chat answer may make 20 model calls (`ai.chat.maxSteps`, 1 to 100), where it made 10. The last may call no tool and is told to answer from what was read, in the language of the question. In 0.7.8 a tool the tenth call asked for ran, and the answer then was one fixed Korean sentence that used nothing of what was read. When that last call writes no text, the answer says why: the calls are used up, it reached its length, or the provider's filter stopped it. More calls can cost more tokens; the chat token budgets are checked when a turn starts. On a Claude subscription Claude Code stops at `ai.providers.claudeCode.maxTurns` (10) as before, and one more run without tools then answers, in a slot of its own, which it waits for as the first run does. When no slot comes in time or that run does not start, the answer keeps what was read and says to ask again (#1084).
- On a Claude subscription the call that closes a chat answer at its limit reads the tool results between markers that cluster text cannot end, each line of them behind `| `, and is told that an instruction or a request in them is not the user's and that a link it asks for stays out of the answer. The call that closes an alert investigation and its second ask use the same markers (#1087).
- On a Claude subscription (provider `claude-code`), Claude Code receives every prompt as written (#1086).
- A chat question is offered only `k8s_get_resources`, or `k8s_get_resource_yaml` for YAML (with events, logs and describe when it names them), when it asks for that output form: kubectl's `-o json`, `-o yaml` or `-o wide`, "as YAML", "show the YAML", "in JSON format", "wide output" and the Korean words for these. The words yaml, yml, wide or json anywhere in the question did that in 0.7.8 (#1078).
- The debug lines of `ai.debugDump` are masked with every credential rule, whatever `ai.redaction.enabled` and `ai.redaction.disable` say (#1079).
- Each k8s-service (k8s-service-stream with `streams.enabled`) refuses a terminal or followed log past `multicluster.maxStreamsPerServer` (443) open on it for all accounts together, the way it refuses one past an account's cap: the person is told the server is full, and the refusal leaves a failed audit row of its action (#1060). Set it to `0` for no such cap, or raise it together with that pod's memory limit (about 0.37 MiB each on a kind node).
- 0.7.9 adds no chart object, ClusterRole or Role.

**AI switches**

- `features.anomalyRank.enabled` is on by default (beta). AI Chat, the floating chat and the MCP server get the tool `anomaly_rank`, so the read tools are 53 where they were 52, and `GET /api/v1/namespaces/{namespace}/anomalies` answers, read as the caller, also on an install with the AI off. One answer makes at most 12 store queries in 20 s. A grant limited to namespaces gets no metric checks, and the log and trace checks follow the rules of the log and trace tools. `false` keeps the install as 0.7.8 had it (#902, #1088).
- `ai.ruleCards.investigations` and `features.alertInvestigation.rules`, `changesFirst`, `narrowFirst`, `ledger`, `evidenceCheck` and `verdict` are on by default (alpha) and change only alert investigations, which stay off (`features.alertInvestigation.enabled`). An investigation then reads the changes and the anomaly check before its first model call, its report ends with a block of causes, hypotheses and the outcome, each model call may answer at 4,096 tokens instead of 2,048, and one more model call may be asked (#1088).
- The other AI switches are off: `ai.timelineChanges`, `ai.timelineChangesMore`, `ai.causeQuestions`, `ai.refuseRepeatedReads`, `ai.toolResultDetails`, `ai.toolResultsJSON`, `ai.redaction.numbered`, `ai.ruleCards.chat`, `ai.ruleCards.symptoms`, `features.callGraph.enabled`, `features.nodeNeighbors.enabled` and `features.logSearch.queryMaxBytes` (0).
- With every AI switch 0.7.9 adds set to `false`, the model's prompts and tool definitions are as in 0.7.8, but for the changes that have no switch.

## 5. One-time effects of this upgrade

- **Every Kubeast server pod is replaced** (#1072). Its image changes, and with `podStartup.quickReady` its probes.
- **`tool_approvals` indexes** (#1077). 00033 builds them once, in the migration's transaction; writes to `tool_approvals` (a new approval card, Approve, Reject) wait until it ends (about 1.5 s per million rows). 〔How long on the rehearsal's data: after the rehearsal.〕
- **Self sign-ups single sign-on reached** (#1077). 00032 marks the accounts the sign-up form made from their `user.register` rows (`self_signed_up`), makes each marked password account holding no password, or named by an earlier `user.account.link` row, an `oidc` account once, keeping a password it holds and ending its sessions, and leaves a `user.account.link` row by `system` / `migration` (`sessions_ended`) for each. An account an admin made is not changed whatever its account level. A self sign-up whose `user.register` row the retention purge already removed is not marked and stays a password account, and so does one whose `user.account.link` row the purge removed and that an admin gave a password since.
- **Alerts stored with an address that is not http or https** (#1060). Rows stored before 0.7.9 keep it, and the windows show it as text; new alerts store it as empty.
- **Passwords of SSO accounts** (#1077). They stop signing in at the upgrade; sessions already open go on until `auth.sessionAbsoluteHours`.
- **The first retention purge** (#1072). Where the chat tables have no `ON DELETE CASCADE`, every 0.7.8 run failed at the first expired conversation and also skipped the windows after the chat window (reviews, alert investigations and the Alerts inbox), so the first purge on 0.7.9 deletes the expired conversations and all that piled up past those windows.
- **Pages not reloaded** (#1060). A 0.7.8 page still open closes a terminal refused at the server's cap without the line saying why, and shows the account's line for a followed log refused there, until it is reloaded.
- 〔Anything else the rehearsal shows once: after the rehearsal.〕

## 6. After you upgrade

```bash
helm list -n kubeast                 # CHART kubeast-0.7.9
kubectl -n kubeast get pods          # every pod Running and ready
helm get notes kubeast -n kubeast    # the install notes
```

**Schema** (#882, #1077):

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- \
  psql -U kubeast -d kubeast -c "SELECT max(version_id) FROM goose_db_version"    # 33
```

**k8s-service's keys** (#1072). The keys k8s-service takes from Secrets, by name:

```bash
kubectl -n kubeast get deploy k8s-service -o yaml | grep -B3 'secretKeyRef'
```

**Alert rules** (#1060):

```bash
kubectl -n kubeast get prometheusrule -o yaml | grep 'alert: KubeastAI'
```

**Retention purge** (#1072). With more than one auth-service replica, a replica whose turn was skipped logs it:

```bash
kubectl -n kubeast logs deploy/auth-service | grep 'another replica is purging'
```

**Password sign-ins refused** (#1077). Admin → Audit Logs, action `user.login.failed`, shows each refusal with `single_sign_on_account`. The accounts 00032 changed are the `user.account.link` rows by `system` / `migration`.

## 7. Rolling back to 0.7.8

```bash
helm history kubeast -n kubeast                        # the revision of 0.7.8
helm rollback kubeast <revision> -n kubeast
```

- **Database** (#882, #1077): `helm rollback` runs no Down migration, so `alert_investigations.result`, `auth_users.self_signed_up` and the two indexes on `tool_approvals` stay. The 0.7.8 services wait for schema 30 or later, which schema 33 meets. 〔Whether 0.7.8 starts on that database: after the rehearsal.〕
- **Probes** (#1072): `helm rollback` puts 0.7.8's probes back.
- **k8s-service's Secret keys** (#1072): `helm rollback` gives k8s-service and k8s-service-stream the whole main Secret as environment again.
- **Kubernetes version check** (#1072): `helm rollback` applies the manifests of the 0.7.8 release and renders nothing, so no check runs.
- **Alert rules** (#1060): `helm rollback` puts 0.7.8's PrometheusRule back, without the two AI alerts.
- **Retention purge** (#1072): each 0.7.8 auth-service pod purges on its own again, and where the chat tables have no `ON DELETE CASCADE` a run fails at the first expired conversation.
- **Gateway behind an AWS Application Load Balancer** (#1072): 0.7.8 renders the Ingress without the deregistration delay; the target group may stay at 20 s. Write `deregistration_delay.timeout_seconds=300` in `alb.ingress.kubernetes.io/target-group-attributes` under `ingress.annotations` to have the load balancer's default again.
- **API answers and audit rows**: the audit rows 0.7.9 wrote stay as written. 〔The rest after the rehearsal.〕
- **Password sign-in of SSO accounts** (#1077): 0.7.8 does not refuse it, so a password such an account holds signs it in again and an admin's reset gives one. 00032 is not undone: the accounts it changed stay `oidc`, which 0.7.8 reads only to label them. 0.7.8 ignores `self_signed_up`, so a self sign-up made on 0.7.8 after the upgrade is not marked and stays a password account once 0.7.9 is back, and a self sign-up single sign-on reaches on 0.7.8 stays a password account until its next single sign-on sign-in on 0.7.9. `helm rollback` runs no Down migration, so the `self_signed_up` column stays; 00032's Down, if you run it, drops the column and leaves the changed accounts `oidc`. 〔Confirm on the rehearsal.〕
- **The server's cap on terminals and followed logs** (#1060): 0.7.8 has no `multicluster.maxStreamsPerServer`, so after `helm rollback` a k8s-service holds as many as each account's caps let it (`multicluster.maxTerminalsPerAccount`, `multicluster.maxFollowedLogsPerAccount`), with no cap for all accounts together.
- **AI switches**: 0.7.8 reads none of them. auth-service writes the built-in roles' permissions at start-up, so Read loses `ai.tool.anomaly_rank`. A custom role keeps the line, which names no tool there. The results kept in `alert_investigations.result` stay, and 0.7.8 does not show them.
- **The chat's call limit** (#1084): 0.7.8 does not read `ai.chat.maxSteps`, and a chat answer makes at most 10 model calls again.

## 8. Docker Compose

Upgrade from the checkout. The script writes `.env` again: the passwords and keys, `OPENAI_MODEL` and `OPENAI_BASE_URL` in it stay, and a line you added goes. Add it again after the script and run `docker compose up -d`, or run the script with `--skip-env`, which changes only the port in `.env`. Give it the gateway port you use, since it writes `--port` (8000 when left out) into `.env`:

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.9.dump
git fetch --tags && git checkout v0.7.9
./install-docker.sh --port <your port>
```

If you set `KUBEAST_TAG`, set it to `v0.7.9` or unset it.

What differs from the chart:

- **Probes, the Kubernetes version check, the alert rules, the gateway's wait behind a load balancer and its pod name header**: `podStartup.quickReady`, the check of [1.3](#13-kubernetes-version), the PrometheusRule, `gateway.preStopSeconds` and `gateway.servedByHeader` change the chart only (Compose's gateway reads the chart's `nginx.conf` as it is, so it never sends `X-Kubeast-Gateway`).
- **The main Secret**: Compose's k8s-service still reads the whole `.env`, as every service does (#1072 changes the chart only).
- **Retention purge**: Compose runs one auth-service, so the lock is always its own, on one more connection while a purge runs (Compose checks no connection sum); the purge's other changes apply.
- **The server's cap on terminals and followed logs** (#1060): Compose sets no value, so each k8s-service takes the code's default, 443 for all accounts together, the default of the chart's `multicluster.maxStreamsPerServer`. To change it, set `MAX_STREAMS_PER_SERVER` in `.env` (`0` for no such cap).
- **A cluster's kubeconfig replaced in Admin → Clusters**: when the database does not take the change, the kubeconfig before it is put back in its file (#1079).
- **The chat's call limit** (#1084): Compose sets no value, so ai-service takes the code's default, 20, the default of the chart's `ai.chat.maxSteps`. To change it, set `AI_CHAT_MAX_STEPS` in `.env`.
- **The AI switches of 0.7.9**: Compose sets none of them, so each is off, whatever the chart's default is: a Compose install has no `anomaly_rank`, where a chart install has it. To turn one on, set its variable to `true` in `.env`, which ai-service, k8s-service and tool-server read: `AI_TIMELINE_CHANGES`, `AI_REFUSE_REPEATED_READS`, `AI_TOOL_RESULT_DETAILS`, `AI_RULE_CARDS_CHAT`, `AI_RULE_CARDS_INVESTIGATIONS`, `AI_TOOL_RESULTS_JSON`, `ANOMALY_RANK_ENABLED`, `CALL_GRAPH_ENABLED`, `ALERT_INVESTIGATION_RULES`, `ALERT_INVESTIGATION_CHANGES_FIRST`, `ALERT_INVESTIGATION_NARROW_FIRST`, `ALERT_INVESTIGATION_LEDGER`, `ALERT_INVESTIGATION_EVIDENCE_CHECK`, `ALERT_INVESTIGATION_VERDICT`, `AI_TIMELINE_CHANGES_MORE`, `AI_CAUSE_QUESTIONS`, `AI_RULE_CARDS_SYMPTOMS`, `NODE_NEIGHBORS_ENABLED`.
- **The same as the chart**: the migrations (schema 33), the cluster read wait, the breaker, the API answers and the audit rows.
- **Rollback**: `git checkout v0.7.8 && ./install-docker.sh --port <your port>`. 〔after the rehearsal〕
