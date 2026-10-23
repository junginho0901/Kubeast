**English** | [한국어](ko/security-audit.md)

# Security and audit

## API keys (automation)

A long-lived credential that scripts and CI use instead of a human sign-in. In Settings → API keys, set a name, an expiry (default 30 days, capped by the chart's `auth.apiKeys.maxDays`), clusters and a role ceiling (default Read) and issue the key; its value (`kbk_…`) is shown only once. The key does not call the API itself; it is exchanged for a short-lived access token — the token is the permissions the issuer holds at that moment, cut down to the key's scope, so it cannot do more than the issuer. Once the key is revoked (or expires), the next exchange is refused, and tokens already obtained with that key are refused within the services' token check interval (30 seconds) (an admin can revoke someone else's key from the user details; only the owner can issue one).

```bash
TOKEN=$(curl -s -X POST https://console.example.com/api/v1/auth/token \
  -H "Authorization: Bearer $KUBEAST_API_KEY" | jq -r .access_token)     # exchange again after expires_in seconds
curl -s "https://console.example.com/api/v1/cluster/overview?cluster=prod" \
  -H "Authorization: Bearer $TOKEN" -H "X-Cluster-Name: prod"
```

Without `?cluster=`, the request goes to the registry's default cluster (the self cluster, or else the first one registered), and permissions are checked against that cluster. `GET /api/v1/cluster/current` (`{"id": "…"}`) tells which cluster it is.

To turn it off, set `auth.apiKeys.enabled: false` (`API_KEYS_ENABLED` in compose). Issuing, revoking and exchanging keys are recorded in the audit log.

## Access review

Puts "who can do what right now" on one page so it can be reviewed periodically, and records "reviewed" (ISMS-P 2.5.6 access rights review, NIST 800-53 AC-2(j)). Admin → Access review shows five sections as tables.

| Section | Contents | Flags |
|---|---|---|
| Users | email, team, global role, auth source, created date, **last login** (`auth_users.last_login_at`, recorded on every successful login, backfilled from the audit log), number of cluster roles/API keys/temporary grants | `global_admin` · `never_logged_in` · `dormant` (last login or creation `dormantDays` ago) · `locked` |
| Cluster roles | cluster and role per user, permanent/via request, expiry and the role it reverts to | `temporary` · `admin_role` |
| API keys | owner, name, prefix, cluster, role ceiling, created, expires, last used | `expired` · `expiring_30d` · `unused_30d` |
| Temporary access history | access requests since the last review: requester, cluster, role, duration, reason, approver, decision, end | — |
| Roles | name, system or not, permission list, number of users/bindings using it | `has_admin_permissions` · `unused` |

- **CSV** per tab (UTF-8 BOM, formula injection prevented) · cards at the top with the number of global Admins, dormant accounts, keys about to expire and active temporary grants, and the **last review and next due date** (`intervalDays` later, flagged when past).
- The **Sign off** button saves the whole report as of that moment, with a note (`access_reviews`, kept for `retention.reviewDays`, default 3 years). Past reviews can be opened from the list and downloaded again as the CSV of that time.
- Permissions `admin.review.read` · `admin.review.export` · `admin.review.signoff` (included in the system Admin role); the audit actions have the same names. The only write is the sign-off; access changes are made on the existing screens.
- To turn it off, `auth.accessReview.enabled: false` (the menu and API go away). Cost: 7 queries when the page opens, a snapshot of tens of KB per sign-off.

## Dormant account auto-lock

Where the report above **shows** dormant accounts, this feature **closes** them without anyone looking (ISMS-P 2.5.6 deficiency example "accounts not accessed for 6 months or more still active", NIST 800-53 AC-2(3)). With `auth.dormantAccounts.enabled: true`, a sweeper inside auth-service runs every `sweepHours` (24), locks **accounts with no login and no API key exchange** for `days` (90) (an account never used counts from its creation date) and revokes that account's sessions. A locked account is refused password login, SSO and API key exchange alike (the response is a plain 401; the reason is `reason: dormant` in the audit log), and gets back in only after an admin presses **Unlock** in Admin → User Management.

