package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/release"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// helmAPI answers what the Helm SDK asks an API server during an upgrade: discovery and the release Secrets.
type helmAPI struct {
	mu      sync.Mutex
	secrets map[string]*corev1.Secret
}

func writeAPIJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *helmAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	const secrets = "/api/v1/namespaces/team-a/secrets"
	switch {
	case r.URL.Path == "/version":
		writeAPIJSON(w, http.StatusOK, map[string]string{"major": "1", "minor": "33", "gitVersion": "v1.33.0"})
	case r.URL.Path == "/openapi/v2":
		// An empty document, so a chart that renders objects passes the SDK's validation.
		w.Header().Set("Content-Type", "application/com.github.proto-openapi.spec.v2.v1.0+protobuf")
		w.WriteHeader(http.StatusOK)
	case r.URL.Path == "/api":
		writeAPIJSON(w, http.StatusOK, metav1.APIVersions{TypeMeta: metav1.TypeMeta{Kind: "APIVersions"}, Versions: []string{"v1"}})
	case r.URL.Path == "/apis":
		writeAPIJSON(w, http.StatusOK, metav1.APIGroupList{TypeMeta: metav1.TypeMeta{Kind: "APIGroupList", APIVersion: "v1"}})
	case r.URL.Path == "/api/v1":
		writeAPIJSON(w, http.StatusOK, metav1.APIResourceList{TypeMeta: metav1.TypeMeta{Kind: "APIResourceList", APIVersion: "v1"}, GroupVersion: "v1",
			APIResources: []metav1.APIResource{{Name: "secrets", Namespaced: true, Kind: "Secret", Verbs: metav1.Verbs{"get", "list", "create", "update"}}}})
	case r.URL.Path == secrets && r.Method == http.MethodGet:
		selector, err := labels.Parse(r.URL.Query().Get("labelSelector"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		list := corev1.SecretList{TypeMeta: metav1.TypeMeta{Kind: "SecretList", APIVersion: "v1"}}
		for _, s := range a.secrets {
			if selector.Matches(labels.Set(s.Labels)) {
				list.Items = append(list.Items, *s)
			}
		}
		writeAPIJSON(w, http.StatusOK, list)
	case strings.HasPrefix(r.URL.Path, secrets+"/") && r.Method == http.MethodGet && a.secrets[strings.TrimPrefix(r.URL.Path, secrets+"/")] != nil:
		writeAPIJSON(w, http.StatusOK, a.secrets[strings.TrimPrefix(r.URL.Path, secrets+"/")])
	case strings.HasPrefix(r.URL.Path, secrets) && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		body, _ := io.ReadAll(r.Body)
		s := &corev1.Secret{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, s); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.Kind, s.APIVersion = "Secret", "v1"
		a.secrets[s.Name] = s
		writeAPIJSON(w, http.StatusOK, s)
	default:
		writeAPIJSON(w, http.StatusNotFound, metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
			Status: metav1.StatusFailure, Reason: metav1.StatusReasonNotFound, Code: http.StatusNotFound, Message: r.URL.Path + " not found"})
	}
}

func releaseSecret(t *testing.T, rel *release.Release) *corev1.Secret {
	t.Helper()
	raw, err := json.Marshal(rel)
	if err != nil {
		t.Fatal(err)
	}
	var zipped bytes.Buffer
	gz := gzip.NewWriter(&zipped)
	if _, err := gz.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{Kind: "Secret", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("sh.helm.release.v1.%s.v%d", rel.Name, rel.Version), Namespace: rel.Namespace,
			Labels: map[string]string{"name": rel.Name, "owner": "helm", "status": rel.Info.Status.String(), "version": strconv.Itoa(rel.Version)}},
		Type: "helm.sh/release.v1",
		Data: map[string][]byte{"release": []byte(base64.StdEncoding.EncodeToString(zipped.Bytes()))},
	}
}

// upgradeValues sends values to the upgrade handler for a deployed release of a chart with the given schema and
// returns the handler's answer and the one audit row it left.
func upgradeValues(t *testing.T, schema, values string) (*httptest.ResponseRecorder, audit.Record) {
	t.Helper()
	ch := &chart.Chart{Metadata: &chart.Metadata{Name: "app", Version: "1.0.0", APIVersion: "v2"}}
	if schema != "" {
		ch.Schema = []byte(schema)
	}
	rel := &release.Release{Name: "app", Namespace: "team-a", Version: 1, Config: map[string]any{}, Info: &release.Info{Status: release.StatusDeployed}, Chart: ch}
	secret := releaseSecret(t, rel)
	api := httptest.NewServer(&helmAPI{secrets: map[string]*corev1.Secret{secret.Name: secret}})
	t.Cleanup(api.Close)

	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", api.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	store := &memAudit{}
	h := &Handler{svc: svc, helmSvc: helm.NewService(svc, nil), auditStore: store}

	body, err := json.Marshal(helm.UpgradeValuesRequest{Values: values})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/helm/releases/team-a/app/values", bytes.NewReader(body))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("namespace", "team-a")
	rc.URLParams.Add("name", "app")
	ctx := auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: auth.PermissionMatrix{"c": {"resource.helm.upgrade"}}})
	ctx = context.WithValue(cluster.WithID(ctx, "c"), chi.RouteCtxKey, rc)
	w := httptest.NewRecorder()
	h.UpgradeHelmValues(w, req.WithContext(ctx))

	if len(store.rows) != 1 || store.rows[0].Action != "helm.release.upgrade" {
		t.Fatalf("audit rows: %+v", store.rows)
	}
	return w, store.rows[0]
}

