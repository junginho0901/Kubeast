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
	timeoutRe      = regexp.MustCompile(`^[0-9]+(ms|s|m|h)$`)

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
	"resource_type": checkResourceType,
	"resource_name": checkObjectName,
	"pod_name":      checkObjectName,
	"service_name":  checkObjectName,
	"service":       checkObjectName,
	"name":          checkObjectName,
	"namespace":     checkDNSLabel,
	"container":     checkDNSLabel,
	"output":        checkOutput,
	"action":        checkRolloutAction,
	"patch_type":    checkPatchType,
	"timeout":       checkTimeout,
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
	for _, k := range argStringSlice(args, "keys") {
		if err := checkQualifiedName("keys", k); err != nil {
			return err
		}
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
