package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
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

// gitopsRead reads objects with kubectl get -o json. It goes around runKubectl
// because the output cap of a tool's answer would cut the JSON this decision
// rests on, and kubectl's warnings share a stream with it. kubectl prints what
// it found and then what it did not (several types, a category): what it could
// not find is no refusal, anything else it could not do is an error.
func gitopsRead(ctx context.Context, args ...string) ([]gitops.Object, error) {
	argv, done, err := kubectlCommand(ctx, args)
	if err != nil {
		return nil, err
	}
	defer done()
	output, runErr := kubectlExec(ctx, argv, nil)
	return gitopsReadOutput(string(output), runErr)
}

var kubectlLogLine = regexp.MustCompile(`^[IWEF][0-9]{4} `)

func gitopsReadOutput(output string, runErr error) ([]gitops.Object, error) {
	var objs []gitops.Object
	rest := output
	start := 0
	if !strings.HasPrefix(output, "{") {
		start = strings.Index(output, "\n{") + 1
	}
	if start > 0 || strings.HasPrefix(output, "{") {
		dec := json.NewDecoder(strings.NewReader(output[start:]))
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, fmt.Errorf("unreadable kubectl output: %w", err)
		}
		var err error
		if objs, err = gitopsObjects(raw); err != nil {
			return nil, fmt.Errorf("unreadable kubectl output: %w", err)
		}
		rest = output[:start] + output[start+int(dec.InputOffset()):]
	} else if runErr == nil {
		return nil, errors.New("kubectl printed no object")
	}
	if runErr == nil {
		return objs, nil
	}
	missing := false
	for _, line := range strings.Split(rest, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "Warning:") || kubectlLogLine.MatchString(line):
		case strings.HasPrefix(line, "Error from server (NotFound)") || reUnknownKind.MatchString(line):
			missing = true
		default:
			return nil, errors.New(line)
		}
	}
	if !missing {
		return nil, runErr
	}
	return objs, nil
}

// gitopsReadFailed is what a read the guard needed and could not make means:
// in block mode the write does not go; otherwise it goes as if nothing was found.
func gitopsReadFailed(what string, err error) error {
	if !gitopsCfg.Blocks() {
		return nil
	}
	return fmt.Errorf("could not check whether Argo CD manages %s, so the write was refused: %w", what, err)
}

// gitopsGuard reads the live object and, when Argo CD manages it, refuses
// the write (block) or returns the notice the tool puts before its result
// (warn). With no name it reads every object of the type, what a delete of
// them all reaches. An object kubectl cannot find is not managed.
func gitopsGuard(ctx context.Context, headers http.Header, resourceType, name, namespace string) (string, error) {
	if !gitopsCfg.Enabled || resourceType == "" {
		return "", nil
	}
	args := []string{"get", resourceType}
	what := resourceType
	if name != "" {
		args = append(args, name)
		what += " " + name
	} else if err := gitopsListFits(ctx, headers, resourceType, namespace); err != nil {
		return "", gitopsReadFailed(what, err)
	}
	args = append(args, "-o", "json")
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	objs, err := gitopsRead(ctx, args...)
	if err != nil {
		return "", gitopsReadFailed(what, err)
	}
	return gitopsGuardObjects(ctx, headers, objs, false)
}

// gitopsListFits holds the guard to listMax, as the read tools are: kubectl holds
// a whole list. A type it cannot size (several, a category) is listed as before.
func gitopsListFits(ctx context.Context, headers http.Header, resourceType, namespace string) error {
	size, ok, err := listSize(ctx, headers, resourceType, namespace, false, "", "")
	if err == nil && ok && size.count > listMax {
		return fmt.Errorf("%d objects are more than the %d it reads", size.count, listMax)
	}
	return nil
}

// gitopsGuarded is the guard for a write tool that names one object and does
// not call it itself: the admission gate first, as the tools that do. A missing
// argument stays the tool's own answer.
func gitopsGuarded(next ToolHandler) ToolHandler {
	return func(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
		resourceType, name := argString(args, "resource_type", ""), argString(args, "resource_name", "")
		if resourceType == "" || name == "" {
			return next(ctx, args, headers)
		}
		if err := admissionPolicyGate(resourceType); err != nil {
			return "", err
		}
		notice, err := gitopsGuard(ctx, headers, resourceType, name, argString(args, "namespace", ""))
		if err != nil {
			return "", err
		}
		out, err := next(ctx, args, headers)
		return withGitopsNotice(notice, out), err
	}
}

// gitopsGuardManifest checks every object a manifest would change: each document
// with a name, read as kubectl reads it, is looked at in the cluster.
func gitopsGuardManifest(ctx context.Context, headers http.Header, manifest string) (string, error) {
	if !gitopsCfg.Enabled {
		return "", nil
	}
	var named []gitops.Object
	for _, o := range manifestObjects(manifest) {
		if o.Name != "" {
			named = append(named, o)
		}
	}
	return gitopsGuardObjects(ctx, headers, named, true)
}

func gitopsGuardObjects(ctx context.Context, headers http.Header, objs []gitops.Object, live bool) (string, error) {
	if !gitopsCfg.Enabled {
		return "", nil
	}
	var notices []string
	managed := 0
	for _, o := range objs {
		if live {
			kind := o.Kind
			if o.Group != "" {
				kind += "." + o.Group
			}
			args := []string{"get", kind, o.Name, "-o", "json"}
			if o.Namespace != "" {
				args = append(args, "-n", o.Namespace)
			}
			got, err := gitopsRead(ctx, args...)
			if err != nil {
				if refused := gitopsReadFailed(o.Kind+" "+o.Namespace+"/"+o.Name, err); refused != nil {
					return "", refused
				}
				continue
			}
			if len(got) != 1 {
				continue // not there yet: the apply creates it
			}
			o = got[0]
		}
		if res := gitopsCfg.Detect(o); res.Managed {
			if gitopsCfg.Blocks() {
				return "", fmt.Errorf("%w: %s %s/%s is managed by Argo CD application %s; change it in Git", errConflict, o.Kind, o.Namespace, o.Name, res.App)
			}
			if managed++; managed <= gitopsNoticeLines {
				notices = append(notices, fmt.Sprintf("⚠ %s %s/%s is managed by Argo CD application %s (gitops.argocd.mode=warn): this change drifts from Git until the Application syncs it back.", o.Kind, o.Namespace, o.Name, res.App))
			}
		}
	}
	if managed > gitopsNoticeLines {
		notices = append(notices, fmt.Sprintf("⚠ … and %d more objects managed by Argo CD.", managed-gitopsNoticeLines))
	}
	return strings.Join(notices, "\n"), nil
}

// gitopsNoticeLines is how many managed objects a warn-mode notice names: a delete of a whole type can touch thousands,
// and the notice goes in front of the tool's answer, which the model reads only so far of.
const gitopsNoticeLines = 10

// withGitopsNotice puts the warn-mode notice before a tool's output.
func withGitopsNotice(notice, output string) string {
	if notice == "" {
		return output
	}
	return notice + "\n\n" + output
}
