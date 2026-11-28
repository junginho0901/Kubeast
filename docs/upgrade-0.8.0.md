**English** | [한국어](ko/upgrade-0.8.0.md)

# Upgrading from 0.7.9 to 0.8.0

**Changes you must act on: none in your values.** A script, an alert rule or an MCP client that reads Kubeast's answers may have to change ([4](#4-what-changes-by-itself)). An install with an AI model setting of a provider Kubeast does not call, or with Entra ID users in more than 200 groups, has a step to take before upgrading ([1.4](#14-ai-model-settings-and-entra-id-groups)).

This page is for an install of 0.7.9 going to 0.8.0: what to check first, what changes by itself, which values to change, what the upgrade does once, and how to go back.
The upgrade command is the one in [Getting started](getting-started.md#upgrade), with `--version 0.8.0`.
Each item names the pull request that made the change.

The commands below use the release name `kubeast` in the namespace `kubeast`; put yours in their place.

## In short

- Run the dry run in [1.2](#12-rehearse-with-a-dry-run) first. Every check that can stop the upgrade stops it there, and nothing changes.
- From 0.7.8 or earlier, upgrade to 0.7.9 first ([1.1](#11-where-you-are)).
- A ModelConfig of `bedrock`, `geminivertexai` or `anthropicvertexai`, and a model setting with no `base_url` whose provider has no address of its own, stop working: change or delete them first ([1.4](#14-ai-model-settings-and-entra-id-groups), #1158, #1160).
- An Entra ID sign-in whose token leaves the person's groups out is refused: with people in more than 200 groups, change the Entra ID app first ([1.4](#14-ai-model-settings-and-entra-id-groups), #1163).
- Every screen is restyled. The console's addresses and the settings the browser keeps stay, and nothing is to be done for it; tools that drive the screens may have to change ([4](#4-what-changes-by-itself), #1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129).
- A LogQL query over all Namespaces, on the screen or from the AI, no longer reads streams without a Namespace label, such as node or control-plane logs ([4](#4-what-changes-by-itself), #1144).
- With more than one cluster registered, one cluster's paged reads and pod lists take at most half of their places, so one cluster slow to answer its lists keeps the others waiting no more ([4](#4-what-changes-by-itself), #1142, #1143).
- A 500 written when the client had already left, with the request under 5 s old, counts as `code="499"` in the Go services' request metrics ([4](#4-what-changes-by-itself), #1142).
- People asking for the same Pods page or node map at the same moment with the same access get one answer built for all of them; each person's access is checked on its own (#1109).
- An approved AI write running when the old pods stop is closed as 0.7.9 closes it, ten minutes after its approval; from the new pods on, a run their shutdown cuts is closed at once ([4](#4-what-changes-by-itself), #1131).
- `anomaly_rank` keeps of each pod only what its checks read, so one answer holds far less of k8s-service's memory; its answers are the same, and no value is new ([4](#4-what-changes-by-itself), #1154).
- The database goes from schema 33 to 34: migration 00034 adds one table, `model_uses`, and changes no other table (#1152).
- No value has to change. The new AI features (eight switches, seven for the AI's reads and answers and one for an alert's earlier investigations in its window, and the choice of the model that answers each use) change nothing until they are turned on; the AI's answers change only where a fix with no switch says so ([3](#3-values-you-must-change), [4](#4-what-changes-by-itself), #1149, #1150).
- What a grant limited to namespaces could not read is named, so scripts and MCP clients that read the Service check, a Service's details, the issue check or the timeline see new fields ([4](#4-what-changes-by-itself), #1147, #1148).
- Back up the database first ([1.3](#13-back-up-the-database)). A rollback to 0.7.9 keeps the 0.8.0 database, which 0.7.9 runs on; the backup is what takes you back to the data of before ([7](#7-rolling-back-to-079)).

## 1. Before you upgrade

### 1.1 Where you are

```bash
helm list -n kubeast                          # CHART kubeast-0.7.9
helm get values kubeast -n kubeast -o yaml    # the values you set yourself
```

From 0.7.8 or earlier, upgrade to 0.7.9 first with [Upgrading from 0.7.8 to 0.7.9](upgrade-0.7.9.md), and let it settle.

### 1.2 Rehearse with a dry run

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.8.0 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

It renders 0.8.0 with your values and changes nothing. A check that stops it makes Helm print an error saying what to change. 0.8.0 adds no such check.

### 1.3 Back up the database

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.8.0.dump
```

With an external database, use its own backup. [Database: TLS, backup and restore](database-backup-restore.md#backing-up-the-in-cluster-database) has both ways and the restore.

### 1.4 AI model settings and Entra ID groups

AI model settings that 0.8.0 no longer calls:

```bash
kubectl get modelconfigs -A -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,PROVIDER:.spec.provider
```

- A ModelConfig whose provider is `bedrock`, `geminivertexai` or `anthropicvertexai` stays after the upgrade, but the controller no longer syncs it and the API server refuses a new one. Kubeast had no code that calls them. For those models, use an OpenAI-compatible endpoint: the provider's own where it offers one, or a gateway such as LiteLLM in front of it, as provider `openai` with the address in `spec.baseURL`, or provider `custom` in Admin → AI Models. Change the stored ModelConfig's `spec.provider` or delete it; deleting it also removes its setting from Admin → AI Models.
- In Admin → AI Models, a setting with no `base_url` whose provider has no address of its own (`custom`, or a name such as `groq` saved through the API) is refused by the chat and **Test** after the upgrade, with nothing sent; 0.7.9 sent its chat to OpenAI's address. Give it its endpoint as `base_url` (provider `custom`), or delete it. It can also be turned off.

Microsoft Entra ID: for a person in more than 200 groups, Entra ID leaves the groups out of the ID token, and 0.8.0 refuses that sign-in with `oidc_groups_overage`. Where that can happen, have Entra ID send only the groups assigned to the application, or app roles with `auth.oidc.claims.groups: roles`, before upgrading ([SSO (OIDC) setup — Microsoft Entra ID](oidc.md#microsoft-entra-id)).

## 2. Upgrade

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.8.0 \
  -n kubeast --reset-then-reuse-values
```

- The pods that stop during the upgrade are 0.7.9's, so an approved AI write they cut is closed the 0.7.9 way, by the first ai-service that looks ten minutes after the approval (#1131).
- auth-service applies migration 00034 at boot, or the migration Job does with `migrations.mode: job`. It creates one small table with a foreign key on the model configs. auth-service, session-service, k8s-service and ai-service wait for schema 34. In the rehearsals below it took 7 to 16 ms on a nearly empty database.
- `helm upgrade` without `--wait` ends before the pods are ready. Look at them afterwards ([6](#6-after-you-upgrade)): a migration that fails leaves the new pods of the other services beside the old pods of the four services that wait for it, and shows only in those pods and in auth-service's log. With `migrations.mode: job` the Job fails and none of the services change.
- Each Kubeast Deployment gets its new image and rolls one pod at a time. Terminals and followed logs open on a pod that stops end as in 0.7.9.
- No 0.8.0 change touches the bundled PostgreSQL and Redis pods.
- `--reuse-values` stops with a hint, as in 0.7.9.
- In six rehearsals of this upgrade from 0.7.9 on kind (Kubernetes 1.37.0, Helm 4.2.4: the chart's defaults, `secrets.existingSecret` with and without another key, an external database, three replicas, and the AI off), `helm upgrade` took 31 to 32 s, and the 0.7.9 pods were gone 14 to 16 s after the first of them was deleted. Six routes asked once a second through it (the gateway, the sign-in keys, the console's page, a list of a cluster, the chat sessions and the signed-in account) got no answer but 200 and none hung, the slowest in 0.06 s; the bundled PostgreSQL pod stayed, and the accounts' passwords, API keys and roles worked after it as before. On Kubernetes 1.29.14 an install of 0.7.9 with `podShutdown.preStopSeconds: 0` upgraded and every Deployment became ready.

## 3. Values you must change

None.

These values are new and off by default, so an upgrade with values kept from 0.7.9 renders what it did, with these settings added as off: `ai.causeNaming`, `ai.faultOnset`, `ai.pastHints`, `ai.traceSpanTable`, `ai.yamlSpecFirst`, `features.callGraph.clientLatency` and `features.nodeNeighbors.busiestCPU` (#1149, #1150).

`features.alertInvestigation.pastReports.window` is new too, off by default, and adds a line to the ConfigMap only when it is set (#1151).

`multicluster.flowSchemas` is new too, off by default, and while it is off the chart renders no FlowSchema (#1171). To turn it on, whoever applies the chart needs `create` on `flowschemas.flowcontrol.apiserver.k8s.io`, the clusters need Kubernetes 1.29 or later, and each other registered cluster takes its two FlowSchemas from `scripts/render-target-rbac.sh`, applied as its roles are ([Target cluster requirements](cluster-requirements.md#1-permissions-rbac--every-target-cluster)).

The ConfigMap gains a line for each of the seven, so its checksum changes, and the Kubeast pods that read it roll once, as they do for the new images.

Turn a switch on with another `helm upgrade`, once this one has settled. Each is alpha: its key or behaviour can still change or be removed. "Stages of new values" in [Configuration](configuration.md#stages-of-new-values) says what has been run with each. Two of them change nothing alone: `features.callGraph.clientLatency` needs `features.callGraph.enabled`, and `features.nodeNeighbors.busiestCPU` needs `features.nodeNeighbors.enabled`.

## 4. What changes by itself

**Screens**

- Every screen is restyled in the three colour modes. Addresses, what each screen does, and the colour mode and the other settings the browser keeps are as in 0.7.9 (#1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129). AI Chat's conversation list, which folds on a window narrower than 1,280 px, keeps nothing in the browser (#1127).
- The detail drawer is a modal dialog (`role="dialog"`, `aria-modal="true"`, `data-testid="resource-drawer"`) that keeps Tab inside while it is on top. A tool or a test of your own that takes any `role="dialog"` for the open window may now find the drawer: take `[role="dialog"]:not([data-testid="resource-drawer"])` for a window (#1134, #1135, #1140).
- List rows and sortable column headers take the Tab order and open or sort on Enter or Space (#1134, #1136, #1137).
- A terminal keeps Tab, Shift+Tab and Escape for the shell; Ctrl+M (Ctrl+Shift+M on a Mac) lets Tab leave it (#1141).
- ⌘/ (Ctrl+/ elsewhere) pressed outside the open floating chat moves the focus into it, where it closed the chat (#1139).

**Log search**

- A LogQL query over all Namespaces (the screen's LogQL, `loki_query`, `loki_patterns`, the size estimate before `loki_query`, the log search API without a Namespace) gets the Namespace label matcher structured search has, `k8s_namespace_name=~".+"` with the default labels, so it reads only streams that carry a Namespace label. Node and control-plane logs kept in the same Loki without one are no longer in its answer: read them in Loki itself. A metric query summed by Namespace loses its group with no Namespace, and `effectiveQuery` shows the matcher (#1144).
- A query of one Namespace, structured search and the narrowing's reads send what they sent. Who may read across Namespaces is as before.
- A log store registered without a label value for its cluster is still read as holding that cluster alone: where clusters share a store, give each registration its cluster's label value.

**Places shared between clusters**

- With more than one cluster registered, one cluster's reads of more than one page take at most half of `multicluster.bigReadConcurrency`'s places, rounded up (one of the default two), so that cluster's big reads go one at a time. `multicluster.bigReadConcurrency: 3` lets two of them run, and k8s-service's memory goes up by a read (#1143).
- A list of a cluster's pods as the person takes a place of its own, one fewer of them than the places of the pod rows (as many with one CPU or two), at most half of them, rounded up, one cluster's. `POD_ROW_CONCURRENCY` sets these too (#1142).
- The only cluster of an installation takes every place, as in 0.7.9.

**The AI's pod log reads**

- `k8s_get_pod_logs`, for MCP callers too, fails with what kubectl says last, reads every container past one that has not started or has no earlier run and names it in a last line, and says of each container what was read (#1146).

**Audit log list**

- `GET /api/v1/auth/admin/audit-logs` and its export answer 400 naming the filter for a text filter holding 0x00 or a byte that is not UTF-8, where they answered 500 (#1143).

**Metrics**

- A 500 written when the client had already left, with the request under 5 s old, is counted as `code="499"` by the Go services, so `KubeastHighErrorRate` and a rule of your own on 5xx no longer count reads whose client had gone (a page closed or reloaded, a chat stopped). A failure that came while its person reloaded within those 5 s counts as a 499 too. A 500 written later, or while the client was there, counts as before (#1142).

**`anomaly_rank`**

- `anomaly_rank` and its route keep of each pod only what their pod checks read, where 0.7.9 held every pod's row until the answer was made. Measured with this change laid on 0.7.9, on 50 000 of KWOK's simulated pods with one k8s-service at 512 Mi, one answer took its memory to 132 MiB at most, where 0.7.9 took it to 480 MiB, and two at once to 139 MiB. The answers, for MCP callers too, are as before, and no value is new (#1154).
- Two answers at once on a large namespace still wait for the two places of `multicluster.bigReadConcurrency`, as in 0.7.9: a check that waits past its 5 s is listed as not run, "did not answer in time".

**Approved AI writes**

- A run the shutdown cuts is ended by the ai-service that ran it: failed as interrupted, with an `ai.tool.interrupt` row whose `after.end_reason` is `shutdown`. `interrupted`, the value it had, stays for a run whose ai-service was killed and that was closed ten minutes after the approval (#1131).
- A filter, an alert rule or a report on `end_reason: interrupted` alone misses the runs a shutdown cut.
- An approved exec's `k8s.pod.exec` row is in the same transaction as the end of its approval.

**Pods page and node map**

- People asking for the same page at the same moment get one answer built for all of them. Each person's access is checked on its own. Nothing changes in the answers (#1109).

**AI tools and screens, for a grant limited to namespaces**

- The issue check has a row of kind `Collector` for a list that some namespaces of the grant refused, with `namespaces` and the reason; pods and events count too. It left them out. The AI tool `issues` names the list in `not_read` (#1147, #1148).
- The timeline (screen API and AI tool) has `summary.not_read_in` beside the count of the others, and the tool's note says so, where it said that nothing changed or happened. The Timeline screen does not draw it.
- The AI tool `k8s_find_resource` names the namespaces that refused a kind and looks in the others. Pods are still read from the rows k8s-service keeps, which leave such a namespace out.
- A grant that covers the whole cluster, one namespace, or that is refused nothing gets the same answers as before.

**The Service check and the Service drawer**

- `k8s_check_service_connectivity` answers `status` `Forbidden` or `Unknown` with the reason, and null counts with `endpoints_error`, where it answered `NotFound` or 0 and `NotReady`. What was read, and a Service that is not there, answer the same bytes (#1147, #1148).
- `GET /api/v1/namespaces/{namespace}/services/{name}/describe` has `endpoints_error` and no `endpoints` or `endpoint_slices` when the EndpointSlices could not be listed.
- With `ai.toolResultDetails` on, endpoints that were not read have no `empty_reason`.

**AI chat**

- A write that ran in an answer (`ai.writeApproval` off), or one approved from its card, drops what the conversation keeps of the reads before it, so the same read after it reads the cluster, also in an answer that began after the approval (#1147, #1148).
- A log, a describe or a YAML read is not taken for a failure or a refusal because a line in it is a JSON object with an `error` or a `status`.

**Alert investigations**

- An investigation's `alerts_inbox` with `with_report` is refused, whatever the switches: the call is not run, its `ai.tool.call` row is a failure, and the model reads the alert without the stored report. AI Chat's `alerts_inbox` reads reports as before (#1153).
- A cause given only reads of alerts, rules or names (`alerts_inbox`, `alerts_list`, metric, label and tag names, `k8s_find_resource`, `k8s_explain`, the API resources, `can_i`, `clusters_list`) is not verified, with the verdict on or off: the model is asked once more, and what still fails is listed as not verified, where the report window said the server had verified it (#1153).

**Models**

- Migration 00034 and Admin → AI Models' "Which model answers" change nothing until someone chooses a model. With no choice, alert investigations and the Optimization explanation each read the new table once (#1152).
- The text of an investigation that fails for a missing key changes for an install that names `features.alertInvestigation.model`.

**AI model settings, sign-in and answers**

- The ModelConfig CRD's `spec.provider` takes `openai`, `anthropic`, `azureopenai`, `gemini`, `ollama` and `claude-code`; the controller no longer syncs a stored `bedrock`, `geminivertexai` or `anthropicvertexai` ([1.4](#14-ai-model-settings-and-entra-id-groups), #1158).
- `POST` and `PATCH /api/v1/ai/model-configs` answer 400 for a setting with no `base_url` whose provider has no address of its own. **Test**, the model dropdown and the chat read one table of addresses, and **Test** of a Gemini setting with a `base_url` calls that address (#1160).
- An Entra ID sign-in whose ID token names the groups claim in `_claim_names` is refused with `oidc_groups_overage` and a `user.login.failed` row with `after.claim` (#1163).
- `GET /api/v1/prometheus/query` gives `null` for a value Prometheus gave as NaN or an infinity, and `query_range` and a LogQL metric query leave such a point out, where the whole answer was a 200 with no body (#1156).
- An `anomaly_rank` answer whose window before has no data for most values carries `no_baseline` first, and with `features.anomalyRank` on the chat's instructions gain one sentence (#1157).

**Other**

- With the chart's defaults 0.8.0 adds no chart object, ClusterRole or Role: of the chart's templates the ConfigMap changes, by the lines in [3](#3-values-you-must-change), and the ModelConfig CRD's `spec.provider` list loses three values (#1158). The ConfigMap's change moves the `checksum/config` annotation of six Deployments, so their pods roll, as they do for their new images. With `multicluster.flowSchemas` on, the chart adds the FlowSchemas `kubeast-cache` and `kubeast`, objects of the whole cluster that change where its API server places Kubeast's requests among its other users' (#1171). No value is renamed or removed.

## 5. One-time effects of this upgrade

- The Kubeast pods are replaced, one at a time, for their new images.
- A 0.7.9 console page left open during the upgrade draws the 0.7.9 screens until it is loaded again. Opening a screen whose code the 0.8.0 frontend no longer serves loads the page again by itself, as 0.7.9 does after any upgrade (`frontend/src/main.tsx`).
- Migration 00034 creates `model_uses` (#1152).
- The bundled PostgreSQL keeps its pod: in the rehearsals it was down for no second.

## 6. After you upgrade

```bash
helm list -n kubeast                 # CHART kubeast-0.8.0
kubectl -n kubeast get pods          # every pod Running and ready
helm get notes kubeast -n kubeast    # the install notes
```

Open Admin → AI Models: "Which model answers" says which model runs each use now. An entry that says "Does not run now" names why. Where a pod does not become ready, `kubectl -n kubeast logs deploy/auth-service` says whether a migration failed.

## 7. Rolling back to 0.7.9

```bash
helm history kubeast -n kubeast                        # the revision of 0.7.9
helm rollback kubeast <revision> -n kubeast
```

- **Screens**: 0.7.9's frontend draws the 0.7.9 screens, and the settings the browser keeps are read as 0.7.9 wrote them: 0.8.0 writes the same keys with the same values (#1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129).
- **`anomaly_rank`**: 0.7.9 holds every pod's row of the namespace again until its answer is made.
- **Log search**: 0.7.9 reads across Namespaces with the cluster matcher only again.
- **Metrics**: 0.7.9 counts those reads as 500 again.
- **Approved AI writes**: 0.7.9 closes a run whose ai-service stopped ten minutes after its approval. A row with `end_reason: shutdown` stays as written.
- **Database**: `helm rollback` runs no Down migration, so `model_uses` stays. The 0.7.9 services wait for schema 33 or later, which schema 34 meets, and they do not read the table. In the rehearsals `helm rollback` took 13 to 34 s, 0.7.9 started on the schema 34 database with no migration error, its own end-to-end tests of the main screens passed there, and the upgrade back to 0.8.0 had nothing to migrate. A choice made in Admin → AI Models is not read, and each use runs on the model it ran on before; when 0.8.0 is installed again, the choices are there. Where a choice says where a use's data goes, turn the use off or choose another model before you go back. A backup taken before 0.8.0 is restored into an 0.8.0 database after `DROP TABLE IF EXISTS model_uses;`, or into an empty database. In the rehearsal a backup taken on 0.7.9, restored with `pg_restore --clean --if-exists --no-owner` into a new 0.7.9 install, held the same accounts, audit rows and clusters, and its admin signed in with the password from before.
- **AI switches**: 0.7.9 reads none of the new ones.
- **FlowSchemas**: 0.7.9's chart renders none, so `helm rollback` deletes the two it made on the install's cluster. Those applied by hand on the other registered clusters stay until you delete them, `kubectl --context <cluster> delete flowschema kubeast-cache kubeast`, and while they stay they place 0.7.9's requests too, which go under the same user and group names.
- **AI model settings**: 0.7.9's ModelConfig CRD takes `bedrock`, `geminivertexai` and `anthropicvertexai` again, and 0.7.9 sends a setting with no `base_url` whose provider has no address of its own to OpenAI's address again.
- **Entra ID**: 0.7.9 signs in a person whose ID token leaves the groups out again, a new account with `defaultRole` and a stored one with its earlier role and grants.
- **Alert investigations**: an investigation of 0.7.9 of an alert with no namespace may read a stored report again, and a cause given only reads of alerts, rules or names passes its check again.
- **API answers and audit rows**: the audit rows 0.8.0 wrote stay as written. In the rehearsals the rolled-back 0.7.9 answered its lists of roles, accounts, clusters and recordings and a pod's logs, its pods logged no database error, and the people's passwords, API keys and roles worked as before.

## 8. Docker Compose

Upgrade from the checkout. The script keeps the passwords and keys in `.env`; a line you added goes, so add it again after the script, or run the script with `--skip-env`. Give it the gateway port you use:

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.8.0.dump
git fetch --tags && git checkout v0.8.0
./install-docker.sh --port <your port>
```

If you set `KUBEAST_TAG`, set it to `v0.8.0` or unset it.

- **The new switches**: Compose sets none, so each is off. To turn one on, set its variable to `true` in `.env`: `AI_CAUSE_NAMING`, `AI_FAULT_ONSET`, `AI_PAST_HINTS`, `AI_TRACE_SPAN_TABLE`, `AI_YAML_SPEC_FIRST`, `CALL_GRAPH_CLIENT_LATENCY`, `NODE_NEIGHBORS_BUSIEST_CPU`. ai-service, k8s-service and tool-server read them.
- An alert's earlier investigations in its window: `ALERT_INVESTIGATION_PAST_WINDOW`.
- **The same as the chart**: the migration, the model choices and their audit rows.
- **Rollback**: `git checkout v0.7.9 && ./install-docker.sh --port <your port>`.
