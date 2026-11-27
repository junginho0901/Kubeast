# OWASP ASVS 5.0.0 self-check

This page checks Kubeast against the OWASP Application Security Verification Standard: every level 1 requirement, and the level 2 requirements on authentication, sessions, access control, input, errors and logging, secrets and configuration. It says for each whether Kubeast meets it, where, and what is left. It was written from the code; nothing was run for it. The per-release threat model pages are listed in the [index](README.md).

| What | Value |
| --- | --- |
| Standard | ASVS 5.0.0, GitHub release [`v5.0.0_release`](https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release) (2025-05-30), the latest stable version. The repository's `latest` release is the unreleased edge, not a version. Requirement numbers are those of the release file `OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json` (sha256 `8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311`); cite one as `v5.0.0-1.2.5`. |
| Counts in the standard | 345 requirements: 70 at level 1, 183 more at level 2, 92 more at level 3 |
| Code read | `main` at `a5796663`, on 2026-11-20. Rows whose From is `first` were read first that day, with `frontend/src` at a branch of the v0.8.0 screen redesign (`cbf6479f`), before its pull requests merged: their `frontend/src` lines have not been read again against the merged screens. The files `main` changed up to `a79441da` were compared again and their line numbers moved. V6.1.1 and V7.1.2 cite the section that this page's change adds to `docs/security-audit.md`. On 2026-11-27 each file and line a level 1 row cites was checked to be in the last tree before the v0.8.0 merges, and V1.2.2 and V1.3.1, whose lines had moved, were read again there. The same day the level 1 rows that were To check, with V5.2.1, V5.3.1, V8.1.1, V10.4.1 to V10.4.5, V13.4.1 and V15.1.1, were read again on that tree, and each now names the files, lines and tests it rests on. |
| Not read | 68 level 2 requirements outside the areas above (V3: 2, V4: 6, V5: 5, V10: 22, V11: 11, V12: 6, V14: 6, V15: 10) |
| License | The "Asks (short)" column restates the requirements of the OWASP ASVS 5.0.0 in a few words. The standard is © the OWASP Foundation, under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). |

Status:

- **Met**: the file and line named do what the requirement asks. Where a row says "search", a search found nothing against it; a search can miss a form it did not look for.
- **Partly**: a part is done; the row says which part is not.
- **Not met**: not done. **Not met — planned**: not done, and a change is planned; this page gives no date for it.
- **N/A**: Kubeast has no such function; the row says how that was found.
- **To check**: not read far enough to say, or decided by the install; the row says what to read.
- **Needs a test**: the code named reads as doing what the requirement asks, and no test shows it yet; "Left" names the test.

"From" says which reading first read the row, both on 2026-11-20: `first` for the reading of level 1, which also met some level 2 items, `second` for the reading of the level 2 areas. "Left" says `open` where something is left and not done yet, with what it is where the row needs it, `to decide` where no change is chosen yet, the row or page that holds it, or `—`.

Paths are from the repository root. `nginx.conf` is `helm/kubeast/files/nginx.conf`; `values.yaml` is `helm/kubeast/values.yaml`.

## Summary

| Area | Items | Met | Partly | Not met | To check | Needs a test | N/A |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Level 1, all chapters | 70 | 49 | 3 | 5 | 0 | 3 | 10 |
| Level 2, V1 Encoding and Sanitization | 19 | 11 | 1 | 0 | 2 | 0 | 5 |
| Level 2, V2 Validation and Business Logic | 7 | 1 | 2 | 0 | 4 | 0 | 0 |
| Level 2, V3.3 Cookies | 3 | 1 | 1 | 1 | 0 | 0 | 0 |
| Level 2, V6 Authentication | 22 | 3 | 4 | 2 | 1 | 0 | 12 |
| Level 2, V7 Session Management | 12 | 8 | 2 | 1 | 1 | 0 | 0 |
| Level 2, V8 Authorization | 3 | 0 | 1 | 0 | 1 | 0 | 1 |
| Level 2, V9.2 Token Content | 3 | 2 | 0 | 0 | 0 | 0 | 1 |
| Level 2, V13 Configuration | 12 | 3 | 8 | 1 | 0 | 0 | 0 |
| Level 2, V16 Security Logging and Error Handling | 16 | 6 | 9 | 0 | 1 | 0 | 0 |
| Total | 167 | 84 | 31 | 10 | 10 | 3 | 29 |

Level 1 by chapter: V1 8 (7 met, 1 N/A) · V2 4 (3 met, 1 not met — planned) · V3 8 (6 met, 1 partly, 1 needs a test) · V4 2 (1 met, 1 partly) · V5 4 (3 met, 1 N/A) · V6 13 (10 met, 1 partly, 2 not met) · V7 6 (6 met) · V8 4 (3 met, 1 needs a test) · V9 4 (4 met) · V10 5 (5 N/A) · V11 3 (1 met, 2 N/A) · V12 3 (2 met, 1 N/A) · V13 1 (1 met) · V14 2 (2 met) · V15 3 (2 not met — planned, 1 needs a test).