- With `exemptAdmins: true` (default), accounts whose roles carry the `*` or `admin.*` permission are not locked — if the last admin were locked too, no one could unlock anyone. They keep showing as `dormant` in the access review report instead.
- Admin → User Management: a "Dormant lock"/"Locked" badge and an **Unlock** button on locked accounts, and **Sweep dormant now** at the top (runs the sweeper once right away, `admin.users.update`). Audit actions: `user.account.dormant_lock` (actor `system`) · `admin.dormant.sweep` · `admin.users.unlock`.
- Turning it off stops the sweeper so no new locks happen, but accounts already locked stay locked until unlocked. It is a separate value from the access review's `dormantDays` (the display threshold), so the two can be spread apart, e.g. "flag from 60 days, lock at 90".

## Audit sinks (S3 · webhook · email · file)

The audit log's primary store is the DB; sinks **copy** its rows **out**. One auth-service replica keeps "how far it has sent" (a cursor) per sink in the DB and sends in batches, so a dead sink does not block requests, and sending resumes once it recovers (at-least-once delivery — deduplicate by the record's `id`). Without sinks, nothing changes.

| Type | Use | Secrets (Secret keys) |
|---|---|---|
| `s3` | long-term retention (S3, MinIO, GCS, R2). Time-partitioned NDJSON gzip | `accessKeyId`·`secretAccessKey` — without them, IRSA (role in `serviceAccounts.authService.annotations`) |
| `webhook` `json` | general purpose, such as SIEM or n8n (optional HMAC signature `X-Kubeast-Signature`) | `url`, `hmacSecret` |
| `webhook` `slack` · `teams` · `discord` | chat notifications | `url` |
| `webhook` `telegram` | chat notifications (`chatId`) | `botToken` |
| `webhook` `pagerduty` | on-call (Events v2, one per event) | `routingKey` |
| `email` | email (SMTP, STARTTLS/TLS) | `username`·`password` |
| `file` | NDJSON on a PVC (`/var/lib/kubeast-audit`, `audit.fileSinkVolume`) | — |

`teams`, `discord` and `pagerduty` follow each service's published payload format but have not been tested against the real services yet.

```yaml
audit:
  sinks:
    - name: archive                      # long-term retention, full history
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
    - name: slack-danger                 # only risky actions to Slack
      type: webhook
      secret: kubeast-audit-slack        # kubectl create secret generic kubeast-audit-slack --from-literal=url=https://hooks.slack.com/...
      webhook: {format: slack}
      filter: {actions: ["k8s.*.delete", "k8s.pod.exec", "k8s.node.shell", "access.request.create", "admin.*"]}
retention:
  auditDays: 90                          # with S3 on, keep in the DB only the period the screen and CSV need
```

- **Filter**: the same wildcards as permission patterns (`k8s.*.delete`, `admin.*`) and `results: [failure]`. No filter = everything.
- **Starting point**: `s3` and `file` start from the beginning (the whole existing history), the rest from when they are turned on (change with `startFrom`).
- **S3 Object Lock (WORM, ISMS-P evidence)**: create the bucket with Object Lock + versioning and set a **default retention** (compliance or governance, a period). Kubeast does not set retention per object, and the only IAM permission needed is `s3:PutObject`. In compliance mode, not even root can delete during the period.
- **Retention**: even past `retention.auditDays`, **rows not yet sent to a sink are not deleted**. A stalled sink shows up as the alert `KubeastAuditSinkStalled` (metrics `kubeast_audit_sink_pending` · `_failures_total` · `_last_success_timestamp_seconds`).
- **Network**: 443 is open. For SMTP (587/465) or in-cluster endpoints, add NetworkPolicy rules to `audit.sinkEgress`.

On local kind, `kind-deploy.sh` also brings up `deploy/kind/devtools.yaml` (versitygw as an S3 stand-in + an Object Lock bucket, Mailpit, a webhook receiver), and the dev values point three sinks at it. Mail inbox: `kubectl -n kubeast-devtools port-forward svc/mailpit 8025`.

## Audit log integrity (hash chain · S3 anchor)

Makes it possible to tell whether audit rows were changed or deleted later. Every `audit.integrity.sealSeconds` (default 10 seconds), auth-service chains new rows with a sha256 that includes the previous row's hash (`chain_seq` · `prev_hash` · `row_hash`), and when `audit.integrity.anchor.sink` names an S3 sink, it writes the chain head as a digest JSON to `<prefix>digests/` in that bucket every `anchor.hours` (default 24). The bar at the top of Admin → Audit Logs shows the seal position and the last anchor, with **Verify** (default = from the last anchor, including a check against the sink objects) and **Anchor now** buttons. Both are recorded as audit rows (`admin.audit.verify` · `admin.audit.anchor`); the periodic anchor is `audit.chain.anchor` (actor `system`).

