package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/release"
	corev1 "k8s.io/api/core/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// helmValuesConfig is what a release was installed with: values the masked text hides whole (a string, a number, a
// block), one it hides a part of and one under a Secret the values carry.
func helmValuesConfig() map[string]any {
	return map[string]any{
		"adminPassword": "fake-admin-value",
		"dbPassword":    float64(87654321),
		"replicaCount":  float64(2),
		"image":         map[string]any{"tag": "fake-image-tag"},
		"db":            map[string]any{"url": "postgres://app:fake-url-password@db.shop:5432/app"},
		"cert":          map[string]any{"token": "fake block line one\nfake block line two\n"},
		"extraObjects": []any{map[string]any{
			"kind":       "Secret",
			"metadata":   map[string]any{"name": "extra"},
			"stringData": map[string]any{"password": "fake-nested-value"},
		}},
	}
}

var helmValuesKept = []any{"adminPassword", "cert.token", "db.url", "dbPassword", "extraObjects[0].stringData.password"}

// helmValuesSecrets are what must never come back to a caller who cannot reveal them.
var helmValuesSecrets = []string{"fake-admin-value", "87654321", "fake-url-password", "fake block line", "fake-nested-value"}

type helmValuesRig struct {
	t     *testing.T
	api   *helmAPI
	h     *Handler
	store *memAudit
	perms []string
}

func newHelmValuesRig(t *testing.T, ch *chart.Chart, perms ...string) *helmValuesRig {
	t.Helper()
	return newHelmValuesRigOf(t, ch, helmValuesConfig(), "", perms...)
}

// newHelmValuesRigOf is a rig whose current revision holds config and has already rendered manifest.
func newHelmValuesRigOf(t *testing.T, ch *chart.Chart, config map[string]any, manifest string, perms ...string) *helmValuesRig {
	t.Helper()
	rel := &release.Release{Name: "app", Namespace: "team-a", Version: 1, Config: config, Info: &release.Info{Status: release.StatusDeployed}, Chart: ch, Manifest: manifest}
	secret := releaseSecret(t, rel)
	api := &helmAPI{secrets: map[string]*corev1.Secret{secret.Name: secret}}
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)

	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", server.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	store := &memAudit{}
	return &helmValuesRig{t: t, api: api, h: &Handler{svc: svc, helmSvc: helm.NewService(svc, nil), auditStore: store}, store: store, perms: perms}
}

func helmValuesChart() *chart.Chart {
	return &chart.Chart{Metadata: &chart.Metadata{Name: "app", Version: "1.0.0", APIVersion: "v2"}}
}

func helmEditorPerms() []string { return []string{"resource.helm.read", "resource.helm.upgrade"} }

func (r *helmValuesRig) request(method, path string, body []byte, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	rc := chi.NewRouteContext()
	for key, value := range params {
		rc.URLParams.Add(key, value)
	}
	ctx := auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: auth.PermissionMatrix{"c": r.perms}})
	return req.WithContext(context.WithValue(cluster.WithID(ctx, "c"), chi.RouteCtxKey, rc))
}

// shown is the values text the Values tab gets.
func (r *helmValuesRig) shown() string {
	r.t.Helper()
	w := httptest.NewRecorder()
	r.h.GetHelmReleaseSection(w, r.request(http.MethodGet, "/api/v1/helm/releases/team-a/app/values", nil, map[string]string{"namespace": "team-a", "name": "app", "section": "values"}))
	var answer map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil || w.Code != http.StatusOK {
		r.t.Fatalf("status %d body %s: %v", w.Code, w.Body, err)
	}
	return answer["content"]
}

