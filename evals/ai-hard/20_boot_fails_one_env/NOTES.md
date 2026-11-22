# 20 — a new release boots only with one environment's settings

Group: hidden cause, asked at two times (5 min and 65 min after the rollout). Cluster `self` (events, logs, ReplicaSets and object specs only).

Asks (EN gloss): specific "shop-web doesn't open at all — why?"; vague "people say the shop-20 site is down, find the cause".

Setup: the app's code is a release ConfigMap mounted at `/app` (`boot.sh` and `VERSION`), the case's stand-in for a new image tag, since the cases use one image. `shop-web` (production settings, `APP_ENV=production`, 3 pods, strategy `Recreate`) runs release 2.3.0. `preview-web` (`APP_ENV=staging`, 1 pod) has run 2.4.0 since setup. Both read their env file from `shop-web-config`; only `staging.conf` has `asset_host` (added when 2.4.0 was tried on preview). `visitor` opens both every few seconds.

The fault: `shop-web` is rolled to release 2.4.0 (volume and version label). 2.4.0 builds its asset manifest URL from `asset_host`; with production's settings that is `/manifest-2.4.0.json`, and boot stops: `level=fatal msg="unable to load application" err="invalid asset manifest url: /manifest-2.4.0.json"`. `Recreate` has already removed the 2.3.0 pods, so the site is fully down and the new pods crash-loop.

What the AI has to notice:
- The outage started with the rollout to 2.4.0 (new ReplicaSet, revision, version label); the crash is in the previous container log.
- The same release runs on `preview-web`; the difference is the env file: `production.conf` has no `asset_host`.
- At 65 min the rollout events are gone; the ReplicaSets' creation times and revisions, and the restart count, still date it.

The trap: blame `assets` (the URL mentions the manifest), call it a plain crash with no change behind it, or name `preview-web` because it is "the 2.4.0 one"; at 65 min, answer from the crash loop alone without the rollout.

How the scorer judges: cause = what changed — the rollout of `shop-web` to 2.4.0: the Deployment or its ReplicaSet, the release ConfigMap `shop-web-release-2-4-0`, or the env file ConfigMap `shop-web-config` that lacks `asset_host` — with kind `rollout` or `config_change`. `crash` is not taken: it is what the pod list shows, so the Deployment with `crash` (or a pod alone) is the symptom, not the cause. The pods may be named beside the cause (`also_ok`). `preview-web` and `assets` are decoys. Path: `shop-web` first, its Service (or the visitor) last. Start time ±2 min of the patch. The prose check asks for `asset_host` or the manifest, and for the release or the rollout.

Why the Deployment still counts: the release is part of its pod template, so the Deployment is the object that changed; what tells "its rollout broke it" from "it crashes" is the kind. The release objects alone (ReplicaSet and ConfigMap only) would fail the most natural right answer, the Deployment with `rollout`.

Unsure:
- `Recreate` is what makes this a full outage; with a rolling update and a readiness probe the old pods would have stayed. That is the realistic part (the outage needs the missing safety net too), but a reviewer may prefer a rolling update without a readiness probe, which races.
- The fatal line names the URL, not the missing key; the AI has to read the two env files to connect them.
- The BackOff events stay fresh at 65 min, so the case is about dating the change, not about finding the crash.
