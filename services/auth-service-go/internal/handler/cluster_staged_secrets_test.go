package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// secretBox is a secret store in memory; a Secret named in refuse is not written.
type secretBox struct {
	kubeconfigs map[string]string
	values      map[string]map[string]string
	refuse      map[string]bool
}

func newSecretBox() *secretBox {
	return &secretBox{kubeconfigs: map[string]string{}, values: map[string]map[string]string{}, refuse: map[string]bool{}}
}

func (b *secretBox) ReadKubeconfig(_ context.Context, name string) (string, error) {
	v, ok := b.kubeconfigs[name]
	if !ok {
		return "", errors.New("secret " + name + " not found")
	}
	return v, nil
}

func (b *secretBox) ReadValue(_ context.Context, name, key string) (string, error) {
	v, ok := b.values[name][key]
	if !ok {
		return "", errors.New("secret " + name + " not found")
	}
	return v, nil
}

func (b *secretBox) WriteKubeconfig(_ context.Context, id cluster.ID, content string) (string, error) {
	name := cluster.SecretName(id)
	if b.refuse[name] {
		return "", errors.New("the API server refused " + name)
	}
	b.kubeconfigs[name] = content
	return name, nil
}

func (b *secretBox) DeleteKubeconfig(_ context.Context, name string) error {
	delete(b.kubeconfigs, name)
	return nil
}

func (b *secretBox) WriteValue(_ context.Context, name, key, value string) error {
	if b.refuse[name] {
		return errors.New("the API server refused " + name)
	}
	if b.values[name] == nil {
		b.values[name] = map[string]string{}
	}
	b.values[name][key] = value
	return nil
}

func (b *secretBox) DeleteSecret(_ context.Context, name string) error {
	delete(b.values, name)
	return nil
}

func changeRequest() *http.Request {
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/clusters/prod", nil)
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "a1", Email: "admin@example.com"}))
}

// A row change that did not commit after its Secrets were written (the commit or the database failed) puts each
// Secret back to what it held, so the stored headers again match the config_version k8s-service compares; the answer
// is a 500 and the audit row a failure naming the database's error.
func TestAChangeThatDidNotCommitPutsItsSecretsBack(t *testing.T) {
	box := newSecretBox()
	promName, lsName := cluster.PrometheusSecretName("prod"), cluster.LogSearchSecretName("prod")
	box.values[promName] = map[string]string{cluster.PrometheusAuthKey: "Bearer old-prom"}
	box.values[lsName] = map[string]string{cluster.LogSearchAuthKey: "Bearer old-logs"}
	store := &memAuditStore{}
	h := &ClustersHandler{secrets: box, auditStore: store}
	staged := []*stagedSecret{
		h.stageValue("prometheus auth", promName, cluster.PrometheusAuthKey, "Bearer new-prom"),
		h.stageValue("log search auth", lsName, cluster.LogSearchAuthKey, "Bearer new-logs"),
	}
	if err := storeAll(staged)(context.Background()); err != nil {
		t.Fatal(err)
	}
	if box.values[promName][cluster.PrometheusAuthKey] != "Bearer new-prom" {
		t.Fatal("the staged write did not go through")
	}

	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, map[string]string{"prometheus_auth": "set"}, staged, errors.New("commit: connection reset"))

	if got := box.values[promName][cluster.PrometheusAuthKey]; got != "Bearer old-prom" {
		t.Errorf("prometheus header %q after the change failed, want the one before", got)
	}
	if got := box.values[lsName][cluster.LogSearchAuthKey]; got != "Bearer old-logs" {
		t.Errorf("log store header %q after the change failed, want the one before", got)
	}
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "connection reset") {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 {
		t.Fatalf("%d audit rows, want 1", len(store.written))
	}
	rec := store.written[0]
	if rec.Action != "admin.cluster.update" || rec.Result != audit.ResultFailure || rec.Error != "commit: connection reset" {
		t.Fatalf("row %s %s %q", rec.Action, rec.Result, rec.Error)
	}
	if strings.Contains(rec.Error+string(rec.After), "Bearer") {
		t.Fatalf("the row holds a header: %q %s", rec.Error, rec.After)
	}
}

// A Secret the store refuses stops the row change: the Secrets written before it are put back, the answer is a 500
// with the store's reason and the audit row a failure.
func TestARefusedSecretWritePutsTheEarlierOnesBack(t *testing.T) {
	box := newSecretBox()
	promName, lsName := cluster.PrometheusSecretName("prod"), cluster.LogSearchSecretName("prod")
	box.values[promName] = map[string]string{cluster.PrometheusAuthKey: "Bearer old-prom"}
	box.refuse[lsName] = true
	store := &memAuditStore{}
	h := &ClustersHandler{secrets: box, auditStore: store}
	staged := []*stagedSecret{
		h.stageValue("prometheus auth", promName, cluster.PrometheusAuthKey, "Bearer new-prom"),
		h.stageValue("log search auth", lsName, cluster.LogSearchAuthKey, "Bearer new-logs"),
	}
	err := storeAll(staged)(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "store log search auth: ") {
		t.Fatalf("store = %v", err)
	}

	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, nil, staged, err)

	if got := box.values[promName][cluster.PrometheusAuthKey]; got != "Bearer old-prom" {
		t.Errorf("prometheus header %q, want the one before", got)
	}
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "store log search auth") {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 || store.written[0].Result != audit.ResultFailure || !strings.HasPrefix(store.written[0].Error, "store log search auth: ") {
		t.Fatalf("rows %+v", store.written)
	}
}

// A kubeconfig whose value before could not be read stays as written when its change does not commit, and the audit
// row says so; a row gone is a 404 with a failure row.
func TestWhatCannotBePutBackIsInTheFailureRow(t *testing.T) {
	box := newSecretBox() // no kubeconfig stored before
	store := &memAuditStore{}
	h := &ClustersHandler{secrets: box, auditStore: store}
	staged := []*stagedSecret{h.stageKubeconfig("prod", "apiVersion: v1\nkind: Config\n")}
	if err := storeAll(staged)(context.Background()); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, map[string]string{"kubeconfig": "replace"}, staged, errors.New("commit: connection reset"))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("answer %d", w.Code)
	}
	if rec := store.written[0]; rec.Result != audit.ResultFailure || !strings.Contains(rec.Error, "left as written: kubeconfig") {
		t.Fatalf("row %s %q", rec.Result, rec.Error)
	}

	gone := &memAuditStore{}
	h = &ClustersHandler{secrets: newSecretBox(), auditStore: gone}
	w = httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, nil, nil, cluster.ErrNotFound)
	if w.Code != http.StatusNotFound || len(gone.written) != 1 || gone.written[0].Result != audit.ResultFailure {
		t.Fatalf("answer %d rows %+v", w.Code, gone.written)
	}
}

// With nothing staged the row change runs no store.
func TestNothingStagedIsNoStore(t *testing.T) {
	if storeAll(nil) != nil {
		t.Fatal("a store for nothing staged")
	}
}
