# shellcheck shell=bash
# Sourced by scripts/kind-cilium.sh, kind-retina.sh and kind-calico.sh (not run on its own); uses their NAME,
# NAMESPACE, RELEASE, ROOT, main_kubectl and main_helm. Each of them adds its cluster to features.networkFlows.clusters
# and turns the feature on. So that down leaves the feature as it was before up, up notes in the ConfigMap
# kind-networkflows (Kubeast's namespace) its cluster ID under its cluster name and, for the first of them,
# features.networkFlows.enabled as it was (enabled-before). down takes its cluster out and, once no noted cluster is
# left in features.networkFlows.clusters, puts enabled back to that value and removes the ConfigMap; with nothing
# noted (down without up, or an up from before this record) it turns the feature off only when no cluster is left.
# The record is kept in the dev install, not in the checkout, so a down from another worktree finds it; a noted
# cluster no longer in the release's values counts as gone, so an up that failed or a reinstall leaves nothing behind.
FLOWS_RECORD=kind-networkflows

flows_record() { # the record's data, {} when there is none
  local cm
  cm=$(main_kubectl -n "$NAMESPACE" get configmap "$FLOWS_RECORD" --ignore-not-found -o json)
  if [ -n "$cm" ]; then jq -c '.data // {}' <<<"$cm"; else echo '{}'; fi
}

flows_write() { # the record's data becomes $1
  jq -n --arg n "$FLOWS_RECORD" --argjson d "$1" '{apiVersion: "v1", kind: "ConfigMap", metadata: {name: $n}, data: $d}' \
    | main_kubectl -n "$NAMESPACE" apply -f - >/dev/null
}

flows_up() { # before up's helm upgrade adds cluster $1
  local values record
  values=$(main_helm get values "$RELEASE" --all -o json)
  record=$(flows_record)
  flows_write "$(jq -nc --argjson v "$values" --argjson r "$record" --arg name "$NAME" --arg id "$1" '
    ($v.features.networkFlows // {}) as $f | ($f.clusters // {}) as $in
    | ($r | del(.["enabled-before"]) | with_entries(select(.value as $c | $in | has($c)))) as $noted
    | (if ($noted | length) > 0 then $r["enabled-before"]   # an up came first (this one, run again, too): its value
       elif ($in | has($id)) then null                      # in already with nothing noted: not known
       else (($f.enabled // false) | tostring) end) as $before
    | $noted + {($name): $id} + (if $before == null then {} else {"enabled-before": $before} end)')"
}

flows_down() { # down: cluster $1 (empty when no longer registered) out, enabled as it was before the first up
  local values record plan sets
  values=$(main_helm get values "$RELEASE" --all -o json)
  record=$(flows_record)
  plan=$(jq -nc --argjson v "$values" --argjson r "$record" --arg name "$NAME" --arg id "$1" '
    ($v.features.networkFlows // {}) as $f | ($f.clusters // {}) as $in | ($f.enabled // false) as $on
    | (if $id != "" then $id else ($r[$name] // $name) end) as $key
    | ($in | del(.[$key])) as $left
    | ($r | del(.["enabled-before"], .[$name]) | with_entries(select(.value as $c | $left | has($c)))) as $others
    | (if ($others | length) > 0 then $on                 # another noted cluster is still in: left as it is
       elif ($r | has("enabled-before")) then ($r["enabled-before"] == "true")
       elif ($left | length) == 0 then false
       else $on end) as $want
    | {set: ([if ($in | has($key)) then "features.networkFlows.clusters.\($key)=null" else empty end]
             + [if $want != $on then "features.networkFlows.enabled=\($want)" else empty end] | join(",")),
       record: (if ($others | length) > 0 then $others + ($r | with_entries(select(.key == "enabled-before"))) else null end)}')
  sets=$(jq -r '.set' <<<"$plan")
  if [ -n "$sets" ]; then
    echo "═══ Kubeast: ${sets//,/ } ═══"
    main_helm upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values --set "$sets" \
      --wait --timeout 5m | grep -E "REVISION|STATUS"
  fi
  if [ "$(jq -c '.record' <<<"$plan")" = null ]; then
    main_kubectl -n "$NAMESPACE" delete configmap "$FLOWS_RECORD" --ignore-not-found >/dev/null
  else
    flows_write "$(jq -c '.record' <<<"$plan")"
  fi
}
