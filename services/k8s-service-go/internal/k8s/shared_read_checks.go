package k8s

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
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

// groupCheckUserPrefix starts the user name the shared checks go out as; groupCheckUser adds a part made at each start.
const groupCheckUserPrefix = "kubeast:group-check:"

// groupCheckUser is the one name groupCheckTransport sends in place of a person's.
var groupCheckUser = groupCheckUserPrefix + groupCheckSuffix()

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

// sharesChecksOn says whether cluster id's screens share their allowed read checks; not with the switch off, the
// cluster left out, or auth.impersonation.enabled off, so no transport sends the groups.
func sharesChecksOn(id cluster.ID) bool {
	return impersonationEnabled && sharedReadChecks.on && id != "" && !slices.Contains(sharedReadChecks.exclude, string(id))
}

// unknownExcludes are the excludeClusters entries that are no registered cluster's id: a cluster meant to be left out
// under another spelling goes on sharing. nil while the switch is off, nothing is listed or the registry cannot be read.
func (s *Service) unknownExcludes(ctx context.Context) []string {
	if !sharedReadChecks.on || len(sharedReadChecks.exclude) == 0 || s.registry == nil {
		return nil
	}
	infos, err := s.registry.List(ctx)
	if err != nil {
		return nil
	}
	var unknown []string
	for _, id := range sharedReadChecks.exclude {
		if !slices.ContainsFunc(infos, func(i cluster.Info) bool { return string(i.ID) == id }) {
			unknown = append(unknown, id)
		}
	}
	return unknown
}

// warnUnknownExcludes logs unknownExcludes, at start and after a cluster changed.
func (s *Service) warnUnknownExcludes(ctx context.Context) {
	if unknown := s.unknownExcludes(ctx); len(unknown) > 0 {
		slog.Warn("k8s: auth.impersonation.sharedReadChecks.excludeClusters names no registered cluster id, so those entries leave no cluster out", "entries", unknown)
	}
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
// that is no person's, a question that is no plain read, or a name personName refuses.
func groupCheckKey(ctx context.Context, b *clientBundle, what string, attrs authorizationv1.ResourceAttributes) (key string, groups []string, ok bool) {
	if !b.sharesChecks || accesstrail.FromContext(ctx) != nil || !shareableRead(attrs) {
		return "", nil, false
	}
	p, found := auth.FromContext(ctx)
	if !found || p.System != "" {
		return "", nil, false
	}
	// the cluster the transport takes the groups for
	user, groups := p.Impersonation(string(b.id))
	if len(groups) == 0 || !personName(user) {
		return "", nil, false
	}
	return string(b.id) + "|" + what + "|groups:" + strings.Join(groups, ","), groups, true
}

// personName is a name a shared allow may stand for: not the shared checks' own, nor a system: user, whose groups the
// API server makes otherwise (system:anonymous).
func personName(user string) bool {
	return user != "" && !strings.HasPrefix(user, groupCheckUserPrefix) && !strings.HasPrefix(user, "system:")
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
// person is asked; any other failure, or a review that did not go out under that name, is not kept.
func (s *Service) askAsGroups(ctx context.Context, b *clientBundle, key string, groups []string, attrs authorizationv1.ResourceAttributes) (bool, error) {
	if allowed, ok := s.accessAnswers.get(key, time.Now()); ok {
		return allowed, nil
	}
	if s.answered.askedAgain(key, time.Now()) {
		ctx = askingAgain(ctx)
	}
	return s.askOnce(ctx, b, key, func(ctx context.Context) (bool, error) {
		if known, ok := s.accessAnswers.get(key, time.Now()); ok {
			return known, nil
		}
		accessReviews.byGroups.Inc()
		mark := &groupCheck{groups: groups}
		review, err := b.authz.SelfSubjectAccessReviews().Create(context.WithValue(ctx, groupCheckCtx{}, mark), &authorizationv1.SelfSubjectAccessReview{
			Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &attrs},
		}, metav1.CreateOptions{})
		if !mark.sent.Load() {
			return false, errGroupCheckNotSent
		}
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

// groupCheck marks a review to go out as groupCheckUser in groups; sent says groupCheckTransport sent it so.
type groupCheck struct {
	groups []string
	sent   atomic.Bool
}

type groupCheckCtx struct{}

var (
	errGroupCheck        = errors.New("a check asked by groups names no person of those groups")
	errGroupCheckNotSent = errors.New("a check asked by groups did not go out under the shared name")
)

// groupCheckTransport sits under auth.ImpersonationRoundTripper (wrapPerson): a request marked groupCheck goes out as
// groupCheckUser only when a person's token, a name personName takes and exactly the marked groups are on it.
type groupCheckTransport struct{ base http.RoundTripper }

func (t groupCheckTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	mark, marked := req.Context().Value(groupCheckCtx{}).(*groupCheck)
	if !marked || mark == nil {
		return t.base.RoundTrip(req)
	}
	p, ok := auth.FromContext(req.Context())
	if !ok || p.System != "" || !personName(req.Header.Get(auth.HeaderImpersonateUser)) || len(mark.groups) == 0 ||
		!slices.Equal(req.Header.Values(auth.HeaderImpersonateGroup), mark.groups) {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, errGroupCheck
	}
	r2 := req.Clone(req.Context())
	r2.Header.Set(auth.HeaderImpersonateUser, groupCheckUser)
	mark.sent.Store(true)
	return t.base.RoundTrip(r2)
}
