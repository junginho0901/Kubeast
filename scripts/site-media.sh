#!/usr/bin/env bash
# Record the clips of the project site (site/) on the dev kind clusters and write site/media/<name>.mp4 and a
# poster <name>.jpg (its last frame); the floating-chat clip also becomes docs/images/floating-chat.gif, the README's
# picture. Each clip is one e2e/demo/<name>.demo.ts; the shop in e2e/demo/shop.yaml
# and a Helm release of e2e/demo/chart with three revisions are put on the second cluster for the run and removed
# after (helm.spec.ts expects no release there). For "changes" the shop of e2e/demo/shop-traffic.yaml, whose
# workloads talk to each other, is put on the Cilium cluster of scripts/kind-cilium.sh (Resource Graph traffic
# lines) and removed after. Dev data only.
#
#   scripts/site-media.sh                 # every clip
#   scripts/site-media.sh logs helm       # only these
#
# Needs ffmpeg (brew install ffmpeg), the dev clusters of scripts/kind-deploy.sh with the second cluster's add-ons,
# and E2E_USER_EMAIL / E2E_USER_PASSWORD as for the e2e. The AI clips need a default model that answers well:
# scripts/kind-model-subscription.sh up <token-file> before, down after.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECOND="${SECOND_CLUSTER:-kubeast-b}"
CILIUM="${CILIUM_CLUSTER:-kubeast-cilium}"
CLIPS="$ROOT/e2e/test-results/clips"
MEDIA="$ROOT/site/media"

command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (brew install ffmpeg)" >&2; exit 1; }

kc="$(mktemp)"
ckc="$(mktemp)"
cleanup() {
  helm --kubeconfig "$kc" -n shop uninstall storefront-settings >/dev/null 2>&1 || true
  kubectl --kubeconfig "$kc" delete namespace shop --ignore-not-found --wait=false >/dev/null
  if [ -s "$ckc" ]; then kubectl --kubeconfig "$ckc" delete namespace shop --ignore-not-found --wait=false >/dev/null; fi
  rm -f "$kc" "$ckc"
}
trap cleanup EXIT
kind get kubeconfig --name "$SECOND" > "$kc"
kubectl --kubeconfig "$kc" apply -f "$ROOT/e2e/demo/shop.yaml" >/dev/null
for set in "" "--set theme=dark" "--set theme=dark --set checkoutV2=true"; do
  # shellcheck disable=SC2086 # each entry is a list of flags
  helm --kubeconfig "$kc" -n shop upgrade --install storefront-settings "$ROOT/e2e/demo/chart" $set >/dev/null
done
kubectl --kubeconfig "$kc" -n shop rollout status deploy/storefront --timeout 120s >/dev/null

# "changes" draws the traffic between the shop's workloads: on the Cilium cluster, with a rollout for Change History
if { [ $# -eq 0 ] || printf '%s\n' "$@" | grep -x changes >/dev/null; } && kind get clusters | grep -x "$CILIUM" >/dev/null; then
  kind get kubeconfig --name "$CILIUM" > "$ckc"
  kubectl --kubeconfig "$ckc" apply -f "$ROOT/e2e/demo/shop-traffic.yaml" >/dev/null
  for d in storefront checkout-api recommendations payments; do
    kubectl --kubeconfig "$ckc" -n shop rollout status "deploy/$d" --timeout 120s >/dev/null
  done
  kubectl --kubeconfig "$ckc" -n shop rollout restart deploy/checkout-api >/dev/null
  kubectl --kubeconfig "$ckc" -n shop rollout status deploy/checkout-api --timeout 120s >/dev/null
  sleep 30 # flows between them for the graph
fi

args=()
for name in "$@"; do args+=("demo/$name.demo.ts"); done
status=0
(cd "$ROOT/e2e" && E2E_DEMO=1 npx playwright test --project=demo ${args[@]+"${args[@]}"}) || status=$?

mkdir -p "$MEDIA"
for raw in "$CLIPS"/*.webm; do
  [ -e "$raw" ] || continue
  name="$(basename "$raw" .webm)"
  keep=""
  while read -r from to; do keep="${keep:+$keep+}between(t,$from,$to)"; done < "$CLIPS/$name.parts"
  ffmpeg -y -loglevel error -i "$raw" -an \
    -vf "fps=25,select='$keep',setpts=N/FRAME_RATE/TB,scale=1280:-2" \
    -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "$MEDIA/$name.mp4"
  ffmpeg -y -loglevel error -sseof -0.2 -i "$MEDIA/$name.mp4" -frames:v 1 -q:v 4 "$MEDIA/$name.jpg"
  if [ "$name" = floating-chat ]; then
    ffmpeg -y -loglevel error -i "$MEDIA/$name.mp4" -loop 0 \
      -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
      "$ROOT/docs/images/$name.gif"
  fi
  echo "$name: $(du -h "$MEDIA/$name.mp4" | cut -f1)"
done

# Each clip's step marks (the scripts' c.step) into site/media/steps.js; clips not recorded this run keep theirs.
python3 - "$CLIPS" "$MEDIA/steps.js" <<'EOF'
import glob, json, os, sys
clips, out = sys.argv[1], sys.argv[2]
marks = {}
if os.path.exists(out):
    text = open(out).read()
    marks = json.loads(text[text.index('{'):text.rindex('}') + 1])
for f in sorted(glob.glob(os.path.join(clips, '*.steps.json'))):
    marks[os.path.basename(f)[:-len('.steps.json')]] = json.load(open(f))
with open(out, 'w') as fh:
    fh.write('// Step marks of each clip in seconds, from the recording scripts (scripts/site-media.sh writes this).\n')
    fh.write('window.KUBEAST_STEPS = ' + json.dumps(marks, indent=2, sort_keys=True) + ';\n')
EOF
exit "$status"
