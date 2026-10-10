# Action suite (opt-in)

Every catalogued UI action — 92 of them: deletes of every resource kind the UI lists, in-place YAML edits,
rollbacks, Helm upgrade/rollback/uninstall, node cordon/drain, and the admin pages (teams, users, roles,
clusters, model configs, access requests, own password, logout, registration) — performed **through the real UI** against a
seeded target cluster and verified with `kubectl` against that cluster or with the app's API.

It is **not part of the default `npx playwright test` run**: it takes about 12 minutes on top of the regular
suite, needs a second kind cluster with seed objects, and mutates that cluster heavily. Run it before a
release or after a large UI change.

```bash
cd e2e
E2E_ACTIONS=1 npx playwright test --project=actions                      # seed + all 92 actions
                                                                         # (the 2 access-request actions pass as skipped when ACCESS_REQUESTS_ENABLED is off)
E2E_ACTIONS=1 E2E_ACTIONS_ONLY=cm-delete,helm-rollback npx playwright test --project=actions
E2E_ACTIONS=1 npx playwright test --project=actions --list               # the catalogue
```

`E2E_ACTIONS=1` adds two projects to `playwright.config.ts`: `actions-seed` (runs `seed/seed.sh`) and
`actions` (depends on `setup` for the admin session and on `actions-seed`). Without the variable the config
is unchanged, so `npx playwright test` keeps running only the regular suite. `E2E_ACTIONS_SEED=0` reuses the
previous seed (handy while iterating on admin-page drivers that do not consume seed objects).

Two things the drivers rely on: the `actions` project sets `actionTimeout`/`navigationTimeout` (Playwright
Test defaults both to unlimited, so a missing element would otherwise eat the whole test timeout), and
Monaco editors are filled through the clipboard (typing is auto-indented by Monaco; the select-all chord
follows the page's user agent, which under the `Desktop Chrome` device is Windows → Ctrl).

## Prerequisites

| What | Default | Why |
| --- | --- | --- |
| Kubeast on the gateway (`E2E_BASE_URL`, default `http://localhost:30080`) with the admin login the regular suite uses (`E2E_USER_EMAIL` / `E2E_USER_PASSWORD`) | — | the drivers run as admin through `.auth/user.json` |
| A kind cluster to seed (`E2E_ACTIONS_KIND`) registered in Kubeast under the id `E2E_ACTIONS_CLUSTER` | `test2` / `test2` | every action runs on this cluster; `?cluster=` in each URL |
| Gateway API v1.3.0 experimental CRDs and the VPA CRDs installed on that cluster; Kubernetes ≥ 1.34 (DRA built in) | — | the seed creates GatewayClass/Gateway/HTTPRoute/GRPCRoute/ReferenceGrant/BackendTLSPolicy, a VPA, and DRA objects |
| A second kind cluster not registered in Kubeast (`E2E_ACTIONS_EXTRA_KIND`) | `kubeast-np` | `cluster-register` / `cluster-delete`; skipped when it does not exist |
| `kind`, `kubectl`, `helm`, `python3` on PATH | — | `seed/seed.sh` |

The seed writes `seed/.kubeconfig-<kind>` from `kind get kubeconfig` and the drivers use only that file
(`E2E_ACTIONS_KUBECONFIG` overrides the path). The shell's own `KUBECONFIG` is never used, so a kubeconfig
that points at a real cluster cannot be touched by accident.

## What a test does

For each key in `support/drivers.ts` (`support/` rather than `lib/` because the repository ignores `lib/` directories): open the page on the target cluster → perform the action in the UI →
record the API calls the page made (POST/PUT/PATCH/DELETE and every 4xx/5xx; successful GETs only for the
sensitive reads: Secret YAML/describe, logs), console errors, uncaught page errors, dialog/toast texts →
run the driver's `verify()` (kubectl or API) → attach `action.json` and an `after.png` screenshot → assert:
the UI flow completed, no uncaught page errors, `verify().ok`.

Confirmations are the app's own windows (`acceptConfirm` clicks them; nothing auto-accepts a browser dialog), and
the delete window of a system object (CRD, Node, objects in the system namespaces …) asks for the name before
Delete turns on — `confirmDialog(page, re, name)` types it when the window shows the name field. A PR that changes
a flow a driver walks runs those drivers (`E2E_ACTIONS_ONLY=…`) even when the whole suite is not due.

Order matters and is fixed in `ORDER`: reads and in-place edits first, then namespace create/delete, then
every delete (a deleted seed object cannot be read afterwards), Helm uninstall, the admin pages, and the
drivers that need their own session last. Tests in this file run serially in that order (`workers: 1`).

Drivers that would change the signed-in user's own session — `account-password-change`, `logout`,
`register` — run in a second browser context as a temporary user created and deleted through the admin API,
so the shared admin session stays valid. The admin-page drivers create their own objects (`qa-team-<stamp>`,
`qa-user-<stamp>@example.com`, `qa-role-<stamp>`, `qa-model-<stamp>`, `qa-extra-<stamp>`) and remove them.

## Origin

Ported from the QA sweep runner used for the 2026-10 hardening QA (90 drivers, 93 actions of the 115-action
coverage skeleton). The runner compared the hardened build with the pre-hardening one and recorded results
to JSON; that comparison axis is not part of this suite — here each action is a pass/fail test with its
evidence attached to the HTML report.
