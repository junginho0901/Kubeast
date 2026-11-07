// A tool reaches the cluster through kubectl, where a screen goes through a route that asks a permission first. This
// table says, per tool, what that route asks: a role holding ai.tool.* does not get past it through the AI, however
// much its group is bound in the cluster. A list or detail asks resource.objects.read, as k8s-service's read gate does;
// what has no object in its answer asks nothing. ai-service keeps the same table
// (app/services/ai/screen_permissions.py); TestToolScreenCasesFixture writes the cases both run.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/util/yaml"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// toolRule gives the permissions a screen asks for one call of a tool.
type toolRule func(args map[string]interface{}) []string

func asksNothing(map[string]interface{}) []string { return nil }

// listsAndDetails is what the read gate on k8s-service's lists and details asks.
func listsAndDetails(map[string]interface{}) []string { return []string{auth.PermObjectsRead} }

// alsoGlobal is a cluster's key whose route also answers an all-cluster key (k8s-service hygieneReadAllowed; ai-service ALSO_GLOBAL).
var alsoGlobal = map[string]string{"resource.hygiene.scan": "admin.hygiene.read"}

func holdsForTool(payload auth.TokenPayload, permission, clusterID string) bool {
	if payload.HasPermissionForCluster(permission, clusterID) {
		return true
	}
	global, ok := alsoGlobal[permission]
	return ok && payload.HasPermission(global)
}

func always(permissions ...string) toolRule {
	return func(map[string]interface{}) []string { return permissions }
}

// forResourceType asks the verb on every kind the resource_type argument names.
func forResourceType(verb string) toolRule {
	return func(args map[string]interface{}) []string {
		return kindPermissions(resourceTypeNames(argString(args, "resource_type", "")), verb)
	}
}

// forManifest asks the verb on the kind of every object in the manifest, read as kubectl reads it.
func forManifest(verb string) toolRule {
	return func(args map[string]interface{}) []string {
		manifest, err := manifestFromArgs(args)
		if err != nil {
			return kindPermissions([]string{"*"}, verb)
		}
		objects, ok := readManifest(manifest)
		if !ok {
			return kindPermissions([]string{"*"}, verb)
		}
		names := make([]string, 0, len(objects))
		for _, o := range objects {
			names = append(names, resourcePermName(strings.ToLower(o.kind)))
		}
		return kindPermissions(names, verb)
	}
}

// rolloutRule: undo is the rollback button, status and history read what a screen reads, the others change the object.
func rolloutRule(args map[string]interface{}) []string {
	switch strings.ToLower(strings.TrimSpace(argString(args, "action", ""))) {
	case "undo":
		return []string{"resource.workload.rollback"}
	case "status", "history":
		return listsAndDetails(args)
	}
	return forResourceType("edit")(args)
}

