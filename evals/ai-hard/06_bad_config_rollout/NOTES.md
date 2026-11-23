# 06 — a bad ConfigMap rollout, only new pods fail

Group: hidden cause, asked at two times (5 min and 65 min after the change). Cluster `default`.

Asks (EN gloss): specific "price lookups at checkout sometimes fail — why?"; vague "people say payment is acting strange in shop-06".

The fault: a new ConfigMap `pricing-settings-9b2c1` (adds `FX_REFRESH_SECONDS`, and changes `TAX_RATE_BP` from `1000` to `0.10`) and a rollout of `pricing` to it. `minReadySeconds: 120` holds the old pods, and the runner pauses the rollout once the two surge pods exist, so 4 old + 2 new pods serve together for as long as the case lives (a canary step that was never promoted).

What the AI has to notice:
- checkout sees HTTP 500 on roughly one call in three, not all of them.
- The 500s come only from the two pods of the new ReplicaSet ("invalid TAX_RATE_BP '0.10'"); the four old pods answer.
- The new ReplicaSet points at a different ConfigMap; the value changed unit (basis points → a fraction).

The trap: call `pricing` broken as a whole, or blame checkout; or stop at "pricing returns 500" without the change that made it.

How the scorer judges: cause = the new ConfigMap with kind `config_change`; the pricing rollout (Deployment or new ReplicaSet) with kind `rollout` is accepted as the same cause. The path must pass through the new ReplicaSet (the "only new pods" step). Start time ±2 min of the patch.

Unsure:
- That busybox httpd hands the container's environment to the CGI script (it should; if not, the script must read a file written at start).
- That busybox httpd turns a CGI `Status: 500` header into the response code.
- The pause is a visible clue ("a rollout is paused"); without it the rollout would finish after `minReadySeconds` and the 65-min variant would show all pods failing.
- The log line names the key, which makes the case easier than a real app that only says "internal error"; a harder variant would log less.
