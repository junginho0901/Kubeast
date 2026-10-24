**English** | [한국어](ko/features.md)

# Features at a glance


## 🤖 AI assistant

- **Multiple LLM support** — OpenAI, Anthropic, Gemini, Ollama and others. They go through one OpenAI-compatible adapter, except Anthropic, which uses the Messages API.
- **Streaming chat** — real-time responses over SSE, with sessions and history kept.
  - The model gets the most recent `ai.chat.historyMessages` (default 10) user and assistant messages as they are.
  - The conversation before them is folded into **one summary** kept in the session context (`ai.chat.summary.enabled`, on by default). For each turn pushed out of the window, the same model adds a note to it.
  - The summary is masked and capped at `maxChars`. When the cap is exceeded, older notes are merged.
  - Long conversations do not lose early facts, and the prompt does not grow.
  - The summary is updated incrementally only when new messages are pushed out of the window, and is audited as `ai.chat.summarize`.
  - Below each answer, the turn's tokens are shown ("In · out · % cached"). The tooltip adds the number of model calls and the model.
  - The tokens are stored with the message in `messages.usage`, with the same values as that turn's `ai.chat.complete`, so they remain after a refresh.
  - That row (tokens and Copy) stays closed while the answer is coming in. It opens and fades in when the answer ends or is stopped. With the operating system's reduce-motion setting, it opens immediately.
  - A stopped answer is saved with the text so far and a "Stopped · usage not available" marker. session-service accepts only the marker `{"stopped": true}`.
  - The conversation follows new text only while you are at the bottom. When you scroll up, it stays put and a "Jump to latest" button appears.
  - Tables in answers have horizontal and vertical lines, and answers have the Kubeast icon next to them.