// A tool that is not here is refused to everyone: TestEveryToolIsInTheTableAndHasACase makes a new tool say what it asks.
var toolScreenTable = map[string]toolRule{
	"k8s_get_resources":              listsAndDetails,
	"k8s_get_resource_yaml":          listsAndDetails,
	"k8s_describe_resource":          listsAndDetails,
	"k8s_get_events":                 listsAndDetails,
	"get_cluster_overview":           listsAndDetails,
	"get_node_metrics":               listsAndDetails,
	"get_pod_metrics":                listsAndDetails,
	"k8s_check_service_connectivity": listsAndDetails,
	"k8s_find_resource":              listsAndDetails,
	"prometheus_query":               listsAndDetails,
	"prometheus_metrics":             listsAndDetails,
	"prometheus_labels":              listsAndDetails,
	"prometheus_rules":               listsAndDetails,
	"prometheus_targets":             listsAndDetails,
	"traces_search":                  listsAndDetails,
	"traces_get":                     listsAndDetails,
	"traces_tags":                    listsAndDetails,
	"traces_metrics":                 listsAndDetails,
	"traces_compare":                 listsAndDetails,
	"issues":                         listsAndDetails,
	"gitops_status":                  listsAndDetails,
	"optimization":                   listsAndDetails,
	"resource_graph":                 listsAndDetails,
	"k8s_jq_query":                   listsAndDetails,
	"k8s_tabular_query":              listsAndDetails,
	"k8s_count":                      listsAndDetails,
	"pod_rbac":                       listsAndDetails,
	"storage_summary":                listsAndDetails,
	"limit_range_violations":         listsAndDetails,
	"timeline":                       listsAndDetails,
	"gpu":                            listsAndDetails,

	// No object in the answer, as the routes that read none: the kinds a cluster serves, its version, can-i.
	"k8s_get_available_api_resources": asksNothing,
	"k8s_get_cluster_configuration":   asksNothing,
	"k8s_explain":                     asksNothing,
	"can_i":                           asksNothing,
	// The picker asks for a sign-in only; auth-service answers the caller's own clusters.
	"clusters_list": asksNothing,

	"alert_investigate":        always("resource.alert.investigate", "resource.pod.read"),
	"k8s_get_pod_logs":         always("resource.pod.read"),
	"alerts_list":              always("resource.pod.read"),
	"alerts_inbox":             always("resource.pod.read"),
	"logfiles":                 always("resource.pod.logfile"),
	"logsearch":                always("resource.pod.read"),
	"loki_query":               always("resource.pod.read"),
	"loki_labels":              always("resource.pod.read"),
	"loki_patterns":            always("resource.pod.read"),
	"policy_reports":           always("resource.policyreport.read"),
	"helm_read":                always("resource.helm.read"),
	"cost":                     always("resource.cost.read"),
	"network_policy_check":     always("resource.networkpolicy.read"),
	"network_policy_effective": always("resource.networkpolicy.read"),
	"network_flows":            always("resource.networkflow.read"),
	"network_drops":            always("resource.networkflow.read"),
	"network_top_flows":        always("resource.networkflow.read"),
	"hygiene":                  always("resource.hygiene.scan"),
	"audit_search":             always("admin.audit.read"),
	"nodes_stats_summary":      always("admin.nodes.read"),
	"nodes_log":                always("admin.nodes.read"),
	"access_review":            always("admin.review.read"),
	"ai_usage":                 always("admin.audit.read"),
	"access_requests":          always("admin.users.update"),
	"audit_integrity":          always("admin.audit.read"),
	"hygiene_history":          always("resource.hygiene.scan"),
	"investigations":           always("admin.investigations.read"),
	"ai_models":                always("admin.ai_models.*"),
	"session_recordings":       always("admin.sessions.read"),

	"k8s_delete_resource":   forResourceType("delete"),
	"k8s_patch_resource":    forResourceType("edit"),
	"k8s_annotate_resource": forResourceType("edit"),
	"k8s_remove_annotation": forResourceType("edit"),
	"k8s_label_resource":    forResourceType("edit"),
	"k8s_remove_label":      forResourceType("edit"),
	"k8s_scale":             forResourceType("edit"),
	"k8s_rollout":           rolloutRule,
	"k8s_execute_command":   always("resource.pod.exec"),
	"k8s_cordon_node":       always("resource.node.cordon"),
	"k8s_cronjob_suspend":   always("resource.cronjob.suspend"),
	"k8s_cronjob_trigger":   always("resource.cronjob.trigger"),
	"k8s_create_resource":   forManifest("create"),
	// A screen's apply patches what exists; what kubectl apply would create is applyCreateGate's.
	"k8s_apply_manifest": forManifest("edit"),
	"k8s_diff":           forManifest("edit"),
}

// toolAppPermissions is what a screen asks for this call; listed is false for a tool nobody decided.
func toolAppPermissions(tool string, args map[string]interface{}) (permissions []string, listed bool) {
	rule, listed := toolScreenTable[tool]
	if !listed {
		return nil, false
	}
	return rule(args), true
}

func toolScreenTableNames() []string {
	names := make([]string, 0, len(toolScreenTable))
	for name := range toolScreenTable {
		names = append(names, name)
	}
	return names
}

// kindPermissions is resource.<name>.<verb> for each name, once each, sorted. "*" is resource.*.<verb>, every kind.
func kindPermissions(names []string, verb string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(names))
	for _, name := range names {
		permission := "resource." + name + "." + verb
		if !seen[permission] {
			seen[permission] = true
			out = append(out, permission)
		}
	}
	sort.Strings(out)
	return out
}

// Names kubectl expands to several kinds, some of them only known to the cluster: those need every kind.
var kubectlCategories = map[string]bool{"all": true, "api-extensions": true, "gateway-api": true}

// resourceTypeNames is the permission name of every kind a kubectl resource argument names: any case, the singular,
// plural or short form, with a version or group behind it, several separated by commas. As on the screens the kind
// decides, not the group. What cannot be read is every kind.
func resourceTypeNames(resourceType string) []string {
	var names []string
	for _, one := range strings.Split(resourceType, ",") {
		name, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(one)), ".")
		if name == "" || kubectlCategories[name] {
			return []string{"*"}
		}
		names = append(names, resourcePermName(name))
	}
	return names
}

