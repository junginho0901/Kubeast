package k8s

import (
	"context"
	"errors"
	"strings"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// The overview is served from the kubeast:cache informers, so the caller's own
// identity is asked first (SelfSubjectAccessReview, list namespaces).
func TestOverviewIdentityAllowed(t *testing.T) {
	answer := func(allowed bool, fail error) *clientBundle {
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "selfsubjectaccessreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
			if fail != nil {
				return true, nil, fail
			}
			return true, &authorizationv1.SelfSubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: allowed}}, nil
		})
		return &clientBundle{authz: cs.AuthorizationV1()}
	}
	s := &Service{} // no cache: every call asks the cluster

	if err := s.overviewIdentityAllowed(context.Background(), answer(true, nil)); err != nil {
		t.Fatalf("allowed identity must pass: %v", err)
	}
	err := s.overviewIdentityAllowed(context.Background(), answer(false, nil))
	if !apierrors.IsForbidden(err) {
		t.Fatalf("refused identity must be forbidden (403): %v", err)
	}
	if err == nil || !strings.Contains(err.Error(), "namespaces") || !strings.Contains(err.Error(), "overview") {
		t.Fatalf("the refusal must say what is missing: %v", err)
	}
	boom := errors.New("apiserver down")
	if err := s.overviewIdentityAllowed(context.Background(), answer(false, boom)); !errors.Is(err, boom) {
		t.Fatalf("a failed review is the cluster's error, not a verdict: %v", err)
	}
	// No authorization client (a bundle built without one): nothing to ask, the overview is served.
	if err := s.overviewIdentityAllowed(context.Background(), &clientBundle{}); err != nil {
		t.Fatalf("no authz client must pass: %v", err)
	}
}