- **Multi-round Tool Calling** — the AI views and changes K8s with allowlisted tools, for up to 10 rounds. Read, write and admin tools are **gated by the user's permissions (JWT)**.
  - The 13 read tools include:
    - `k8s_find_resource`, which finds multiple kinds and namespaces at once by name fragment or label
    - `k8s_explain`, which asks for the API schema
    - Pod logs, with the previous log of a dead container (`previous`), a time range, all containers and a text filter
    - events narrowed by object, kind or `type=Warning`
  - A missing name, kind or capability (metrics-server, etc.) comes back as a result instead of a kubectl error: **`not_found` (with a list of similar names), `unknown_kind` or `unavailable`**.
  - The AI therefore looks once instead of asking back while switching namespaces, then says where it looked and asks.
  - Similar names are searched only within that person's namespace scope.
  - Each tool block starts with a **🔐 line: who the cluster saw the call as**.
    - The user and groups are the impersonation values sent to the cluster, as the service that sent them reports them (tool-server, or k8s-service in its `X-Kubeast-Access` header).
    - The line also shows the Kubeast role, the namespace scope and whether the tool reads or writes.
    - The same values are in the call's audit row (`after.access`), so the call can be matched with `impersonatedUser` in the cluster's audit log.
    - With impersonation off (`auth.impersonation.enabled=false`), the line says Kubeast's own credential ran the call.
    - An alert investigation report says which identity read the cluster.
  - Tools that use Kubeast features call the k8s-service API **with that person's token** rather than kubectl, so permissions, audit and masking are the same as in the UI. These tools are:
    - `issues`: an issue check of pods, workloads, nodes, PVCs and warning events at once
    - `prometheus_query`: PromQL instant and range queries, absolute time ranges too. Given `chart=true`, a title and a unit, the result becomes a **graph below the answer**.
      - The graph is the same in AI Chat and floating, holds up to 10 series, has "View larger", and is kept in saved answers.
    - `prometheus_metrics` and `prometheus_labels`: find metric names, types and descriptions, and label names and values, before querying
    - `prometheus_rules`: alerting and recording rules and the alerts firing now. The AI calls it first when investigating an alert.
    - `prometheus_targets`: scrape targets up or down, for when a metric is empty. If the store is shared by multiple clusters or has no targets API, it goes through the `up` metric.
    - `alerts_list`: this cluster's alerts in the alert store (firing, silenced, inhibited) and the silences covering them
    - `logsearch`: log store search, also for pods that are gone
    - `loki_query`: LogQL lines, or metric queries such as `count_over_time` and `rate` for a series of error counts over time, also as a graph
    - `loki_labels`: log label names and values
    - `loki_patterns`: log patterns, with the line count per error type
    - `traces_search`, `traces_get`, `traces_tags`, `traces_metrics` and `traces_compare`: TraceQL on the trace store. They cover slow or failed requests, the spans of one trace, finding attributes, graphs of request count, error rate and p95 trends, and fast and slow samples.
    - `helm_read`: release list, values, manifest, history, resources, images, revisions and the diff of two revisions, **read only**
    - `policy_reports`: PolicyReport summary and results
    - `cost`: OpenCost allocation
    - `optimization`: usage against requests, and recommendations
    - `can_i`: whether that user can do something
    - `resource_graph`: namespace objects and their connections
    - `hygiene`: the hygiene report (Admin)
  - A tool is left out of the tool list (`/api/v1/features`, 1-minute cache) when:
    - the cluster does not have the feature: Prometheus is not set up, there is no log, trace or alert store, or cost or policy reports are off
    - the person lacks the permission k8s-service checks: `admin.hygiene.read`, `resource.helm.read`, `resource.policyreport.read` or `resource.cost.read`
  - Results are cut at 100 series, 120 points, 200 log lines, 200 rows, 200 graph nodes/400 edges and 64 KB of text.
  - A range result (`prometheus_query` and `loki_query` metric queries) can be longer than what the model reads at once (6,000 characters). Then it is not cut.
  - Instead, it is reduced to the 10 series with the largest values, each with its min, max, average and last value and a 12-point overview. Results drawn as graphs get the same summary.
  - `gitops_status` reads Argo CD Application CRs with that person's permissions. It summarizes sync, health, the last operation, error conditions and OutOfSync resources per app.
  - That tool is unavailable on a cluster without Argo CD. With a central Argo CD, ask on the management cluster.
  - The Admin-only `audit_search` reads auth-service's audit log API (`admin.audit.read`). The read itself is audited.
  - `nodes_stats_summary` and `nodes_log` read the kubelet's stats summary and log query through the API server proxy. They need `admin.nodes.read` and the cluster RBAC `nodes/proxy`. Log queries need kubelet `enableSystemLogQuery` on, and answer unavailable when it is off.
  - Large lists are reduced with these tools:
    - `k8s_jq_query` filters `kubectl get -o json` with jq down to the needed fields. It has no environment or file access and a 5-second cap.
    - `k8s_tabular_query` returns a table of chosen columns only.
    - `k8s_count` returns counts, and counts per group.
  - Before a write, `k8s_diff` shows what will change. It diffs the server dry-run result against the live object, and **nothing is applied**. Only users with write permission see it.
- **Floating AI widget (AI Chat)** — a widget floating on every page understands the **current screen context (the resource you are looking at)** and answers, limited to read-only tools.
  - It shows waiting dots before the first character and a small copy icon next to a finished answer (no token row). Wide tables scroll inside a box with a fixed header row.
  - It floats above modals, so you can ask while looking at an open dialog. When the right-hand detail drawer opens, the widget moves to its left (screens 1348px and wider).
  - Esc pressed inside the widget closes only the widget.
  - List screens pass "0 items" even when empty (not while loading).
  - Dialogs that show information pass their contents:
    - dashboard lists, issues, optimization and storage
    - Cluster View pods
    - Helm revisions, tests and upgrade preview
    - the alert investigation report
  - Create and confirm dialogs pass only "which action + target".
  - Admin menus (except Cluster Hygiene and Investigations) and the My account screen pass nothing.
  - There is one conversation per browser tab, and it continues after a refresh. "+" to the left of the input starts a new conversation, and previous conversations stay in the AI Chat list. The conversation is cleared on logout.
- **Resource optimization suggestions** — a table of namespace observations (requests/limits and usage), streamed AI suggestions, and per-row **apply without restart** (Pod `resize` subresource, Kubernetes 1.35+, `features.inPlaceResize`).
  - Values can also be entered directly in the container card of the Pod drawer and adjusted the same way.
