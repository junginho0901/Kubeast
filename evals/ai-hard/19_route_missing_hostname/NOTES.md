# 19 — traffic moved to a new edge whose routes lack the main hostname

Group: hidden cause. Cluster `self` (events, logs and object specs only).

Asks (EN gloss): specific "www.shop.example returns 404 — why?"; vague "people say the shop-19 site won't open, find the cause".

Setup: two edge proxies run the same small router (`edge-server`'s `index.cgi`): it reads the request's `Host`, looks it up in its mounted `routes.conf` and forwards, or answers 404 with `flags=NR` (no route), one access line per request. `edge-legacy` reads `edge-legacy-routes` (`www.shop.example`, `help.shop.example`); the new `edge` reads `edge-routes` (`preview.shop.example`, the name it was tried out with, and `help.shop.example`). The Service `frontdoor` selects `edge-legacy`. `visitor` (users) opens both sites through `frontdoor` every 2 s; `uptime-probe` checks the new edge through its own Service with `preview.shop.example` and logs a passing summary every minute. Gateway API is not on the dev clusters, so a routes ConfigMap stands in for an HTTPRoute's `hostnames`.

The fault: the cut-over: `frontdoor`'s selector is switched to `edge`. From then on every `www.shop.example` request gets 404; `help.shop.example` keeps working; `storefront` sees fewer requests and nothing else.

What the AI has to notice:
- The 404 comes from the edge, not from `storefront` (Ready, no errors; the edge's access line says `flags=NR upstream=-`).
- `frontdoor` now selects `edge`, and `edge-routes` has no `www.shop.example` line while `edge-legacy-routes` has one.
- The probe that keeps passing checks a different hostname.

The trap: blame `storefront` ("returns 404"), the old edge, DNS, or stop at "the Service selector changed" without what is missing in the new routes.

How the scorer judges: cause = the ConfigMap `edge-routes` with kind `config_change`. `frontdoor` and `edge` may be named beside it (`also_ok`); alone they miss the missing hostname. `storefront`, `edge-legacy` and `helpdesk` are decoys. Path: `edge-routes` first, `frontdoor` (or the visitor) last. Start time ±2 min of the selector patch.

Unsure:
- A selector patch makes no event; the change shows in `frontdoor`'s managedFields time and in when the edge logs begin. A view of recent changes that reads managedFields would see it.
- busybox httpd runs `cgi-bin/index.cgi` for `/` and passes `Host` as `HTTP_HOST`; wget sends the given `Host` header (checked in a local busybox 1.38.0 container, not on kind).
- The edge copies its CGI from a ConfigMap at start, so a change to `edge-server` needs a restart; nothing in the case changes it.
