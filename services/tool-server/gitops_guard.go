package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// The write tools refuse an object an Argo CD Application manages while
// gitops.argocd.mode is "block" (the same rule k8s-service applies to the
// REST writes), so an approved AI tool cannot go around the console. In
// "warn" mode the write goes through and the result starts with a notice
// naming the Application, for the model and the MCP client to relay.
var (
	gitopsCfg   = gitops.LoadFromEnv()
	errConflict = errors.New("conflict")
)

type gitopsObject struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name        string            `json:"name"`
		Namespace   string            `json:"namespace"`
		Annotations map[string]string `json:"annotations"`
		Labels      map[string]string `json:"labels"`
	} `json:"metadata"`
	Items []json.RawMessage `json:"items"`
}

// gitopsObjects turns kubectl -o json output (one object or a List) into
// the objects the check reads.
func gitopsObjects(raw []byte) ([]gitops.Object, error) {
	var o gitopsObject
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, err
	}
	if o.Kind == "List" || len(o.Items) > 0 {
		var out []gitops.Object
		for _, it := range o.Items {
			objs, err := gitopsObjects(it)
			if err != nil {
				return nil, err
			}
			out = append(out, objs...)
		}
		return out, nil
	}
	if o.Kind == "" || o.Metadata.Name == "" {
		return nil, nil
	}
	group := ""
	if i := strings.Index(o.APIVersion, "/"); i > 0 {
		group = o.APIVersion[:i]
	}
	return []gitops.Object{{
		Group: group, Kind: o.Kind, Namespace: o.Metadata.Namespace, Name: o.Metadata.Name,
		Annotations: o.Metadata.Annotations, Labels: o.Metadata.Labels,
	}}, nil
}

// gitopsGuard reads the live object and, when Argo CD manages it, refuses
// the write (block) or returns the notice the tool puts before its result
// (warn). An object kubectl cannot find is not managed.
func gitopsGuard(ctx context.Context, headers http.Header, resourceType, name, namespace string) (string, error) {
	if !gitopsCfg.Enabled || resourceType == "" || name == "" {
		return "", nil
	}
	args := []string{"get", resourceType, name, "-o", "json"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	raw, err := runKubectl(ctx, headers, args...)
	if err != nil {
		return "", nil
	}
	objs, err := gitopsObjects([]byte(raw))
	if err != nil {
		return "", nil
	}
	return gitopsGuardObjects(ctx, headers, objs, false)
}

// gitopsGuardManifest checks every object a manifest would change: kubectl
// renders the documents (client dry run), then each one that already exists
// in the cluster is read and checked.
func gitopsGuardManifest(ctx context.Context, headers http.Header, manifest string) (string, error) {
	if !gitopsCfg.Enabled {
		return "", nil
	}
	raw, err := runKubectlWithInput(ctx, headers, manifest, "apply", "--dry-run=client", "-o", "json", "-f", "-")
	if err != nil {
		return "", nil // the real apply reports the problem
	}
	objs, err := gitopsObjects([]byte(raw))
	if err != nil {
		return "", nil
	}
	return gitopsGuardObjects(ctx, headers, objs, true)
}

func gitopsGuardObjects(ctx context.Context, headers http.Header, objs []gitops.Object, live bool) (string, error) {
	if !gitopsCfg.Enabled {
		return "", nil
	}
	var notices []string
	for _, o := range objs {
		if live {
			kind := strings.ToLower(o.Kind)
			if o.Group != "" {
				kind += "." + o.Group
			}
			args := []string{"get", kind, o.Name, "-o", "json"}
			if o.Namespace != "" {
				args = append(args, "-n", o.Namespace)
			}
			raw, err := runKubectl(ctx, headers, args...)
			if err != nil {
				continue // not there yet: the apply creates it
			}
			got, err := gitopsObjects([]byte(raw))
			if err != nil || len(got) != 1 {
				continue
			}
			o = got[0]
		}
		if res := gitopsCfg.Detect(o); res.Managed {
			if gitopsCfg.Blocks() {
				return "", fmt.Errorf("%w: %s %s/%s is managed by Argo CD application %s; change it in Git", errConflict, o.Kind, o.Namespace, o.Name, res.App)
			}
			notices = append(notices, fmt.Sprintf("⚠ %s %s/%s is managed by Argo CD application %s (gitops.argocd.mode=warn): this change drifts from Git until the Application syncs it back.", o.Kind, o.Namespace, o.Name, res.App))
		}
	}
	return strings.Join(notices, "\n"), nil
}

// withGitopsNotice puts the warn-mode notice before a tool's output.
func withGitopsNotice(notice, output string) string {
	if notice == "" {
		return output
	}
	return notice + "\n\n" + output
}
