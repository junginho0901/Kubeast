package k8s

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// Gitops is the Argo CD guard configuration (chart gitops.argocd).
func (s *Service) Gitops() gitops.Config { return s.gitops }

// GitopsManaged reads the object named by a Kubeast API path segment
// ("deployments", "hpas", "pvcs"), namespace and name in the ctx cluster and
// reports the Argo CD Application that manages it. An object that does not
// exist is not managed (the write will fail on its own).
func (s *Service) GitopsManaged(ctx context.Context, resourceType, namespace, name string) (gitops.Result, error) {
	gvr, namespaced, err := s.resolveForGitops(ctx, resourceType)
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
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err == nil {
		return gvr, namespaced, nil
	}
	if strings.HasSuffix(resourceType, "s") {
		if g, n, err2 := s.ResolveResource(ctx, strings.TrimSuffix(resourceType, "s")); err2 == nil {
			return g, n, nil
		}
	}
	return schema.GroupVersionResource{}, false, err
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
