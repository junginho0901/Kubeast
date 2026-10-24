// Package kube records the Kubernetes API requests of a call (accesstrail):
// a transport that sends each request with a fresh Audit-ID and reads it the
// way the API server does (apiserver RequestInfoFactory).
package kube

import (
	"net/http"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/util/sets"
	"k8s.io/apiserver/pkg/endpoints/request"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

var requestInfo = &request.RequestInfoFactory{
	APIPrefixes:          sets.NewString("api", "apis"),
	GrouplessAPIPrefixes: sets.NewString("api"),
}

// RoundTripper wraps base: a request whose context carries a Recorder goes out
// with a new Audit-ID and is added to it; any other request passes unchanged.
func RoundTripper(base http.RoundTripper) http.RoundTripper {
	return &recordingRoundTripper{base: base}
}

type recordingRoundTripper struct{ base http.RoundTripper }

func (t *recordingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := accesstrail.FromContext(req.Context())
	if rec == nil {
		return t.base.RoundTrip(req)
	}
	id := accesstrail.NewAuditID()
	r2 := req.Clone(req.Context())
	r2.Header.Set(accesstrail.HeaderAuditID, id)
	start := time.Now()
	resp, err := t.base.RoundTrip(r2)
	entry := Describe(req)
	entry.AuditID, entry.Ms = id, time.Since(start).Milliseconds()
	if resp != nil {
		entry.Status = resp.StatusCode
		entry.Echoed = resp.Header.Get(accesstrail.HeaderAuditID) == id
	}
	rec.Add(entry)
	return resp, err
}

// Describe reads a request as the API server does: verb, group, resource,
// subresource, namespace and name, or the path for a non-resource request. A
// server URL with a path before /api or /apis (a proxy) is read from there.
func Describe(req *http.Request) accesstrail.Request {
	r := *req
	u := *req.URL
	u.Path = apiPath(u.Path)
	r.URL = &u
	info, err := requestInfo.NewRequestInfo(&r)
	if err != nil || !info.IsResourceRequest {
		verb := strings.ToLower(req.Method)
		if err == nil {
			verb = info.Verb
		}
		return accesstrail.Request{Source: "api", Verb: verb, Path: u.Path}
	}
	return accesstrail.Request{
		Source: "api", Verb: info.Verb, Group: info.APIGroup, Resource: info.Resource,
		Subresource: info.Subresource, Namespace: info.Namespace, Name: info.Name,
	}
}

func apiPath(p string) string {
	if p == "/api" || p == "/apis" || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/apis/") {
		return p
	}
	// a proxy prefix: the first /api/ or /apis/ segment starts the API path
	at := -1
	for _, prefix := range []string{"/api/", "/apis/"} {
		if i := strings.Index(p, prefix); i > 0 && (at == -1 || i < at) {
			at = i
		}
	}
	if at == -1 {
		return p
	}
	return p[at:]
}
