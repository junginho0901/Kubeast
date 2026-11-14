# 18 — a service moved namespace, the frontend still calls the old address

Group: hidden cause, in the hidden set (`hidden: true`). Cluster `self` (events, logs and object specs only).

Asks (EN gloss): specific "people can't sign in: after signing in they get the sign-in page again — why?"; vague "there's a problem with the shop-18 site, find the cause".

Setup: `accounts` runs in two namespaces: its old home `members-18` (made and removed by the runner's `setup_cmds` and `cleanup_cmds`, as `edge-15` in case 15) and its new home `shop-18`. `visitor` (a browser stand-in) signs in through `accounts` in `shop-18`, then opens `web`'s account page with the session cookie. `web` checks the session server-side at `ACCOUNTS_INTERNAL_URL` from its ConfigMap `web-settings`, which still names `accounts.members-18.svc.cluster.local`. Until the move finishes the old copy answers, so everything works.

The fault: the move finishes: the old Deployment and Service in `members-18` are deleted. Within the DNS cache time `web`'s lookups fail with "bad address". `web` treats any failed lookup as "not signed in": it logs `user=anonymous` and draws the sign-in form, with no error line.

What the AI has to notice:
- Sign-ins succeed (`accounts` in `shop-18` logs them); only the page after sign-in fails.
- `web` logs no error, only `user=anonymous` from the moment of the change; its startup line and its ConfigMap name the `members-18` address.
- `members-18` holds no `accounts` any more (deletion events there for an hour); the `accounts` in `shop-18` gets sign-ins but no session lookups.

The trap: blame `accounts` (it is where sign-in lives), cookies, or DNS in general; or answer "no errors anywhere, nothing is wrong" from `web`'s quiet log.

How the scorer judges: cause = `web-settings` (or `web` itself) with kind `config_change`, `dns` or `dependency_down`. The old Service, Deployment or namespace in `members-18` may be named beside it (`also_ok`); alone they miss what has to change. `accounts` in `shop-18` and CoreDNS are decoys. Start time ±2 min of the deletion.

Unsure:
- A swallowed error is the point of the case; the startup line that names the address is the one hint a real app often also gives. Without it the AI must read the ConfigMap, which is still within its tools.
- The deletion of the old copy is in another namespace, where a namespace-scoped look at `shop-18` does not reach. The question names `shop-18` only.
- kind's CoreDNS caches answers for 30 s; `inject_wait` gives three minutes.
- busybox httpd passes `Cookie` to the CGI as `HTTP_COOKIE` and wget sends a given `Host`/`Cookie` header (checked in a local busybox 1.38.0 container, not on kind).
