#!/usr/bin/env bash
# Rebuilds schemas.tar.gz from the releases named in sources.txt: the
# Kubernetes kinds from yannh/kubernetes-json-schema, the custom resources
# converted from their release CRDs with kubeconform's openapi2jsonschema.py.
# Not run by CI; run it when a newer release comes out, then run the tests.
# Needs curl and python3 (it makes a virtualenv for PyYAML in a temp dir).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 -m venv "$work/venv"
"$work/venv/bin/pip" -q install pyyaml
grep -v '^#' "$here/sources.txt" | while read -r file url; do
  [ -n "$file" ] || continue
  case "$file" in
    crd:*) curl -sSfL -o "$work/${file#crd:}.yaml" "$url" ;;
    tool:openapi2jsonschema.py) curl -sSfL -o "$work/openapi2jsonschema.py" "$url" ;;
    *) curl -sSfL -o "$work/$file" "$url" ;;
  esac
done

mkdir -p "$work/crds"
(cd "$work/crds" && FILENAME_FORMAT='{kind}-{group}-{version}' "$work/venv/bin/python" "$work/openapi2jsonschema.py" "$work"/*.yaml >/dev/null)
for f in httproute-gateway-v1 externalsecret-external-secrets-v1 servicemonitor-monitoring-v1; do
  cp "$work/crds/$f.json" "$work/"
done

# Sorted names, mtime 0 and gzip mtime 0: the same inputs give the same bytes.
"$work/venv/bin/python" - "$work" "$here/schemas.tar.gz" <<'PY'
import gzip, io, os, sys, tarfile
src, out = sys.argv[1], sys.argv[2]
names = sorted(n for n in os.listdir(src) if n.endswith(".json"))
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
    for n in names:
        data = open(os.path.join(src, n), "rb").read()
        ti = tarfile.TarInfo(n)
        ti.size, ti.mtime, ti.mode = len(data), 0, 0o644
        tf.addfile(ti, io.BytesIO(data))
with open(out, "wb") as f, gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0, compresslevel=9) as gz:
    gz.write(buf.getvalue())
print(len(names), "schemas,", os.path.getsize(out) // 1024, "KB")
PY
