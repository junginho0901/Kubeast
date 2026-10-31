#!/usr/bin/env bash
# Writes frontend/src/utils/cron.cases.json: the next run of each case (cases.py) as kube-controller-manager computes
# it, with the robfig/cron version Kubernetes v1.37 requires (go.mod: github.com/robfig/cron/v3 v3.0.1). Needs Go and
# Python 3.9+; the module is built in a temporary directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$here/../../frontend/src/utils/cron.cases.json
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$here/main.go" "$tmp/"
(cd "$tmp" && go mod init cronoracle >/dev/null 2>&1 && go get github.com/robfig/cron/v3@v3.0.1 >/dev/null 2>&1 && go build -o oracle .)
# one case per line: [zone, schedule, from, next]
python3 "$here/cases.py" | "$tmp/oracle" | python3 -c '
import json, sys
rows = [json.dumps([c["zone"], c["schedule"], c["from"], c["next"]], ensure_ascii=False) for c in map(json.loads, sys.stdin)]
print("{\"generated_by\": \"scripts/cron-cases/run.sh (robfig/cron v3.0.1, the version Kubernetes v1.37 requires)\",")
print("\"cases\": [\n" + ",\n".join(rows) + "\n]}")
' > "$out"
echo "$(python3 -c "import json;print(len(json.load(open('$out'))['cases']))") cases -> $out"
