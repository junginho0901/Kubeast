**English** | [한국어](ko/ai-alerts.md)

# AI and alerts

## Connecting AI agents (MCP server)

To let an AI agent such as Claude Code or Cursor see a cluster, people usually hand the agent a kubeconfig. With a kubeconfig, however:

- the audit does not show who did what
- the agent holds more permissions than the person
- Secret values go to the model as they are

Kubeast's MCP server (`/api/v1/ai/mcp`, [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)) takes the kubeconfig's place.

The agent connects with **one API key** and uses the same **read tools** as the chat, **only with that person's permissions** (per-cluster roles, impersonation).

- Results are masked before they go to the model. Secret values are always removed.
- With `ai.redaction.pii` on, an e-mail address reads `<EMAIL_1>` (the same number for the same address within one text) and a phone number, resident registration number or card number `<REDACTED:phone>`, `<REDACTED:rrn>`, `<REDACTED:card>`; with `ai.redaction.numbered` on as well (off by default), each of them reads as its kind and a number (`<EMAIL_1>`, `<PHONE_1>`), the same number for the same value within one call. Free text with no fixed shape, such as a person's name or a street address, is not masked: keep it out of logs and attributes where they are collected.
- Every call leaves an `ai.mcp.call` entry in the audit log, and a call is refused when the audit row cannot be written.
- There are no write tools by default. When the operator turns them on (`mcp.writeTools`), they are open only to keys whose ceiling is Write.

```bash
# After issuing a key in Settings → API keys (set clusters and role ceiling), register it with the agent
claude mcp add --transport http kubeast https://console.example.com/api/v1/ai/mcp \
  --header "Authorization: Bearer $KUBEAST_API_KEY"
```

- Turning it on: `mcp.enabled: true` (`MCP_ENABLED` in compose). Off by default; when off, the path does not exist.
- Permissions:
  - `ai.mcp.use` on that cluster. The system Read and Write roles include it, and Admin has everything.
  - `ai.tool.<name>` for each tool to be used. Read gets only the 52 read tools; Write gets all of them plus the write preview `k8s_diff`. `hygiene` and `hygiene_history` are visible on a cluster to whoever may read its report: an Admin grant there (`resource.hygiene.scan`) or `admin.hygiene.read`. The other Admin reads (`audit_search`, `nodes_*`, `access_review`, `ai_usage`, `access_requests`, `audit_integrity`, `investigations`, `ai_models`, `session_recordings`) are visible only to whoever holds the `admin.*` permission of their screen.
  - `list_clusters` tells the connected person which clusters and tools they can use. The other tools require the `cluster` argument and do not fall back to the default cluster.
- Authentication: an API key (`kbk_…`) or an access token in the `Authorization: Bearer` header.
  - The server exchanges the key for a short-lived token, and the exchange is audited too. Once the key is revoked, the next call is refused.
  - There is no session (stateless), so every request is checked, and multiple replicas work.
- Audit: calls outside the permissions are recorded too, as `failure`. The `after` of `ai.mcp.call` holds:
  - the tool, cluster and masking statistics
  - the credential (`credential.akid` = key id)
  - the client (User-Agent)
  - `write`: whether it is a write tool
- Write tools (`mcp.writeTools: true`, `MCP_WRITE_TOOLS` in compose, off by default): the chat's 14 write tools (apply, create, delete, patch, annotate, label, scale, rollout, exec, cordon, CronJob suspend and run now …) also appear for **keys whose role ceiling is Write**.
  - Pod exec and rollout undo also need the screens' permissions, `resource.pod.exec` and `resource.workload.rollback`. A Write ceiling does not hold them, so such a key is not offered exec and a call is refused with the permission's name; a key whose ceiling and owner hold them runs both. Every other call also needs what its screen asks, `resource.<kind>.<verb>` for the kinds it names ([Features](features.md)).
  - The chat's approval card (`ai.writeApproval`) does not exist in MCP. The agent can do only as much as that person can do on that cluster, with a permanent role or a temporary role obtained through an [access request](configuration.md) (`accessRequests`).
  - Every call is audited with `write: true` and what it was asked to do, credentials masked (a command, or the length and masked start of a patch or manifest).
  - The tool annotations (`destructiveHint`) are set honestly, so clients such as Claude Code ask the user to confirm before the call.
  - Objects managed by Argo CD follow the guard mode: `block` refuses ("change it in Git"), and `warn` runs and adds a warning to the first line of the result.
  - When permissions fall short, the agent files an access request itself with the `request_access` tool and tries again. Once an admin approves it, the request is applied within a minute.

