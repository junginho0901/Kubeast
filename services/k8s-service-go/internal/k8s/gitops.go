package k8s

import (
	"context"
	"errors"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// Gitops is the Argo CD guard configuration (chart gitops.argocd).
func (s *Service) Gitops() gitops.Config { return s.gitops }

// GitopsManaged reads the object named by a Kubeast API path segment
// ("deployments", "hpas", "pvcs"), namespace and name in the ctx cluster and
// reports the Argo CD Application that manages it. An object that does not
// exist, or of a kind the cluster does not serve, is not managed (the write
// will fail on its own). An error says the answer is not known.
func (s *Service) GitopsManaged(ctx context.Context, resourceType, namespace, name string) (gitops.Result, error) {
	gvr, namespaced, err := s.resolveForGitops(ctx, resourceType)
	if errors.Is(err, errResourceTypeNotServed) {
		return gitops.Result{}, nil
	}
	if err != nil {
		return gitops.Result{}, err
	}
	return s.gitopsManagedGVR(ctx, gvr, namespaced, namespace, name)
}

// GitopsManagedGVK is GitopsManaged for a manifest's apiVersion and kind
// (the YAML apply paths).
func (s *Service) GitopsManagedGVK(ctx context.Context, apiVersion, kind, namespace, name string) (gitops.Result, error) {
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return gitops.Result{}, fmt.Errorf("apiVersion %q: %w", apiVersion, err)
	}
	resourceType := strings.ToLower(kind)
	if gv.Group != "" {
		resourceType += "." + gv.Group
	}
	gvr, namespaced, err := s.resolveForGitops(ctx, resourceType)
	if errors.Is(err, errResourceTypeNotServed) {
		return gitops.Result{}, nil
	}
	if err != nil {
		return gitops.Result{}, err
	}
	return s.gitopsManagedGVR(ctx, gvr, namespaced, namespace, name)
}

// GitopsManagedCustom is GitopsManaged for the custom-resource paths, which
// carry the group, version and plural themselves.
func (s *Service) GitopsManagedCustom(ctx context.Context, group, version, plural, namespace, name string) (gitops.Result, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	return s.gitopsManagedGVR(ctx, gvr, namespace != "" && namespace != "-", namespace, name)
}

// resolveForGitops is ResolveResource plus the Kubeast path spellings that
// are neither a plural nor a short name ("hpas" → "hpa", "pvcs" → "pvc").
func (s *Service) resolveForGitops(ctx context.Context, resourceType string) (schema.GroupVersionResource, bool, error) {
	m, err := s.matchForGitops(ctx, resourceType)
	if errors.Is(err, errResourceTypeNotServed) && strings.HasSuffix(resourceType, "s") {
		if short, err2 := s.matchForGitops(ctx, strings.TrimSuffix(resourceType, "s")); err2 == nil {
			return short.gvr, short.namespaced, nil
		}
	}
	return m.gvr, m.namespaced, err
}

// matchForGitops also reads the groups that answered when another did not: an
// aggregated API that is down fails discovery as a whole, and must not stop
// every write of a cluster whose kinds can still be told apart.
func (s *Service) matchForGitops(ctx context.Context, resourceType string) (resourceMatch, error) {
	m, err := s.resolveResourceMatch(ctx, resourceType)
	var partial *discovery.ErrGroupDiscoveryFailed
	if !errors.As(err, &partial) {
		return m, err
	}
	groups, lists, _ := s.discoveryCtx(ctx).ServerGroupsAndResources()
	found, matchErr := matchResource(preferredFirst(groups, lists), resourceType)
	if matchErr != nil {
		return resourceMatch{}, err // it may belong to a group that did not answer
	}
	return found, nil
}

func (s *Service) gitopsManagedGVR(ctx context.Context, gvr schema.GroupVersionResource, namespaced bool, namespace, name string) (gitops.Result, error) {
	if !s.gitops.Enabled || name == "" {
		return gitops.Result{}, nil
	}
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return gitops.Result{}, errNotLoaded
	}
	if namespace == "-" {
		namespace = ""
	}
	var ri = dyn.Resource(gvr).Namespace("")
	if namespaced {
		ri = dyn.Resource(gvr).Namespace(namespace)
	}
	obj, err := ri.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return gitops.Result{}, nil
		}
		return gitops.Result{}, err
	}
	return s.gitops.Detect(gitops.Object{
		Group:       gvr.Group,
		Kind:        obj.GetKind(),
		Namespace:   obj.GetNamespace(),
		Name:        obj.GetName(),
		Annotations: obj.GetAnnotations(),
		Labels:      obj.GetLabels(),
	}), nil
}