// resourceSpellings: the other names kubectl takes for a kind with a permission name of its own. Without its line here
// such a kind would count as customresource when spelled that way; TestEveryPermissionNameHasItsSpellings holds that.
var resourceSpellings = map[string][]string{
	"pod": {"pods", "po"}, "deployment": {"deployments", "deploy"}, "statefulset": {"statefulsets", "sts"}, "daemonset": {"daemonsets", "ds"},
	"replicaset": {"replicasets", "rs"}, "job": {"jobs"}, "cronjob": {"cronjobs", "cj"},
	"service": {"services", "svc"}, "endpoints": {"ep"}, "endpointslice": {"endpointslices"}, "ingress": {"ingresses", "ing"},
	"ingressclass": {"ingressclasses"}, "networkpolicy": {"networkpolicies", "netpol"},
	"configmap": {"configmaps", "cm"}, "secret": {"secrets"}, "serviceaccount": {"serviceaccounts", "sa"},
	"role": {"roles"}, "rolebinding": {"rolebindings"}, "clusterrole": {"clusterroles"}, "clusterrolebinding": {"clusterrolebindings"},
	"namespace": {"namespaces", "ns"}, "node": {"nodes", "no"}, "storageclass": {"storageclasses", "sc"}, "volumeattachment": {"volumeattachments"},
	"resourcequota": {"resourcequotas", "quota"}, "limitrange": {"limitranges", "limits"}, "priorityclass": {"priorityclasses", "pc"},
	"runtimeclass": {"runtimeclasses"}, "lease": {"leases"},
	"mutatingwebhookconfiguration": {"mutatingwebhookconfigurations"}, "validatingwebhookconfiguration": {"validatingwebhookconfigurations"},
	"validatingadmissionpolicy": {"validatingadmissionpolicies"}, "validatingadmissionpolicybinding": {"validatingadmissionpolicybindings"},
	"mutatingadmissionpolicy": {"mutatingadmissionpolicies"}, "mutatingadmissionpolicybinding": {"mutatingadmissionpolicybindings"},
	"gateway": {"gateways", "gtw", "gw"}, "gatewayclass": {"gatewayclasses", "gc"}, "httproute": {"httproutes"}, "grpcroute": {"grpcroutes"},
	"referencegrant": {"referencegrants", "refgrant"}, "backendtlspolicy": {"backendtlspolicies", "btlspolicy"},
	"deviceclass": {"deviceclasses"}, "resourceclaim": {"resourceclaims"}, "resourceclaimtemplate": {"resourceclaimtemplates"}, "resourceslice": {"resourceslices"},
	"policyreport": {"policyreports", "polr"}, "cost": {}, "networkflow": {},
	"hpa": {"horizontalpodautoscaler", "horizontalpodautoscalers"}, "vpa": {"verticalpodautoscaler", "verticalpodautoscalers"},
	"pdb": {"poddisruptionbudget", "poddisruptionbudgets"}, "pv": {"persistentvolume", "persistentvolumes"},
	"pvc": {"persistentvolumeclaim", "persistentvolumeclaims"}, "crd": {"crds", "customresourcedefinition", "customresourcedefinitions"},
}

var permNameOfSpelling = func() map[string]string {
	out := map[string]string{}
	for name, spellings := range resourceSpellings {
		out[name] = name
		for _, spelling := range spellings {
			out[spelling] = name
		}
	}
	return out
}()

func resourcePermName(lowered string) string {
	if name, ok := permNameOfSpelling[lowered]; ok {
		return name
	}
	return "customresource"
}

const (
	// Past these a manifest counts as unreadable, which asks for every kind.
	manifestReadMaxBytes   = 256 << 10
	manifestReadMaxDepth   = 8
	manifestReadMaxObjects = 2000
)

type manifestObject struct {
	kind, apiVersion, name, generateName, namespace string
}

// readManifest is every object of a manifest, read by the decoder kubectl uses so both see the same documents. ok is
// false when any of it cannot be read, or nothing is there.
func readManifest(manifest string) (objects []manifestObject, ok bool) {
	if len(manifest) > manifestReadMaxBytes {
		return nil, false
	}
	decoder := yaml.NewYAMLOrJSONDecoder(strings.NewReader(manifest), 4096)
	for {
		var doc map[string]interface{}
		err := decoder.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return objects, len(objects) > 0
		}
		if err != nil {
			return nil, false
		}
		if doc == nil {
			continue
		}
		if objects, ok = appendManifestObjects(objects, doc, 0); !ok {
			return nil, false
		}
	}
}