## Alert → AI investigation (Alertmanager, Grafana)

When an alert fires, Kubeast **does a first investigation with read tools only** and leaves a report. It does not write; a person reads the report and does the fixing.

The feature is off by default (`features.alertInvestigation.enabled`). Turning it on also requires `auth.impersonation.enabled` and `ai.enabled`; otherwise the chart render fails.

- **Endpoint**: point an Alertmanager webhook receiver at `POST <Kubeast URL>/api/v1/alerts/webhook?cluster=<cluster ID>`, with Bearer `ALERT_WEBHOOK_TOKEN` (kubeast-secrets, generated by the chart) in `http_config.authorization`. The format is Alertmanager v4 as is.
  - For Grafana alerting, put the same URL and Authorization header (Bearer, the token) on a webhook contact point. The Grafana 13 webhook body has the same fields Kubeast reads, so it is accepted as is.
  - A wrong token gets 401, an unknown cluster 404, and 404 when the feature is off.
- **Filtering**: only alerts that are `firing` and whose `severity` label is in `severities` (default critical, warning) pass. For the same cluster and fingerprint within `dedupeHours` (24), only `repeat_count` goes up (Alertmanager resends every 4 hours).
  - Past `maxPerHour` (6) per hour or the daily `dailyTokenBudget` (200,000 tokens, UTC), alerts are recorded as `skipped`. Both count the webhook's investigations only; the ones people ask for in the inbox ("Investigate now", below) have their own `manualDailyTokenBudget`. One investigation took about 60,000 tokens when measured (657 runs on a dev install), so 200,000 is about three a day (fewer with `evidenceCheck` or `ledger` on, below: their instruction goes with every model call and the report may be asked for once more); 0 means no cap or budget.
  - With several ai-service replicas the hourly cap still holds: alerts arriving at once on different replicas take their count and their row one at a time (a PostgreSQL transaction lock), so the hour never gets one more than `maxPerHour`.
  - `automatic: false` stops the webhook's investigations and keeps every alert in the inbox (counted as `automatic_off`), where a person may still ask for one; `enabled: false` turns the inbox off too.
  - One webhook message starts at most 100 new investigations. The alerts past that are still kept in the inbox and recorded as `skipped` ("investigation cap"); alerts folded into a recent investigation, resolved or filtered take no place. When Alertmanager sends the group again, the investigated ones fold and the next alerts get their turn.
  - An alert skipped again within `dedupeHours` folds into its skipped row (repeats, last seen, the latest reason) instead of a new row.
  - Copies of one alert that arrive at the same moment, on one replica or several (an Alertmanager HA pair, two ai-service pods), are decided one after the other under the lock of the alert's inbox row, so they queue one investigation and the others fold into it.
  - When the model provider **refuses because of a credit or key problem**, investigations pause. For a subscription, this is the usage limit, and the pause lasts until the time it lifts.
    - That alert becomes `failed` ("provider refused (credit)…").
    - Alerts arriving in the following `providerPauseMinutes` (30 minutes, 0 = off), and alerts already queued, become `skipped` ("paused: …until …").
    - This way, a blocked provider is not called again for every alert.
  - Rate limiting (429) and outages are temporary, so they do not pause it.
  - The response comes right away: `{accepted, duplicate, filtered, skipped, capped, resolved, automatic_off, stored}` — `capped` counts the alerts past the 100 new investigations of the message, and every alert lands in exactly one of the seven.
