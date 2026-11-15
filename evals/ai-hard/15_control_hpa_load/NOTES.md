# 15 — control: load rises, the HPA handles it

Group: control, in the hidden set (`hidden: true`). Cluster `default`: the HPA needs metrics-server, and the AI's CPU and request-rate evidence comes from the dev Prometheus (cAdvisor, kube-state-metrics).

Asks (EN gloss): specific "people say api got a bit slower — what's the cause?"; vague "is shop-15 OK? if not, the cause too".

Setup: `api` (hashes 2 MB per request; requests 50m, limit 500m) with an HPA (1–4 pods, 60% CPU). The traffic comes from a `gateway` in a second namespace `edge`, standing in for users outside the asked namespace (the case's `setup_cmds` and `cleanup_cmds` make and remove it by name; no case number and no `kubeast.io/ai-eval` label on it). Five minutes in, the runner scales gateway from 1 to 5, about five times the request rate.

What the AI has to notice:
- api's request rate and CPU went up; the HPA scaled it out within a couple of minutes; its events give the reason.
- No errors, no restarts, no throttling (the limit is ten times the request); latency changes little.
- That is the autoscaler doing its job, not a fault.

The trap: call the traffic rise or the scale-out a cause; or report "CPU above target" as a problem.

How the scorer judges: correct only with `no_fault: true` and no cause of a kind other than `none`. The HPA, api or gateway named as a cause is a made-up cause. It checks that ranking what is unusual does not turn normal change into a fault.

Unsure:
- All numbers need a first measured run: 2 MB per request, 1 s between gateway calls and 5 gateway pods are guesses meant to give ~25% CPU before and ~100–150% after (desired 2–3 pods). If the baseline already scales, lower the work or the rate.
- The second namespace sits outside the runner's one-namespace model; `setup_cmds` and `cleanup_cmds` carry it, with `$CASE_DIR` for `edge.yaml`.
- A small rise in latency may not appear at all with this much headroom; the case still works as a control without it.