func (r *helmValuesRig) upgrade(values string, dryRun bool) *httptest.ResponseRecorder {
	r.t.Helper()
	body, err := json.Marshal(helm.UpgradeValuesRequest{Values: values, DryRun: dryRun})
	if err != nil {
		r.t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r.h.UpgradeHelmValues(w, r.request(http.MethodPut, "/api/v1/helm/releases/team-a/app/values", body, map[string]string{"namespace": "team-a", "name": "app"}))
	return w
}

// stored is the values of a revision, as the Helm release Secret holds them; false without that revision.
func (r *helmValuesRig) stored(version int) (map[string]any, bool) {
	r.t.Helper()
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	secret, ok := r.api.secrets["sh.helm.release.v1.app.v"+string(rune('0'+version))]
	if !ok {
		return nil, false
	}
	zipped, err := base64.StdEncoding.DecodeString(string(secret.Data["release"]))
	if err != nil {
		r.t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(zipped))
	if err != nil {
		r.t.Fatal(err)
	}
	raw, err := io.ReadAll(gz)
	if err != nil {
		r.t.Fatal(err)
	}
	var rel release.Release
	if err := json.Unmarshal(raw, &rel); err != nil {
		r.t.Fatal(err)
	}
	return rel.Config, true
}

func (r *helmValuesRig) lastRow() audit.Record {
	r.t.Helper()
	if len(r.store.rows) == 0 {
		r.t.Fatal("no audit row")
	}
	return r.store.rows[len(r.store.rows)-1]
}

func (r *helmValuesRig) wantNoSecretIn(where, text string) {
	r.t.Helper()
	for _, secret := range helmValuesSecrets {
		if strings.Contains(text, secret) {
			r.t.Errorf("%s holds %q: %s", where, secret, text)
		}
	}
}

func keptMaskedOf(t *testing.T, raw []byte) []any {
	t.Helper()
	var answer map[string]any
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	kept, _ := answer["kept_masked"].([]any)
	return kept
}

// The text the tab shows hides the values; left as shown, each stands for the value it hides, and the edit beside it goes
// through. What stayed is said by name, in the preview, the answer and the row, and no value comes back.
func TestHelmUpgradeWithoutRevealKeepsWhatWasMasked(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	shown := r.shown()
	r.wantNoSecretIn("the tab", shown)
	draft := strings.Replace(shown, "replicaCount: 2", "replicaCount: 5", 1)
	if draft == shown {
		t.Fatalf("nothing to edit in %s", shown)
	}

	preview := r.upgrade(draft, true)
	if preview.Code != http.StatusOK {
		t.Fatalf("dry-run status %d: %s", preview.Code, preview.Body)
	}
	if got := keptMaskedOf(t, preview.Body.Bytes()); !reflect.DeepEqual(got, helmValuesKept) {
		t.Errorf("the preview says kept %v, want %v", got, helmValuesKept)
	}
	r.wantNoSecretIn("the preview", preview.Body.String())
	if _, ok := r.stored(2); ok {
		t.Fatal("the dry-run made a revision")
	}

	w := r.upgrade(draft, false)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got, ok := r.stored(2)
	if !ok {
		t.Fatal("no new revision")
	}
	want := helmValuesConfig()
	want["replicaCount"] = float64(5)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("the stored values = %v, want %v", got, want)
	}
	if kept := keptMaskedOf(t, w.Body.Bytes()); !reflect.DeepEqual(kept, helmValuesKept) {
		t.Errorf("the answer says kept %v, want %v", kept, helmValuesKept)
	}
	r.wantNoSecretIn("the answer", w.Body.String())
	row := r.lastRow()
	if row.Action != "helm.release.upgrade" || row.Result != audit.ResultSuccess {
		t.Fatalf("row %+v", row)
	}
	r.wantNoSecretIn("the row", rowText(row))
	if kept := keptMaskedOf(t, row.After); !reflect.DeepEqual(kept, helmValuesKept) {
		t.Errorf("the row says kept %v, want %v", kept, helmValuesKept)
	}
}

// A value written over its mask is the new value: an editor without reveal can still change one they cannot read.
func TestHelmUpgradeWithoutRevealWritesWhatWasWrittenOverAMask(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	draft := strings.Replace(r.shown(), "adminPassword: <REDACTED:adminPassword>", "adminPassword: fake-new-value", 1)
	w := r.upgrade(draft, false)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got, _ := r.stored(2)
	want := helmValuesConfig()
	want["adminPassword"] = "fake-new-value"
	if !reflect.DeepEqual(got, want) {
		t.Errorf("the stored values = %v, want %v", got, want)
	}
	for _, name := range keptMaskedOf(t, w.Body.Bytes()) {
		if name == "adminPassword" {
			t.Errorf("a value written over its mask is named as kept: %s", w.Body)
		}
	}
}

// A line the editor took out goes, as without masks: the upgrade replaces the values, and this is how an override is removed.
func TestHelmUpgradeWithoutRevealLeavesOutALineTheEditorRemoved(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	shown := r.shown()
	draft := strings.Replace(shown, "adminPassword: <REDACTED:adminPassword>\n", "", 1)
	if draft == shown {
		t.Fatalf("no such line in %s", shown)
	}
	if w := r.upgrade(draft, false); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got, _ := r.stored(2)
	if _, there := got["adminPassword"]; there || got["dbPassword"] != float64(87654321) {
		t.Errorf("the stored values = %v", got)
	}
}

// A mask has no value to keep where it did not stand: anywhere else, or with the text around it edited, nothing is
// written, and the answer and the failure row name the place and no value.
func TestHelmUpgradeWithoutRevealRefusesAMaskThatStandsForNoValueThere(t *testing.T) {
	for _, c := range []struct {
		title string
		edit  func(string) string
		place string
	}{
		{"a copy under another key", func(s string) string { return s + "note: <REDACTED:adminPassword>\n" }, "note"},
		{"under a renamed key", func(s string) string {
			return strings.Replace(s, "adminPassword: <REDACTED", "rootPassword: <REDACTED", 1)
		}, "rootPassword"},
		{"the text around a partial mask edited", func(s string) string { return strings.Replace(s, "db.shop", "db.other", 1) }, "db.url"},
		{"another key's mask", func(s string) string {
			return strings.Replace(s, "dbPassword: <REDACTED:dbPassword>", "dbPassword: <REDACTED:adminPassword>", 1)
		}, "dbPassword"},
		{"a mask in a key", func(s string) string { return s + "<REDACTED:adminPassword>: a\n" }, "<REDACTED:adminPassword>"},
	} {
		t.Run(c.title, func(t *testing.T) {
			r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
			shown := r.shown()
			draft := c.edit(shown)
			if draft == shown {
				t.Fatalf("the edit changed nothing in %s", shown)
			}
			preview := r.upgrade(draft, true)
			w := r.upgrade(draft, false)
			for name, answer := range map[string]*httptest.ResponseRecorder{"preview": preview, "upgrade": w} {
				var body map[string]string
				if err := json.Unmarshal(answer.Body.Bytes(), &body); err != nil {
					t.Fatalf("%s: %s: %v", name, answer.Body, err)
				}
				if answer.Code != http.StatusBadRequest || !strings.Contains(body["detail"], c.place) {
					t.Errorf("%s: status %d body %s, want 400 naming %s", name, answer.Code, answer.Body, c.place)
				}
				r.wantNoSecretIn(name, answer.Body.String())
			}
			if _, ok := r.stored(2); ok {
				got, _ := r.stored(2)
				t.Errorf("a revision was made: %v", got)
			}
			row := r.lastRow()
			if row.Result != audit.ResultFailure || !strings.Contains(row.Error, c.place) {
				t.Errorf("row %+v", row)
			}
			r.wantNoSecretIn("the row", rowText(row))
		})
	}
}

