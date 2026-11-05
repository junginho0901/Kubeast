package handler

import (
	"net/http"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// CanI handles GET /api/v1/can-i?verb=&group=&resource=&namespace=&name= — asks
// the request's cluster, as the signed-in user, whether they may do verb on
// resource (a SelfSubjectAccessReview, like kubectl auth can-i). The console
// shows a create or delete button only where the cluster would allow it: the
// app permission alone does not say (the Write role's edit ClusterRole cannot
// create or delete cluster-scoped objects). An empty namespace means every
// namespace; a name asks about that object, which RBAC resourceNames can allow.
func (h *Handler) CanI(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	attrs := &authorizationv1.ResourceAttributes{
		Verb:      q.Get("verb"),
		Group:     q.Get("group"),
		Resource:  q.Get("resource"),
		Namespace: q.Get("namespace"),
		Name:      q.Get("name"),
	}
	if attrs.Verb == "" || attrs.Resource == "" {
		response.Error(w, http.StatusBadRequest, "verb and resource are required")
		return
	}
	cs, err := h.svc.ClientsetFor(r.Context())
	if err != nil {
		h.handleError(w, err)
		return
	}
	review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(r.Context(), &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: attrs},
	}, metav1.CreateOptions{})
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]bool{"allowed": review.Status.Allowed})
}