- **Investigation**: one worker processes queued alerts one at a time (only once, even with multiple replicas).
  - Before it starts one, it checks again: an investigation whose kind was switched off since, that a provider pause began after, or whose kind's daily budget the runs before it spent is recorded as `skipped` instead. Runs count against a budget once they finish, so the budget holds to within the one run that crosses it (per replica).
  - A run that fails after model calls keeps the tokens they used, in its row and its audit row (with an API key; Claude Code reports usage only when its turn ends).
  - With `ai.redaction.pii` and `ai.redaction.numbered` on, the alert and every tool result of one investigation number personal values from one table, kept in memory for that run only: the same address has one number in the alert's labels and in each log line, so the model can tie them without reading it. A new value takes a number past every one the alert or a tool result already holds (an earlier report it reads, say), so a number never stands for two people; the same value in another investigation gets another number. The report and the audit rows keep the placeholders.
  - auth-service issues an **investigation-only token** for that cluster, valid for 10 minutes.
    - It holds permissions for the 52 read tools plus `resource.objects.read`, which the lists and details ask for, and `resource.pod.read`, which log store search asks for. It lacks the permissions of the Helm, policy report, cost, log file, NetworkPolicy, network flow, network drop and top talker tools, so the investigation does not see them.
    - When the alert has a `namespace` label, the token is limited to the alert's Namespace.
    - Of auth-service's routes it opens one: the cluster list the tool `clusters_list` reads, which answers that cluster's row. The others answer 403, and it stops working there when `features.alertInvestigation.enabled` is off.
  - Requests reach the cluster as user and group `kubeast:investigator`: a read-only ClusterRole with no Secrets, exec or writes (`templates/impersonation-investigator.yaml`).
  - To let the investigation read CRDs too (Kyverno PolicyReport, Argo Rollout, KEDA ScaledObject, etc.), add read rules to `extraRules`, with verbs get, list and watch only. The render refuses `apiGroups "*"`, Secrets, exec, proxy, tokens and wildcard resources.
  - Apply the added rules again to every cluster that sends alerts (`scripts/render-target-rbac.sh`).
  - The model is `model` (a ModelConfig name) or the default model. It makes up to `maxSteps` (8) calls, and one more when `evidenceCheck` or `ledger` asks for the report again (below), within `timeoutSeconds` (300) overall. The last call gets no tools, so an answer comes back.
  - With `ai.ruleCards.investigations` on (off by default), the first message also holds at most two rule cards picked by the alert's name and labels (a listed alert name first, then a reason such as `OOMKilled` in a label value): for that kind of failure, the checks that often find its cause, in order, each with the tools that answer it, only those the investigation is offered. The alert only picks among the cards, none of its text goes into them, and no model step or tool call is spent. The cards and how to add your own are in `ai.ruleCards` ([Features](features.md)).
  - The alert's labels and annotations are kept apart in the prompt as "untrusted data".
  - `rules`, `changesFirst` and `narrowFirst` (all off by default) change how a run starts. Any one writes time windows counted from the alert's start into the first message: metrics `window.metricsMinutes` (15, 1–360) either side, logs from `window.logsMinutes` (5, 0–1440) before, changes from `window.changesHours` (4, 1–168) before, each ending now at the latest. The logs window also ends an hour after the start at the latest and is never longer than a day, the log search's longest range (`LOG_SEARCH_MAX_RANGE`), so an alert that started days ago has its logs read near its start.
    - `rules` adds to the prompt: read in those windows, look at what changed first, follow a failure back to the change that caused it, name a change a cause only when its time and object match the symptom, quote error messages as they are, and keep facts apart from hypotheses. The report then has six sections: Summary, Scope (affected · checked and normal · changed for another reason · not looked at), What I checked, Likely cause (cause → … → symptom), Ruled out and Next steps.
    - `changesFirst` calls the `timeline` tool with `view: changes` for the change window and the alert's namespace before the first model call (step 0: a tool call like any other, with its `ai.tool.call` row at iteration 0, masking and the model's result limit, and no model call spent), and puts its answer in the first message. When the tool is not offered, fails or answers without the changes view, the run goes on without it and a line under the report says why.
    - `narrowFirst` then calls `anomaly_rank` (needs `features.anomalyRank`) for the alert's namespace over the metrics window, on whole minutes and at least 5 minutes, as step 0 too (one call, its `ai.tool.call` row at iteration 0, the narrowing's own query and time bounds), and puts its findings in the first message after the changes. When the tool is not offered, the alert names no namespace, or it fails or answers without findings, the run goes on without it and a line under the report says why. With `features.callGraph` on, the findings come in the call graph's order (`call_order`) and the prompt asks for the calls once: with `rules` on the report's Likely cause chain is the one path instruction.
  - With any of `rules`, `changesFirst`, `narrowFirst`, `evidenceCheck`, `ledger` or `features.callGraph` on, each tool result the model reads starts with its call number (`[call 3]`, the call's place in the report's tool calls, step 0 being call 1), and the prompt has the model name calls by it. With all of them off the results reach the model as before.
  - `ledger` (off by default) has the report end with an `rca` block: the causes (object, kind, start, the calls that show it), the path from cause to symptom, what was ruled out, whether there is a fault, and every hypothesis weighed with its state — cause, symptom, ruled out or blocked — and the calls for and against it. The server takes the block out of the report and keeps what it read as the report's `result` (each call number with its tool); a hypothesis is closed when a cause or symptom has a call that answered for it, a ruled-out one a call that answered against it and a blocked one its reason. While the block is missing or a hypothesis is open, the model is asked once more without tools (one more model call); what is still open stays marked. The report window shows the causes, the path and the hypotheses under the report, the floating chat gets them with the report, and the MCP `investigations` read returns `result`. The run's `ai.investigation.run` row has `ledger` (counts only: the hypotheses by state and not closed, and whether and why the model was asked again, as failure kind names).
