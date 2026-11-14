# 14 — control: no fault right after a normal rollout

Group: control. Cluster `self`. This is the case that checks that looking at what changed first does not turn every recent change into a cause.

Asks (EN gloss): specific "people say order processing got slow — what's the cause?" (false report); vague "anything wrong in shop-14 right now? if so, the cause too".

Setup: a healthy namespace. Five minutes in, `orders` is rolled out to a new release (only `RELEASE` changes, with a change-cause annotation, as a release tool would leave it). The rollout completes; the new pods log their start and serve as before.

What the AI has to notice:
- There is a fresh rollout, and `timeline` shows it at the top.
- storefront's `duration_ms` for orders is the same before and after it; no errors, no restarts, no Warning events.
- A change that is not followed by a symptom is not a cause.

The trap: "orders was just deployed → the deploy made it slow".

How the scorer judges: correct only with `no_fault: true` and no cause of a kind other than `none`. Naming the orders rollout (kind `rollout`) is a made-up cause. Mentioning the rollout in `ruled_out` is good.

Unsure:
- During the rolling update a request can land on a terminating pod and fail once; with `terminationGracePeriodSeconds: 1` and a readiness probe this should be rare. If the first run shows any storefront error around the rollout, the case is no longer a clean control: either add a preStop sleep or accept "one transient error" in the truth.
- The image does not change (only an env value), so the release looks lighter than a real one; a second image tag known to be on both kind clusters would make it more realistic.
