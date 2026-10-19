// Tool arguments come from the model. kubectl (pflag) reads flags anywhere
// on the command line before "--", so a value such as "--kubeconfig=…" in a
// positional slot would be parsed as a flag, not as a name. Every argument
// that lands in argv is therefore checked against the shape Kubernetes gives
// it (RFC 1123 names, qualified label keys, a fixed set of verbs) before
// kubectl runs; anything else is a 400. Values that kubectl reads from stdin
// or as the value of a flag (manifests, patches, exec command after "--") are
// not argv positions and are left to the cluster.

package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	dns1123LabelFmt     = `[a-z0-9]([-a-z0-9]*[a-z0-9])?`
	dns1123SubdomainFmt = dns1123LabelFmt + `(\.` + dns1123LabelFmt + `)*`
	qualifiedNameFmt    = `([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]`

	dns1123LabelMaxLength     = 63
	dns1123SubdomainMaxLength = 253
	qualifiedNameMaxLength    = 63
	labelValueMaxLength       = 63
)

var (
	dns1123LabelRe     = regexp.MustCompile(`^` + dns1123LabelFmt + `$`)
	dns1123SubdomainRe = regexp.MustCompile(`^` + dns1123SubdomainFmt + `$`)
	qualifiedNameRe    = regexp.MustCompile(`^` + qualifiedNameFmt + `$`)
	labelValueRe       = regexp.MustCompile(`^(` + qualifiedNameFmt + `)?$`)
	// A kubectl resource argument: type, type.group or type.version.group,
	// optionally several separated by commas (kubectl get pods,services).
	// kubectl matches kinds case-insensitively ("Pod"), so case is free here.
	resourceTypeSegFmt = `[A-Za-z0-9]([-A-Za-z0-9]*[A-Za-z0-9])?(\.[A-Za-z0-9]([-A-Za-z0-9]*[A-Za-z0-9])?)*`
	resourceTypeRe     = regexp.MustCompile(`^` + resourceTypeSegFmt + `(,` + resourceTypeSegFmt + `)*$`)
	timeoutRe          = regexp.MustCompile(`^[0-9]+(ms|s|m|h)$`)
	// kubectl logs --since: a relative duration such as 5s, 2m, 3h or 1h30m.
	sinceRe = regexp.MustCompile(`^([0-9]+(s|m|h))+$`)
	// kubectl explain argument: a type, optionally followed by a dotted field path.
	explainResourceRe = regexp.MustCompile(`^[A-Za-z0-9]([-A-Za-z0-9]*[A-Za-z0-9])?(\.[A-Za-z0-9_-]+)*$`)
	apiVersionRe      = regexp.MustCompile(`^([a-z0-9]([-a-z0-9.]*[a-z0-9])?/)?v[0-9]+((alpha|beta)[0-9]+)?$`)
	kindNameRe        = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*$`)
	// A k8s_find_resource query: a name fragment, or key=value for a label.
	findQueryRe = regexp.MustCompile(`^[A-Za-z0-9._/-]+(=[A-Za-z0-9._-]*)?$`)
	// Event field selectors: key(=|==|!=)value pairs separated by commas; the keys
	// are the ones the events API accepts as field selectors.
	eventSelectorKeys = map[string]bool{
		"involvedObject.kind": true, "involvedObject.namespace": true, "involvedObject.name": true,
		"involvedObject.uid": true, "involvedObject.apiVersion": true, "involvedObject.resourceVersion": true,
		"involvedObject.fieldPath": true, "reason": true, "reportingComponent": true, "source": true, "type": true,
	}

	rolloutActions = map[string]bool{"restart": true, "undo": true, "pause": true, "resume": true, "status": true, "history": true}
	patchTypes     = map[string]bool{"json": true, "merge": true, "strategic": true}
	outputFormats  = map[string]bool{"json": true, "yaml": true, "wide": true, "name": true}
	// Output formats that take an inline expression; the *-file variants read
	// files from the tool-server container and are not accepted.
	outputPrefixes = []string{"jsonpath=", "jsonpath-as-json=", "custom-columns=", "go-template="}
)

// argCheck validates one argument value.
type argCheck func(field, value string) error

// argRules maps a tool argument name to its check. Only arguments that reach
// argv are listed; the handlers read the same names.
var argRules = map[string]argCheck{
	"resource_type":  checkResourceType,
	"resource_name":  checkObjectName,
	"pod_name":       checkObjectName,
	"service_name":   checkObjectName,
	"service":        checkObjectName,
	"name":           checkObjectName,
	"namespace":      checkDNSLabel,
	"container":      checkDNSLabel,
	"output":         checkOutput,
	"action":         checkRolloutAction,
	"patch_type":     checkPatchType,
	"timeout":        checkTimeout,
	"since":          checkSince,
	"field_selector": checkFieldSelector,
	"kind":           checkKindName,
	"query":          checkFindQuery,
	"resource":       checkExplainResource,
	"api_version":    checkAPIVersion,
	"grep":           checkGrep,
	// Feature tools (k8s-service, never argv): still one printable line each.
	"promql":        checkPromQL,
	"text":          checkSearchText,
	"pod":           checkObjectName,
	"workload_kind": checkKindName,
	"workload_name": checkObjectName,
	"severity":      checkSeverity,
	"what":          checkEnum("list", "get", "values", "manifest", "notes", "hooks", "history", "resources", "images", "diff", "revision"),
	"view":          checkEnum("summary", "results"),
	"section":       checkEnum("manifest", "values", "notes", "hooks"),
	"aggregate":     checkEnum("namespace", "controller"),
	"window":        checkEnum("1h", "6h", "12h", "24h", "48h", "7d", "14d", "30d"),
	"release":       checkObjectName,
	"status":        checkLowerWord,
	"policy":        checkQualifiedPath,
	"search":        checkSearchText,
	"results":       checkWordList,
	"severities":    checkWordList,
	"check":         checkLowerWord,
	"verb":          checkLowerWord,
	"group":         checkAPIGroup,
	// Query tools: a jq program, custom columns, a sort/group path, selectors.
	"jq":             checkJQ,
	"columns":        checkColumns,
	"sort_by":        checkFieldPath,
	"group_by":       checkFieldPath,
	"label_selector": checkLabelSelector,
	// Argo CD, the audit log and node internals.
	"project":               checkObjectName,
	"destination_namespace": checkDNSLabel,
	"audit_action":          checkAuditAction,
	"actor_email":           checkPrintable(200),
	"target_id":             checkPrintable(200),
	"result":                checkEnum("success", "failure"),
	"since_time":            checkFromTime,
	"until_time":            checkRFC3339,
	"node":                  checkObjectName,
	"rank_by":               checkEnum("memory", "cpu", "ephemeral_storage"),
	"source":                checkLogSource,
	"pattern":               checkPrintable(200),
	// Prometheus discovery: a series selector, a label name, a rule name, a job.
	"selector":  checkPromQL,
	"label":     checkPromLabel,
	"rule":      checkPrintable(200),
	"rule_type": checkEnum("alert", "record"),
	"health":    checkEnum("up", "down", "unknown"),
	"job":       checkPrintable(200),
	// LogQL (the selector of loki_patterns is the "selector" rule above).
	"logql": checkLogQL,
	// TraceQL and the trace tools.
	"traceql":  checkTraceQL,
	"trace_id": checkTraceID,
	"scope":    checkEnum("resource", "span", "intrinsic", "event", "link", "instrumentation"),
	"tag":      checkTraceTag,
	// The alert store.
	"state":     checkEnum("firing", "silenced", "inhibited", "all"),
	"alertname": checkPrintable(200),
}

// validateToolArgs rejects any argument that would not be read by kubectl as
// the name, namespace, key or verb it is meant to be.
func validateToolArgs(args map[string]interface{}) error {
	for field, check := range argRules {
		if v := argString(args, field, ""); v != "" {
			if err := check(field, v); err != nil {
				return err
			}
		}
	}
	for _, field := range []string{"labels", "annotations"} {
		for k, v := range argStringMap(args, field) {
			if err := checkQualifiedName(field+" key", k); err != nil {
				return err
			}
			if field == "labels" {
				if err := checkLabelValue(field+" value", v); err != nil {
					return err
				}
			}
		}
	}
	for k, v := range argStringMap(args, "alert_labels") {
		if !alertLabelRe.MatchString(k) {
			return badArg("alert_labels key", k, "a label name such as severity or namespace")
		}
		if err := checkPrintable(200)("alert_labels value", v); err != nil {
			return err
		}
	}
	for _, k := range argStringSlice(args, "keys") {
		if err := checkQualifiedName("keys", k); err != nil {
			return err
		}
	}
	for _, k := range argStringSlice(args, "kinds") {
		if err := checkResourceType("kinds", k); err != nil {
			return err
		}
	}
	return nil
}

func checkSince(field, v string) error {
	if len(v) > 20 || !sinceRe.MatchString(v) {
		return badArg(field, v, "a relative duration such as 5s, 2m, 3h or 1h30m")
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 || d > 7*24*time.Hour {
		return badArg(field, v, "a duration between 1s and 7d")
	}
	return nil
}

var (
	auditActionRe = regexp.MustCompile(`^[a-z][a-z0-9_.*-]{0,79}$`)
	rfc3339Re     = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$`)
	logSourceRe   = regexp.MustCompile(`^[A-Za-z0-9_/][A-Za-z0-9_./-]{0,119}$`)
)

