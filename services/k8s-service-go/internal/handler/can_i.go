package handler

import (
	"net/http"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// CanI handles GET /api/v1/can-i?verb=&group=&resource=&namespace=&name= — asks
// the request's cluster, as the signed-in user, whether they may do verb on
// resource (a SelfSubjectAccessReview, like kubectl auth can-i). The console
// shows a create or delete button only where the cluster would allow it: the
// app permission alone does not say (the Write role's edit ClusterRole cannot
// create or delete cluster-scoped objects). An empty namespace means every
// namespace; a name asks about that object, which RBAC resourceNames can allow.
// A namespace outside a limited grant, or a guarded namespace (services/pkg/protectedns), is "no" without asking: the
// middleware would refuse the action there, and a button shows when this call fails.
func (h *Handler) CanI(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	attrs := &authorizationv1.ResourceAttributes{
		Verb:        q.Get("verb"),
		Group:       q.Get("group"),
		Resource:    q.Get("resource"),
		Subresource: q.Get("subresource"),
		Namespace:   q.Get("namespace"),
		Name:        q.Get("name"),
	}
	if attrs.Verb == "" || attrs.Resource == "" {
		response.Error(w, http.StatusBadRequest, "verb and resource are required")
		return
	}
	payload, _ := auth.FromContext(r.Context())
	id, _ := cluster.FromContext(r.Context())
	if attrs.Namespace != "" && !payload.AllowedIn(string(id), attrs.Namespace) {
		response.JSON(w, http.StatusOK, map[string]bool{"allowed": false})
		return
	}
	// A Namespace object is asked about by name, with or without itself as the namespace.
	reaches := attrs.Namespace
	if attrs.Group == "" && attrs.Resource == "namespaces" && attrs.Name != "" {
		reaches = attrs.Name
	}
	act := protectedns.ActOf(attrs.Group, attrs.Verb, attrs.Resource, attrs.Subresource)
	if h.svc.ProtectedNamespaces(r.Context()).Refusal(payload, string(id), reaches, act) != nil {
		response.JSON(w, http.StatusOK, map[string]bool{"allowed": false})
		return
	}
	reviews, err := h.svc.ReviewsFor(r.Context())
	if err != nil {
		h.handleError(w, err)
		return
	}
	review, err := reviews.Create(r.Context(), &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: attrs},
	}, metav1.CreateOptions{})
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]bool{"allowed": review.Status.Allowed})
}