## Level 1

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V1.2.1 | Output encoded for its context | Met | React draws text and attributes escaped; the one HTML string, `frontend/src/pages/helm/modals/DiffView.tsx:35-39`, is diff2html 3.4.56's, which escapes each line; JSON by the encoder (`services/pkg/response/response.go:24`) | first | open |
| V1.2.2 | URLs built from data encoded; safe protocols only | Met | An alert's two addresses are drawn through `frontend/src/components/ExternalHttpLink.tsx`, a link only for an http or https URL with a host (`frontend/src/components/InvestigationReportModal.tsx:108-109`; `frontend/src/pages/alerts/AlertInbox.tsx:548-549`; `frontend/src/components/ExternalHttpLink.test.ts`), and the webhook stores no other value (`services/ai-service/tests/test_alert_webhook_addresses.py`). Also `frontend/src/utils/traceLinks.ts:8-21`, `frontend/src/components/chatMarkdown.ts:45-46`, `services/auth-service-go/internal/handler/access_requests.go:69-72` | first | — |
| V1.2.3 | JavaScript and JSON built with encoding | Met | Two JSON strings made with `Sprintf`, both of fixed shape (`services/auth-service-go/internal/security/jwt.go:109`, `services/k8s-service-go/internal/k8s/workloads_cronjob.go:119`) | first | — |
| V1.2.4 | Database queries parameterized | Met | `services/auth-service-go/internal/repository/repository_user.go:198-219`; `services/ai-service/app/services/claude_code_slots.py:46-51`, `:67-68` | first | — |
| V1.2.5 | Operating system calls parameterized | Met | `services/tool-server/kubectl.go:85-97` runs `kubectl` with an argument list, no shell; arguments held to Kubernetes' shapes (`services/tool-server/argcheck.go:1-8`) | first | — |
| V1.3.1 | HTML from a writer sanitized with a known library | Met | rehype-sanitize 6.0.0 with an allow list (`frontend/src/components/chatMarkdown.ts:18-49`, `:160`); reports show HTML as words (`frontend/src/components/AIMarkdown.tsx:6-13`) | first | open |
| V1.3.2 | No `eval` or other dynamic code | Met | Search of `frontend/src` and `services/ai-service/app`; the CSP has no `'unsafe-eval'` (`nginx.conf:86`) | first | — |
| V1.5.1 | XML parsers do not resolve external entities | N/A | Search of `services`: no XML parser | first | — |
| V2.1.1 | Documentation defines input validation rules | Not met — planned | No page sets the rules; they are in the code: a model's tool arguments (`services/tool-server/argcheck.go:1-8`, `:213`), account names (`services/auth-service-go/internal/handler/account_name.go:18`), passwords (`services/auth-service-go/internal/security/password.go:56`), kubeconfigs (`services/pkg/cluster/exec.go:34`), log file paths (`services/k8s-service-go/internal/logfiles/paths.go:39`) | first | open: a page that names each input that decides access and its rule |
| V2.2.1 | Input validated to its expected shape | Met | At level 1, the inputs that decide access: a model's tool arguments that land in argv are RFC 1123 names, qualified keys or fixed verbs (`services/tool-server/argcheck.go:189`, `:213`); a kubeconfig has no exec, file path, proxy or skipped certificate check (`services/pkg/cluster/exec.go:34-60`); a log file path is absolute, clean and inside the patterns (`services/k8s-service-go/internal/logfiles/paths.go:39-48`, `:80-86`); account names and passwords (`services/auth-service-go/internal/handler/auth_user.go:38-47`, `services/auth-service-go/internal/security/password.go:56`). Tests: `services/tool-server/argcheck_test.go` (`TestValidateToolArgs`, `TestNetpolCheckArgs`), `services/pkg/cluster/exec_test.go`, `services/k8s-service-go/internal/logfiles/paths_test.go`, `services/auth-service-go/internal/security/password_test.go` | first | — |
| V2.2.2 | Validation on a trusted service layer | Met | Every check of V2.2.1 runs in a server, and tool-server refuses a write tool without a signed approval (`services/tool-server/authz.go:43-63`). Specs that call the API without the screens: `e2e/tests/permission-ceiling.spec.ts`, `e2e/tests/api-keys.spec.ts`, `e2e/tests/ai-write-permissions.spec.ts`; `e2e/guard/permission-matrix.spec.ts` holds each role's screens to the cluster's answer | first | — |
| V2.3.1 | Multi-step flows run in order | Met | An AI write is asked, approved, then run: approving or rejecting an approval that is not pending is a 409 (`services/ai-service/app/api.py:361-366`), approving moves it from pending only (`:501`), the approval token signs the approval, the user, the cluster, the tool, the arguments' sha256 and a 120 s expiry (`services/ai-service/app/services/approval_token.py:35-43`), and tool-server runs a write tool only with a token that matches the call (`services/tool-server/authz.go:43-63`). Tests: `services/tool-server/approval_token_test.go`, `services/ai-service/tests/test_approval_binding.py`, `services/ai-service/tests/test_tool_approval.py`, `e2e/tests/ai-tool-approval.spec.ts` | first | — |
| V3.2.1 | Content cannot be drawn in the wrong context | Met | `nosniff` and the CSP on every gateway response (`nginx.conf:82`, `:86`); JSON is `application/json`; downloads are attachments | first | open |
| V3.2.2 | Text drawn with safe functions | Met | One `dangerouslySetInnerHTML` (`frontend/src/pages/helm/modals/DiffView.tsx:38`), the escaped diff | first | open |
| V3.3.1 | Cookies `Secure`, named `__Host-` or `__Secure-` | Partly | `Secure` unless DEBUG (`services/auth-service-go/internal/config/config.go:364`; `values.yaml:66`); the name is `kubeast.token` with no prefix (`config.go:363`); the OIDC state cookie's clearing line has no `Secure` (`services/auth-service-go/internal/handler/oidc.go:376`) | first | to decide |
| V3.4.1 | HSTS on every response, at least a year | Met | `nginx.conf:81`; `helm/kubeast/tests/gateway_test.yaml:6-10` | first | — |
| V3.4.2 | CORS answers a fixed origin or a list | Met | Each service lists origins: `services/auth-service-go/cmd/server/main.go:320-338`, `services/session-service-go/cmd/server/main.go:132-145`, `services/k8s-service-go/cmd/server/main.go:430-442`, `services/ai-service/main.py:112-122` | first | — |
| V3.5.1 | Requests from another site cannot use the session | Met | Cookie requests that change state need `X-Requested-With` (`services/pkg/auth/jwt.go:447-456`); `SameSite=Strict` (`auth_user.go:274`) | first | — |
| V3.5.2 | A request that skips the preflight cannot reach the function | Met | Same lines as V3.5.1 | first | — |
| V3.5.3 | Changes use POST, PUT, PATCH or DELETE | Needs a test | A request signed in by cookie with another method needs `X-Requested-With` (`services/pkg/auth/jwt.go:447-456`). A search of the route registrations by handler name (Go `r.Get`, ai-service `@router.get`) finds three kinds of GET that change state: the OIDC sign-in and its callback, as the protocol has them (`services/auth-service-go/cmd/server/routes.go:23-24`), WebSocket handshakes, which check Origin (`services/k8s-service-go/internal/ws/origin.go:40-50`), and the optimization answer's event stream, which a browser opens with GET; the session cookie is `SameSite=Strict` (`services/auth-service-go/internal/handler/auth_user.go:286`). Not every GET handler was read | first | open: a guard spec that calls every GET route `scripts/api-snapshot.sh` lists as an admin and finds no new write row in the audit log, no changed `resourceVersion` and no new database row after them |
| V4.1.1 | Every body has a matching `Content-Type`, charset for text | Partly | Event streams with no charset: `services/k8s-service-go/internal/handler/pods.go:309`, `logfiles.go:427`, `live_session.go:100`, `helm_watch.go:94`, `stream_caps.go:67`; JSON written with `http.Error` goes out as `text/plain` (`services/pkg/auth/jwt.go:492`, `:496`; `services/auth-service-go/internal/security/middleware.go:85`, `:96`, `:100`, `:106`) | first | open |
| V4.4.1 | WebSockets over TLS | Met | The three sockets the page opens take `wss:` on an https page (`frontend/src/components/PodExecTerminal.tsx:48`, `frontend/src/components/NodeShellTerminal.tsx:24`, `frontend/src/services/watchMultiplexer.ts:37`); the session cookie is `Secure` by default (`values.yaml:70`), so a page over plain http holds no sign-in to open one with; HSTS (`nginx.conf:81`, `helm/kubeast/tests/gateway_test.yaml`). TLS is ended in front by the install; `ingress.tls` is false by default (`values.yaml:993`) | first | — |
| V5.2.1 | Only bodies of a size the app can handle | Met | `MaxBody` (`services/pkg/limits/body.go:18`) in auth-service, k8s-service and session-service (`services/auth-service-go/cmd/server/main.go:311`, `services/k8s-service-go/cmd/server/main.go:446`, `services/session-service-go/cmd/server/main.go:123`); ai-service's cap (`services/ai-service/main.py:132-138`); nginx's 1 MiB in front. Tests: `services/pkg/limits/body_test.go` (`TestMaxBody_RejectsOversizedBody`), `services/ai-service/tests/test_p2_hardening.py` (`test_oversized_body_is_refused_before_routing`) | first | — |
| V5.2.2 | A file that decides security is checked by content | Met | A kubeconfig is parsed and refused on an unlisted exec plugin, skipped TLS checks, a proxy or a file reference (`services/pkg/cluster/exec.go:34-60`) | first | — |
| V5.3.1 | Uploaded files are not run | N/A | No route takes a file upload: a search of `services` for `multipart`, `UploadFile`, `ParseMultipartForm` and `FormFile` finds none outside tests; what is served is the image's build (`frontend/Dockerfile:20`, `frontend/nginx.conf:6`), on a read-only root filesystem (`values.yaml:791`) | first | — |
| V5.3.2 | File paths not built from a writer's names | Met | `services/k8s-service-go/internal/logfiles/paths.go:43`, `:81`, `:112`; `services/k8s-service-go/internal/recording/manager.go:140` | first | — |
| V6.1.1 | Documentation: sign-in limits, and how others cannot lock an account | Met | `docs/security-audit.md:37-45`: the gateway's sign-in rate per client address (`nginx.conf:70`, `:472`), the account lock and its settings (`services/auth-service-go/internal/handler/login_lockout.go`; `docs/audit-log-plan.md:108`), and what a person who knows an address can do: keep the password path locked 15 minutes at a time, not single sign-on, API keys or open sessions | first | — |
| V6.2.1 | Passwords of at least 8 characters | Met | `services/auth-service-go/internal/security/password.go:57-61`; default 12 (`values.yaml:61`) | first | open |
| V6.2.2 | A person can change their password | Met | `services/auth-service-go/cmd/server/routes.go:82`; `auth_user.go:534` | first | — |
| V6.2.3 | Changing it needs the current password | Met | `auth_user.go:547-550`, `:565-569` | first | open |
| V6.2.4 | New passwords checked against at least the top 3000 | Not met | Six whole values and eight fragments (`password.go:44-52`) | first | open |
| V6.2.5 | No composition rules | Met | `password.go:54-85` | first | — |
| V6.2.6 | Password fields are `type=password` | Met | `frontend/src/pages/Login.tsx:318`, `:336`; `frontend/src/pages/Account.tsx:290`, `:304`, `:318` | first | — |
| V6.2.7 | Paste and password managers work | Met | `autoComplete` on each field; no paste handler (search) | first | — |
| V6.2.8 | The password is checked exactly as typed | Met | `auth_user.go:174`; `password.go:144` | first | — |
| V6.3.1 | Controls against password guessing | Met | Account lock (`auth_user.go:157-194`); gateway rate per address (`nginx.conf:70`, `:472`) | first | — |
| V6.3.2 | No default account such as `admin`, or it is off | Not met | The first boot creates `admin` with the Admin role (`services/auth-service-go/cmd/server/main.go:393-455`); it gets a random 20 character password (`helm/kubeast/templates/secret.yaml:16`); `auth.passwordLogin: admin-only` or `off` narrows password sign-in (`values.yaml:67-70`) | first | to decide |
| V6.4.1 | First passwords random, short-lived, not kept | Partly | The first admin password and an admin's reset are random (`secret.yaml:16`; `services/auth-service-go/internal/handler/auth_admin_users.go:580-623`); neither expires or must be changed at the next sign-in | first | to decide |
| V6.4.2 | No password hints or secret questions | Met | Search of the sign-in and account pages and of `services/auth-service-go` | first | — |
| V7.2.1 | Session tokens checked on the server | Met | `services/pkg/auth/jwt.go:348-360`; `services/auth-service-go/internal/security/jwt.go:236-255`; `services/ai-service/app/security.py:291-300` | first | — |
| V7.2.2 | Tokens made per sign-in, not static keys | Met | `auth_user.go:234`; an API key is exchanged for a short token (`routes.go:35`) | first | — |
| V7.2.3 | Reference tokens with 128 random bits | Met | API keys: 32 bytes from `crypto/rand` (`services/auth-service-go/internal/handler/api_keys.go:399-403`) | first | — |
| V7.2.4 | A new token at each sign-in and re-authentication | Met | Each token issued has a new `jti` (`services/auth-service-go/internal/security/jwt.go:213`); a password sign-in (`services/auth-service-go/internal/handler/auth_user.go:246`, its cookie `:258`) and an OIDC one (`services/auth-service-go/internal/handler/oidc.go:532`) issue a new one, and a password change ends the tokens issued so far and sets a new one (`auth_user.go:605-626`). There is no session before sign-in and no second sign-in for an action: a refresh keeps `auth_time` (`auth_user.go:377`). Tests: `services/auth-service-go/cmd/server/password_change_test.go`, `e2e/tests/password-change-session.spec.ts` | first | — |
| V7.4.1 | After sign-out or expiry the session cannot be used | Met | `auth_user.go:402`, `:435`; `services/auth-service-go/internal/security/middleware.go:135-141` | first | — |
| V7.4.2 | A locked or deleted account's sessions end | Met | `services/auth-service-go/internal/repository/repository_dormant.go:68`; `middleware.go:12-16` | first | — |
| V8.1.1 | Documentation: who may use which function and data | Met | `docs/features.md:204` (the built-in roles, what they can do and who they act as in the cluster); `docs/cluster-requirements.md:51` (§1, the RBAC of each target cluster) | first | — |
| V8.2.1 | Functions need an explicit permission | Met | Each route asks its permission (for one, `auth_admin_users.go:565`); `e2e/guard/permission-matrix.spec.ts` | first | — |
| V8.2.2 | Data needs a permission for that item | Needs a test | A chat session and its messages answer their owner only and 404 to anyone else (`services/session-service-go/internal/handler/session.go:200`, `:249`, `:299`, `:361`, `:427`; listed by owner, `services/session-service-go/internal/repository/repository.go:99`); a tool approval answers its owner only (`services/ai-service/app/api.py:362`, `:406`); a drain's progress needs `resource.node.drain` on its cluster and is answered on that cluster only (`services/k8s-service-go/internal/handler/node_drain.go:120`, `:141`); recordings need `admin.sessions.read` (`services/k8s-service-go/internal/handler/recordings.go:71`). Unit tests: `services/session-service-go/internal/handler/session_audit_test.go`, `session_messages_test.go`, `services/k8s-service-go/internal/handler/node_drain_cluster_test.go`, `recordings_test.go` | first | open: an e2e spec in which one account opens a chat session, a terminal and a drain, and another account without `admin.sessions.read` or `resource.node.drain` asks for each by its id and gets a 403 or 404 with none of its data; check S-4 of the [v0.7.8 page](v0.7.8.md#plan-items-and-checks-this-page-refers-to) |
| V8.3.1 | Authorization enforced on the server | Met | The services check every request; the clusters decide again, since requests go out as the signed-in person ([v0.7.8 page](v0.7.8.md), TB5) | first | — |
| V9.1.1 | Signature checked before contents are used | Met | `services/pkg/auth/jwt.go:348-360`; `services/auth-service-go/internal/security/jwt.go:236-255`; `security.py:293-300` | first | — |
| V9.1.2 | Only listed algorithms, never `none` | Met | RS256 only (`services/pkg/auth/jwt.go:350`, `security/jwt.go:238`, `security.py:297`) | first | — |
| V9.1.3 | Keys from a trusted, configured source | Met | The JWKS address is configuration; `kid` only picks among fetched keys; no `jku`, `x5u` or `jwk` (search) | first | open |
| V9.2.1 | `exp` and `nbf` checked | Met | golang-jwt v5; PyJWT (`security.py:320`) | first | — |
| V10.4.1 to V10.4.5 | OAuth authorization server items (5) | N/A | Kubeast is an OIDC client (`services/auth-service-go/cmd/server/routes.go:22-24`), not an authorization server: it has no authorization endpoint, and `/api/v1/auth/token` exchanges an API key (`routes.go:33-35`) | first | — |
| V11.3.1 | No ECB, no weak padding | N/A | No encryption of Kubeast's own (search) | first | — |
| V11.3.2 | Only approved ciphers | N/A | As V11.3.1 | first | — |
| V11.4.1 | Only approved hash functions | Met | SHA-256, HMAC-SHA256, PBKDF2-SHA256, RS256; MD5 only as the `Content-MD5` S3 asks for | first | — |
| V12.1.1 | Only TLS 1.2 and 1.3 | Met | Kubeast ends no TLS for people: its gateway serves plain HTTP behind the install's TLS (`nginx.conf` has no `ssl` line). The TLS it opens itself has 1.2 as its floor (`services/tool-server/kubeproxy.go:82`, `services/auth-service-go/internal/auditsink/email.go:90`, `:105`, `services/k8s-service-go/internal/netflows/store.go:61`), and its other Go clients keep Go's default floor, 1.2 | first | — |
| V12.2.1 | TLS for every client connection | Met | With the defaults a browser is held to TLS: the session cookie is `Secure` (`values.yaml:70`), HSTS is sent (`nginx.conf:81`, `helm/kubeast/tests/gateway_test.yaml`), the sockets take `wss:` (V4.4.1), and the docs keep Kubeast behind TLS (`docs/configuration.md:29`). TLS itself is ended by the install's Ingress, Gateway or load balancer | first | — |
| V12.2.2 | Publicly trusted certificates | N/A | The certificate people reach is that of the install's Ingress, Gateway or load balancer; the chart's `ingress.tls` is false by default and its Secret is the install's (`values.yaml:993-994`) | first | — |
| V13.4.1 | No source control folder in what is deployed | Met | The release builds from `services`, `services/ai-service`, `frontend` and `services/model-config-controller-go` (`.github/workflows/release.yaml:41-75`), none of which holds the repository's `.git`; Go images copy their binary (`services/k8s-service-go/Dockerfile:46`, `services/tool-server/Dockerfile:47`); the frontend copies `dist` (`frontend/Dockerfile:20`, `frontend/.dockerignore:3`) | first | — |
| V14.2.1 | No sensitive data in a URL | Met | No token is taken from a query string (`services/pkg/auth/jwt.go:480-482`; `security.py:334-350`). Beside it, since the requirement is about requests to Kubeast: the Gemini connection test puts the model API key in the URL it calls at Google (`services/ai-service/app/api_public.py:137-140`); Google also takes it in the `x-goog-api-key` header | first | open (the Gemini key in a header) |
| V14.3.1 | The browser drops session data when it ends | Met | `frontend/src/components/Layout.tsx:164-165`, `frontend/src/services/auth.ts:77-97`, `frontend/src/hooks/useSignInOnSessionEnd.ts:14` | first | — |
| V15.1.1 | Documented time frames for third-party updates, by risk | Not met — planned | `SECURITY.md:13-15` (reports: an acknowledgement within 7 days, a fix or a plan within 30), `:23-24` (a release fails on a fixed CRITICAL or HIGH finding), `.github/dependabot.yml` (weekly); no time frame per risk for components | first | open: a support policy page with time frames by severity |
| V15.2.1 | Components within those time frames | Not met — planned | No time frame to compare with (V15.1.1). What holds a component back now: the release's image scan, which fails on a fixed CRITICAL or HIGH finding (`.github/workflows/release.yaml:140-146`), and CI's govulncheck, `npm audit` and `pip-audit` at high or above (`.github/workflows/ci.yaml:343-408`) | first | after V15.1.1 |
| V15.3.1 | Answers hold only the fields needed | Needs a test | The user answer has no password hash (`services/auth-service-go/internal/model/model.go:59-73`); a reader gets Secret and Helm release values masked (`e2e/tests/secret-exposure.spec.ts`); each role's screens are held to the cluster's answer (`e2e/guard/permission-matrix.spec.ts`) | first | open: a guard spec that calls every GET route `scripts/api-snapshot.sh` lists as a Read and as a namespace-limited account and holds each answer to the permission table, with no field the admin's answer does not have and no value shaped like a password, token or key; check S-5 of the [v0.7.8 page](v0.7.8.md#plan-items-and-checks-this-page-refers-to) |