- **Cost (OpenCost)** — finds OpenCost in the cluster the same way as Prometheus: a 9003 Service with `opencost` in its name, through the API server proxy (`features.cost`).
  - It shows cost tables by Namespace and by workload (Cost menu), and the **monthly cost** and **monthly savings** columns of the optimization table.
  - Permission `resource.cost.read`. A Namespace-scoped grant covers only those Namespaces.
- **Policy Reports** — reads the `wgpolicyk8s.io` PolicyReport and ClusterPolicyReport written by Kyverno, Trivy Operator and others (`features.policyReports`).
  - Security → Policy Reports shows pass/fail/warn/error/skip per policy and per Namespace, with result rows.
  - Workload and Pod drawers have a "Policy violations" section.
  - Without the CRD, the screen says "is not installed on this cluster".
  - Permission `resource.policyreport.read`. A Namespace-scoped grant covers only those Namespaces.
- **AI agent connection (MCP server)** — off by default. Claude Code and Cursor connect with an API key instead of a kubeconfig. They use the same read tools **only with that person's permissions**, through masking and audit.
  - When the operator turns on `mcp.writeTools`, keys whose ceiling is Write also get write tools and access request tools.
  - These run without approval cards, with that person's permissions (permanent or temporary) as they are, and with the same Argo CD guard and audit.
- **Model settings** — managed with the `ModelConfig` CRD and the DB, and added and tested in the Admin UI.
  - A setting can have the tier `economy` (`tier`, CRD `spec.tier`). When such a setting is enabled, the chat history summary and the floating assistant use that model, which is usually cheaper. Chat keeps the default model.
  - `model_info.tier` in the stream shows which one is used.
  - If there is no economy setting, or it cannot be used because it has no key, both use the default model.

## 🌐 Multi-cluster & RBAC

- **Cluster registry** — register, validate and health-check the in-cluster cluster (self) and external clusters (kubeconfig)
- **Per-cluster RBAC** — roles granted per user × cluster, **deny-by-default**. Clusters without permission do not even appear in the list.
- **Load/failure isolation** — per-cluster client pool (LRU), circuit breaker, health checks, rate limit and Prometheus query cache
- **Cluster switcher** — switch at the top of the UI, independently per tab (based on the URL query)
- **Custom roles** — resource-level permissions (`resource.*.read/create/edit/delete`), menu visibility (`menu.*`), AI tools (`ai.tool.*`)

### Roles and permissions — what the built-in roles can do, and who they act as in the cluster

