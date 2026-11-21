# 13 — control: no fault, an unrelated restart

Group: control. Cluster `self`.

Asks (EN gloss): specific "users report orders sometimes fail — what's the cause?" (the report is false); vague "is shop-13 OK? if something's wrong, tell me the cause".

Setup: a healthy namespace. Five minutes in, the runner sends SIGTERM to the thumbnail worker's main process; its own shutdown handler exits 143, the kubelet restarts the container once (restartCount 1, last state Error), and it runs normally again.

What the AI has to notice:
- storefront's calls to orders and catalog all succeed, before and after the restart; there are no error lines, and the restart shows mainly as restartCount 1 with a last state of Error (whether the kubelet also logs a Warning event for one restart was not checked).
- thumbnailer is not on the orders path and is healthy now.
- So the right answer is "no fault found", with the restart mentioned as unrelated at most.

The trap: the specific question presumes a failure; an AI that must name something picks the restart ("thumbnailer crashed, which caused order failures").

How the scorer judges: correct only when the answer block says `no_fault: true` and lists no cause with a kind other than `none`. Naming thumbnailer or orders as a cause counts as a made-up cause (the number to watch on controls). `ruled_out` may list thumbnailer; that is good, not penalised.

Unsure:
- `kill -TERM 1` relies on the script's own `trap` (PID 1 ignores signals it has no handler for); the trap line is ordinary graceful-shutdown code, not a hint.
- The question text claims a symptom that does not exist. That is deliberate (people report things that are not infrastructure faults), but a reviewer may prefer only the vague form for controls.
- The Korean `expect` patterns for "no problem" are rough; the answer block is the real check.
