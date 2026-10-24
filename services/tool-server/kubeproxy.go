// A loopback proxy kubectl talks to instead of the cluster, so each request
// of a kubectl tool goes out with an Audit-ID and is listed for the call
// (services/pkg/accesstrail). kubectl gets a kubeconfig naming this proxy and
// a token for that one run; the proxy drops whatever identity kubectl sends,
// then sends the request with the cluster's own credential, the user's
// impersonation and a fresh Audit-ID — the parts are those of `kubectl proxy`
// (apimachinery UpgradeAwareHandler, client-go transports), so exec, attach,
// port-forward and log streams pass through.

package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/util/httpstream"
	utilnet "k8s.io/apimachinery/pkg/util/net"
	"k8s.io/apimachinery/pkg/util/proxy"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/transport"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	kubetrail "github.com/junginho0901/kubeast/services/pkg/accesstrail/kube"
)

type kubeProxy struct {
	addr string
	// caPEM is the proxy's own certificate: client-go sends a token only over
	// TLS, so kubectl talks to it on https and trusts this certificate.
	caPEM []byte
	mu    sync.Mutex
	calls map[string]*proxyRun
}

// proxyRun is one kubectl run: the cluster it may reach and how.
type proxyRun struct {
	cluster  string
	target   *url.URL
	rt       http.RoundTripper
	upgrade  proxy.UpgradeRequestRoundTripper
	recorder *accesstrail.Recorder
}

// kubectlProxy is started once at boot; nil keeps kubectl talking to the
// cluster directly (with --as), without a request list.
var kubectlProxy *kubeProxy

func startKubeProxy() (*kubeProxy, error) {
	cert, caPEM, err := loopbackCertificate()
	if err != nil {
		return nil, err
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	if err != nil {
		return nil, err
	}
	p := &kubeProxy{addr: l.Addr().String(), caPEM: caPEM, calls: map[string]*proxyRun{}}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(l) }()
	return p, nil
}

// loopbackCertificate is a self-signed certificate for 127.0.0.1, made at boot.
func loopbackCertificate() (tls.Certificate, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "kubeast tool-server kubectl proxy"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:         true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, caPEM, nil
}

// prepare writes a kubeconfig for one kubectl run against cluster, through the
// proxy, as the user in cfg (its Impersonate set or not), recording into rec.
// The returned cleanup removes the file and the token.
func (p *kubeProxy) prepare(cluster, realKubeconfig string, impersonate rest.ImpersonationConfig, rec *accesstrail.Recorder) (string, func(), error) {
	var cfg *rest.Config
	var err error
	if realKubeconfig == "" {
		cfg, err = rest.InClusterConfig() // TOOL_SERVER_USE_INCLUSTER
	} else {
		cfg, err = clientcmd.BuildConfigFromFlags("", realKubeconfig)
	}
	if err != nil {
		return "", nil, fmt.Errorf("kubeconfig: %w", err)
	}
	cfg.Impersonate = impersonate
	run, err := newProxyRun(cluster, cfg, rec)
	if err != nil {
		return "", nil, err
	}
	var b [32]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return "", nil, err
	}
	token := hex.EncodeToString(b[:])
	f, err := os.CreateTemp("", "kubectl-run-*.yaml")
	if err != nil {
		return "", nil, err
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return "", nil, err
	}
	server := "https://" + p.addr + "/c/" + url.PathEscape(cluster)
	if _, err := fmt.Fprintf(f, proxyKubeconfig, server, base64.StdEncoding.EncodeToString(p.caPEM), token); err != nil {
		return "", nil, err
	}
	p.mu.Lock()
	p.calls[token] = run
	p.mu.Unlock()
	return f.Name(), func() {
		p.mu.Lock()
		delete(p.calls, token)
		p.mu.Unlock()
		_ = os.Remove(f.Name())
	}, nil
}

const proxyKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: kubeast
  cluster:
    server: %s
    certificate-authority-data: %s
contexts:
- name: kubeast
  context: {cluster: kubeast, user: kubeast}
current-context: kubeast
users:
- name: kubeast
  user:
    token: %s
`

// newProxyRun builds the two transports kubectl proxy uses: one for ordinary
// requests and one that bypasses HTTP/2 for those that upgrade.
func newProxyRun(cluster string, cfg *rest.Config, rec *accesstrail.Recorder) (*proxyRun, error) {
	host := cfg.Host
	if !strings.HasSuffix(host, "/") {
		host += "/"
	}
	target, err := url.Parse(host)
	if err != nil {
		return nil, err
	}
	rt, err := rest.TransportFor(cfg)
	if err != nil {
		return nil, err
	}
	tc, err := cfg.TransportConfig()
	if err != nil {
		return nil, err
	}
	tlsConfig, err := transport.TLSConfigFor(tc)
	if err != nil {
		return nil, err
	}
	base := utilnet.SetOldTransportDefaults(&http.Transport{
		TLSClientConfig: tlsConfig,
		DialContext:     (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	})
	upgrader, err := transport.HTTPWrappersForConfig(tc, proxy.MirrorRequest)
	if err != nil {
		return nil, err
	}
	return &proxyRun{cluster: cluster, target: target, rt: rt, upgrade: proxy.NewUpgradeRequestRoundTripper(base, upgrader), recorder: rec}, nil
}

// identityHeaders are what kubectl may not set: the proxy adds the identity.
var identityHeaders = []string{"Authorization", "Impersonate-User", "Impersonate-Group", "Impersonate-Uid", accesstrail.HeaderAuditID}

func (p *kubeProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	under, ok := strings.CutPrefix(r.URL.Path, "/c/")
	cluster, apiPath, _ := strings.Cut(under, "/")
	token, hasToken := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	p.mu.Lock()
	run := p.calls[token]
	p.mu.Unlock()
	if !ok || !hasToken || run == nil || url.PathEscape(run.cluster) != cluster {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	for _, h := range identityHeaders {
		r.Header.Del(h)
	}
	for k := range r.Header {
		if strings.HasPrefix(strings.ToLower(k), "impersonate-extra-") {
			r.Header.Del(k)
		}
	}
	r.URL.Path = "/" + apiPath
	r.URL.RawPath = ""
	id := accesstrail.NewAuditID()
	r.Header.Set(accesstrail.HeaderAuditID, id)
	entry := kubetrail.Describe(r)
	entry.AuditID = id

	h := proxy.NewUpgradeAwareHandler(run.target, run.rt, false, false, proxyResponder{})
	h.UpgradeTransport = run.upgrade
	h.UseRequestLocation = true
	h.UseLocationHost = true
	sw := &statusWriter{ResponseWriter: w}
	start := time.Now()
	h.ServeHTTP(sw, r)
	entry.Ms = time.Since(start).Milliseconds()
	switch {
	case sw.status != 0:
		entry.Status = sw.status
		entry.Echoed = sw.Header().Get(accesstrail.HeaderAuditID) == id
	case httpstream.IsUpgradeRequest(r):
		entry.Status = http.StatusSwitchingProtocols // the backend answered on the hijacked connection
	}
	// kubectl's discovery reads (/api, /apis, /openapi) are not the tool's requests.
	if entry.Resource != "" {
		run.recorder.Add(entry)
	}
}

type proxyResponder struct{}

func (proxyResponder) Error(w http.ResponseWriter, _ *http.Request, err error) {
	http.Error(w, "kubeast proxy: "+err.Error(), http.StatusBadGateway)
}

// statusWriter keeps the status the backend answered with; an upgraded
// connection is hijacked and leaves it 0.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer cannot hijack")
	}
	return hj.Hijack()
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