func checkAuditAction(field, v string) error {
	if !auditActionRe.MatchString(v) {
		return badArg(field, v, "an audit action such as k8s.pod.delete or ai.tool.execute")
	}
	return nil
}

// checkPrintable accepts one line of printable text up to n characters.
func checkPrintable(n int) argCheck {
	return func(field, v string) error {
		if len(v) > n || strings.ContainsAny(v, "\n\r\x00") {
			return badArg(field, v, fmt.Sprintf("one line of at most %d characters", n))
		}
		for _, r := range v {
			if r < 0x20 || r == 0x7f {
				return badArg(field, v, "printable text")
			}
		}
		return nil
	}
}

func checkFromTime(field, v string) error {
	if len(v) > 40 {
		return badArg(field, v, "a window such as 24h or 7d, or an RFC3339 time")
	}
	if _, err := parseFromTime(v, time.Now()); err != nil {
		return badArg(field, v, err.Error())
	}
	return nil
}

func checkRFC3339(field, v string) error {
	if !rfc3339Re.MatchString(v) {
		return badArg(field, v, "an RFC3339 time such as 2026-10-16T09:00:00Z")
	}
	return nil
}

// checkLogSource accepts a service name (kubelet, containerd) or an absolute
// path under the kubelet's log root; ".." never passes.
func checkLogSource(field, v string) error {
	if !logSourceRe.MatchString(v) || strings.Contains(v, "..") {
		return badArg(field, v, "a service name such as kubelet or a file path such as /var/log/kubelet.log")
	}
	return nil
}

