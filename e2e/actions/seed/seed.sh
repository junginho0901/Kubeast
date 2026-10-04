#!/usr/bin/env bash
# Seed/reset for the action suite's target cluster (kind, default test2): recreate namespace qa-sweep from
# seed.yaml, install one Helm release (a tiny chart rendered inline — two revisions, so rollback has
# something to go back to) and wait for the workloads. Writes an explicit kubeconfig from
# `kind get kubeconfig` and uses only that — never the ambient one.
#
#   TARGET_KIND=test2 KUBECONFIG_OUT=./.kubeconfig-test2 bash seed.sh
set -eu
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
CLUSTER=${TARGET_KIND:-test2}
HERE=$(cd "$(dirname "$0")" && pwd)
KC=${KUBECONFIG_OUT:-$HERE/.kubeconfig-$CLUSTER}
kind get kubeconfig --name "$CLUSTER" > "$KC"
export KUBECONFIG=$KC
k() { kubectl "$@"; }
echo "== $(date -u +%FT%TZ) seed on kind $CLUSTER ($(k config current-context))"
if k get ns qa-sweep >/dev/null 2>&1; then
  k delete ns qa-sweep --wait=true --timeout=120s >/dev/null && echo "  old qa-sweep removed"
fi
k delete ns qa-sweep-2 --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
# The Gateway API (v1.3.0 experimental-install.yaml) and VPA (vpa-v1-crd-gen.yaml) CRDs must already be on
# the target cluster; DRA is built in on K8s >= 1.34.
for crd in gatewayclasses.gateway.networking.k8s.io backendtlspolicies.gateway.networking.k8s.io verticalpodautoscalers.autoscaling.k8s.io; do
  k get crd "$crd" >/dev/null 2>&1 || echo "  !! CRD $crd missing — Gateway/VPA seed objects will fail (see README)"
done
k apply -f "$HERE/seed.yaml" >/dev/null && echo "  seed.yaml applied ($(grep -c '^kind:' "$HERE/seed.yaml") objects)"
# the CRD must be established before its instance can be created
k wait --for=condition=Established crd/widgets.qa.example.com --timeout=60s >/dev/null
k apply -f - >/dev/null <<'EOF'
apiVersion: qa.example.com/v1
kind: Widget
metadata: { name: qa-widget, namespace: qa-sweep }
spec: { color: blue }
EOF
# A Helm release the Helm screens can show/upgrade/rollback/uninstall.
CH=$HERE/.chart-qa; rm -rf "$CH"; mkdir -p "$CH/templates"
cat > "$CH/Chart.yaml" <<'EOF'
apiVersion: v2
name: qa-chart
version: 0.1.0
appVersion: "1"
EOF
cat > "$CH/values.yaml" <<'EOF'
replicas: 1
message: rev1
EOF
cat > "$CH/templates/deploy.yaml" <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: qa-release, labels: { app: qa-release } }
spec:
  replicas: {{ .Values.replicas }}
  selector: { matchLabels: { app: qa-release } }
  template:
    metadata: { labels: { app: qa-release }, annotations: { message: {{ .Values.message | quote }} } }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 100m, memory: 64Mi } }
EOF
cat > "$CH/templates/cm.yaml" <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-release-cm }
data: { message: {{ .Values.message | quote }} }
EOF
helm upgrade --install qa-release "$CH" -n qa-sweep --set message=rev1 >/dev/null
helm upgrade qa-release "$CH" -n qa-sweep --set message=rev2 >/dev/null
echo "  helm release qa-release revision $(helm list -n qa-sweep -o json | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["revision"])')"
k -n qa-sweep rollout status deploy/qa-web --timeout=120s >/dev/null && echo "  qa-web ready"
k -n qa-sweep wait --for=condition=Ready pod/qa-pod --timeout=120s >/dev/null && echo "  qa-pod ready"
echo "  objects: $(k -n qa-sweep get all,cm,secret,ing,hpa,pvc,sa,role,rolebinding,quota,limitrange,netpol,pdb,lease --no-headers 2>/dev/null | wc -l | tr -d ' ')"
echo "== done $(date -u +%FT%TZ)"
