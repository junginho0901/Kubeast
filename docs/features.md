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
  - A stopped answer is saved with the text so far and a "Stopped · usage not available" marker.
  - An answer whose connection closed before it ended is saved the same way, marked "Ended by an error".
  - Both are saved only while their question is still the newest message, so an answer the server already saved (stopped or cut just as it ended) is not saved twice.
  - session-service accepts only the markers `{"stopped": true}` and `{"failed": true}`, no token counts.
  - The conversation follows new text only while you are at the bottom. When you scroll up, it stays put and a "Jump to latest" button appears.
  - Tables in answers have horizontal and vertical lines, and answers have the Kubeast icon next to them.
- **Multi-round Tool Calling** — the AI views and changes K8s with allowlisted tools, for up to 10 rounds. Read, write and admin tools are **gated by the user's permissions (JWT)**.
  - The 52 read tools include:
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
  - Under the 🔐 line, **🧾 Cluster requests** lists the Kubernetes requests the call made, each with the `Audit-ID` Kubeast sent and whether the API server returned it, so the call can be found in the cluster's audit log ([Security and audit](security-audit.md#ai-tool-calls-in-the-clusters-audit-log)).
    - An answer from Kubeast's own cache is listed as such: no request reached the cluster.
    - The kubectl tools reach the cluster through a proxy inside tool-server that adds the identity and the `Audit-ID`; kubectl's own discovery reads are not listed.
  - Tools that use Kubeast features call the k8s-service API **with that person's token** rather than kubectl, so permissions, audit and masking are the same as in the UI. These tools are:
    - `issues`: an issue check of pods, workloads, nodes, PVCs and warning events at once
    - `prometheus_query`: PromQL instant and range queries, absolute time ranges too. Given `chart=true`, a title and a unit, the result becomes a **graph below the answer**.
      - The graph is the same in AI Chat and floating, holds up to 10 series, has "View larger", and is kept in saved answers.
    - `prometheus_metrics` and `prometheus_labels`: find metric names, types and descriptions, and label names and values, before querying
    - `prometheus_rules`: alerting and recording rules and the alerts firing now. The AI calls it first when investigating an alert.
    - `prometheus_targets`: scrape targets up or down, for when a metric is empty. If the store is shared by multiple clusters or has no targets API, it goes through the `up` metric.
    - `alerts_list`: this cluster's alerts in the alert store (firing, silenced, inhibited) and the silences covering them. With `silences=true`, the Silences tab: every active and pending silence, also one that matches no alert now
    - `alert_investigate`: starts the formal investigation of an alert in the Alerts inbox, as its "Investigate now" button does (see [AI alerts](ai-alerts.md))
    - `clusters_list`: the clusters the person can see and their connection status, as the cluster picker lists them (the last check with its time: k8s-service probes each cluster every 60 seconds by default, `multicluster.healthcheckIntervalSec`, and a person's Test in Admin → Clusters also writes it). With `admin.clusters.list`, also what Admin → Clusters lists. Never a kubeconfig or credential
    - `alerts_inbox`: the Alerts inbox with who acknowledged an alert, who it is assigned to and whether it is done, with `alert_id` its note, and with `with_report` the report its Report button opens, recorded as `ai.investigation.view`. Reading only; the marks change on the screen
    - `pod_rbac`: a pod's service account, the bindings that apply to it and what each role allows, as the pod's RBAC API and the window's RBAC tab answer. What the cluster refuses the caller is named, not left empty
    - `logfiles`: log files inside a container, as the Log files tab lists and reads them (fixed `tail`, the last N lines, no following; see [Log files inside containers](operations.md#log-files-inside-containers))
    - `storage_summary`: the Storage window's PVCs with their usage and PVs by status, and the claim-to-volume topology
    - `network_policy_effective`: the NetworkPolicies that select a pod or workload, per direction, as a drawer's Network Policies section shows them
    - `limit_range_violations`: the containers outside a LimitRange's bounds, as its window's Violating Pods lists them
    - `logsearch`: log store search, also for pods that are gone
    - `loki_query`: LogQL lines, or metric queries such as `count_over_time` and `rate` for a series of error counts over time, also as a graph
    - `loki_labels`: log label names and values
    - `loki_patterns`: log patterns, with the line count per error type
    - `traces_search`, `traces_get`, `traces_tags`, `traces_metrics` and `traces_compare`: TraceQL on the trace store. They cover slow or failed requests, the spans of one trace, finding attributes, graphs of request count, error rate and p95 trends, and fast and slow samples.
    - `helm_read`: release list, values, manifest, history, resources, images, revisions and the diff of two revisions, **read only**. Always the masked text, also for someone who may see it in full on the screen.
    - `policy_reports`: PolicyReport summary and results, a page at a time, by source and in the order the screen offers
    - `cost`: OpenCost allocation, whose totals add up the rows answered
    - `optimization`: usage against requests, and recommendations
    - `can_i`: whether that user can do something, to a kind or to one object
    - `network_policy_check`: whether NetworkPolicy allows a connection, with the policy and rule that decide (see [NetworkPolicy view and check](#networkpolicy-view-and-check))
    - `network_flows`: recent connections of a namespace, pod or workload from the cluster's Hubble Relay, folded per connection, with the drop reason and the policies that decided (see [Recent flows](#recent-flows-hubble))
    - `network_drops`: drops of a namespace, pod or workload counted by the Hubble agents, from the cluster's Prometheus, by reason and peer, up to a day back (see [Network drops](#network-drops-hubble-metrics))
    - `network_top_flows`: the peers a namespace, pod or workload exchanges the most data with, or has the most retransmissions or timeouts with, from the cluster's Network Flow Monitor on EKS (see [Top talkers](#top-talkers-network-flow-monitor))
    - `resource_graph`: namespace objects and their connections, with the healthy pods of an owner that has more than 10 as one node and a count, as the page draws them
    - `timeline`: the change history of the Timeline screen, events and rollout revisions of a namespace, one object or every namespace in a window, by event type. The counts are the screen's, with "the newest M of N" when the list is cut and why the rollouts could not be read.
    - `gpu`: the numbers of the GPU screens, GPUs per company and node with what is in use and free, pods' requests, device plugins, DeviceClasses, ResourceClaimTemplates and DCGM utilization. A source that could not be read is named and its numbers are null, not zero.
    - `hygiene`: the hygiene report (an Admin grant on the cluster)
  - A tool is left out of the tool list (`/api/v1/features`, 1-minute cache) when:
    - the cluster does not have the feature: Prometheus is not set up, there is no log, trace or alert store, network flows are off, or cost or policy reports are off
    - the person lacks the permission k8s-service checks: `resource.hygiene.scan` (or `admin.hygiene.read`), `resource.helm.read`, `resource.policyreport.read`, `resource.cost.read` or `resource.networkflow.read`
  - Results are cut at 100 series, 120 points, 200 log lines, 200 rows, 200 graph nodes/400 edges and 64 KB of text.
  - A range result (`prometheus_query` and `loki_query` metric queries) can be longer than what the model reads at once (the model's tool result length, 6,000 characters unless set). Then it is not cut.
  - Instead, it is reduced to the 10 series with the largest values, each with its min, max, average and last value and a 12-point overview. Results drawn as graphs get the same summary.
  - `gitops_status` reads Argo CD Application CRs with that person's permissions. It summarizes sync, health, the last operation, error conditions and OutOfSync resources per app.
  - That tool is unavailable on a cluster without Argo CD. With a central Argo CD, ask on the management cluster.
  - The Admin-only `audit_search` reads auth-service's audit log API (`admin.audit.read`). The read itself is audited.
  - Other Admin-only reads answer what the Admin screens show, from the same APIs, a page at a time, and each call is audited like any tool's (`ai.tool.call`, `ai.mcp.call`).
    - `access_review`: who has what, as on Access review (`admin.review.read`): the cards, accounts, per-cluster roles, API keys, temporary grants, roles and past sign-offs with their stored reports. An account whose global role carries `*` reaches every cluster without a row among the per-cluster roles.
    - `ai_usage`: AI use by user, model or cluster for a period, as on AI Usage (`admin.audit.read`).
    - `access_requests`: pending and decided requests, as on Access requests (`admin.users.update`). Approving and rejecting stay on the screen.
    - `audit_integrity`: how far the audit log's chain is sealed and its last anchor (`admin.audit.read`). It does not check the chain; the Verify button on Audit Logs does.
    - `hygiene_history`: a cluster's hygiene sign-offs, how often one is due (`interval_days`) and the report each stored (`resource.hygiene.scan` or `admin.hygiene.read`).
    - `investigations`: the alert investigation reports of every cluster or of one, as on Investigations (`admin.investigations.read`). `investigation_id` opens one with its text, tool calls, labels and annotations, recorded as `ai.investigation.view`.
    - `ai_models`: each AI model's name, provider, what it runs on now (`used_for`) and its limits, and which providers this install cannot run, from what AI Models reads (`admin.ai_models.*`). `enabled_only` lists the models switched on. `key_env_set` says only whether a key variable is named, in `api_key_env` or the older `api_key_secret_key`, which the model runs with alike: false is the card's "No key env" warning, null a provider that asks for no key. It never answers an API key, the name of the variable holding one, a header, a certificate or an address.
    - `session_recordings`: that a terminal session was recorded and its details, as on Session recordings (`admin.sessions.read`): who, kind, cluster, target, times, size (`kept_bytes`, the Size column), status. It never reads what the terminal showed, which opens only on that screen with its `admin.session.read` row.
    - `audit_search` and these reads of Kubeast's own records (not `hygiene_history` and the `nodes_*` tools, which read the cluster) answer whoever holds their all-cluster permission from any cluster, as their screens do, also on a cluster where that person's grant is limited to namespaces. Anyone else there is refused.
    - These answers name each field they give. A key's value and password hashes are not among them; `key_prefix` is what lists show of a key. Mail addresses follow `ai.redaction.pii`.
  - `nodes_stats_summary` and `nodes_log` read the kubelet's stats summary and log query through the API server proxy. They need `admin.nodes.read` and the cluster RBAC `nodes/proxy`. Log queries need kubelet `enableSystemLogQuery` on, and answer unavailable when it is off.
  - Large lists are reduced with these tools:
    - `k8s_jq_query` filters `kubectl get -o json` with jq down to the needed fields. It has no environment or file access and a 5-second cap. The program runs in a child process with a memory budget (about 40 MiB for a 1 MiB list), which in the released image the kernel holds too, one program at a time: one that builds more, such as a long range or a repeated string, is refused with that reason and tool-server goes on, and one that waits for its turn until its call's time runs out is told tool-server was busy and to ask again.
    - `k8s_tabular_query` returns a table of chosen columns only.
    - `k8s_count` returns counts, and counts per group.
    - **A Secret's values never go out through these.** `k8s_jq_query` and `k8s_count` read the list without them: key names stay, values read `<REDACTED:secret>`. What kubectl computes itself cannot be cleaned first, so a table or a `jsonpath`, `go-template` or `custom-columns` output of Secrets is refused with where to look instead, and so is a count grouped by `.data`. A list of several kinds keeps the other kinds' values. A failed tool's text is masked like its answer.
    - **Other credentials are found by their key and shape.** A `key: value` line, and among a line's words a `key=value` or a quoted value after `=` or `:` (`password=…` in a log line, a token in a URL's query). A key counts when its last word is the credential, standing apart or glued to the word before it (`DB_PASSWORD`, `PGPASSWORD`, `APIKEY`), in the plural (`api_keys`, `passwords`, each item of a list too) or as a password's short name after another word (`DB_PASS`, `PGPASS`; not `pass` alone, `first_pass` or `bypass`). `tokens` and `secrets` do not count: they name what a model used and a kind. So `password_policy=strict` and `token_count=5` stay, as do a count (`token=5`), a state (`token=expired`), a reference (`password=$DB_PASSWORD`), a Secret's name (`secret=kube-system/my-tls`, and a name under a key charts use for one, such as `existingSecret: my-tls` or `tlsSecret: my-tls`), a small number under a short name (`foo_pass: 3`), a file given to kubectl (`--from-file=token=./token.txt`) and the shell's working directory (`PWD=/app`, `OLDPWD=/root`, `PWD=/home/me/My Docs`; `DB_PWD=/x` counts as a password, and so does lower-case `pwd` with a value that reads as encoded text). Because sentences read the same way (`invalid password: too short`), an unquoted value after `:` in the middle of a line stays too. After `DB_PASSWORD=x` the rest of the line stays when it reads as a command (`psql -h db`, `HOME=/root`, `./run.sh`), and goes when it cannot be told from a value with spaces. A Secret is also read when it is written in YAML's flow style or as escaped JSON in a log line.
  - Pods come from the rows k8s-service keeps for the Pods list (`/pods/page`), not from kubectl, so a large cluster is read whole:
    - `k8s_get_resources` for more than 25 pods without a name answers the counts over all of them (by phase, status, card colour, namespace and node) and 25 pods in order of need, errors and warnings first, with `next_offset` to read on. 25 or fewer come from kubectl as before.
    - `k8s_find_resource` searches every pod: `key=value` as a label selector, anything else by its words in the name or in one label. The log tool places a pod named without a namespace by the same rule.
    - `k8s_count` counts pods from the rows, grouped by nothing, namespace, node or phase, with or without a label selector. A field selector or another field goes to kubectl.
  - The query tools take any field selector the API server supports (`status.phase!=Running`, `spec.nodeName=node-1`); `k8s_get_events` keeps to the events fields.
    - A pod name that is not found gets its similar names from the pods holding a word of that name, not from a list of every pod.
    - `k8s_jq_query` and `k8s_tabular_query` still list pods with kubectl, which holds every pod it lists: above 5,000 pods in their namespace and label selector they answer `too_large` with the count and the tools that answer at any size.
  - Other kinds are sized before kubectl lists them, since kubectl holds a whole list whatever the output (110,000 events took it 1–1.8 GB): the API server answers how many without the objects (`limit=1` and its remaining count; with a selector the matches are counted 500 at a time up to 5,001). A page longer than the tool output is asked again with half as many objects, since its bytes say nothing of how many there are; a list one of whose objects alone is longer is answered `too_large` without a count. Above 5,000, `k8s_get_resources`, `k8s_jq_query`, `k8s_tabular_query` and `k8s_count` by a field answer `too_large` with the count instead of listing; `k8s_count` without a field answers that count at any size.
  - `k8s_get_events` lists the newest events (200 by default, at most 1,000), newest first, read by k8s-service a page at a time; when more match it says how many.
  - A kubectl list longer than the tool output (`TOOL_OUTPUT_MAX_BYTES`, 1 MiB) is answered as cut: `too_large` from `k8s_jq_query` and `k8s_count`, and "the total is not known" from `k8s_tabular_query`, instead of a read error or a wrong count.
  - Before a write, `k8s_diff` shows what will change. It diffs the server dry-run result against the live object, and **nothing is applied**. A manifest holding what the AI reads in place of a value is named in `placeholders`, since the diff compares those letters and the write would be refused. Only users with write permission see it. For a Secret it names the keys that would change, without their values. Without `resource.secret.reveal` it does not compare the values, as the screens do not: each key the manifest gives that the Secret already holds shows as a change whether its value differs or not, `values_not_compared` says so, and a right guess reads the same as a wrong one. Keys added and taken out are still named.
  - A write holding what the assistant read in place of a value (`<REDACTED:…>` whatever its name holds, `k8s_diff`'s `<REDACTED:secret:new value>` too, the `<EMAIL_n>` of `REDACTION_PII`, or a Secret's `***`, in a `SecretList` too, encoded as well) is refused for everyone, before an approval card and again in tool-server, since it would store those letters. The refusal says what to do instead: patch the other fields only, and get a new value from the user.
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
  - Admin menus (except Investigations) and the My account screen pass nothing.
  - There is one conversation per browser tab, and it continues after a refresh. "+" to the left of the input starts a new conversation, and previous conversations stay in the AI Chat list. The conversation is cleared on logout.
- **Resource optimization suggestions** — a table of namespace observations (requests/limits and usage), streamed AI suggestions, and per-row **apply without restart** on the pods of that row's workload, of its API group (Pod `resize` subresource, Kubernetes 1.35+, `features.inPlaceResize`).
  - Values can also be entered directly in the container card of the Pod drawer and adjusted the same way.
- **Cost (OpenCost)** — finds OpenCost in the cluster the same way as Prometheus: a 9003 Service with `opencost` in its name, through the API server proxy (`features.cost`).
  - It shows cost tables by Namespace and by workload (Cost menu), and the **monthly cost** and **monthly savings** columns of the optimization table.
  - Permission `resource.cost.read`. A Namespace-scoped grant covers only those Namespaces.
- **Policy Reports** — reads the `wgpolicyk8s.io` PolicyReport and ClusterPolicyReport written by Kyverno, Trivy Operator and others (`features.policyReports`).
  - Security → Policy Reports shows pass/fail/warn/error/skip per policy and per Namespace, with result rows. Narrowed to one Namespace, it and the AI's `policy_reports` also count what the ClusterPolicyReports hold about that Namespace's objects, as their drawers do, or say why those were not read.
  - Every drawer of an object the reports can name has a "Policy violations" section (a cluster-scoped object's from the ClusterPolicyReports; a namespaced object's from its namespace's reports and the ClusterPolicyReports naming it, or saying why those were not read; a workload's with its pods; a workload's and a custom resource's leave out an object of another group with the same Kind and name).
  - Without the CRD, the screen says "is not installed on this cluster".
  - Permission `resource.policyreport.read`. A Namespace-scoped grant covers only those Namespaces.
- **AI agent connection (MCP server)** — off by default. Claude Code and Cursor connect with an API key instead of a kubeconfig. They use the same read tools **only with that person's permissions**, through masking and audit.
  - When the operator turns on `mcp.writeTools`, keys whose ceiling is Write also get write tools and access request tools. Pod exec and rollout undo stay with whoever holds their permissions, as in the Admin-only list below.
  - These run without approval cards, with that person's permissions (permanent or temporary) as they are, and with the same Argo CD guard and audit.
- **Model settings** — managed with the `ModelConfig` CRD and the DB, and added and tested in the Admin UI.
  - A setting can have the tier `economy` (`tier`, CRD `spec.tier`). When such a setting is enabled, the chat history summary and the floating assistant use that model, which is usually cheaper. Chat keeps the default model.
  - `model_info.tier` in the stream shows which one is used.
  - If there is no economy setting, or it cannot be used because it has no key, both use the default model.
  - Each setting can have its own **answer length** (`max_tokens`; empty: 4,096 for chat answers, 2,048 for each alert investigation step) and **tool result length** (`tool_result_chars`, 1,000–200,000 characters; empty: 6,000), set in the edit window for every provider or as `spec.maxTokens` and `spec.toolResultChars` of a `ModelConfig` resource (with its CA certificate as `spec.caCert`). They are kept in the setting's options, and the tool result length is never sent to the provider. A longer result is cut at that length and the model reads its start; `k8s_get_pod_logs`, `logfiles` and `nodes_log` keep the end instead, where the newest lines are, and they keep it past tool-server's own limit (`TOOL_OUTPUT_MAX_BYTES`) too. The Claude subscription leaves the answer length to Claude Code.
  - Each card says what the server runs on it now — Chat, Floating assistant, History summaries, Alert investigations — worked out by the rules ai-service picks models with. "Active" is the one that runs the chat.
  - OpenAI and Azure OpenAI get the answer length as `max_completion_tokens`: their reasoning models (o-series, GPT-5) refuse `max_tokens`. When a model answers 400 naming a parameter it does not take (reasoning models refuse `temperature`, `top_p` and others), the request is sent again once without it, and that model is sent it no more.

## 🌐 Multi-cluster & RBAC

- **Cluster registry** — register, validate and health-check the in-cluster cluster (self) and external clusters (kubeconfig)
- **Per-cluster RBAC** — roles granted per user × cluster, **deny-by-default**. Clusters without permission do not even appear in the list.
- **Load/failure isolation** — per-cluster client pool (LRU), circuit breaker, health checks, rate limit and Prometheus query cache
- **Cluster switcher** — switch at the top of the UI, independently per tab (based on the URL query)
- **Custom roles** — resource-level permissions (`resource.*.read/create/edit/delete`, `resource.objects.read` for the lists and details alone), menu visibility (`menu.*`), AI tools (`ai.tool.*`)

### Roles and permissions — what the built-in roles can do, and who they act as in the cluster

| Kubeast role | Granted where | App permissions | In-cluster identity (impersonation group) |
| --- | --- | --- | --- |
| **Pending** | Default right after sign-up/SSO | None — can log in, but the API returns 403 | — |
| **Member** | Account level | No global permissions, access **only through per-cluster grants** | `kubeast:authenticated` (no permissions) |
| **Read** | Per cluster | 10 menus · `resource.*.read` (what the routes under **Read APIs** below ask for: the lists and details, and cost `resource.cost.read` and the others with a permission of their own; what the cluster shows is the right column's) · Helm read (the permission key exists, but Release records are Secrets so the cluster refuses — see the right column) · read log files inside containers (`resource.pod.logfile`, when the feature is on) · the 52 read tools of AI chat (`ai.tool.<read tool>`) and MCP connection (`ai.mcp.use`) — no write tools | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view` excludes Secrets and `services/proxy`, so the cluster refuses Secrets and Helm releases (stored in Secrets) and the UI shows a permission notice. Prometheus and OpenCost read through the API server proxy (optimization usage, storage analysis, cost, drawer metrics) are opened **for GET** only for the Services listed in the chart value `auth.impersonation.viewerProxyServices` — a Role in that Namespace, name exactly `<service>:<port>`; other Services, POST and NS-scoped grants are still refused (values comments in [Configuration](configuration.md)). If not listed, refused (the proxy starts at `kubeast:operator`=`edit`) |
| **Write** | Per cluster | `menu.*` · create/edit/delete resources · CronJob suspend/trigger · view Secret values · read log files · Helm rollback/upgrade/test · all AI tools (`ai.tool.*`, including write tools, except the Admin-only list below) · MCP connection | `kubeast:operator` = `edit` + viewer |
| **Admin** | Account level (`*`) or per cluster | Everything — admin menus, all clusters (including ones registered later) | `kubeast:admin` = `cluster-admin` |
| Custom | Per cluster | Only the chosen permissions (within the permissions the creator has) | `kubeast:role:<name>` — every call is 403 until the cluster binds this group (`auth.impersonation.customRoles`). The no-permission banner in the UI and the role creation dialog show this group name |

- **Admin only**: Pod exec, Node shell, cordon/drain, workload rollback, Helm uninstall and the Cluster Hygiene report. Their permissions (`resource.pod.exec`, `resource.node.cordon/drain/shell`, `resource.workload.rollback`, `resource.helm.uninstall` and `resource.hygiene.scan`) are not in Write. Add them to a custom role if needed. An Admin grant holds them on its cluster only; exporting and signing off the report take the all-cluster `admin.hygiene.export` and `admin.hygiene.signoff`, and `admin.hygiene.read` reads every cluster's report.
  - The AI asks for the same permissions (below). Write is not offered exec and is told why; Admin and a custom role with those permissions run them as before.
  - On the cluster side, the Write group (`kubeast:operator`) can already exec in every namespace, because the default `edit` ClusterRole includes `pods/exec`. What makes Pod exec Admin-only is Kubeast's app permission.
  - Kubeast's impersonation credential (`kubeast-impersonator`) must therefore be guarded as carefully as the full permissions of those groups.
  - Log file viewing (`features.logFiles`, default off) is also available to Read and Write, because Kubeast fixes the commands to `ls` and `tail`.
  - For this, the chart binds `pods/exec` to the Read group (`kubeast:viewer`) only in the namespaces you list. See [Log files inside containers](operations.md#log-files-inside-containers).
- **Kubeast's own namespace, on the cluster it runs on, is for global admins** (`*` on every cluster), because it holds the sign-in key and the other clusters' credentials.
  - Anyone else, a Write or Admin grant on that cluster included, is refused with 403 on screens, the API, AI tools and MCP: its Secrets and Helm releases, any change there, and exec, attach and log files in its pods. Lists of Secrets across namespaces leave them out, and a resource drawer hides the buttons for what would be refused.
  - Its pods, logs, events and ConfigMaps stay readable. A namespace of that name on another cluster is an ordinary one.
  - The buttons follow. `writeGuardedNamespaces` in `/cluster/features` names what refuses this caller's writes, so a list's create button there, Cluster View's pod menu and Optimization's Apply are gone without a question per row. On the list of every namespace the create button stays, since the YAML names the namespace.
  - This is a limit of the app. Write on that cluster is still `edit` across it and Admin `cluster-admin` on the cluster's side, so someone using Kubernetes directly has to be stopped with RBAC ([details](cluster-requirements.md#who-reaches-kubeasts-own-namespace)).
- **The node shell's namespace (`nodeShell.namespace`), on any cluster, is for those holding `resource.node.shell`**: anyone else is refused any change there and exec, attach, log files and logs in its pods, since it allows privileged pods and a node shell's log is its screen ([details](cluster-requirements.md#9-node-shell)).
- **The AI asks what the screens ask.** `ai.tool.<tool>` opens a tool. Each call also needs, in that cluster, what the route behind the same screen asks, in the chat and over MCP, whatever the cluster's RBAC lets the role's group do. Binding a custom role's group gives the AI no more than the role's screens.
  - `k8s_delete_resource` needs `resource.<kind>.delete`.
  - `k8s_patch_resource`, `k8s_scale`, the annotate and label tools and `k8s_rollout` with restart, pause or resume need `resource.<kind>.edit`.
  - `k8s_create_resource` needs `resource.<kind>.create`.
  - `k8s_apply_manifest` and the preview `k8s_diff` need `resource.<kind>.edit`. `kubectl apply` also creates, so an object that is not there yet also needs `resource.<kind>.create`. Without it the object is looked up as the user first, and the apply is refused if it is not there or the cluster does not say.
  - `k8s_execute_command` needs `resource.pod.exec` and `k8s_rollout` with undo needs `resource.workload.rollback`.
  - `k8s_cordon_node`, `k8s_cronjob_suspend` and `k8s_cronjob_trigger` press the Cordon, Suspend and Run now buttons through their routes and need `resource.node.cordon`, `resource.cronjob.suspend` and `resource.cronjob.trigger`, so a role holding only a button does through the AI what it does on the screen. A Node's YAML apply asks `resource.node.edit`, on the screen and through the AI, and can change `spec.unschedulable` as it can any field of the Node, where the cluster's RBAC lets the role's group patch nodes (`edit` does not).
  - `<kind>` is the name the screens use (`permResource`): the lower-cased kind, `hpa`, `vpa`, `pdb`, `pv`, `pvc` and `crd`, and `customresource` for a kind without a name of its own.
  - Every kind a call names counts: a list with commas, each document of a manifest, the items of a List. `all`, `api-extensions`, `gateway-api` and a manifest that cannot be read need `resource.*.<verb>`. A short name or category a CRD gives itself counts as `customresource`.
  - The reads whose screen asks a permission: `k8s_get_pod_logs`, `logsearch`, the `loki_*` tools and `alerts_list` need `resource.pod.read`. `helm_read` needs `resource.helm.read`, `cost` `resource.cost.read`, `policy_reports` `resource.policyreport.read`, `network_policy_check` and `network_policy_effective` `resource.networkpolicy.read`, the `network_*` flow tools `resource.networkflow.read`, `logfiles` `resource.pod.logfile` and `alerts_inbox` `resource.pod.read`. `hygiene` and `hygiene_history` need `admin.hygiene.read`, `audit_search`, `ai_usage` and `audit_integrity` `admin.audit.read`, `access_review` `admin.review.read`, `access_requests` `admin.users.update`, `investigations` `admin.investigations.read`, `ai_models` `admin.ai_models.*`, `session_recordings` `admin.sessions.read` and the `nodes_*` tools `admin.nodes.read`. `alert_investigate` needs what its button asks: `resource.alert.investigate` and `resource.pod.read`.
  - The other read tools need `resource.objects.read`, as the lists and details behind them do (see Read APIs below), and then the cluster's RBAC decides. `resource.*.read` covers it. Secret values never go to the AI.
  - `k8s_get_available_api_resources`, `k8s_get_cluster_configuration`, `k8s_explain`, `can_i` and `clusters_list` have no object in their answer and need nothing more.
  - A tool the role can never call is not offered, in the chat, in `list_clusters` or in MCP `tools/list`, which lists what a call could do in some cluster: `ai.tool.<tool>` and every permission it asks, there together. A refused call runs nothing, gets no approval card, says which permission is missing and leaves a failure row (`ai.tool.call`, `ai.mcp.call`). A tool missing from the table (`services/tool-server/screen_permissions.go`, `app/services/ai/screen_permissions.py`) is refused to everyone.
- **Every write API** checks permissions in the handler and is refused without an audit row (fail-closed).
  - **Read APIs** are blocked by three checks: whether the user has a role on that cluster (cluster middleware, deny-by-default), whether that role holds the read permission (the read gate, `internal/handler/read_gate.go`, answered from the token with no call to the cluster or the database; a live list asks once when it opens), and the cluster's RBAC (viewer group).
    - Every list and detail asks `resource.objects.read`, and a new route does too until it says otherwise (`TestEveryReadRouteSaysWhatItAsks`).
    - Some reads ask a permission of their own instead, and `resource.objects.read` does not open them: Pod logs, log search and the Alerts reads (`resource.pod.read`), Helm (`resource.helm.read`), Cost (`resource.cost.read`), Policy Reports (`resource.policyreport.read`), the NetworkPolicy check (`resource.networkpolicy.read`) and the network flows, drops and traffic (`resource.networkflow.read`).
    - `resource.*.read` ("All resources: read") covers all of those. Read and Write hold it, and Admin holds `*`, so the built-in roles do not change.
    - What has no object in its answer asks nothing: the kinds a cluster serves, its version, the feature switches, can-i and the status of a store.
    - A custom role with neither key reads no list, whatever the cluster binds; the no-permission banner says which permission it lacks. A new role in the role form starts with `resource.objects.read` when its author may hand that out; a role made through the API holds what it names.
    - Upgrading to v0.7.6 gives every custom role with a permission and no such wildcard `resource.objects.read` (migration 22), so it reads what it read and gains no logs, Helm or Cost. A role of `admin.*` keys alone gets it only when it is granted on a cluster: its keys open pages, not clusters. Holders of a role that got it on a cluster sign in once, because a token issued before does not hold the key.
  - `menu.*` only hides UI menus, and the role window says so. The group's screens stay open by address and the AI still reads them, as far as the read permissions above and the cluster let them. There is one key per sidebar group:
    - Core is `menu.dashboard`. It holds Dashboard, Cluster View, Monitoring, Alerts, Cost, AI Chat, Resource Graph, Change History and Advanced Search. Alerts, Cost and AI Chat appear when those features are on.
    - Cluster and Custom Resources are `menu.cluster`.
    - Workloads, Storage, Network, Gateway, GPU, Security, Configuration and Helm each use the key of the same name.
    - Admin shows each admin page to whoever holds that page's permission (`frontend/src/utils/adminAccess.ts`: User Management `admin.users.read`, Audit Logs `admin.audit.read`, Role Management any of `admin.roles.create/update/delete` …), so a custom role with some admin permissions sees and opens those pages only. Admin permissions open pages, not clusters: only `*` reaches every cluster. On a cluster with no grant, a global admin key opens just what its page reads there: Cluster Hygiene for `admin.hygiene.*`, the store status in the cluster edit dialog for `admin.clusters.create` or `.update`, and `/cluster/features`. Session recordings are the exception that spans clusters ([details](security-audit.md#session-recording-exec--node-shell)).
  - The built-in roles have `menu.*`, so groups go missing only in custom roles.
- **Dashboard counts** (namespaces, pods, nodes …) are counted from the per-cluster informer cache, which uses the `kubeast:cache` identity.
  - Kubeast therefore first asks whether the user identity can list namespaces (SelfSubjectAccessReview, 60-second cache), and returns 403 if not.
  - This way, custom roles whose group is not yet bound, or users bound to a single namespace, do not see cluster-wide counts.
- **The Pods list** is paged by the server from the same cache, which keeps a small row per pod (about 0.4 KB), so a cluster of 100 000 pods sends the browser one page, not every pod.
  - Before the rows go out, Kubeast asks whether the user identity can list pods (SelfSubjectAccessReview, 60-second cache): in every namespace, or else in the namespace chosen or in each namespace of a namespace-scoped grant. A namespace the cluster refuses is left out; if all are refused, the answer is 403.
  - The search, the sort, the summary cards and the page are worked out on the server. The page asks again every 3 seconds, or every 10 seconds when it counts more than 10 000 pods (the namespace chosen, or every namespace the user may see), so a change k8s-service has seen is on screen within 3 or 10 seconds. It only gets rows back when one it may see has changed. These requests are answered from the cache, not by the cluster.
  - Until the cache has synced, or when `kubeast:cache` may not watch pods, the rows are listed as the user, 500 at a time, and the page asks again every 30 seconds.
- **Cluster View** draws every node as a cell of the node map with a dot per pod, in the colour its card has (error, warning, healthy — counted by the server from the same rows and the same user check), so a large cluster is seen whole without its pods coming to the browser.
  - Below the map, a node's box fetches its pods when it comes on screen and watches that node (`fieldSelector=spec.nodeName`), so a pod that starts, ends or comes back on another node shows at once in the boxes on screen; the map follows within 2 seconds.
  - The search is counted on the server (a pod's name, namespace, node or IP, as the Pods list searches): the map and the boxes show the nodes with a match, wherever they are.
- **The Resource Graph** groups the pods of an owner (ReplicaSet, StatefulSet, DaemonSet, Job) with more than 10 pods: its healthy pods with the same lines are one box ("Running 98" with a dot per pod), and a line of that box stands for every pod in it, with the count on the line. A pod that is not healthy, or whose lines differ, stays a box of its own; the header counts every pod (groups and apart).
  - A StatefulSet's PVCs made for each pod, and their PVs, are grouped with its pods. The grouping by node or instance is kept: a group never crosses it.
  - A group opens every pod of its owner — the ones apart too — counted by card colour, searchable, problems first, and a pod opens its drawer. A search finds a pod inside a group.
  - Expand this group (from its window) or Expand all draws the pods one by one, as before; above 2,000 pods Expand all asks first.
  - The pods are read 500 at a time and kept as short rows, so a namespace of many pods is not held whole.
- **The other pod lists** take only what they show from the same server page: the RuntimeClass, PriorityClass and ClusterRoleBinding drawers list the pods that use them ten at a time, the Dashboard's Pods window takes 50 at a time with the chart's phase and the search worked out on the server, and Monitoring Pods gets each pod's limits with its usage. Cluster Hygiene checks pods 500 at a time as they come and keeps only the findings; the network flows name the workloads of every pod (there was a limit of 5,000 a namespace).
- **A pod's drawer** has its Status tile as the Pods list and kubectl say it; Reason and Message are the pod's own (`Evicted` and why) and Last State is why each container ended before, with its exit code and time. Every drawer's pod table shows the same Status, not the phase.
- **A node's drawer** has its Allocated Resources as `kubectl describe node` prints them, from the pods listed as the user: a grant limited to namespaces counts only those and says so, and pods that could not be read give the reason, not zeros. "Since Ready Changed" is the time since the Ready condition last changed, which the API has; it has no uptime.
- **A pod that is initializing** shows kubectl's STATUS, READY and RESTARTS in the Pods list, the other pod lists and its drawer: `Init:Error`, `Init:CrashLoopBackOff`, `Init:1/2` and the init containers' restarts (not `PodInitializing` and 0), and a native sidecar (an init container with `restartPolicy: Always`) counts in READY as kubectl counts it.
- **List pages keep the namespace in the address** (`?namespace=`): a link or a reload opens the same namespace, and choosing All namespaces drops it.
- **The Resource Graph with several namespaces chosen** lists each of them, not the whole cluster: a namespace-scoped account sees them, and a kind refused in only some of them is named with those namespaces. Its **Issues** filter keeps what is drawn yellow or red, a Deployment still `Progressing` included, and the floating chat counts the same ones as problems.
- **Pickers keep their width**: the Resource Graph's namespace picker shows the first namespace and a count when several are chosen (all of them on hover), Cluster View's namespace picker and the log file picker have a fixed width, and a long namespace in a list page's picker is cut with an ellipsis, so the controls after them stay where they are.
- **YAML create and edit** check the Kind's `resource.<name>.create` for each document (edit checks the target's `resource.<name>.edit`).
  - The name is the Kind in lowercase, with two exceptions:
    - HorizontalPodAutoscaler, VerticalPodAutoscaler, PodDisruptionBudget, PersistentVolume, PersistentVolumeClaim and CustomResourceDefinition are `hpa`, `vpa`, `pdb`, `pv`, `pvc` and `crd`, in that order.
    - Kinds without a name of their own (CRs, etc.) are `customresource`.
  - The Write group's `edit` cannot create cluster-scoped objects (Namespace, ClusterRole, StorageClass, etc.), so the cluster refuses those.
  - On those screens (15 cluster-scoped kinds plus Role, RoleBinding, Endpoints, EndpointSlice, ResourceQuota and LimitRange), the create button therefore asks the cluster directly, in addition to checking the app permission.
  - That check is `GET /api/v1/cluster/can-i?verb=create&group=&resource=`, a SelfSubjectAccessReview of the user identity. It is the same as `kubectl auth can-i`.
  - A drawer's "Delete <Kind>" asks the same way for that object (`verb=delete&…&namespace=&name=`, a Namespace in its own name).
  - If the cluster says no, there is no button. While it is asked the button is not shown; if it cannot be asked, the app permission decides.
- **Namespace-scoped grants**: a per-cluster role can be limited to a list of namespaces (up to 50).
  - Enter the list in the field next to the role, in the user details or in the cluster access dialog. Empty means the whole cluster.
  - The grant API takes it as `namespaces` and puts it in `/auth/me` (`cluster_namespaces`) and in the token (`ns` claim).
  - Access requests can also have a list. People with scoped grants can only request within it, and the form prefills it and requires it.
  - For such grants:
    - Kubeast **refuses a namespace outside those namespaces with 403** before asking the cluster, however the request names it: in the path, in a query (`namespace`, `namespaces`), in the body or in YAML (`metadata.namespace` of every document; a create with one document outside creates none). Writes get an audit row.
    - A route with no namespace in its path has a rule in `internal/handler/namespace_scope_routes.go`; one without a rule is refused to such a grant, so a new route starts closed.
    - What reads across namespaces with none named reads the grant's namespaces: events, the timeline, Helm releases and their live updates, pod metrics, the Resource Graph, a custom resource kind's list, the Ingresses of an IngressClass, the GPU pods, the claims of a StorageClass.
    - What reaches other namespaces by what it does is refused: draining a node, the node shell and the hygiene report.
    - A summary screen shows what the grant's namespaces hold and names what the cluster refuses beyond them. The Dashboard and Cluster View count the namespaces' objects and name Node; Monitoring's Nodes tab names Node and metrics, its Pods tab lists the namespaces' pods; Custom resource instances names what the CRD list leaves out; the Timeline, GPU Pods and Resource Graph refuse nothing they can read there. GPU Dashboard and GPU Nodes (their numbers are the nodes') and Alerts (labels no namespace bounds) are closed to such a grant and say so.
    - Objects in no namespace (Nodes, PVs, ClusterRoles, CRDs) stay the cluster's RBAC to answer. `/cluster/can-i` answers no for a namespace outside, without asking.
    - The namespace list is the grant list as is.
    - An "all namespaces" query goes through the list one by one and merges the results.
    - Dashboard counts are counted only within the list (`scoped: true`). Nodes and PVs are 0.
    - The dashboard's issue check reads pods, workloads and Warning events in each namespace of the list. Nodes, which such a grant cannot list, show as an info row saying they were not read.
  - AI tools and MCP require `namespace`, refuse `all_namespaces` even next to one of the grant's namespaces, and refuse cluster-wide tools: node metrics, apply, create, API list and cluster settings.
    - Eight stay inside the grant by themselves, as their screens do, so they work without one: `issues`, `cost`, `k8s_find_resource`, `gitops_status`, `storage_summary`, `timeline`, `gpu` and `get_cluster_overview`, which answers the dashboard's counts with nodes and PVs as not counted (null). `k8s_explain` and `clusters_list` read no object data.
  - The cluster's Prometheus answers for the whole cluster, so its reads answer 403 to such grants. This covers `/prometheus/query`, `query_range`, `metrics`, `labels`, `rules`, `targets` and `/gpu/metrics`, whether the cluster reaches the store through the API server's proxy or as an external store with Kubeast's own credentials. Alerts and silences are refused the same way.
  - An external store reads with Kubeast's own credentials, so the cluster's RBAC never sees the caller: reading it takes `resource.pod.read` on that cluster, as the log store does. Through the API server's proxy the cluster decides.
    - `/cluster/features` reports `prometheus.namespaceLimited`, and the drawers' Prometheus sections then say the metrics need a grant on the whole cluster instead of asking.
    - The proxy path's short query cache is kept per identity (`CacheIdentity`), so no one is served an answer read for someone else.
  - The cluster-side identity is the `kubeast:role:<slug>` group, so **the cluster refuses until a RoleBinding is bound in each of those namespaces**.
  - Writing `{name: Read, namespaces: [a, b], clusterRoles: [view]}` in the chart's `auth.impersonation.customRoles` renders those RoleBindings. They are applied on each registered cluster.
  - In the UI:
    - the namespace selector shows only the granted namespaces
    - the no-permission notice adds "Your access to this cluster is limited to the namespaces a, b"
    - real-time updates subscribe per namespace; a kind of the whole cluster is one subscription when the cluster's RBAC lets the user list it, and a notice above a screen listing it says when it does not, as for the Namespaces list, which is narrowed to the grant
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
- **Managing accounts stays within what you hold**:
  - A password reset hands the account to the admin, so it is refused for an account holding anything the admin does not: its global permissions and its per-cluster grants, with their namespaces.
  - Deleting an account, changing its role, unlocking it and setting or revoking a grant gain the admin nothing, and taking access away must not wait for someone who holds it. They are refused only for an account with a global permission (`*`, `admin.*`) the admin lacks, whatever it holds per cluster. What the admin hands out stays under the ceiling of each grant.
  - Changing only the name or the team is not limited.
  - A refusal is 403 and leaves a failure in the audit log. A global admin (`*`) is not limited, and neither is a change to one's own account.
  - Revoking someone's API key stays open to `admin.users.update`, so a leaked key can be stopped at once. It takes nothing away that the owner cannot issue again.
  - A permission added to a role must be held on every cluster the role is granted on, within the namespaces granted there.
- **Role edits and sessions**: taking a permission away from a role ends the sessions and key tokens that could still use it, at once: those of everyone granted the role on a cluster and, for `*` or `admin.*` keys, of everyone holding it as a global role. Renaming a role to another group ends those of everyone granted it. Adding a permission or changing the description ends nothing; holders get an added permission at their next refresh. An editor who holds the role signs in again too. The role window says so before a save that does this.
- **Role names**: a role acts on a cluster as the group made from its name. A new name or a rename is refused if it is a built-in role's name in other capitals or with spaces, or makes the same group as another role (`a b` and `a-b`, or Korean names of the same length). A name that makes a group the chart binds (`auth.impersonation.customRoles`) takes all permissions (`*`): the role gets that binding, which permission keys do not describe ([Cluster requirements](cluster-requirements.md) §1). A name already stored keeps working as it is.
- **What the UI says when a list is empty**:
  - Without permission (403): "You do not have permission to view", in a banner at the top and in the table.
  - On a server error or no response: "Could not load (server error 503)" with Retry.
  - If the cluster does not have that CRD (Gateway API, VPA): "is not installed on this cluster". k8s-service checks via discovery and adds the `X-Kubeast-Not-Installed` header to the empty list. The answer is the same regardless of role, and there is no create button.
  - If the kind is a built-in Kubernetes API the cluster does not serve (DRA, the admission policies — an older version or the API turned off): "is not served by this cluster", not the CRD text.
  - Otherwise: "No items".
  - An address that does not exist shows the 404 screen.
- Regression checks:
  - `e2e/tests/rbac-matrix.spec.ts`: the role × action 403/200 table
  - `permission-ceiling.spec.ts`: you cannot grant others more than you have, reset an account that holds more, or manage one with wider global permissions
  - `reader-ui-notices.spec.ts`: UI notices for Read
  - `notices.spec.ts`: server error, not installed, 404, create button can-i and the permission request notice

## ☸️ Kubernetes resource management

| Domain | Resources |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint (API deprecated since 1.33 — the object screens remain, while Service details, the resource graph and the AI service check read EndpointSlice), EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy, Policies (policies of all implementations on one screen — automatic discovery of CRDs labeled `gateway.networking.k8s.io/policy` + built-in Envoy Gateway · Istio + `gatewayApi.policyKinds`). The six lists take their columns and cards from one server row (`internal/gatewayrow`), the same in live updates, which every kind gets at the version the cluster serves it; each drawer reads that row too, with the object's metadata and the events `kubectl describe` lists, and its condition badges print the condition's status as kubectl's columns do (True, False or Unknown) |
| **Storage** | PV, PVC, StorageClass, VolumeAttachment |
| **Configuration** | ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease |
| **Security (RBAC)** | Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount · Policy Reports (collection of `wgpolicyk8s.io` reports, when the CRD exists) |
| **Cluster** | Node, Namespace, Webhook Configuration (Mutating/Validating), Admission Policy (Validating/Mutating — `admissionregistration.k8s.io/v1`, read-only, "not served" if the API is missing; with `features.admissionPolicies.readOnly: true`, the shared YAML apply and AI write tools also refuse the 4 policy and binding kinds, so they change only through Git) |
| **Custom Resources** | Dynamic CRD discovery and instance editing. An instance's printer columns — in its list and in its drawer — are the API server's Table of the CRD's columns at the version read (one server function), and its drawer opens by link too (`detailApi=<group>/<version>/<plural>`). Advanced Search, the Timeline, a Helm release's resources, Policy Reports, the dashboard's Issues and Optimization windows, Cluster Hygiene, the Alerts inbox (a kube-state-metrics custom resource state alert), a drawer's owner and scale target links and an HTTPRoute's or GRPCRoute's parentRef and backendRef links (group and Kind, at the version the CRD prefers) open an object with its apiVersion, and the drawer picks by group and Kind as kubectl describe does: a Kind of another group than its own drawer's that a CRD serves (one Kind of two groups, Istio's Gateway) opens as that CRD's custom resource. The drawer also lists the fields beside spec and status (a PolicyReport's results, scope and summary), and a CRD's drawer its events |

- **YAML editing** (Monaco), **Pod Exec / logs** (xterm.js, WebSocket)
- **Real-time updates** — resource changes streamed through a WebSocket multiplexer

### NetworkPolicy view and check

The Pod and workload drawers have a "Network Policies" section.

- It lists the NetworkPolicies that select the pods, for incoming and for outgoing connections, and what their rules allow.
- "Check a connection" asks whether NetworkPolicy allows one connection with another pod, workload, Service or IP address.
- The answer is allowed, denied or unknown, with the policy and rule that decide, or why each rule did not match.
- A Service is checked at its pods' port. A named target port is looked up on each pod.
- Unknown means one of two things:
  - the network plugin decides: an `ipBlock` that covers a pod IP (Calico and kindnet apply it, Cilium does not), or a hostNetwork pod
  - a rule selects namespaces by labels that your permissions do not let Kubeast read
- When the source's egress policies leave out cluster DNS, the answer says that a Service name will not resolve, though its IP works.
- Only Kubernetes NetworkPolicy is evaluated. Cilium, Calico and network-policy-api policies in those namespaces are listed as not part of the answer.
- Everything is read as the signed-in user, and a namespace-limited user can check only connections within their namespaces.
- The AI tool `network_policy_check` gives the same answer.
- The evaluator (`services/pkg/netpol`) has no outside dependency. Its tests check it against np-guard/netpol-analyzer on generated policies (`services/netpol-oracle`), and the e2e test against real connections on kind's kindnet.
- What the target cluster needs is in [Cluster requirements §7](cluster-requirements.md#7-apis-shown-when-present).

### Recent flows (Hubble)

With `features.networkFlows` on for a cluster, the Pod and workload drawers also have a "Recent Flows" section.

- It shows the connections the cluster's Hubble Relay saw to and from the pod or workload: verdict, direction, the other end, port, count, last seen, and the drop reason or the policies that decided.
- It loads only after "Show flows", because reading flows is recorded in the audit log (`k8s.networkflows.query`). The window is the last 5 minutes, 15 minutes or hour, and it can show drops only.
- One row is one connection: the reply packets are folded into it, and a connection seen on both nodes shows once.
- "Why?" on a dropped connection opens the NetworkPolicy check above for that peer, port and direction, so the rule that denies it is named.
- The Relay is read as the signed-in user, through the cluster's API server service proxy (`proxy`, the default) or at a TLS address (`https://`). The cluster must let the user create `services/proxy` on the Relay Service; `templates/impersonation-viewer-hubble.yaml` gives that to the Read group.
- A namespace-limited user sees peers outside their namespaces by namespace and address only, and URL query strings are dropped. A Service of another namespace on an end with no namespace, a policy of another namespace and the node that saw the flow are left out too; a cluster-wide policy stays.
- Microsoft Retina's Hubble control plane serves the same Relay. Its flows name pods only, so Kubeast names their workloads from the pods it lists as the user. A connection to a Service shows the Service's cluster IP where it left the client.
- On Calico, the flows come from Whisker (read the same way, as the user), aggregated by Calico: the numbers are packets, and a pod shows the flows of the pods of its ReplicaSet or Job, which Calico names together.
- The AI tool `network_flows` reads the same connections and points to `network_policy_check` for a drop.
- What the target cluster needs is in [Cluster requirements §16](cluster-requirements.md#16-hubble-relay-network-flows).

### Network drops (Hubble metrics)

Where the cluster's Prometheus has the Hubble drop metric, the Pod and workload drawers have a "Network Drops" section.

- It shows the drops the Hubble agents counted for the pod or workload over the last 15 minutes, hour, 6 hours or day: incoming and outgoing totals, and each peer with the drop reason.
- One count is one dropped packet, so a refused connection that retries counts several times.
- "Why?" on a `POLICY_DENIED` row opens the NetworkPolicy check for that peer and direction, so the rule is named.
- It loads on its own, like the drawer graphs, and is not audited: it reads the cluster's Prometheus through the same path as the other metrics, as the signed-in user.
- Without a Prometheus or without the metric, the section is not shown. When the metric has no pod or workload labels, it says so.
- When the metric has no pod label, a pod shows its workload's drops and says so.
- Peers outside a namespace-limited user's namespaces show their namespace only.
- The AI tool `network_drops` reads the same counts.
- What the target cluster needs is in [Cluster requirements §17](cluster-requirements.md#17-hubble-metrics-network-drops).

### Top talkers (Network Flow Monitor)

With `features.networkFlowMonitor` on for an EKS cluster, the Pod and workload drawers have a "Top Talkers" section, like the EKS console's flow table.

- It lists the peers the pod or workload exchanged the most data with over the last 15 minutes, hour or 2 hours, from the cluster's Amazon CloudWatch Network Flow Monitor monitor: peer, port, value, zones and category.
  - Views: within the cluster (same zone and across zones), AWS services (Amazon S3, DynamoDB), outside AWS (the internet or on-premises).
  - Ranked by data transferred, retransmissions or retransmission timeouts.
  - A workload's rows also name which of its pods it was.
- It loads only after "Show top talkers": the read goes to AWS and is recorded in the audit log (`k8s.networkflows.query`, `provider: nfm`).
- Kubeast reads AWS with its own identity, so the user must be able to list the namespace's pods. Peers in namespaces whose pods the user cannot list show their namespace and address only.
- A connection measured at both ends (each node's agent reports what it measured) is shown once, as the end that opened it measured it; a row with no port is the receiving end of a connection whose other row is not in the answer, and a Service's cluster IP at that end is named as the Service.
- The AI tool `network_top_flows` reads the same rows.
- What the cluster and AWS need is in [Cluster requirements §19](cluster-requirements.md#19-network-flow-monitor-top-talkers-eks).

### Traffic lines in the Resource Graph (Hubble)

Where the cluster has Recent flows or the Hubble metrics, the Resource Graph header has a switch: **Structure** (the objects and how they relate, as before), **Traffic** (who talks to whom among the workloads of the chosen namespaces) and **Both**.

- It is off until switched on, and reads once then and on refresh only.
- Two sources:
  - **Recent flows**: one Hubble Relay read for all the chosen namespaces, recorded in the audit log like the drawer's (`k8s.networkflows.query`, with `graph: true` and the namespaces). It covers the last 15 minutes, up to `features.networkFlows.graphMaxFlows` flows (2,000).
  - **Metrics 1h / 24h**: the Hubble TCP metric (connections opened, `flag="SYN"`) and drop metric in the cluster's Prometheus. Not audited, like the drawer's drops. UDP traffic such as DNS is not counted.
  - Where the metrics name pods only and one side of a drop (Microsoft Retina without remote context labels only the pod on the node that saw it), the other side is a box "Peer the metric did not name", not outside the pods, and the status line says so; drops that name no pod at either end are counted on the status line, since no namespace holds them.
- A line goes from the workload that opened the connection to the one it reached: green allowed, red dropped, amber both. It is wider when busier, and its number is flows (recent flows) or connections and dropped packets (metrics).
- The lines are routed around the boxes, at right angles, with their numbers where they cover nothing. Hovering a box or a line lights its lines and fades the rest, so a line can be followed to its end, and a box keeps its lines lit while its drawer is open. In the Traffic view a receiving box lists the ports its lines go to, with their counts, and each line ends at its port's row, as in Hubble UI's service map; the six busiest ports get a row and the rest share a last `+n` row. In the Both view a line's number starts with its port (`80 · 1.0k`, `UDP 53 · 420`). While lines are shown the boxes stay where the layout put them.
- A peer the graph does not show (another namespace, outside the cluster's pods, a kind the filters hide) is a dashed box; clicking one with a drawer opens it.
- Clicking a line opens its details on the right: ports, drop reasons, the policies that denied it, and (recent flows) its latest connections. "Why?" on a dropped line opens the NetworkPolicy check for it, and each end's drawer has its recent flows.
- The Traffic view lays the workloads out by their lines, left to right. Both keeps the structure layout and draws the lines over it.
- A box at the top says what was read and what is left out: only the latest flows the Relay returned, a missing metric, peers outside a namespace-limited user's namespaces (namespace only).
- Who may see it: `resource.networkflow.read`, plus what the source needs (the Relay permission of §16, or Prometheus).
- What the target cluster needs is in [Cluster requirements §18](cluster-requirements.md#18-resource-graph-traffic-lines).

## ⎈ Helm release management

- View the release list, details, history, values, manifest and resources
- **Rollback, Upgrade, Uninstall and Test**, all with a dry-run preview and run after confirmation
- Without `resource.secret.reveal` the values are read masked. A value shown as `<REDACTED:…>` stays as it is while its line does, and the preview names which; written over, it changes, and with its line gone it goes. The preview names those too. It reads what you sent and does not compare it with the hidden value, so it does not tell you whether a guess was right. The same placeholder anywhere else is refused with where, as it stands for no value there. A list item goes with the item shown with the same text, so removing or moving items keeps each value with its item, and one item's other fields can be edited where it stands. Items that read alike must all stay, or which value is meant cannot be said and the upgrade is refused with where. One thing masking cannot hide: a chart that renders a hidden value's checksum, as an annotation that rolls a Deployment on a change. The checksum is in the manifest and on the Deployment for whoever reads them, and in the preview it differs for a right guess and a wrong one (see [Security and audit](security-audit.md#what-masked-helm-values-do-not-hide)).
- The preview's Apply opens when the values you send differ from the values shown, also when the manifest shows no difference: a value only a Secret holds (without `resource.secret.reveal`), only a hook uses or nothing in the chart uses. The preview says so. A comment or another spacing is no change

## 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU node, Pod and utilization dashboard counting NVIDIA, AMD and Intel GPUs (each node's and Pod's vendor), and NVIDIA GPU metrics
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice management

## 📊 Observability

- **Topology View** — visualization of cluster resource relationships (React Flow, dagre, elkjs)
- **Dependency Graph** — dependency graph between workloads
- **Monitoring** — Prometheus time-series charts, anomaly detection, correlation analysis, in-depth GPU metrics (the Prometheus and metrics the target cluster needs are in [docs/cluster-requirements.md §3](cluster-requirements.md#3-prometheus))
- **Node Shell** — web-based node terminal; its settings (on or off, the image) are this browser's own, on the Account page
- **Log files** — read and follow the in-container logs of apps that write logs to files, only from allowed paths (fixed `tail`, default off, [details](operations.md#log-files-inside-containers))
- **Log search** — find logs in Loki by text and time range, even for restarted or deleted pods. It follows cluster RBAC (`pods/log`) and is off by default ([details](operations.md#log-search-loki)).
- **Advanced Search** — expression-based global resource search. Each chosen resource is listed in pages and stops at the page's "Max items per resource" (at most 10,000); a list that stops says so, and a namespace narrows it. A resource name served by two API groups (core and events.k8s.io Events) is two entries, each its own list; a type that fails is read again on every refresh and reported each time, and a list that fails partway says how many it read. The Status column is kubectl's STATUS where the kind prints one (a pod's `Completed` or `CrashLoopBackOff`, read from the API server's table as `kubectl get` does), else the phase or the Ready condition; a grant limited to namespaces searching All Namespaces gets each of its namespaces' lists, skipping one the cluster refuses

## 🔐 Authentication · Audit

- JWT-based built-in authentication (JWKS) with an Organization, Team and User hierarchy
- **API keys** — credentials for scripts and CI (Settings → API keys). A key is exchanged for a short access token. It has a cluster scope, a role ceiling and an expiry, and cannot exceed the issuer's permissions. See [API keys](security-audit.md#api-keys-automation).
- **Audit log** — records every write operation and sensitive reads (viewing Secrets, Node Shell, viewing container log files, log search, Helm changes, etc.), with both success and failure
- **Cluster hygiene check** (Cluster → Cluster Hygiene) — reads Pod Security Standards, image tags, resources, Namespace policies, RBAC and TLS expiry into one sheet, with the viewer's permissions.
  - It has CSV/JSON and a monthly sign-off per cluster ([details](operations.md#cluster-hygiene-check)).
- **AI usage** (Admin → AI Usage) — aggregates the `ai.chat.complete` audit rows by user, model and cluster. A row is left for each chat turn and each Optimization AI explanation, with the token counts the provider sent, summed per turn. Alert investigations (`ai.investigation.run`) are counted in rows of their own, marked "Alert investigation" (by user, the investigator `kubeast:investigator`), and in the totals, which show chat and investigations apart. Each source lists the 500 groups with the most tokens; the totals count every group, and a cut list says so under the table.
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
