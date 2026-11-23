// Package proxypath holds two rules for a read of a Service through a cluster's API server proxy
// (/api/v1/namespaces/<namespace>/services/<name>/proxy/…): which redirects the read follows, and which failed answers
// are the API server's own rather than the Service's.
package proxypath

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MaxRedirects is the most redirects a read follows, as many as Go's own client does.
const MaxRedirects = 10

// ErrRedirect is a redirect a read did not follow (Follow, FollowNone).
var ErrRedirect = errors.New("redirect not followed")

// redirectError is ErrRedirect with the reason.
type redirectError struct{ why string }

func (e *redirectError) Error() string { return ErrRedirect.Error() + ": " + e.why }

func (e *redirectError) Is(target error) bool { return target == ErrRedirect }

// NotFollowed is the redirect a read did not follow in err, without the request net/http writes around it (the
// Location the Service answered with), or nil when err holds none.
func NotFollowed(err error) error {
	var re *redirectError
	if errors.As(err, &re) {
		return re
	}
	return nil
}

const servicesPath = "/api/v1/namespaces/"

// Prefix is the Service proxy part of path p, up to and including its "/proxy":
// "[<server URL's path>]/api/v1/namespaces/<namespace>/services/<name>/proxy". ok is false when p is no Service
// proxy path.
func Prefix(p string) (prefix string, ok bool) {
	i := strings.Index(p, servicesPath)
	if i < 0 {
		return "", false
	}
	parts := strings.SplitN(p[i+len(servicesPath):], "/", 5)
	if len(parts) < 4 || parts[0] == "" || parts[1] != "services" || parts[2] == "" || parts[3] != "proxy" {
		return "", false
	}
	return p[:i] + servicesPath + parts[0] + "/services/" + parts[2] + "/proxy", true
}

// Follow is an http.Client CheckRedirect for reads of a Service through the API server proxy. The client sends the
// cluster's credentials with every request, a redirect's too, and the API server passes on a Location naming another
// host as the Service wrote it; so a redirect is followed only to the scheme and host of the first request, under its
// Service's proxy path (Prefix), with no "." or ".." segment, and at most MaxRedirects times.
func Follow(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	if len(via) >= MaxRedirects {
		return &redirectError{fmt.Sprintf("stopped after %d redirects", MaxRedirects)}
	}
	first := via[0].URL
	prefix, ok := Prefix(first.Path)
	switch {
	case !ok:
		return &redirectError{"the first request was not a read of a Service through the API server"}
	case req.URL.Scheme != first.Scheme || !strings.EqualFold(req.URL.Host, first.Host):
		return &redirectError{"it points to another server or scheme than the cluster's API server"}
	case dotSegment(req.URL.Path):
		return &redirectError{`its path has a "." or ".." segment`}
	case req.URL.Path != prefix && !strings.HasPrefix(req.URL.Path, prefix+"/"):
		return &redirectError{"it leaves the Service's path on the API server; register the path the store answers on"}
	}
	return nil
}

// FollowNone is an http.Client CheckRedirect that follows no redirect.
func FollowNone(*http.Request, []*http.Request) error {
	return &redirectError{"this read follows no redirect; register the address the store answers on"}
}

func dotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// MaxStatusBytes is the largest failed answer read as a Status; the API server's own are a few hundred bytes.
const MaxStatusBytes = 64 << 10

// APIServerAnswer reads a failed answer of a Service read through the API server proxy. A Kubernetes Status (kind
// Status, apiVersion v1), which only the API server writes, is its own answer: a refusal of the proxy, no such
// Service, no endpoint, a Service that did not answer. It comes back as a StatusError, with code when the Status names
// none and its message cut to 300 characters. Any other body is the Service's own answer, which the API server passed
// on: nil, false.
func APIServerAnswer(code int, body []byte) (*apierrors.StatusError, bool) {
	if len(body) > MaxStatusBytes {
		return nil, false
	}
	var st metav1.Status
	if json.Unmarshal(body, &st) != nil || st.Kind != "Status" || st.APIVersion != "v1" {
		return nil, false
	}
	if st.Code == 0 {
		st.Code = int32(code)
	}
	if r := []rune(st.Message); len(r) > 300 {
		st.Message = string(r[:300])
	}
	return &apierrors.StatusError{ErrStatus: st}, true
}