func checkFieldSelector(field, v string) error {
	if len(v) > 512 {
		return badArg(field, v, "a field selector of at most 512 characters")
	}
	for _, part := range strings.Split(v, ",") {
		op := strings.IndexAny(part, "=!")
		if op <= 0 {
			return badArg(field, v, "a field selector such as involvedObject.name=web,type=Warning")
		}
		key := part[:op]
		rest := part[op:]
		switch {
		case strings.HasPrefix(rest, "=="), strings.HasPrefix(rest, "!="):
			rest = rest[2:]
		case strings.HasPrefix(rest, "="):
			rest = rest[1:]
		default:
			return badArg(field, v, "a field selector using =, == or !=")
		}
		if !eventSelectorKeys[key] {
			return badArg(field, v, "a field selector on an events field (involvedObject.kind/name/namespace/uid, reason, type, source, reportingComponent)")
		}
		if strings.ContainsAny(rest, " \t\r\n,") || len(rest) > dns1123SubdomainMaxLength {
			return badArg(field, v, "a field selector value without spaces or commas")
		}
	}
	return nil
}

func checkKindName(field, v string) error {
	if len(v) > dns1123LabelMaxLength || !kindNameRe.MatchString(v) {
		return badArg(field, v, "a resource kind such as Pod or deployments")
	}
	return nil
}

