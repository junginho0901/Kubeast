# 11 — two unrelated faults at once

Group: trap, in the hidden set (`hidden: true`). Cluster `self` (events, objects and logs only).

Asks (EN gloss): specific "product images don't show and orders fail in shop-11 — why?"; vague "things are going wrong all over the shop-11 site, find the cause".

Setup: `storefront` loads a thumbnail from `images` and places an order through `orders` every 3 s, logging each result. `orders` checks stock at `inventory` (through the Service `inventory`, selector `app: inventory, version: v1`) on every order and answers 502 when it cannot. `images` uses the `Recreate` strategy.

The faults, both at the same moment:
- `images` is rolled out with an image tag that does not exist (`busybox:1.38.0-r2`). Recreate stops the old pod first; the new one stays in ImagePullBackOff, so thumbnails fail (no endpoints).
- The Service `inventory` is switched to `version: v2`, a version not deployed; the v1 pods keep running and Ready, but the Service has no endpoints, so orders' stock checks fail and storefront's orders get 502.

What the AI has to notice:
- Two symptoms with two separate paths: storefront → images, and storefront → orders → inventory. Neither explains the other.
- `images` has a pod in ImagePullBackOff since its rollout (the loud one, first in any issue list).
- `inventory`'s pods are fine; its Service selects no pod since its selector changed (the quiet one: no pod event, only the Service's spec, its managedFields time and its empty endpoints).

The trap: find the image pull failure, explain everything with it and stop; or blame orders or inventory's pods for the 502s.

How the scorer judges: both causes must be named — `images` (Deployment, ReplicaSet or pod) with kind `image` or `rollout`, and the Service `inventory` (or its Endpoints/EndpointSlice) with kind `config_change` or `dependency_down`. Naming one is a fail. storefront, orders and inventory's Deployment are decoys. Path: only storefront is required (the path field holds one chain). Start time ±2 min of the change, for each cause.

Unsure:
- Not run on kind. The pull of a tag that does not exist goes to Docker Hub every back-off; behind a TLS-inspecting proxy without its CA the error text differs (a certificate error), the pod state is the same.
- In local busybox 1.38.0 containers (Docker, not kind) orders answered 200 with inventory up and `HTTP/1.1 502 Bad Gateway` once inventory's name no longer resolved, its CGI's error line reaching the container log; with no endpoints behind the Service on kind the stock check fails by connection instead, which takes the same branch.
- Both faults use the same first symptom shape in storefront's log (a failed request); the case relies on the two upstream names to tell them apart.