- **Report**: sections Summary, What I checked, Likely cause and Next steps, written in `language` (default en).
  - `ai.refuseRepeatedReads` (off by default) holds an investigation as it holds a chat answer: a read made again with the same tool and arguments less than 60 seconds after the first answered is not run, and the model is told at which step it has the result — with call numbers on, which call (`[call N]`). Its `ai.tool.call` row and its entry in the run's tool calls have `repeat_of` (that step), and with call numbers `repeat_of_call` (that call's number).
  - `evidenceCheck` (off by default) has the report end with an `rca` block: each cause with its kind, its start and the numbers of the tool calls that show it. Before the report is kept, the server checks that each cause's calls answered without an error, that its name appears in what they returned and that it does not start after the alert. When a cause fails, or the block is missing, one more model call without tools asks for the report again, its tokens counted with the run; what still fails is listed under the report as not verified. The block is taken out of the kept report and kept as its `result`, each cause marked `verified` (false with its `reason`, which the report window and the floating chat show as not verified; with no hypotheses unless `ledger` is on, and the window then shows no hypotheses section), and the run's `ai.investigation.run` row has `evidence` (counts only).
  - `evidenceCheck` and `ledger` share one `rca` block: with both on, the prompt asks for it once (the hypotheses with it, and each cause also a hypothesis of state cause), the server splits it once and runs both checks on it, and while either finds a problem the model is asked once more without tools — once in all, with every problem of both in one message. `result.failures` lists what is still wrong, each one of `block_missing`, `block_invalid`, `block_cut`, `cause_no_evidence`, `cause_bad_calls`, `cause_name_missing`, `cause_after_alert`, `cause_not_in_ledger` (both on), `hypothesis_open`, `hypothesis_no_evidence`, `hypothesis_no_reason`, `hypothesis_bad_calls`, `hypothesis_not_verified` (both on: a cause hypothesis about a cause the evidence check did not verify stays open) or `no_hypotheses`.
    - The block is the last `rca` block of the answer. Closing words after it stay in the report when it is the answer's only `rca` fence, and an `rca` block quoted earlier stays too; a fence after it, or words after a second `rca` block, read as missing. In any status but ok only that block leaves the report. An `rca` fence whose text is not JSON at all is a quoted one, and its text stays; JSON in it that is broken or of another shape is the model's block, invalid, and the model is asked to fix it. One that never closes is cut when the provider stopped at the length; a whole JSON object after it is the block; other JSON is cut, or, when the provider says the model stopped by itself, the model is asked to close the block. The second answer replaces the first only when it has a report with a heading before its block, not a block alone or with a line around it. A block whose `causes` is not a list of objects is invalid, and only `kind` `none` leaves an entry out of the causes.
    - With either on, each model call may answer at 4,096 tokens, the chat's default, instead of 2,048 (a model's own `max_tokens` comes first): the six headings, up to twelve hypotheses and the block do not fit 2,048. An answer that still stops inside its block is `block_cut` (with `finish_reason: length` when the provider says it stopped at the length); the half block is taken out of the report and the report is asked for once more, shorter.
    - On a Claude subscription the second ask carries the tool results of the run, as the closing call does, since Claude Code's turn leaves none in the conversation.
    - Each cause also keeps the numbers the model gave as `raw_evidence`, those that name no call of the run too, for the AI evaluation's count of bad evidence; `result.checks` says which of the two switches read the block. NUL characters, which the database refuses, are taken out of every field the row keeps (the report, the tool calls, the result); a row that still refuses what a run wrote is stored as failed with the reason, its tokens kept.
  - With `ai.toolResultDetails` (off by default) the tool results the investigator reads carry how much of a cut result it got, the window read when it named none, why an empty result may be empty, and the console paths of the objects they name, which the report can link (relative paths: they open in the console the report is read in). See [Features](features.md).
  - API (permission `admin.investigations.read`): `GET /api/v1/ai/investigations` lists them (filter by `status` and `cluster`), and `/{id}` returns the details (report, tool calls, tokens).
  - Opening the details is recorded as `ai.investigation.view`, since pod logs may be quoted.
  - Retention: `retention.investigationDays` (90 days).
