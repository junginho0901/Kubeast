# 04 — a NetworkPolicy blocks A → B

Group: hidden cause. Cluster `self`: kind's kindnet enforces NetworkPolicy since kind 0.24 (the repo's CLAUDE.md says so for `network-policy-check.spec.ts`).

Asks (EN gloss): specific "storefront can't load the product list — why?"; vague "the site in shop-04 is acting up, find the cause".

What the AI has to notice:
- Only storefront → catalog fails (wget "download timed out"); storefront → reviews keeps working.
- catalog pods are Running and Ready, no restarts, its Service has endpoints, and catalog's own log shows nothing (the packets never arrive).
- The new policy `allow-from-gateway` selects every `tier: backend` pod, so it also isolates reviews; reviews survives only because the older `allow-same-namespace` adds an allow for it (policies add up). The AI has to read both and see that nothing admits storefront to catalog.
- `network_policy_check` from `deployment/shop-04/storefront` to `service/shop-04/catalog` answers it in one call, if the AI thinks of it.

The trap: "both sides look healthy", so blame catalog ("not responding") or the network in general.

How the scorer judges: the one cause is the NetworkPolicy `allow-from-gateway` with kind `network_policy`. Naming catalog or `allow-same-namespace` as a cause is a wrong extra (decoy). Start time ±2 min of the apply. Path needs the policy first and storefront last.

Unsure:
- No readiness probe on catalog on purpose: whether kindnet's policy also drops the kubelet's probes was not checked, and a NotReady catalog would turn this into a different, easier case.
- Creating a NetworkPolicy makes no event, so today's `timeline` cannot show the change; only the policy's creation time can. That is the point of the case, but it also means a view of recent changes should list NetworkPolicy creations.
- The policy name says "allow"; that is realistic (it was meant to let a gateway in) and not a hint at the fault, but a reviewer may want a blander name.