## Level 2: authentication, sessions, access control, input, errors and logging, secrets and configuration

### V1 Encoding and Sanitization

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V1.1.1 | Input decoded to one canonical form once, before validation | To check | Not read | second | — |
| V1.1.2 | Encoding is the last step, or done by the interpreter | Met | React writes text when it draws; JSON by the encoder (`services/pkg/response/response.go:24`); in chat answers no step after the sanitizer adds markup (`frontend/src/components/chatMarkdown.ts:167`) | second | — |
| V1.2.6 | No LDAP injection | N/A | Search of `services`, `frontend/src`, `helm`: no LDAP | second | — |
| V1.2.7 | XPath queries parameterized | N/A | No XPath and no XML parser (search; V1.5.1) | second | — |
| V1.2.8 | LaTeX processors safe | N/A | No LaTeX or KaTeX (search, `frontend/package.json` too) | second | — |
| V1.2.9 | Special characters escaped in regular expressions | Met | Literal text is quoted before it joins a pattern: `services/k8s-service-go/internal/logsearch/query.go:132`, `:145`; `frontend/src/utils/logSearch.ts:15`; `services/k8s-service-go/internal/netdrops/netdrops.go:151-166`; `services/k8s-service-go/internal/k8s/service_backend_usage.go:87`. The regular-expression search takes the person's pattern on purpose and compiles it first (`query.go:81-84`, RE2) | second | — |
| V1.3.3 | Data for an interpreter sanitized and capped | Met | kubectl arguments held to Kubernetes' shapes (`services/tool-server/argcheck.go:1-8`); every LogQL value quoted (`query.go:115-149`) and search text capped (`query.go:78-80`); cluster text fenced before the model reads it (`services/ai-service/app/services/prompt_fence.py:15`); the mail subject encoded (`services/auth-service-go/internal/auditsink/email.go:62`). A search can miss a place | second | — |
| V1.3.4 | SVG from people sanitized | Met | No SVG is taken from people; chat answers allow no `svg` or `foreignObject` (`chatMarkdown.ts:20-24`), and `img` keeps only `src`, `alt`, `title` (`:34`) with `http` or `https` (`:44-47`) | second | — |
| V1.3.5 | Markdown and similar sanitized | Met | `frontend/src/components/chatMarkdown.ts:17-48`; `frontend/src/components/AIMarkdown.tsx:6-13` | first | — |
| V1.3.6 | Outbound requests from untrusted data held to an allow list (SSRF) | Partly | Store addresses people enter: cloud metadata, link-local, the service's own machine and addresses nothing answers on are refused (`services/pkg/storeurl/storeurl.go:41-50`, `:178`, `:219`); an allow list applies only when set (`values.yaml:860`, empty by default). Model base URLs: `http(s)`, public addresses only unless listed (`services/ai-service/app/services/model_config_policy.py:1-25`). Operator values (`gitops.argocd.url`, store URLs in values, audit sinks) are not checked | second | to decide; `networkPolicy.aiEgress.allowListOnly` (off by default, in v0.7.9 by [#917](https://github.com/junginho0901/Kubeast/pull/917)) holds the AI services' outbound connections to listed addresses |
| V1.3.7 | No templates built from untrusted input | Met | Search: no `text/template` or `html/template` in service code; Python `.format` only on the program's own strings (`services/ai-service/app/services/ai/history.py:212`, `services/ai-service/app/services/ai/optimization.py:168-210`). A Helm chart a person installs is a template by design, under the Helm permissions | second | — |
| V1.3.8 | JNDI | N/A | No Java | second | — |
| V1.3.9 | memcache | N/A | No memcache (search; `memory.NewMemCacheClient` in `services/k8s-service-go/internal/helm/getter.go:39` is client-go's discovery cache) | second | — |
| V1.3.10 | Format strings | Met | Search of Go: format strings are constants, or helpers that pass a caller's constant (`services/ci-controller-go/internal/jobspec/jobspec.go:210`, `services/deploy-service-go/internal/render/render.go:143`, `:147`); Python as V1.3.7 | second | — |
| V1.3.11 | Mail input sanitized (SMTP) | Met | Headers from the operator's settings, the subject Q-encoded (`services/auth-service-go/internal/auditsink/email.go:59-68`); the body through `net/smtp` `Data` (`:122`), which dot-stuffs lines; the summary turns control characters into spaces (`docs/audit-log-plan.md:60`) | second | — |
| V1.4.1 | Memory-safe strings and copies | Met | Go, Python, TypeScript; search of `services`: no `unsafe`, cgo or `ctypes` | second | — |
| V1.4.2 | Range checks against integer overflow | To check | One seen: line limits clamped (`query.go:105-107`) | second | — |
| V1.4.3 | No use of freed memory | Met | Garbage-collected languages; no `unsafe` or cgo (search) | second | — |
| V1.5.2 | Safe deserialization of untrusted data | Met | Search of `services`: no `pickle`, `encoding/gob`, `yaml.load(` or `marshal.loads`; bodies are JSON | second | — |

### V2 Validation and Business Logic

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V2.1.2 | Documentation: consistency of combined items | To check | No page found (as V2.1.1) | second | — |
| V2.1.3 | Documentation: limits per person and overall | Partly | Written in parts: `docs/architecture.md:145-192` (many users), `docs/features.md:441` (AI tokens per person per day); no page sets the per-person and overall limits together | second | to decide |
| V2.2.3 | Combinations of related items checked | To check | Seen: a pod and a workload exclude each other, a workload needs its namespace, start before end (`services/k8s-service-go/internal/logsearch/query.go:72`, `:75`, `:100`) | second | — |
| V2.3.2 | Limits enforced as documented | To check | Not compared (needs V2.1.3) | second | — |
| V2.3.3 | Business operations all or nothing | To check | Seen: `services/auth-service-go/internal/repository/repository_cluster_roles.go:184`, `:201`; `repository_access_requests.go:244`, `:336` (18 transactions opened in `services`) | second | — |
| V2.3.4 | Limited resources cannot be taken twice | Met | Claude Code slots are taken by a conditional UPDATE (`services/ai-service/app/services/claude_code_slots.py:70-81`) | second | — |
| V2.4.1 | Controls against excessive automated calls | Partly | Sign-in rate per address (`nginx.conf:70`, `:471-473`); AI token budgets, off by default (`values.yaml:399-401`); subscription chat slots (`services/ai-service/app/config.py:75-77`); live watches capped (`docs/architecture.md:181`, `:192`); no rate per person on the other routes | second | open |

### V3.3 Cookies (session)

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V3.3.2 | `SameSite` fits each cookie | Met | `Strict` for the session (`auth_user.go:274`), `Lax` for the OIDC state (`oidc.go:357`) | first | — |
| V3.3.3 | `__Host-` prefix unless shared with other hosts | Not met | The session cookie is `kubeast.token` (`config.go:363`) | first | to decide |
| V3.3.4 | Session token `HttpOnly` and sent only by `Set-Cookie` | Partly | `HttpOnly` is set; the sign-in and refresh answers also carry `access_token` in JSON (`auth_user.go:252-256`, `:372`; `model.go:276`) | first | to decide |

### V6 Authentication

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V6.1.2 | Documentation: a list of context words kept out of passwords | Not met | The code refuses `kubeast` and seven common words (`password.go:52`); no document lists them | first | open |
| V6.1.3 | Documentation: every sign-in path with its controls | Partly | Password sign-in (`docs/oidc.md:52`, `values.yaml:67-70`), OIDC (`docs/oidc.md`) and API keys (`docs/security-audit.md:5`) are each documented, and the sign-in limits give the rate and the lock of each (`docs/security-audit.md:37-45`); no page sets every path (V6.3.4) side by side with its factors | second | to decide |
| V6.2.9 | Passwords of at least 64 characters allowed | Met | 128 (`password.go:42`) | first | open |
| V6.2.10 | No periodic password rotation | Met | Search of `services/auth-service-go`: no password age or expiry; the dormant lock is about inactivity (`docs/security-audit.md:82-94`) | second | — |
| V6.2.11 | The documented context list is used | Partly | Used in code (`password.go:52`), not documented (V6.1.2) | first | open |
| V6.2.12 | New passwords checked against breached sets | Not met | It needs an outside source (`password.go:44-47`) | first | open |
| V6.3.3 | More than one factor | Partly | Password sign-in has one factor; with OIDC the provider decides; `auth.passwordLogin` narrows the password path (`values.yaml:67-70`) | first | to decide |
| V6.3.4 | No undocumented sign-in path; the same strength on each | To check | Paths seen: password, OIDC, API key exchange (`routes.go:35`), the investigator token for one service (`routes.go:32`), demo accounts (`values.yaml:60`, off), `reset-admin` on the server (`services/auth-service-go/cmd/server/reset_admin.go`); not compared with the docs | second | to decide |
| V6.4.3 | A reset of a forgotten password that skips no factor | Partly | No self-service reset: an admin sets a random password (`routes.go:101`; `auth_admin_users.go:580-623`) or runs `reset-admin`; there is no second factor to skip; the reset password does not expire (V6.4.1) | second | to decide |
| V6.4.4 | A lost factor needs identity proofing again | N/A | No second factor in Kubeast (search: no TOTP, WebAuthn or recovery codes) | second | — |
| V6.5.1 to V6.5.5 | One-time codes, lookup secrets, TOTP (5) | N/A | As V6.4.4 | second | — |
| V6.6.1 to V6.6.3 | Out-of-band codes by phone or SMS (3) | N/A | None (search) | second | — |
| V6.8.1 | Several identity providers: one cannot take over another's user | N/A | One OIDC issuer (`oidc.go:65`). Accounts are matched by address: `email_verified=false` is refused (`oidc.go:422-425`), the domain list applies, and a provider name that is not an address cannot take a password account (`oidc.go:192-204`) | second | — |
| V6.8.2 | Signatures on assertions validated | Met | The go-oidc verifier checks signature, issuer and audience, then the nonce (`oidc.go:403`, `:407`) | second | — |
| V6.8.3 | SAML assertions used once | N/A | No SAML | second | — |
| V6.8.4 | Strength from the identity provider (`acr`, `amr`) checked where needed | N/A | No function asks for a strength; the docs could say an OIDC sign-in counts as one factor (V6.3.3) | second | — |

### V7 Session Management

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V7.1.1 | Documentation: idle and absolute timeouts | Met | `values.yaml:51-56` (15 minutes idle, 8 hours at most) | first | — |
| V7.1.2 | Documentation: concurrent sessions per account | Met | `docs/security-audit.md:47`: no cap, a new sign-in leaves the others, sign-out ends one, a password or role change ends all | second | — |
| V7.1.3 | Documentation: session lifetimes with the identity provider | Partly | `docs/oidc.md:104` (Kubeast sign-out ends only the Kubeast session); nothing on the 8-hour limit against the provider's session | second | to decide |
| V7.3.1 | Idle timeout | Met | Token lifetime 15 minutes (`values.yaml:53`); the page refreshes it only after activity (`frontend/src/services/auth.ts:99-103`, `:125`). An open terminal, followed log or live list stays open while idle until the absolute limit, a written decision (`docs/security-audit.md:49-60`) | second | — |
| V7.3.2 | Absolute session lifetime | Met | `auth_user.go:336` (`auth.sessionAbsoluteHours`, `values.yaml:56`) | second | — |
| V7.4.3 | Option to end other sessions after a factor change | Met | A password change ends every token (`services/auth-service-go/internal/repository/repository_user.go:235`) and issues a new one (`auth_user.go:595-598`) | second | — |
| V7.4.4 | Sign-out visible on every signed-in page | Met | The layout's sign-out (`frontend/src/components/Layout.tsx:164`, `:586`) | second | — |
| V7.4.5 | Admins can end one person's or everyone's sessions | Partly | Only on the side: a role change, a password reset or deleting the account ends its tokens (`repository_user.go:186`, `:235`), and so does `reset-admin` (`reset_admin.go:121`); no action that only ends sessions, none for everyone | second | open |
| V7.5.1 | Full re-authentication before changing sign-in attributes | Met | A person can change only the password, which asks the current one (`routes.go:79-82`; `auth_user.go:547-550`); addresses are changed by admins (`routes.go:100`) | second | — |
| V7.5.2 | People see and end their active sessions | Not met | No list of a person's sessions (search of `routes.go`); sign-out ends this one, a password change ends all | second | open |
| V7.6.1 | Sessions with the identity provider behave as documented | To check | Only sign-out is documented (V7.1.3); needs a run against a provider | second | to decide |
| V7.6.2 | A new session needs the person's action | Met | OIDC sign-in starts from a link the person presses (`frontend/src/pages/Login.tsx:254`); no `prompt=none` (search) | second | — |

### V8 Authorization

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V8.1.2 | Documentation: field-level rules | Partly | Written for AI answers (`docs/features.md:63`, `:95`, `:101`) and masked Helm values (`docs/security-audit.md:220`); no table of fields by permission | second | — |
| V8.2.3 | Field-level access enforced | To check | Seen: Secret values never reach AI answers (`docs/features.md:101`); the user answer has no hash (`model.go:58-73`) | second | check S-5 of the [v0.7.8 page](v0.7.8.md#plan-items-and-checks-this-page-refers-to) |
| V8.4.1 | Operations never reach another tenant | N/A | One install serves one organization; Organization and Team are groups inside it (`docs/features.md:428`); access per cluster is V8.2.2 | second | — |

### V9.2 Token Content (session)

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V9.2.2 | A token is checked to be of the right type for its use | Met | A token exchanged for an API key carries `akid`; refresh and session-only routes refuse it (`services/auth-service-go/internal/security/jwt.go:139-142`; `routes.go:71-72`). The investigator token carries `sys` and only its read tools for one cluster (`jwt.go:146-158`). ID tokens are used only at the OIDC callback (`oidc.go:403`) | second | — |
| V9.2.3 | Only tokens meant for this service (audience) | Met | `services/pkg/auth/jwt.go:352`; `security.py:299` | first | — |
| V9.2.4 | One key for several audiences: the audience names them | N/A | One signing key and one audience for the whole app (`services/auth-service-go/internal/security/jwt.go:215`, `:240`) | second | — |

### V13 Configuration

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V13.1.1 | Documentation: every communication need | Partly | Per feature in `docs/cluster-requirements.md:20-45`; outbound rules in `values.yaml:826-860`; no single list of outbound connections (model APIs, OIDC issuer, audit sinks, S3, metric and log stores) | second | to decide |
| V13.2.1 | Service-to-service authentication without unchanging shared secrets | Partly | Requests carry the person's short token (RS256); service-only routes use shared, unchanging secrets (`INTERNAL_API_TOKEN`, `AI_APPROVAL_SECRET`), and the database and Redis use passwords (`helm/kubeast/templates/secret.yaml:77-91`) | second | to decide; open: secret length checks |
| V13.2.2 | Backend accounts with the least access they need | Partly | One Redis user per service (`values.yaml:755`); one database user, `kubeast`, for every service (`values.yaml:555`) | second | to decide |
| V13.2.3 | No default credentials between components | Met | The chart generates every password and token at install (`templates/secret.yaml:8-64`; `values.yaml:558`, `:745`); auth-service refuses the placeholder admin password outside DEBUG (`services/auth-service-go/cmd/server/main.go:394-401`) | second | see V13.4.2 |
| V13.2.4 | An allow list of outside resources | Partly | NetworkPolicy is on by default with egress per service (`values.yaml:826-827`; `helm/kubeast/templates/networkpolicy.yaml`); ai-service may reach any public address on 443 (`networkpolicy.yaml:305-317`); store hosts are listed only when set (`values.yaml:860`) | second | to decide; `networkPolicy.aiEgress.allowListOnly` (off by default, in v0.7.9 by [#917](https://github.com/junginho0901/Kubeast/pull/917)) holds the AI services' outbound connections to listed addresses |
| V13.2.5 | The server is configured with that allow list | Partly | As V13.2.4 | second | to decide; `networkPolicy.aiEgress.allowListOnly` (off by default, in v0.7.9 by [#917](https://github.com/junginho0901/Kubeast/pull/917)) holds the AI services' outbound connections to listed addresses |
| V13.3.1 | A secrets manager; no secret in code or build output | Partly | Kubernetes Secrets the chart makes; `existingSecret` lets an outside manager supply them (`values.yaml:39-50`); images copy their binaries only (V13.4.1) | second | — |
| V13.3.2 | Access to secrets: least needed | Not met | Every backend Deployment takes the whole app Secret as environment (`helm/kubeast/templates/deployments.yaml:49`, `:178`, `:278`, `:479`, `:590`, `:699`): model API keys, the OIDC client secret, the first admin password, the database password; only the Redis user passwords can be split (`values.yaml:755-770`) | second | open |
| V13.4.2 | Debug modes off in production | Partly | The chart and the Docker installer set `DEBUG` to false (`helm/kubeast/templates/configmap.yaml:10`; `install-docker.sh:113`); unset, auth-service, session-service and ai-service start with debug on (`services/auth-service-go/internal/config/config.go:327`; `services/session-service-go/internal/config/config.go:32`; `services/ai-service/app/config.py:30`), and `.env.example:26` sets it true. With debug on, auth-service starts with the placeholder admin password (`main.go:394-401`) and the cookie loses `Secure` (`config.go:364`) | second | open |
| V13.4.3 | No directory listings | Met | Search: no `autoindex` in `helm`, `frontend` or `deploy` (nginx's default is off) | second | — |
| V13.4.4 | No HTTP TRACE | Met | The gateway's nginx refuses TRACE with 405 while it reads the request (nginx `release-1.31.9` `src/http/ngx_http_request.c`; the gateway image is nginx 1.31, `values.yaml:1351`); not measured | second | — |
| V13.4.5 | Internal API docs and monitoring endpoints not exposed | Partly | The gateway routes only Kubeast's own prefixes (`nginx.conf:89-525`); ai-service keeps FastAPI's `/docs` and `/openapi.json` on (`services/ai-service/main.py:105-110`); they and `/metrics` answer on service ports inside the cluster, where only NetworkPolicy limits them | second | open |

### V16 Security Logging and Error Handling

| Req. | Asks (short) | Status | Evidence | From | Left |
| --- | --- | --- | --- | --- | --- |
| V16.1.1 | An inventory of logging at each layer | Partly | Audit records: what, format, storage, viewing and retention (`docs/audit-log-plan.md:23-92`, `:232`); the services' own logs have no inventory | second | to decide |
| V16.2.1 | Entries say when, where, who and what | Met | The audit record's fields (`docs/audit-log-plan.md:23-37`) | second | — |
| V16.2.2 | Clocks in sync; times in UTC or with an offset | Met | Audit times in UTC (`services/auth-service-go/internal/auditsink/event.go:56`, `webhook.go:225`; `services/ai-service/app/services/audit_writer.py:110`); Go logs are JSON with the zone (`services/pkg/logger/logger.go:15`); clock sync is the cluster's | second | — |
| V16.2.3 | Logs go only where the inventory says | Met | Database, stdout and configured sinks (`docs/audit-log-plan.md:38-92`); recordings (`docs/security-audit.md:183`); the model debug dump is a documented switch, off (`values.yaml:405`) | second | — |
| V16.2.4 | A common format the log processor reads | Partly | Go services log JSON (`services/pkg/logger/logger.go:15`); ai-service sets no log handler or format of its own (search: `logging.getLogger` in 17 files, no `basicConfig` or `dictConfig`; a handler only in `services/ai-service/app/services/ai/debug_dump.py:29-30`); what its lines look like under uvicorn is to check | second | to decide |
| V16.2.5 | Sensitive data logged by its protection level | Partly | Audit before and after are masked (`docs/audit-log-plan.md:18`); secret length checks, which are not written yet, would log a name and a length, not the value; on `main` some audit `Error` fields hold the database's error text, which can carry row values | second | open |
| V16.3.1 | All authentication logged, both outcomes | Met | `auth_user.go:143`, `:187`, `:249` | first | open |
| V16.3.2 | Failed authorization logged | Partly | Refused writes and sensitive acts: `k8s.access.denied` (`services/k8s-service-go/internal/handler/handler.go:180-189`); refused admin calls, reads included: `admin.access.denied` (`services/auth-service-go/internal/handler/auth_helpers.go:14-36`); refused plain reads on the clusters are not recorded (`handler.go:181-182`, a stated choice) | second | to decide |
| V16.3.3 | Documented events and attempts to get around controls logged | Partly | The catalog (`docs/audit-log-plan.md:99`); policy refusals are failure rows (`:209`); malformed requests are not recorded (`:208`); the gateway's rate refusals (429) are only in its access log (`nginx.conf:471-473`) | second | to decide |
| V16.3.4 | Unexpected errors and control failures (backend TLS) logged | To check | Not read | second | — |
| V16.4.1 | Log data encoded against injection | Partly | Go logs and audit lines are JSON (`logger.go:15`; `audit_writer.py:110`); the mail summary turns control characters into spaces (`docs/audit-log-plan.md:60`); ai-service's plain log lines as V16.2.4 | second | to decide |
| V16.4.2 | Logs protected from reading and change | Partly | The audit view needs `admin.audit.read`; a hash chain and anchors (`docs/audit-log-plan.md:72-91`); with no anchor sink, the default, someone who can write the database can recompute the chain (`:88`, a written limit) | second | — |
| V16.4.3 | Logs sent to a separate system | Partly | Each audit row is also one JSON line on stdout for the cluster's log pipeline (`docs/audit-log-plan.md:20`, `:41`); sinks are optional; the pipeline is the install's | second | — |
| V16.5.1 | A generic message on unexpected errors | Partly | Most handlers answer fixed text; granting and removing a cluster role answer with the database's error text (`services/auth-service-go/internal/handler/user_cluster_roles.go:174`, `:207`) | second | open |
| V16.5.2 | Secure operation when an outside resource fails | Met | Audit database down: changes and sensitive reads get 503 (`docs/audit-log-plan.md:19`); ai-service down: one JSON 503 (`nginx.conf:110-115`); a Redis that does not answer costs a read at most 0.5 s (#975, `main`) | second | v0.7.9 |
| V16.5.3 | Fails closed | Met | Audit is fail-closed (`docs/audit-log-plan.md:19`); a token whose version cannot be read is refused unless a recent read exists (`services/pkg/auth/token_version.go:121-128`) | second | — |

## Level 2 outside these areas, seen in the first reading

Not counted above. All from the first reading.

| Req. | Asks (short) | Status | Evidence | Left |
| --- | --- | --- | --- | --- |
| V3.4.3 | CSP with `object-src 'none'` and `base-uri 'none'` | Partly | `base-uri 'self'` (`nginx.conf:86`) | open |
| V3.4.4 | `nosniff` on every response | Met | `nginx.conf:82`; no test holds it | open |
| V3.4.5 | A referrer policy that keeps internal names from other sites | Partly | `strict-origin-when-cross-origin` (`nginx.conf:84`); Monaco opens links with `noopener` only | open |
| V3.4.6 | `frame-ancestors` on every response | Met | `nginx.conf:86`; no test holds it | open |
| V3.5.5 | `postMessage` origins checked | N/A | No `postMessage` in `frontend/src` | — |
| V3.7.2 | Redirects to other hosts only from a list | Met | After sign-in only a same-origin path is followed (`oidc.go:141-143`, `:340`) | — |
| V4.1.3 | Headers an intermediary sets cannot come from the client | Met | `nginx.conf:28-32`, `:101` | — |
| V4.4.2 | WebSocket Origin checked | Met | `services/k8s-service-go/internal/ws/origin.go:40` | — |
| V10.2.1 | PKCE | Met | `oidc.go:338` | — |
| V10.5.1 | Nonce | Met | `oidc.go:359` | — |
| V14.3.2 | `Cache-Control: no-store` on sensitive answers | Not met | Only the event streams (`no-cache`) and the probe (`no-store`, `services/pkg/probe/probe.go:152`) | open |
| V17.1.1 to V17.3.2 | WebRTC (7) | N/A | No WebRTC in `frontend/src` or `services` | — |

## Keeping it

- Read again against the tree that is tagged, with line numbers moved; where a status changes, the threat model page of that release says why.
- The `frontend/src` lines of first-reading rows are read again against the merged v0.8.0 screens (see "Code read" above).
- Level 1 rows that are Partly or Not met become changes or written decisions before the tag; level 2 stays a list.
- The screen rows are held by e2e where the release plan says so (response headers, no script run where text is drawn).