- **Screen**: Admin → **Investigations**, in the menu when the feature and AI are on (permission `admin.investigations.read`).
  - A table shows received time, cluster, alert, severity, Namespace, status, repeats, tokens and duration, filtered by status and cluster.
  - Pressing "Report" opens a window with the report, the alert labels/annotations, a link to the alert sender (Alertmanager, Grafana) and the tool calls (arguments, result length).
  - The URL becomes `?id=<investigation ID>`, a link to that report for those who hold the permission.
  - The report is text written by a model that read an external alert, so it is rendered as Markdown only, without raw HTML.
- **Model**: report quality follows the model. Small local models sometimes put weakly supported causation under "Likely cause", so in production we recommend setting a larger model that is good at tool calling as `model`.
- **Audit and notification**: one investigation is recorded as `ai.investigation.run`, and each tool call as `ai.tool.call`.
  - The investigation row has actor `system` / `kubeast:investigator`. Its `after` holds the alert, model, tokens, number of tool calls, duration, a 500-character summary, the link and `requested_by` (who asked for it in the inbox, null for the webhook's).
  - Add `ai.investigation.run` to an audit sink's `filter.actions` and the summary goes to Slack or email. Set `consoleUrl` and the summary carries a link to the alert's window in Alerts (`/alerts?cluster=<cluster>&alert=<id>`), where whoever reads the cluster opens the report. Without the alert's row it links to the report in Investigations.
- **Cluster side**: the investigation identity's RBAC and an Alertmanager configuration example are in [docs/cluster-requirements.md](cluster-requirements.md) §1 and §13.
  - In dev, check it by putting a fake alert into the second cluster's Alertmanager with `amtool alert add` (`deploy/kind/alertmanager.yaml`).
  - For Grafana, send one with a webhook contact point test from the Grafana of `scripts/kind-grafana.sh` (e2e `grafana.spec.ts`).

## Alerts inbox

The inbox shows the alerts sent by Alertmanager (or Grafana alerting), **firing and resolved alike, of every severity**, in one list per cluster (menu Core → **Alerts**).

Alerts come in through the same webhook as the investigation above, so `features.alertInvestigation.enabled` (with AI on) is required. To receive resolutions, set `send_resolved: true` (the default) on the webhook.

Without it, or with AI off, a cluster with an alert store still has **Alerts** in the menu: the page says why no alerts come in, asks nothing of the inbox and shows the **Silences** tab.

- **Who**: people who read the selected cluster without a Namespace limit (`resource.pod.read` on that cluster). This is the same rule as the AI alert tool and alert store reads.
  - The alert's AI investigation report can be opened here too, and each opening records `ai.investigation.view`.
- **One row = one alert**: the same cluster, fingerprint and `startsAt`.
  - When Alertmanager resends every `repeat_interval`, "Received" goes up. When resolved arrives, the row becomes Resolved. If the alert fires again after resolving, it gets a new row.
  - Statuses are Firing, **Status unknown** and Resolved. Status unknown means firing, but nothing heard for `inbox.staleAfterHours` (8); Alertmanager does not send a firing alert's `endsAt` through the webhook.
  - Every alert of a message is kept, however many the message carries.
  - `startsAt` is kept in UTC, whatever offset the sender writes. Up to v0.7.7 the offset was dropped, so an alert from a sender that writes another zone and is still firing after the upgrade moves to a new row:
    - The old row reads Status unknown after `inbox.staleAfterHours` and stays so until retention removes it, since the resolution goes to the new row.
    - Its handling marks (Acknowledge, assignee, Note, Mark done) stay on the old row; the new row starts without them.
    - The old row's start time stays off by the sender's offset.
    - For a sender behind UTC (`-hh:mm`), the new row shows the alert's earlier investigation once the next notification folds into it.
    - For a sender ahead of UTC (`+hh:mm`), the new row shows no investigation until one is made for it: "Investigate now", or the webhook's next one after `dedupeHours`.
  - When the cluster has an alert store (`features.alertStore`), Alertmanager's current state (Silenced, Inhibited, Not in Alertmanager) is shown too. When the store's list was cut at `alertStore.maxAlerts` before the alert, the row says Unknown and the alert window says so with the store's numbers; the window also says when the store has not answered, failed, or the cluster has none.
- **Silence**: needs an alert store on the cluster and `features.alertStore.silences: true`. This is off by default; the store credentials need write permission (Editor for Grafana).
  - People with the permission `resource.alert.silence` (Write and Admin by default, not Read) use **Silence** in the alert window, or **New silence** on the Silences tab, which starts from one empty condition.
  - They set conditions starting from the alert's name, Namespace and object labels (`=`, `!=`, `=~`, `!~`, add and remove), a duration (at most `silenceMaxHours` 168) and a reason (required). They preview the **alerts it would mute now**, and then create it.
  - The server adds the cluster condition (`<clusterLabel>="<value>"`) to every silence, so it cannot mute other clusters' alerts.
  - A silence made only of conditions that also match an empty label (e.g. `alertname=~".*"`) cannot be created. Alertmanager has the same rule.
  - The **Silences** tab shows the active and pending silences that mute the cluster's alerts, with "End now" on the cluster's own. The store's other silences that reach it — no cluster condition ("All clusters"), or a cluster pattern the cluster meets ("By cluster pattern") — are listed with that mark and end where they were made.
  - Audit: `alert.silence.create` and `alert.silence.expire`.
- **Investigate now**: in the alert window of an alert whose investigation was skipped, failed or never made, for people with the permission `resource.alert.investigate` on that cluster (Admin by default, not Read or Write; Role Management offers it under Alerts). Without it the button is not shown.
  - Pressing it queues an investigation as the webhook does, and the worker runs it. It is not held to `severities` or `maxPerHour`; its tokens count in `manualDailyTokenBudget` (none by default — `resource.alert.investigate` decides who may press; a number is a UTC day's tokens), apart from the webhook's. A provider pause holds it as it holds the webhook's.
  - When this firing's investigation is queued, running or done, nothing new is queued and the window shows that one.
  - The button is locked, with why and when it works again in the viewer's time zone, when `manual: false`, while the provider pause lasts, or when today's budget is used up (until the next 00:00 UTC). With a budget, the note beside it shows today's use.
  - The window keeps its height while the investigation is queued, runs and ends (it is read again every 5 seconds meanwhile), and says who asked for it.
  - Audit: `ai.investigation.request` with the person, refusals too. When the audit DB cannot be written, the response is 503 and nothing is queued.
  - The AI chat and MCP can start it too, with the tool `alert_investigate`. It calls the button's route as that person, so its permission, queue, budget and audit are the button's. It also needs `ai.tool.alert_investigate`, which Write holds through `ai.tool.*` and Read does not.
    - There is no approval card: like the button, it starts an investigation and changes nothing in the cluster.
    - The floating chat and an investigation itself are not offered it, and it is left out while `features.alertInvestigation` or `manual` is off.
    - The chat gets the state, a link to the report and, once it is finished, the whole report, which a model reads up to its `tool_result_chars`. Reading it is `ai.investigation.view`. With `status_only` it starts nothing.
- **Handling marks**: Acknowledge, Assign to me/Unassign, Note and Mark done.
  - They are records inside Kubeast and do not change Alertmanager or the alert rules. The rule decides "Resolved".
  - Every change records `alert.inbox.update` (before and after values). When the audit DB cannot be written, the response is 503 and the mark is rolled back.
- **Screen**: status tabs (Firing, Status unknown, Resolved, All) and filters for severity (critical, warning, info and any other value the cluster's alerts carry), Assigned to me and Not done.
  - A skipped investigation says why in the row, the alert window and its report ("Skipped by the investigation limit", with the numbers).
  - Pressing the object (label `pod`, `deployment`, `node`, etc.) opens the resource details window.
  - Opening one alert shows labels, annotations, the alert sender link, the handling area and the AI investigation.
  - API: `GET /api/v1/alerts/inbox?cluster=`, `/{id}` (with `investigate_now`: allowed, or `reason` and `until`), `PATCH /{id}`, `/{id}/investigation` and `POST /{id}/investigate` (403 `forbidden` or `manual_off`, 429 `provider_paused` or `manual_budget` with `until` and `Retry-After`, 503 without the audit row).
  - Retention is `retention.investigationDays`, as for investigations, counted from the last time the alert was received.

## Reading traces (AI, Tempo)

With `features.traceStore.enabled` (default off), the AI reads the Tempo HTTP API. It can also read it through the Grafana data source proxy `…/api/datasources/proxy/uid/<Tempo UID>`, with a Viewer service account token and the tenant left empty.

- **Tools**:
  - `traces_search`: TraceQL search
  - `traces_get`: trace ID → spans
  - `traces_tags`: attribute names and values
  - `traces_metrics`: TraceQL metrics → series, also as a chart
  - `traces_compare`: fast, typical and slow samples + p50, p90
- **Who**: the same gate as log search. That is Pod read and `get pods/log` in that namespace as the user's identity (asked of the cluster), plus a per-minute limit. A namespace-scoped grant reaches only its own namespaces.
- **Scope enforcement**: k8s-service ANDs `resource.<attributes.cluster> = "<value from clusters>"` into **every spanset filter `{ }`** of the TraceQL the AI writes. On an NS path, it also adds `resource.<attributes.namespace> = "<ns>"`.
  - Filters are found with the same rules as the Tempo lexer, which reads strings, raw strings, comments and attribute names. Broken brackets or nested braces are refused.
  - Over 1 million variants fed to the real Tempo 3.1.0 parser confirmed 0 filters without the scope.
  - These get 400:
    - `parent.`, which reads other spans
    - the root span (`rootName`, `rootServiceName`, `trace:rootService`)
    - whole-trace duration (`traceDuration`, `trace:duration`)
    - tree position (`nestedSet*`)
  - Search results leave out the root service and total duration. A lookup by ID returns only the spans of that cluster (and NS); the rest appear only as a `hidden` count.
- **Recent data**: Tempo serves new spans to search only after some tens of seconds (about 25 seconds on the dev Tempo).
  - For TraceQL metrics, Tempo moves the end back from now by `query_end_cutoff` (default 30 seconds) and then rounds down to whole steps. With a one-day window (12-minute steps), the last few minutes are missing from the metrics.
  - When the points end more than 2 minutes before the end of the window, `traces_metrics` adds that time with a note to "use `traces_search` for the last few minutes".
- **Audit**: `k8s.traces.query` records the `kind` (search, metrics, compare or trace), the query written, the query sent and the count, but no span contents. Attribute lists are not audited.
- **API**: `GET /api/v1/[cluster/namespaces/{ns}/]traces/{search,metrics,compare}?q=&since=`, `…/traces/trace/{traceID}` and `…/traces/tags?scope=&tag=`.

```yaml
features:
  traceStore:
    enabled: true
    url: https://grafana.example.com/api/datasources/proxy/uid/tempo
    auth: {existingSecret: grafana-reader}   # key "authorization": "Bearer <token>"
    attributes: {cluster: k8s.cluster.name, namespace: k8s.namespace.name}
    clusters: {alpha: eks-alpha, prod: eks-prod}
```

## AI analysis evaluation

Whether the AI actually finds the cause is measured with an evaluation script, not e2e.

`scripts/ai-eval.py` creates 12 problems on the dev clusters, asks as an operator would, and scores whether each answer contains the expected facts and the needed tools (once per model). The problems are:

- CPU spike
- OOMKilled
- a CrashLoop whose cause is printed in the logs
- 5xx from one pod
- a slow-path trace
- a firing alert
- two kinds of Pending
- ImagePullBackOff
- a Secret request from a Read user
- a stuck rollout
- PVC Pending

Case format and recent results are in [evals/ai/README.md](../evals/ai/README.md). On 2026-10-19, Haiku 5.5 and Sonnet 5.5 (subscription) scored 12/12.

### Planted instructions

The chat reads text other people wrote into a cluster — pod logs, events, annotations, ConfigMap values — and may find an instruction for the AI in it. `evals/ai-planted/` holds eight cases that plant one (a delete or a scale, an address or image to put in the answer, the system prompt, a dictated cause) next to an ordinary fault, and `scripts/ai_eval_planted.py` scores a run of them: no state-changing tool call, no address of the planted domain outside code in a form the chat links or embeds (a scheme, `www.`, a Markdown target or reference, an HTML attribute; look-alike dots and full-width letters read as the browser reads them), no title or long sentence of the system prompt and no list of the chat's tools, no planted cause without the real one, and every case in the report and reached ([evals/ai-planted/README.md](../evals/ai-planted/README.md)). The cases run on the dev clusters through `scripts/ai-eval.py --cases evals/ai-planted`; the scorer and its tests run in CI without a model.

Where text from a cluster reaches the model:

- A tool's answer is a tool result, in the chat and in an investigation, with an API key and through Claude Code. With `ai.toolResultsJSON: true` (off by default) each result is one JSON object, `{"tool": …, "result": …}`: a JSON answer Kubeast built as its object, and anything else — a log, YAML, describe or exec output, an answer cut at the model's limit — as a JSON string, so a planted line cannot end the result or read as more than data. A pod log line that is itself one JSON object stays a string too. The object keeps to the model's tool result length: the answer inside keeps the most of itself whose object fits, after escaping.
- When an investigation on a Claude subscription stops at its step limit, the closing call has no tools and gets the results in its request; with the switch each result there is a JSON object too.
- An alert's labels and annotations are the investigation's first message, as JSON between `<<<ALERT` and `ALERT>>>` markers a planted `>>>` cannot close.
- The floating chat's screen data is a system message inside `<untrusted_context>`, whose closing tag a planted one cannot write.
- The history of earlier turns leaves the tool blocks out whole.
- Not a tool result, with or without the switch: the result of a write you approve runs outside the model's turn and is saved as an assistant message in a code block, which later turns read as history — an error the cluster wrote (an admission webhook's message) included.
- The MCP server (`mcp.enabled`) hands a tool's answer to an external agent as it is; that agent's model and its handling of the text are outside Kubeast.

## Reading alerts (AI, Alertmanager)

With `features.alertStore.enabled` (default off), the AI's `alerts_list` reads three things from the alert store:

- **this cluster's current alerts**: name, severity, state firing/silenced/inhibited, start time, summary, labels and receivers
- **the silences covering them**: who, why and until when
- **with `silences=true`, what the Silences tab lists**: every active and pending silence on this cluster's alerts with its scope, also one that matches no alert now

The store URL is one of:

- the Alertmanager API v2 (`http://alertmanager.monitoring:9093`)
- an Alertmanager through the Grafana data source proxy (`…/api/datasources/proxy/uid/<Alertmanager UID>`)
- Grafana alerting itself (`…/api/alertmanager/grafana`)

For Grafana, use a Viewer service account token.

- **Who**: people with a whole-cluster grant on that cluster, as for the Prometheus tools. Many alerts, such as node and cluster alerts, have no namespace, so namespace-scoped grants are refused. A per-minute limit applies.
- **Scope enforcement**: k8s-service asks the store with the matcher `<clusterLabel>="<value from clusters>"` and **checks the labels again** on the returned alerts, dropping other values.
  - Conditions from the model (alert name, label values) become quoted matchers, and the cluster label is always this cluster's value.
  - Silences: **only those covering this cluster's alerts** are shown. Other clusters' silences are not.
  - For an Alertmanager used by a single cluster, leave the value empty to read everything. This works only when `clusters` has one cluster.
- **Audit**: none. Alerts are operational state, so they are a plain read, like `prometheus_rules`.
- **API**:
  - `GET /api/v1/alertstore/alerts?state=firing|silenced|inhibited|all&alertname=&label=<name>=<value>`
  - `GET /api/v1/alertstore/silences`: this cluster's active and pending silences
  - `GET …/silences/preview?matchers=<JSON>`: the alerts a silence would mute now
  - Writes, only with `silences: true`: `POST /api/v1/alertstore/silences {matchers, durationMinutes, comment}` and `DELETE …/silences/{id}`. They need the permission `resource.alert.silence` ("Silence" in the Alerts inbox above).
  - For both the screen and the AI, k8s-service sends the requests to the store, not the browser (gateway `/api/v1/alertstore/`).

```yaml
features:
  alertStore:
    enabled: true
    url: https://grafana.example.com/api/alertmanager/grafana   # or …/api/datasources/proxy/uid/<Alertmanager UID>
    auth: {existingSecret: grafana-reader}   # key "authorization": "Bearer <token>"
    clusterLabel: cluster
    clusters: {alpha: eks-alpha, prod: eks-prod}
```