// appendManifestObjects flattens a document as kubectl does: anything with items is a list (kubectl's detector reads
// the key in any case), and an item without a kind takes its list's.
func appendManifestObjects(objects []manifestObject, doc map[string]interface{}, depth int) ([]manifestObject, bool) {
	if depth > manifestReadMaxDepth || len(objects) > manifestReadMaxObjects {
		return nil, false
	}
	kind, _ := doc["kind"].(string)
	apiVersion, _ := doc["apiVersion"].(string)
	isList := false
	for key, value := range doc {
		if !strings.EqualFold(key, "items") || value == nil {
			continue
		}
		items, ok := value.([]interface{})
		if !ok {
			return nil, false
		}
		isList = true
		for _, item := range items {
			object, ok := item.(map[string]interface{})
			if !ok {
				return nil, false
			}
			if itemKind, _ := object["kind"].(string); itemKind == "" {
				object["kind"] = strings.TrimSuffix(kind, "List")
				if _, has := object["apiVersion"]; !has {
					object["apiVersion"] = apiVersion
				}
			}
			if objects, ok = appendManifestObjects(objects, object, depth+1); !ok {
				return nil, false
			}
		}
	}
	if isList && strings.HasSuffix(kind, "List") {
		return objects, true
	}
	if kind == "" {
		return nil, false
	}
	meta, _ := doc["metadata"].(map[string]interface{})
	name, _ := meta["name"].(string)
	generateName, _ := meta["generateName"].(string)
	namespace, _ := meta["namespace"].(string)
	return append(objects, manifestObject{kind, apiVersion, name, generateName, namespace}), true
}

// applyCreateGate: kubectl apply creates what is not there. A screen asks the create permission for that and the edit
// permission only for what exists (its apply is a patch), so a caller without create may apply to what exists only.
// Whoever holds create is not asked to wait for a lookup.
func applyCreateGate(ctx context.Context, headers http.Header, manifest string) error {
	payload, _ := auth.FromContext(ctx)
	clusterID := clusterIDFromCtx(ctx)
	objects, ok := readManifest(manifest)
	if !ok {
		if required := "resource.*.create"; !payload.HasPermissionForCluster(required, clusterID) {
			return fmt.Errorf("%w: k8s_apply_manifest may create objects and this manifest cannot be read to tell which, which needs the permission %s in cluster %s; your role there does not hold it", errForbidden, required, clusterID)
		}
		return nil
	}
	for _, o := range objects {
		required := "resource." + resourcePermName(strings.ToLower(o.kind)) + ".create"
		if payload.HasPermissionForCluster(required, clusterID) {
			continue
		}
		label := strings.TrimSpace(o.kind + " " + o.name)
		exists, err := manifestObjectExists(ctx, headers, o)
		if err != nil {
			return fmt.Errorf("%w: could not tell whether %s exists, and creating it needs the permission %s in cluster %s; your role there does not hold it", errForbidden, label, required, clusterID)
		}
		if !exists {
			return fmt.Errorf("%w: %s does not exist, and creating it needs the permission %s in cluster %s; your role there does not hold it", errForbidden, label, required, clusterID)
		}
	}
	return nil
}

// manifestObjectExists looks the object up as the caller. The names come from the manifest and land in argv, so they
// pass the checks every other argv value does.
func manifestObjectExists(ctx context.Context, headers http.Header, o manifestObject) (bool, error) {
	if o.name == "" {
		return false, nil
	}
	if err := checkKindName("kind", o.kind); err != nil {
		return false, err
	}
	if err := checkAPIVersion("apiVersion", o.apiVersion); err != nil {
		return false, err
	}
	if err := checkObjectName("name", o.name); err != nil {
		return false, err
	}
	cmd := []string{"get", qualifiedType(o.kind, o.apiVersion), o.name, "-o", "name"}
	if o.namespace != "" {
		if err := checkDNSLabel("namespace", o.namespace); err != nil {
			return false, err
		}
		cmd = append(cmd, "-n", o.namespace)
	}
	_, err := runKubectl(ctx, headers, cmd...)
	if err == nil {
		return true, nil
	}
	if f, classified := classifyKubectlFailure(err); classified && f.Status == "not_found" {
		return false, nil
	}
	return false, err
}
