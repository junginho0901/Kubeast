package k8s

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/proxypath"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
)

var errNoProxyClient = errors.New("no REST client for this cluster's Service proxy")

// proxyClient is cs's REST client for one read of a Service through the cluster's API server proxy: the same server,
// request rate and transports (the person and the record of the request's calls go with it as before), on a copy of
// its http.Client that follows a redirect only by proxypath.Follow.
func proxyClient(cs kubernetes.Interface) (*rest.RESTClient, error) {
	if cs == nil {
		return nil, errNoProxyClient
	}
	rc, ok := cs.CoreV1().RESTClient().(*rest.RESTClient)
	if !ok || rc == nil {
		return nil, errNoProxyClient
	}
	var hc http.Client
	if rc.Client != nil {
		hc = *rc.Client
	}
	hc.CheckRedirect = proxypath.Follow
	gv := corev1.SchemeGroupVersion
	// AbsPath with no segment is the server URL as the client holds it, its path included
	return rest.NewRESTClient(rc.Get().AbsPath().URL(), "", rest.ClientContentConfig{
		GroupVersion: gv,
		Negotiator:   runtime.NewClientNegotiator(rest.CodecFactoryForGeneratedClient(scheme.Scheme, scheme.Codecs).WithoutConversion(), gv),
	}, rc.GetRateLimiter(), &hc)
}

// proxyClientCtx is proxyClient of the ctx cluster's clientset.
func (s *Service) proxyClientCtx(ctx context.Context) (*rest.RESTClient, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNoProxyClient
	}
	return proxyClient(cs)
}

// proxyAnswer is a read of a Service through the API server proxy as it came back.
type proxyAnswer struct {
	body []byte
	// code is a failed answer's status, 0 for no answer
	code int
	// cluster: the failed answer is the API server's own (a Kubernetes Status, proxypath.APIServerAnswer), and err
	// the StatusError it wrote; otherwise err is client-go's for the Service's answer, or for none
	cluster bool
	err     error
}

// proxyGet sends req, made on a proxyClient. DoRaw, not Do: a redirect the client did not follow comes back as the
// error alone, where Do would read the closed body of the redirect's answer and log it.
func proxyGet(ctx context.Context, req *rest.Request) proxyAnswer {
	body, err := req.DoRaw(ctx)
	if err == nil {
		return proxyAnswer{body: body}
	}
	a := proxyAnswer{body: body, err: err}
	var st apierrors.APIStatus
	if errors.As(err, &st) {
		a.code = int(st.Status().Code)
	}
	if a.code != 0 {
		if serr, ok := proxypath.APIServerAnswer(a.code, body); ok {
			a.cluster, a.err = true, serr
		}
	}
	return a
}

// storeOwnAuth says the answer is a 401 or 403 the Service wrote itself (an authenticating proxy in front of it): the
// store not answering this read, not the person's sign-in failing or the cluster refusing them.
func (a proxyAnswer) storeOwnAuth() bool {
	return !a.cluster && (a.code == http.StatusUnauthorized || a.code == http.StatusForbidden)
}

// clusterRefusal says the API server itself answered 401 or 403: the person may not read the Service this way.
func (a proxyAnswer) clusterRefusal() bool {
	return a.cluster && (a.code == http.StatusUnauthorized || a.code == http.StatusForbidden)
}

// bodyText is the start of a failed answer's body, for a message.
func (a proxyAnswer) bodyText() string {
	return strings.TrimSpace(string(a.body[:min(len(a.body), 200)]))
}