func checkFindQuery(field, v string) error {
	if len(v) < 2 || len(v) > 2*dns1123LabelMaxLength || !findQueryRe.MatchString(v) {
		return badArg(field, v, "a name fragment (2 to 126 characters) or a label key=value")
	}
	return nil
}

func checkExplainResource(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength || !explainResourceRe.MatchString(v) {
		return badArg(field, v, "a resource type with an optional field path (deployments, deployments.spec.strategy)")
	}
	return nil
}

func checkAPIVersion(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength || !apiVersionRe.MatchString(v) {
		return badArg(field, v, "an API version such as v1, apps/v1 or autoscaling/v2")
	}
	return nil
}

// grep never reaches argv (the filter runs here), but a pattern the model
// sent is still kept to one printable line.
func checkGrep(field, v string) error {
	if len(v) > 200 || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a search text of at most 200 printable characters")
	}
	return nil
}

func checkPromQL(field, v string) error {
	if len(v) > 2000 || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a PromQL expression of at most 2000 printable characters")
	}
	return nil
}

func checkLogQL(field, v string) error {
	if len(v) > 4096 || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a LogQL query of at most 4096 printable characters")
	}
	return nil
}

func checkTraceQL(field, v string) error {
	if len(v) > 4096 || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a TraceQL query of at most 4096 printable characters")
	}
	return nil
}

var (
	traceIDRe  = regexp.MustCompile(`^[0-9a-fA-F]{1,32}$`)
	traceTagRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$`)
)

func checkTraceID(field, v string) error {
	if !traceIDRe.MatchString(v) {
		return badArg(field, v, "a trace ID of up to 32 hex digits")
	}
	return nil
}

func checkTraceTag(field, v string) error {
	if !traceTagRe.MatchString(v) {
		return badArg(field, v, "an attribute name such as resource.service.name or span.http.route")
	}
	return nil
}

var alertLabelRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

var promLabelRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$`)

func checkPromLabel(field, v string) error {
	if !promLabelRe.MatchString(v) {
		return badArg(field, v, "a label name such as namespace or k8s_node_name")
	}
	return nil
}

func checkSearchText(field, v string) error {
	if len(v) > 500 || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a search text of at most 500 printable characters")
	}
	return nil
}

func checkSeverity(field, v string) error {
	switch strings.ToLower(v) {
	case "critical", "warning", "info":
		return nil
	}
	return badArg(field, v, "one of critical, warning, info")
}

// checkEnum accepts one of a fixed set of words.
func checkEnum(words ...string) argCheck {
	return func(field, v string) error {
		for _, w := range words {
			if v == w {
				return nil
			}
		}
		return badArg(field, v, "one of "+strings.Join(words, ", "))
	}
}