func rowText(rec audit.Record) string {
	return string(rec.Before) + "\n" + string(rec.After) + "\n" + rec.Error
}

func TestHelmUpgradeRowHoldsTheTopLevelKeysAndTheLength(t *testing.T) {
	cases := []struct {
		name   string
		values string
		keys   []string
		absent []string
	}{
		{"with a password", "image:\n  tag: fake-image-tag\nadminPassword: fake-admin-value\n", []string{"adminPassword", "image"}, []string{"fake-admin-value", "fake-image-tag"}},
		{"without a password", "replicaCount: 3\nimage:\n  tag: fake-image-tag\n", []string{"image", "replicaCount"}, []string{"fake-image-tag", "replicaCount: 3"}},
		{"no values", "", []string{}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, rec := upgradeValues(t, "", tc.values)
			if w.Code != http.StatusOK || rec.Result != audit.ResultSuccess {
				t.Fatalf("status %d, row %+v, body %s", w.Code, rec, w.Body.String())
			}
			for _, secret := range tc.absent {
				if strings.Contains(rowText(rec), secret) {
					t.Errorf("the row holds %q: %s", secret, rowText(rec))
				}
			}
			var after map[string]any
			if err := json.Unmarshal(rec.After, &after); err != nil {
				t.Fatal(err)
			}
			keys := []any{}
			for _, k := range tc.keys {
				keys = append(keys, k)
			}
			want := map[string]any{"newRevision": float64(2), "values_keys": keys, "values_len": float64(len(tc.values))}
			if !reflect.DeepEqual(after, want) {
				t.Errorf("after = %v, want %v", after, want)
			}
			if !strings.Contains(string(rec.Before), `"fromRevision":1`) {
				t.Errorf("before = %s", rec.Before)
			}
		})
	}
}

func TestHelmUpgradeRefusedByTheChartSchemaKeepsTheReasonButNoValue(t *testing.T) {
	digits := `{"type":"string","pattern":"^[0-9]+$"}`
	schema := `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{` +
		`"adminPassword":` + digits + `,"quoted":` + digits + `,"contact":{"type":"string","format":"email"},"limit":{"type":"integer","maximum":5},` +
		`"db":{"type":"object","properties":{"auth":{"type":"object","properties":{"pw":` + digits + `}}}},"tokens":{"type":"array","items":` + digits + `}}}`
	values := `adminPassword: fake-admin-value
quoted: "fake-it's-\"quoted\"\nvalue"
contact: fake-contact-value
limit: 9
db:
  auth:
    pw: fake-nested-value
tokens:
  - fake-list-value
`
	w, rec := upgradeValues(t, schema, values)
	if w.Code == http.StatusOK || rec.Result != audit.ResultFailure {
		t.Fatalf("status %d, row %+v", w.Code, rec)
	}
	if strings.Contains(rowText(rec), "fake") {
		t.Errorf("the row holds a value: %s", rowText(rec))
	}
	for _, reason := range []string{"/adminPassword", "does not match pattern", "/quoted", "/contact", "is not valid email", "/limit", "want 5", "/db/auth/pw", "/tokens/0"} {
		if !strings.Contains(rec.Error, reason) {
			t.Errorf("the row lost %q: %s", reason, rec.Error)
		}
	}
	if !strings.Contains(w.Body.String(), "fake-admin-value") {
		t.Errorf("the person who sent the values lost the full reason: %s", w.Body.String())
	}
}

func TestHelmUpgradeWithValuesThatDoNotParseKeepsNoValue(t *testing.T) {
	for _, values := range []string{"adminPassword: !!int fake-admin-value\n", "{a: fake-admin-value}: c\n"} {
		w, rec := upgradeValues(t, "", values)
		if w.Code == http.StatusOK || rec.Result != audit.ResultFailure {
			t.Fatalf("status %d, row %+v", w.Code, rec)
		}
		if strings.Contains(rowText(rec), "fake-admin-value") {
			t.Errorf("the row holds the value: %s", rowText(rec))
		}
		if !strings.Contains(rec.Error, "values must be valid YAML") {
			t.Errorf("the row lost the reason: %s", rec.Error)
		}
		if !strings.Contains(string(rec.After), fmt.Sprintf(`"values_len":%d`, len(values))) || !strings.Contains(string(rec.After), `"values_keys":[]`) {
			t.Errorf("after = %s", rec.After)
		}
		if !strings.Contains(w.Body.String(), "values must be valid YAML") {
			t.Errorf("the answer lost the reason: %s", w.Body.String())
		}
	}
}

func TestHelmUpgradeWithValuesThatAreNotAMapListsNoKeys(t *testing.T) {
	for _, values := range []string{"- fake-list-item\n", "fake-scalar-value\n", "# only a comment\n"} {
		_, rec := upgradeValues(t, "", values)
		if !strings.Contains(string(rec.After), `"values_keys":[]`) || strings.Contains(rowText(rec), "fake-") {
			t.Errorf("values %q: %s", values, rowText(rec))
		}
	}
}
