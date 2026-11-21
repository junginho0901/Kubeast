# 12 — a loud old decoy, a quiet config change

Group: trap. Cluster `self` (events and logs only).

Asks (EN gloss): specific "adding to the cart doesn't work — why?"; vague "the shop-12 site has a problem, find the cause".

Setup: `notifier` crash-loops from the start with a DNS-looking error ("lookup smtp.mail.internal: no such host"). The case waits 10 minutes so the decoy is clearly older (about six restarts) than the real fault.

The fault: `storefront-config` is edited in place with `kubectl patch` (cart path `/api/v1/cart` → `/api/v2/cart`). No rollout, no new pod, no event. storefront mounts the ConfigMap as a volume and re-reads it every loop, so within a minute or two its cart calls get HTTP 404.

What the AI has to notice:
- The symptom is cart 404s from storefront, starting minutes ago; the crash loop began long before and has nothing to do with cart.
- Nothing rolled out. The change is only in the ConfigMap: its data, its managedFields time, and the `last-applied-configuration` annotation that still holds the old URL (a real clue, as on any cluster where someone patched an applied object).
- cart still serves `/api/v1/cart` as it always did.

The trap: `issues` ranks the CrashLoopBackOff first; an AI that stops there names notifier (or "DNS"). Second trap: blame cart for the 404s.

How the scorer judges: cause = ConfigMap `storefront-config`, kind `config_change`. notifier or cart as a cause = decoy penalty. Start time ±2 min of the patch (the first 404 can lag the patch by up to the kubelet's ConfigMap sync, about a minute).

Unsure:
- The kubelet's ConfigMap volume refresh delay on kind was not measured; `inject_wait` allows 4 minutes.
- Whether today's `timeline` shows anything for a ConfigMap edit (it should not; a view of recent changes that reads managedFields times would). That is why this case measures such a view.
- busybox httpd `-vv` output format for the 404 lines on cart.
