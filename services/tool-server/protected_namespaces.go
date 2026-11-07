// The guarded namespaces (services/pkg/protectedns) on the AI and MCP path. k8s-service names them with each cluster's
// kubeconfig and holds what goes through it; this holds what goes to the cluster from here. A call is refused from its
// arguments when they say enough, before kubectl runs; then the kubectl proxy reads each request kubectl sends.
package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

type protectedCtxKey struct{}

func withProtectedNamespaces(ctx context.Context, n protectedns.Namespaces) context.Context {
	return context.WithValue(ctx, protectedCtxKey{}, n)
}

func protectedFromCtx(ctx context.Context) protectedns.Namespaces {
	n, _ := ctx.Value(protectedCtxKey{}).(protectedns.Namespaces)
	return n
}

// protectedToolGate refuses a tool call whose arguments name what the caller may not do. What they do not name, such
// as a manifest kubectl cannot read or a namespace a tool finds by itself, the proxy holds as it goes out.
func protectedToolGate(p auth.TokenPayload, clusterID string, n protectedns.Namespaces, tool string, args map[string]interface{}) error {
	if n == (protectedns.Namespaces{}) {
		return nil
	}
	if ns := argString(args, "namespace", ""); ns != "" {
		if err := n.Refusal(p, clusterID, ns, protectedToolAct(tool, args)); err != nil {
			return err
		}
	}
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return nil // no manifest in this call
	}
	return manifestRefusal(p, clusterID, n, manifest)
}

func protectedToolAct(tool string, args map[string]interface{}) protectedns.Act {
	switch {
	case tool == "k8s_execute_command":
		return protectedns.ActExec
	case tool == "k8s_get_pod_logs":
		return protectedns.ActLog
	case requiresApproval(tool):
		return protectedns.ActWrite
	case strings.HasPrefix(tool, "helm_"), isSecretResourceName(argString(args, "resource_type", "")):
		return protectedns.ActSecretRead
	}
	return protectedns.ActRead
}

// isSecretResourceName reads a name as kubectl takes one: secret, secrets, Secret, secret/name, secrets.v1 and so on.
func isSecretResourceName(name string) bool {
	name, _, _ = strings.Cut(strings.ToLower(name), "/")
	name, _, _ = strings.Cut(name, ".")
	return name == "secret" || name == "secrets"
}

// manifestRefusal holds every document of a manifest, the items of a List too, so none of it is applied when one is refused.
func manifestRefusal(p auth.TokenPayload, clusterID string, n protectedns.Namespaces, manifest string) error {
	decoder := utilyaml.NewYAMLOrJSONDecoder(strings.NewReader(manifest), 4096)
	for {
		var doc map[string]interface{}
		if err := decoder.Decode(&doc); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return nil // kubectl reads it and says what is wrong; the proxy holds whatever it still sends
		}
		if err := documentRefusal(p, clusterID, n, doc); err != nil {
			return err
		}
	}
}

func documentRefusal(p auth.TokenPayload, clusterID string, n protectedns.Namespaces, doc map[string]interface{}) error {
	if items, ok := doc["items"].([]interface{}); ok {
		for _, item := range items {
			if child, ok := item.(map[string]interface{}); ok {
				if err := documentRefusal(p, clusterID, n, child); err != nil {
					return err
				}
			}
		}
	}
	meta, _ := doc["metadata"].(map[string]interface{})
	ns, _ := meta["namespace"].(string)
	if kind, _ := doc["kind"].(string); kind == "Namespace" {
		ns, _ = meta["name"].(string)
	}
	return n.Refusal(p, clusterID, ns, protectedns.ActWrite)
}

// protectedRequestCheck is what the kubectl proxy holds each request of this call to; nil when there is nothing to hold.
func protectedRequestCheck(ctx context.Context) func(*http.Request) error {
	n := protectedFromCtx(ctx)
	p, ok := auth.FromContext(ctx)
	if !ok || n == (protectedns.Namespaces{}) {
		return nil
	}
	clusterID := clusterIDFromCtx(ctx)
	return func(r *http.Request) error { return n.Check(p, clusterID, r) }
}

// directKubectlRefusal is for kubectl with the proxy off (TOOL_SERVER_KUBECTL_PROXY=false), where no request can be
// read on its way: its arguments are all there is to see. Every Secret of every namespace cannot be asked for without
// the install namespace's, so that is refused.
func directKubectlRefusal(ctx context.Context, args []string) error {
	n := protectedFromCtx(ctx)
	p, ok := auth.FromContext(ctx)
	if !ok || n == (protectedns.Namespaces{}) || len(args) == 0 {
		return nil
	}
	clusterID := clusterIDFromCtx(ctx)
	namespace, all, names := readKubectlArgs(args)
	act := protectedns.ActWrite
	switch args[0] {
	case "exec", "attach", "port-forward":
		act = protectedns.ActExec
	case "logs":
		act = protectedns.ActLog
	case "get", "describe", "top", "explain", "api-resources", "version", "config", "auth":
		act = protectedns.ActRead
		for _, name := range names {
			if isSecretResourceName(name) {
				act = protectedns.ActSecretRead
			}
		}
	}
	if all && act == protectedns.ActSecretRead && n.Install != "" {
		return n.Refusal(p, clusterID, n.Install, act)
	}
	return n.Refusal(p, clusterID, namespace, act)
}

// readKubectlArgs finds the namespace flag and the words of a kubectl command, up to the -- of an exec's own command.
func readKubectlArgs(args []string) (namespace string, all bool, names []string) {
	for i := 1; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--":
			return namespace, all, names
		case arg == "-n" || arg == "--namespace":
			if i+1 < len(args) {
				i++
				namespace = args[i]
			}
		case strings.HasPrefix(arg, "--namespace="):
			namespace = strings.TrimPrefix(arg, "--namespace=")
		case strings.HasPrefix(arg, "-n") && !strings.HasPrefix(arg, "--"):
			namespace = strings.TrimPrefix(arg, "-n")
		case arg == "-A" || arg == "--all-namespaces" || arg == "--all-namespaces=true":
			all = true
		case arg == "-o", arg == "-l", arg == "-c", arg == "--selector", arg == "--output":
			i++ // a flag's value is no word of the command
		case !strings.HasPrefix(arg, "-"):
			names = append(names, arg)
		}
	}
	return namespace, all, names
}
