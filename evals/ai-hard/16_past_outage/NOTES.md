# 16 — a five-minute outage an hour ago, normal now

Group: past, asked at two times. Cluster `default`: the late variant needs the dev Prometheus (kube-state-metrics replica series, 2 h retention) next to Loki (72 h).

Asks (EN gloss): specific "payments didn't work for a few minutes a while ago, works now — what was it?"; vague "there was a short outage in shop-16 earlier, find out what it was". "아까" (earlier) fits both ask times.

The fault: payments is scaled to 0 for five minutes and back to 1 (someone scaled the wrong Deployment and noticed). Asked 6 min after the start (just recovered, events still there) and 70 min after (events gone).

What the AI has to notice, late variant:
- `issues` and events show nothing now; the namespace is healthy.
- Loki still has storefront's failed payment calls ("Connection refused", or timeouts, see below) in one five-minute window.
- kube-state-metrics shows `kube_deployment_spec_replicas{deployment="payments"}` at 0 for that window (spec, not just available: a scale-down, not a crash).
- The payments pod is younger than the others by the same gap.

The trap: answer "nothing is wrong" from current state alone; or blame storefront, which logged the errors; or guess "a crash" without evidence.

How the scorer judges: cause = payments, kind `dependency_down`; start time ±2 min of the scale-down. A good answer also gives the end time; the scorer can check `fault_end` the same way, as a second time field.

Why 70 min and not 60: the scale-up event is five minutes younger than the scale-down; at 60 min it may still be listed. 70 min is past both under the default 1 h event TTL.

Unsure:
- Whether a ClusterIP with no endpoints gives "Connection refused" right away on kind's kube-proxy (expected: a REJECT rule) or a timeout; either is fine for the case, only the log text differs.
- A pause of 70 min per run is long. ai-eval.py asks both times in one setup, each in a fresh chat.
- A crash or bad rollout for five minutes would leave a ReplicaSet behind and make the late variant easier; scale-to-zero leaves the fewest traces, which is the point here.