// A chart's refusal or a template's failure can quote the values it was given: a value kept for an editor who cannot
// read it stays out of the answer and the row, and the reason stays in.
func TestHelmUpgradeWithoutRevealKeepsAKeptValueOutOfAFailure(t *testing.T) {
	refusing := helmValuesChart()
	refusing.Schema = []byte(`{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"adminPassword":{"type":"string","pattern":"^[0-9]+$"}}}`)
	failing := helmValuesChart()
	failing.Templates = []*chart.File{{Name: "templates/x.yaml", Data: []byte(`{{ fail (printf "%s %v" .Values.adminPassword .Values.dbPassword) }}`)}}
	for _, c := range []struct {
		title  string
		ch     *chart.Chart
		reason string
	}{{"a chart schema", refusing, "does not match pattern"}, {"a template", failing, "execution error"}} {
		t.Run(c.title, func(t *testing.T) {
			r := newHelmValuesRig(t, c.ch, helmEditorPerms()...)
			draft := strings.Replace(r.shown(), "replicaCount: 2", "replicaCount: 5", 1)
			for _, dryRun := range []bool{true, false} {
				w := r.upgrade(draft, dryRun)
				if w.Code == http.StatusOK || !strings.Contains(w.Body.String(), c.reason) {
					t.Fatalf("dryRun %v: status %d body %s, want the reason %q", dryRun, w.Code, w.Body, c.reason)
				}
				r.wantNoSecretIn("the answer", w.Body.String())
			}
			row := r.lastRow()
			if row.Result != audit.ResultFailure || !strings.Contains(row.Error, c.reason) {
				t.Errorf("row %+v", row)
			}
			r.wantNoSecretIn("the row", rowText(row))
		})
	}
}

// Whoever may reveal reads the values themselves, so what they send is what they mean, a placeholder's letters too.
func TestHelmUpgradeWithRevealWritesWhatItSays(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), append(helmEditorPerms(), "resource.secret.reveal")...)
	const values = "adminPassword: <REDACTED:adminPassword>\nreplicaCount: 3\n"
	w := r.upgrade(values, false)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got, _ := r.stored(2)
	if want := map[string]any{"adminPassword": "<REDACTED:adminPassword>", "replicaCount": float64(3)}; !reflect.DeepEqual(got, want) {
		t.Errorf("the stored values = %v, want %v", got, want)
	}
	if strings.Contains(w.Body.String(), "kept_masked") || strings.Contains(string(r.lastRow().After), "kept_masked") {
		t.Errorf("answer %s, row %s", w.Body, r.lastRow().After)
	}
}

// A rollback takes a revision and no text, so what it restores is the revision's own values.
func TestHelmRollbackWithoutRevealRestoresTheRevisionsValues(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), append(helmEditorPerms(), "resource.helm.rollback")...)
	draft := strings.Replace(r.shown(), "replicaCount: 2", "replicaCount: 5", 1)
	if w := r.upgrade(draft, false); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	w := httptest.NewRecorder()
	body, _ := json.Marshal(helm.RollbackRequest{Revision: 1})
	r.h.RollbackHelmRelease(w, r.request(http.MethodPost, "/api/v1/helm/releases/team-a/app/rollback", body, map[string]string{"namespace": "team-a", "name": "app"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	r.wantNoSecretIn("the answer", w.Body.String())
	if got, ok := r.stored(3); !ok || !reflect.DeepEqual(got, helmValuesConfig()) {
		t.Errorf("revision 3 holds %v", got)
	}
}

// Values with no mask go through without a word for anyone.
func TestHelmUpgradeWithoutRevealWritesPlainValuesAsTheyAre(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	w := r.upgrade("replicaCount: 7\nimage:\n  tag: fake-other-tag\n", false)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "kept_masked") {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	got, _ := r.stored(2)
	if want := map[string]any{"replicaCount": float64(7), "image": map[string]any{"tag": "fake-other-tag"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("the stored values = %v, want %v", got, want)
	}
}