| Kubeast role | Granted where | App permissions | In-cluster identity (impersonation group) |
| --- | --- | --- | --- |
| **Pending** | Default right after sign-up/SSO | None — can log in, but the API returns 403 | — |
| **Member** | Account level | No global permissions, access **only through per-cluster grants** | `kubeast:authenticated` (no permissions) |
| **Read** | Per cluster | 10 menus · read all resources (`resource.*.read`, including cost `resource.cost.read`) · Helm read (the permission key exists, but Release records are Secrets so the cluster refuses — see the right column) · read log files inside containers (`resource.pod.logfile`, when the feature is on) · the 39 read tools of AI chat (`ai.tool.<read tool>`) and MCP connection (`ai.mcp.use`) — no write tools | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view` excludes Secrets and `services/proxy`, so the cluster refuses Secrets and Helm releases (stored in Secrets) and the UI shows a permission notice. Prometheus and OpenCost read through the API server proxy (optimization usage, storage analysis, cost, drawer metrics) are opened **for GET** only for the Services listed in the chart value `auth.impersonation.viewerProxyServices` — a Role in that Namespace, name exactly `<service>:<port>`; other Services, POST and NS-scoped grants are still refused (values comments in [Configuration](configuration.md)). If not listed, refused (the proxy starts at `kubeast:operator`=`edit`) |
| **Write** | Per cluster | `menu.*` · create/edit/delete resources · CronJob suspend/trigger · view Secret values · read log files · Helm rollback/upgrade/test · all AI tools (`ai.tool.*`, including write tools) · MCP connection | `kubeast:operator` = `edit` + viewer |
| **Admin** | Account level (`*`) or per cluster | Everything — admin menus, all clusters (including ones registered later) | `kubeast:admin` = `cluster-admin` |
| Custom | Per cluster | Only the chosen permissions (within the permissions the creator has) | `kubeast:role:<name>` — every call is 403 until the cluster binds this group (`auth.impersonation.customRoles`). The no-permission banner in the UI and the role creation dialog show this group name |

- **Admin only**: Pod exec, Node shell, cordon/drain, workload rollback and Helm uninstall. Their permissions (`resource.pod.exec`, `resource.node.cordon/drain/shell`, `resource.workload.rollback` and `resource.helm.uninstall`) are not in Write. Add them to a custom role if needed.
  - On the cluster side, the Write group (`kubeast:operator`) can already exec in every namespace, because the default `edit` ClusterRole includes `pods/exec`. What makes Pod exec Admin-only is Kubeast's app permission.
  - Kubeast's impersonation credential (`kubeast-impersonator`) must therefore be guarded as carefully as the full permissions of those groups.
  - Log file viewing (`features.logFiles`, default off) is also available to Read and Write, because Kubeast fixes the commands to `ls` and `tail`.
  - For this, the chart binds `pods/exec` to the Read group (`kubeast:viewer`) only in the namespaces you list. See [Log files inside containers](operations.md#log-files-inside-containers).
- **Every write API** checks permissions in the handler and is refused without an audit row (fail-closed).
  - **Read APIs** are blocked by two checks: whether the user has a role on that cluster (cluster middleware, deny-by-default), and the cluster's RBAC (viewer group).
  - `menu.*` only hides UI menus. There is one key per sidebar group:
    - Core is `menu.dashboard`. It holds Dashboard, Cluster View, Monitoring, Alerts, Cost, AI Chat, Resource Graph, Change History and Advanced Search. Alerts, Cost and AI Chat appear when those features are on.
    - Cluster and Custom Resources are `menu.cluster`.
    - Workloads, Storage, Network, Gateway, GPU, Security, Configuration and Helm each use the key of the same name.
    - Admin depends on whether the user is an admin.
  - The built-in roles have `menu.*`, so groups go missing only in custom roles.
- **Dashboard counts** (namespaces, pods, nodes …) are counted from the per-cluster informer cache, which uses the `kubeast:cache` identity.
  - Kubeast therefore first asks whether the user identity can list namespaces (SelfSubjectAccessReview, 60-second cache), and returns 403 if not.
  - This way, custom roles whose group is not yet bound, or users bound to a single namespace, do not see cluster-wide counts.
- **YAML create and edit** check the Kind's `resource.<name>.create` for each document (edit checks the target's `resource.<name>.edit`).
  - The name is the Kind in lowercase, with two exceptions:
    - HorizontalPodAutoscaler, VerticalPodAutoscaler, PodDisruptionBudget, PersistentVolume, PersistentVolumeClaim and CustomResourceDefinition are `hpa`, `vpa`, `pdb`, `pv`, `pvc` and `crd`, in that order.
    - Kinds without a name of their own (CRs, etc.) are `customresource`.
  - The Write group's `edit` cannot create cluster-scoped objects (Namespace, ClusterRole, StorageClass, etc.), so the cluster refuses those.
  - On those screens (15 cluster-scoped kinds plus Role and RoleBinding), the create button therefore asks the cluster directly, in addition to checking the app permission.
  - That check is `GET /api/v1/cluster/can-i?verb=create&group=&resource=`, a SelfSubjectAccessReview of the user identity. It is the same as `kubectl auth can-i`.
  - If the cluster says no, there is no button.
- **Namespace-scoped grants**: a per-cluster role can be limited to a list of namespaces (up to 50).
  - Enter the list in the field next to the role, in the user details or in the cluster access dialog. Empty means the whole cluster.
  - The grant API takes it as `namespaces` and puts it in `/auth/me` (`cluster_namespaces`) and in the token (`ns` claim).
  - Access requests can also have a list. People with scoped grants can only request within it, and the form prefills it and requires it.
  - For such grants:
    - Kubeast **filters paths outside those namespaces with 403** before asking the cluster. Writes get an audit row.
    - The namespace list is the grant list as is.
    - An "all namespaces" query goes through the list one by one and merges the results.
    - Dashboard counts are counted only within the list (`scoped: true`). Nodes and PVs are 0.
  - AI tools and MCP require `namespace` and refuse cluster-wide tools: overview, node metrics, apply, create, API list and cluster settings.
  - The cluster-side identity is the `kubeast:role:<slug>` group, so **the cluster refuses until a RoleBinding is bound in each of those namespaces**.
  - Writing `{name: Read, namespaces: [a, b], clusterRoles: [view]}` in the chart's `auth.impersonation.customRoles` renders those RoleBindings. They are applied on each registered cluster.
  - In the UI:
    - the namespace selector shows only the granted namespaces
    - the no-permission notice adds "Your access to this cluster is limited to the namespaces a, b"
    - real-time updates subscribe per namespace
  - The Access Review report and CSV have a `namespaces` column.
- **SSO group → role**: groups from the OIDC provider are converted into account-level roles and per-cluster grants. With `syncRoles`, they are re-applied at every login.
  - Account-level roles use `auth.oidc.roleMapping` (`<group>=<Admin|Member|custom>`).
  - Per-cluster grants use the group name `<clusterGroupPrefix><cluster>:<role>`.
  - For groups whose name you cannot choose, such as a Google group email or an Entra group ID, use `auth.oidc.clusterGroupMapping` (`<group>=<cluster>:<role>`).
  - **Google login has no groups in the ID token**. With `auth.oidc.googleGroups` on, Kubeast reads the person's Workspace groups through the Admin SDK Directory API at login, and adds only those that match a mapping. The company's full group list is not left in the audit row.
  - The service account gets the Workspace admin role **Groups Reader**. There is no domain-wide delegation. Instead, `domain` is added to the request.
  - The credential is a single `credentials.json` in a Secret. It is either a keyless Workload Identity Federation config file (`external_account`, `tokenAudience` for this cluster's token) or a service account key.
  - If the lookup fails, the current roles are kept and `groups_lookup: failed` is left in the login audit row.
  - Admins preview a person's mapping result with `GET /api/v1/auth/admin/oidc/groups?email=`. It returns the mapped group names and the count of the rest, and is audited as `admin.oidc.groups.read`.
  - Setup steps per provider (Keycloak, Google, Entra ID, Okta), the first admin and login failure codes are in [docs/oidc.md](oidc.md).
- `auth.impersonation.enabled=false` is for demos: k8s-service runs as `cluster-admin`, tool-server as `*`, and read APIs open with the cluster grant alone.
- **What the UI says when a list is empty**:
  - Without permission (403): "You do not have permission to view", in a banner at the top and in the table.
  - On a server error or no response: "Could not load (server error 503)" with Retry.
  - If the cluster does not have that CRD (Gateway API, VPA): "is not installed on this cluster". k8s-service checks via discovery and adds the `X-Kubeast-Not-Installed` header to the empty list. The answer is the same regardless of role, and there is no create button.
  - Otherwise: "No items".
  - An address that does not exist shows the 404 screen.
- Regression checks:
  - `e2e/tests/rbac-matrix.spec.ts`: the role × action 403/200 table
  - `permission-ceiling.spec.ts`: you cannot grant others more than you have
  - `reader-ui-notices.spec.ts`: UI notices for Read
  - `notices.spec.ts`: server error, not installed, 404, create button can-i and the permission request notice

## ☸️ Kubernetes resource management

| Domain | Resources |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint (API deprecated since 1.33 — the object screens remain, while Service details, the resource graph and the AI service check read EndpointSlice), EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy, Policies (policies of all implementations on one screen — automatic discovery of CRDs labeled `gateway.networking.k8s.io/policy` + built-in Envoy Gateway · Istio + `gatewayApi.policyKinds`) |
| **Storage** | PV, PVC, StorageClass, VolumeAttachment |
| **Configuration** | ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease |
| **Security (RBAC)** | Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount · Policy Reports (collection of `wgpolicyk8s.io` reports, when the CRD exists) |
| **Cluster** | Node, Namespace, Webhook Configuration (Mutating/Validating), Admission Policy (Validating/Mutating — `admissionregistration.k8s.io/v1`, read-only, "not installed" if the API is missing; with `features.admissionPolicies.readOnly: true`, the shared YAML apply and AI write tools also refuse the 4 policy and binding kinds, so they change only through Git) |
| **Custom Resources** | Dynamic CRD discovery and instance editing |

- **YAML editing** (Monaco), **Pod Exec / logs** (xterm.js, WebSocket)
- **Real-time updates** — resource changes streamed through a WebSocket multiplexer

## ⎈ Helm release management

- View the release list, details, history, values, manifest and resources
- **Rollback, Upgrade, Uninstall and Test**, all with a dry-run preview and run after confirmation

## 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU node, Pod and utilization dashboard, and NVIDIA GPU metrics
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice management

## 📊 Observability

- **Topology View** — visualization of cluster resource relationships (React Flow, dagre, elkjs)
- **Dependency Graph** — dependency graph between workloads
- **Monitoring** — Prometheus time-series charts, anomaly detection, correlation analysis, in-depth GPU metrics (the Prometheus and metrics the target cluster needs are in [docs/cluster-requirements.md §3](cluster-requirements.md#3-prometheus))
- **Node Shell** — web-based node terminal
- **Log files** — read and follow the in-container logs of apps that write logs to files, only from allowed paths (fixed `tail`, default off, [details](operations.md#log-files-inside-containers))
- **Log search** — find logs in Loki by text and time range, even for restarted or deleted pods. It follows cluster RBAC (`pods/log`) and is off by default ([details](operations.md#log-search-loki)).
- **Advanced Search** — expression-based global resource search

## 🔐 Authentication · Audit

- JWT-based built-in authentication (JWKS) with an Organization, Team and User hierarchy
- **API keys** — credentials for scripts and CI (Settings → API keys). A key is exchanged for a short access token. It has a cluster scope, a role ceiling and an expiry, and cannot exceed the issuer's permissions. See [API keys](security-audit.md#api-keys-automation).
- **Audit log** — records every write operation and sensitive reads (viewing Secrets, Node Shell, viewing container log files, log search, Helm changes, etc.), with both success and failure
- **Cluster hygiene check** (Admin → Cluster hygiene) — reads Pod Security Standards, image tags, resources, Namespace policies, RBAC and TLS expiry into one sheet, with the viewer's permissions.
  - It has CSV/JSON and a monthly sign-off per cluster ([details](operations.md#cluster-hygiene-check)).
- **AI usage** (Admin → AI Usage) — aggregates the `ai.chat.complete` audit rows by user, model and cluster. A row is left for each chat turn and each Optimization AI explanation, with the token counts the provider sent, summed per turn.
  - It sets no limits. It shows who used how much.
  - Calls for which the provider sent no usage are left out of the totals and shown as a count.
  - **Cached** next to input tokens is the input tokens the provider served from its cache, and their share. These are Anthropic `cache_read_input_tokens` and OpenAI `prompt_tokens_details.cached_tokens`.
  - The tooltip on the input token column is the average size of the prompts ai-service actually sent. This is the JSON character count of system, tool definitions, history and messages (`prompt_chars`).
  - Use it to see the effect of changes to the history window, summary or tool descriptions, independent of provider accounting.
  - **Chat token budgets** can be set on the same row totals. Both default to 0, which means off:
    - `ai.chat.budget.sessionTokens`: cumulative per session
    - `ai.chat.budget.userDailyTokens`: cumulative per user per UTC day
  - When a budget is exceeded, that turn is refused without calling the model, a notice appears in the chat, and the turn is audited as `ai.chat.budget_exceeded`. Usage is counted the same way as on this screen.
  - Once the user's daily budget is exceeded, the Optimization AI explanation also shows only the observation table and does not call the model.
  - When the model provider refuses, chat, floating and Optimization report it **by type** in the UI language, with the provider name and the masked original message (`app/services/ai/model_errors.py`). The types are:
    - credits or quota exhausted (OpenAI `insufficient_quota`, Claude API `billing_error` or spend limit, Gemini 402)
    - too frequent (429)
    - key or token rejected (401, 403)
    - provider overload or outage (5xx, 529, timeout)
    - subscription usage limit, with the time it resets
- **i18n** — Korean and English. Kubernetes resource kinds (`StatefulSet`, `ConfigMap`, `Namespace` …) and screen names (sidebar items, page titles) are in English in both languages.
  - Only verbs, descriptions and guidance text are translated (e.g. "StatefulSet 생성", "전체 Namespace").