```yaml
audit:
  sinks:
    - name: archive
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
  integrity:
    enabled: true        # default: chain only (no dependencies)
    sealSeconds: 10
    anchor:
      sink: archive      # name of the s3 sink above. Empty = no anchor
      hours: 24
```

- **The trust anchor is the bucket's Object Lock.** Someone who can change both the DB and S3 can also rewrite the anchors, so set a default retention on the bucket that holds the digests. Digests are not signed.
- **Independent verification**: the same formula can be recomputed with psql, without Kubeast (`CanonSQL` in `services/auth-service-go/internal/auditchain`, [docs/audit-log-plan.md](audit-log-plan.md) §7).
- **Limits**: rows deleted in the window before sealing (≤ `sealSeconds`) are not caught. A period during which it was turned off and on again shows in the verification result as having no anchor. Retention (`retention.auditDays`) deletes only a prefix of the chain.
- Metrics `kubeast_audit_chain_sealed_seq` · `kubeast_audit_chain_unsealed_rows` · `kubeast_audit_anchor_last_timestamp_seconds`.

On local kind, the dev values anchor to the `dev-s3` stand-in (`e2e/tests/audit-integrity.spec.ts`).

## Session recording (exec · node shell)

When on (`sessionRecording.enabled`, default off), the **output printed** to Pod exec and node shell terminals (what the user saw — typed commands show through the echo, and password input that is not echoed is not kept) is recorded as asciicast v2. When a session opens, the terminal first prints one line, "This session is recorded" ("이 세션은 녹화됩니다" on a Korean screen) — the recording keeps that line too — and the audit row (`k8s.pod.exec` · `k8s.node.shell`) gets a `recording_id`.

- **Storage**: k8s-service writes to a local volume and uploads chunks every `chunkSeconds` (default 30 seconds) during the session — if the k8s-service pod disappears, only the last chunk interval is lost. Store = `s3` (recommended for production, the same fields as the audit S3 sink) · `database` (1 MiB per session, small installs without S3) · `file` (PVC). S3 keys are mounted as files, so they do not touch k8s-service's IRSA identity.
- **Interrupted sessions**: a session cut off for reasons on the k8s-service side stays as `interrupted` — a graceful shutdown (rollout, drain) and a container restart upload all the remaining output; if the pod disappears entirely, only the chunks uploaded before that remain. The size in the list is the size kept (uploaded), and the play button is disabled when no chunk was uploaded.
- **When the terminal drops**: when the terminal goes away without `exit` because the browser tab was closed or the network dropped, k8s-service sends Ctrl-C and Ctrl-D to the shell to end it (the container runtime does not clean up the processes of a disconnected exec). A program in the foreground that ignores them, such as an editor, may be left running.
- **Failures**: if recording cannot start (cannot write to the local volume), the session is refused (`required: true`). If an upload to the store fails or one chunk does not finish within 30 seconds, the session goes on; uploads are retried, and the problem shows up as the alert `KubeastSessionRecordingUploadStalled`. Past `maxBytes` per session (default 64 MiB), only the recording stops.
- **Playback**: play, or download the `.cast` or a text copy, in Admin → Session recordings (permission `admin.sessions.read`); exec rows in Audit Logs play too. Every time a recording is opened, `admin.session.read` is audited.
- **Player and CSP**: the player (asciinema-player) runs the terminal in WebAssembly. That is why the `script-src` of the CSP the gateway sends includes `'wasm-unsafe-eval'` (not `'unsafe-eval'`, `helm/kubeast/files/nginx.conf`). If an Ingress or proxy in front overwrites the CSP header, it must allow the same value for playback to work — without it, the player stops at the ▶ button and `--:--`.
- **Retention**: remote objects are left to the bucket lifecycle and Object Lock; list rows follow `retention.auditDays`.

```yaml
sessionRecording:
  enabled: true
  s3: {bucket: kubeast-sessions, prefix: sessions/, region: ap-northeast-2}   # s3:PutObject·GetObject on the k8s-service role
```