var (
	lowerWordRe     = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	wordListRe      = regexp.MustCompile(`^[a-z]+(,[a-z]+)*$`)
	qualifiedPathRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$`)
	apiGroupRe      = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
)

func checkLowerWord(field, v string) error {
	if len(v) > dns1123LabelMaxLength || !lowerWordRe.MatchString(v) {
		return badArg(field, v, "a lowercase word")
	}
	return nil
}

func checkWordList(field, v string) error {
	if len(v) > 200 || !wordListRe.MatchString(v) {
		return badArg(field, v, "lowercase words separated by commas")
	}
	return nil
}

func checkQualifiedPath(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength || !qualifiedPathRe.MatchString(v) {
		return badArg(field, v, "a policy name (letters, digits, . _ / -)")
	}
	return nil
}

func checkAPIGroup(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength || !apiGroupRe.MatchString(v) {
		return badArg(field, v, "an API group such as apps or networking.k8s.io")
	}
	return nil
}

var (
	// custom-columns: HEADER:.json.path pairs separated by commas.
	columnsRe   = regexp.MustCompile(`^[A-Za-z0-9_-]+:\.[A-Za-z0-9_.\[\]*'"/-]+(,[A-Za-z0-9_-]+:\.[A-Za-z0-9_.\[\]*'"/-]+)*$`)
	fieldPathRe = regexp.MustCompile(`^\.[A-Za-z0-9_.\[\]*-]+$`)
)

// checkJQ: the program never reaches argv (gojq runs it here), but it is kept
// to printable text of bounded length; gojq reports syntax errors itself.
func checkJQ(field, v string) error {
	if len(v) > 1000 || strings.IndexFunc(v, func(r rune) bool { return (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f }) >= 0 {
		return badArg(field, v, "a jq program of at most 1000 characters")
	}
	return nil
}

func checkColumns(field, v string) error {
	if len(v) > 1000 || !columnsRe.MatchString(v) {
		return badArg(field, v, "custom columns such as NAME:.metadata.name,STATUS:.status.phase")
	}
	return nil
}

func checkFieldPath(field, v string) error {
	if len(v) > 200 || !fieldPathRe.MatchString(v) {
		return badArg(field, v, "a field path such as .status.phase or .metadata.namespace")
	}
	return nil
}

// checkLabelSelector: what kubectl -l takes (app=web, tier in (a,b), !canary),
// never something pflag would read as a flag.
func checkLabelSelector(field, v string) error {
	if len(v) > 500 || strings.HasPrefix(v, "-") || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "a label selector such as app=web,tier!=db")
	}
	return nil
}

func badArg(field, value, want string) error {
	return wrapBadRequest(fmt.Sprintf("%s: %q is not %s", field, value, want))
}

func checkResourceType(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength*4 || !resourceTypeRe.MatchString(v) {
		return badArg(field, v, "a resource type (for example pods, deployments.apps or pods,services)")
	}
	return nil
}

// checkObjectName accepts what the API server accepts as a path segment
// (most names are DNS subdomains; RBAC names such as system:node also carry
// ':') and refuses anything a shell or flag parser would read differently.
func checkObjectName(field, v string) error {
	if len(v) > dns1123SubdomainMaxLength || v == "." || v == ".." || strings.HasPrefix(v, "-") ||
		strings.ContainsAny(v, "/% \t\r\n") || strings.IndexFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return badArg(field, v, "an object name")
	}
	return nil
}

func checkDNSLabel(field, v string) error {
	if len(v) > dns1123LabelMaxLength || !dns1123LabelRe.MatchString(v) {
		return badArg(field, v, "a DNS-1123 label")
	}
	return nil
}

func checkQualifiedName(field, v string) error {
	name := v
	if i := strings.LastIndex(v, "/"); i >= 0 {
		prefix := v[:i]
		name = v[i+1:]
		if len(prefix) > dns1123SubdomainMaxLength || !dns1123SubdomainRe.MatchString(prefix) {
			return badArg(field, v, "a qualified name (prefix must be a DNS subdomain)")
		}
	}
	if len(name) > qualifiedNameMaxLength || !qualifiedNameRe.MatchString(name) {
		return badArg(field, v, "a qualified name")
	}
	return nil
}

func checkLabelValue(field, v string) error {
	if len(v) > labelValueMaxLength || !labelValueRe.MatchString(v) {
		return badArg(field, v, "a label value")
	}
	return nil
}

func checkOutput(field, v string) error {
	if outputFormats[v] {
		return nil
	}
	for _, p := range outputPrefixes {
		if strings.HasPrefix(v, p) && !strings.Contains(v, "\n") {
			return nil
		}
	}
	return badArg(field, v, "an output format (json, yaml, wide, name, jsonpath=…, custom-columns=…, go-template=…)")
}

func checkRolloutAction(field, v string) error {
	if !rolloutActions[v] {
		return badArg(field, v, "a rollout action (restart, undo, pause, resume, status, history)")
	}
	return nil
}

func checkPatchType(field, v string) error {
	if !patchTypes[v] {
		return badArg(field, v, "a patch type (json, merge, strategic)")
	}
	return nil
}

func checkTimeout(field, v string) error {
	if !timeoutRe.MatchString(v) {
		return badArg(field, v, "a duration such as 30s or 5m")
	}
	return nil
}
