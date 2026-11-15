package k8s

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Read checks shared by group (auth.impersonation.sharedReadChecks, off): an allow asked once as groupCheckUser in a
// person's groups stands for everyone with those groups, as RBAC only adds; a refusal is asked again as the person.

// groupCheckUser is the user name the shared checks go out as: auth.GroupCheckUserPrefix and a part made at each start,
// so no cluster can hold a binding of it from before the process ran.
var groupCheckUser = auth.GroupCheckUserPrefix + groupCheckSuffix()

func groupCheckSuffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// sharedReadChecks is ServiceOptions' switch and the clusters it leaves out, read by buildClientBundle.
var sharedReadChecks struct {
	on      bool
	exclude []string
}

// sharedCheckUserFor is the name cluster id's shared checks go out as, "" where every check is asked as the person:
// the switch off, the cluster left out, or auth.impersonation.enabled off, so no transport sends the groups.
func sharedCheckUserFor(id cluster.ID) string {
	if !impersonationEnabled || !sharedReadChecks.on || id == "" || slices.Contains(sharedReadChecks.exclude, string(id)) {
		return ""
	}
	return groupCheckUser
}

// shareableRead is a question a shared answer may stand for: a read with no subresource, and not of Secrets.
func shareableRead(a authorizationv1.ResourceAttributes) bool {
	switch a.Verb {
	case "get", "list", "watch":
	default:
		return false
	}
	return a.Subresource == "" && !(a.Group == "" && a.Resource == "secrets")
}

// groupCheckKey is where everyone with ctx's groups on b's cluster keeps the answer to what, and those groups; ok=false
// leaves the check to the person: a cluster that does not share them, a request recorded for an AI tool call, a token
// that is no person's, a question that is no plain read, or a person whose own name is a shared check's.
func groupCheckKey(ctx context.Context, b *clientBundle, what string, attrs authorizationv1.ResourceAttributes) (key string, groups []string, ok bool) {
	if b.groupCheckUser == "" || accesstrail.FromContext(ctx) != nil || !shareableRead(attrs) {
		return "", nil, false
	}
	p, found := auth.FromContext(ctx)
	if !found || p.System != "" {
		return "", nil, false
	}
	// the cluster the transport takes the groups for
	user, groups := p.Impersonation(string(b.id))
	if len(groups) == 0 || strings.HasPrefix(user, auth.GroupCheckUserPrefix) {
		return "", nil, false
	}
	sum := sha256.Sum256([]byte(strings.Join(groups, ",")))
	return string(b.id) + "|" + what + "|groups:" + hex.EncodeToString(sum[:8]), groups, true
}

// mayDoShown is mayDo for a check that decides what a screen served from kubeast:cache shows: the person's own answer
// while it lasts, else the allow of everyone with its groups (askAsGroups), else mayDo as the person.
func (s *Service) mayDoShown(ctx context.Context, b *clientBundle, what string, attrs authorizationv1.ResourceAttributes) (bool, error) {
	key, groups, ok := groupCheckKey(ctx, b, what, attrs)
	if !ok || b.authz == nil {
		return s.mayDo(ctx, b, what, attrs)
	}
	if allowed, known := s.accessAnswers.get(s.clusterCacheKey(ctx, what), time.Now()); known {
		return allowed, nil
	}
	if allowed, err := s.askAsGroups(ctx, b, key, groups, attrs); err == nil && allowed {
		return true, nil
	}
	return s.mayDo(ctx, b, what, attrs)
}

// askAsGroups is the cluster's answer for key's groups: from this process's answers, or one review for everyone asking
// as groupCheckUser in those groups, kept accessCheckTTL. A cluster that refuses that name answers false, and the
// person is asked; any other failure is not kept.
func (s *Service) askAsGroups(ctx context.Context, b *clientBundle, key string, groups []string, attrs authorizationv1.ResourceAttributes) (bool, error) {
	if allowed, ok := s.accessAnswers.get(key, time.Now()); ok {
		return allowed, nil
	}
	if s.answered.askedAgain(key, time.Now()) {
		ctx = askingAgain(ctx)
	}
	return s.askOnce(ctx, key, func(ctx context.Context) (bool, error) {
		if known, ok := s.accessAnswers.get(key, time.Now()); ok {
			return known, nil
		}
		accessReviews.byGroups.Inc()
		review, err := b.authz.SelfSubjectAccessReviews().Create(auth.AsGroupCheck(ctx, b.groupCheckUser, groups), &authorizationv1.SelfSubjectAccessReview{
			Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &attrs},
		}, metav1.CreateOptions{})
		if err != nil && !apierrors.IsForbidden(err) {
			return false, err
		}
		allowed := err == nil && review.Status.Allowed
		end := time.Now().Add(accessCheckTTL())
		s.accessAnswers.set(key, allowed, end)
		s.answered.answered(key, end)
		return allowed, nil
	})
}

// listCheck is what mayListGroup and mayListShown ask and the name its answer is kept under.
func listCheck(group, resource, namespace string) (string, authorizationv1.ResourceAttributes) {
	name := resource
	if group != "" {
		name = group + "/" + resource
	}
	return name + "_list_allowed:" + namespace, authorizationv1.ResourceAttributes{Verb: "list", Group: group, Resource: resource, Namespace: namespace}
}

// mayListShown is mayListGroup for a screen served from kubeast:cache (mayDoShown).
func (s *Service) mayListShown(ctx context.Context, b *clientBundle, group, resource, namespace string) (bool, error) {
	what, attrs := listCheck(group, resource, namespace)
	return s.mayDoShown(ctx, b, what, attrs)
}
