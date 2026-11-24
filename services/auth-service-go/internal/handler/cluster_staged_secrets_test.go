package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// secretBox is a secret store in memory; a Secret named in refuse is not written, and one named in stall is written
// and then not answered until the write's context ends (an API server that applied it and went quiet).
type secretBox struct {
	kubeconfigs map[string]string
	values      map[string]map[string]string
	refuse      map[string]bool
	stall       map[string]bool
}

func newSecretBox() *secretBox {
	return &secretBox{kubeconfigs: map[string]string{}, values: map[string]map[string]string{}, refuse: map[string]bool{}, stall: map[string]bool{}}
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

func (b *secretBox) WriteValue(ctx context.Context, name, key, value string) error {
	if b.refuse[name] {
		return errors.New("the API server refused " + name)
	}
	if b.values[name] == nil {
		b.values[name] = map[string]string{}
	}
	b.values[name][key] = value
	if b.stall[name] {
		delete(b.stall, name) // the put back is answered
		<-ctx.Done()
		return fmt.Errorf("write secret %s: %w", name, ctx.Err())
	}
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
// Secret back to what it held (the registry calls PutBack), so the stored headers again match the config_version
// k8s-service compares, and reports a change; the answer is a 500 and the audit row a failure naming the database's
// error.
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
	writes := secretWrites(staged)
	if err := writes.Store(context.Background()); err != nil {
		t.Fatal(err)
	}
	if box.values[promName][cluster.PrometheusAuthKey] != "Bearer new-prom" {
		t.Fatal("the staged write did not go through")
	}
	if changed, left := writes.PutBack(context.Background()); !changed || left != "" {
		t.Fatalf("PutBack = %v, %q; want a change put back whole", changed, left)
	}
	if got := box.values[promName][cluster.PrometheusAuthKey]; got != "Bearer old-prom" {
		t.Errorf("prometheus header %q after the change failed, want the one before", got)
	}
	if got := box.values[lsName][cluster.LogSearchAuthKey]; got != "Bearer old-logs" {
		t.Errorf("log store header %q after the change failed, want the one before", got)
	}

	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, map[string]string{"prometheus_auth": "set"}, staged, errors.New("commit: connection reset"))
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

// In docker-compose mode the kubeconfig is the FilesystemSecretStore's file of the cluster: a rotation reads that file
// before it writes, so a row change that did not commit puts the earlier kubeconfig back in it.
func TestAKubeconfigFileRotationThatDidNotCommitPutsTheFileBack(t *testing.T) {
	store := cluster.NewFilesystemSecretStore(t.TempDir())
	path, err := store.WriteKubeconfig(context.Background(), "prod", "apiVersion: v1\nkind: Config\n# old\n")
	if err != nil {
		t.Fatal(err)
	}
	h := &ClustersHandler{secrets: store}
	writes := secretWrites([]*stagedSecret{h.stageKubeconfig("prod", "apiVersion: v1\nkind: Config\n# new\n")})
	if err := writes.Store(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); !strings.HasSuffix(string(got), "# new\n") {
		t.Fatalf("file after the write: %q", got)
	}
	if changed, left := writes.PutBack(context.Background()); !changed || left != "" {
		t.Fatalf("PutBack = %v, %q; want the file put back", changed, left)
	}
	if got, _ := os.ReadFile(path); !strings.HasSuffix(string(got), "# old\n") {
		t.Errorf("file after the change failed: %q, want the kubeconfig before", got)
	}
}

// A Secret the store refuses stops the row change: the Secrets written before it are put back, the answer is a 500
// with the store's reason and the audit row a failure. A refusal of the first write changed nothing, so the registry
// sets no new config_version for it.
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
	writes := secretWrites(staged)
	err := writes.Store(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "store log search auth: ") {
		t.Fatalf("store = %v", err)
	}
	if changed, left := writes.PutBack(context.Background()); !changed || left != "" {
		t.Fatalf("PutBack = %v, %q", changed, left)
	}
	if got := box.values[promName][cluster.PrometheusAuthKey]; got != "Bearer old-prom" {
		t.Errorf("prometheus header %q, want the one before", got)
	}

	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, nil, staged, err)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "store log search auth") {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 || store.written[0].Result != audit.ResultFailure || !strings.HasPrefix(store.written[0].Error, "store log search auth: ") {
		t.Fatalf("rows %+v", store.written)
	}

	first := secretWrites([]*stagedSecret{h.stageValue("log search auth", lsName, cluster.LogSearchAuthKey, "Bearer new-logs")})
	if err := first.Store(context.Background()); err == nil {
		t.Fatal("a refused write stored")
	}
	if changed, left := first.PutBack(context.Background()); changed || left != "" {
		t.Fatalf("PutBack after a refused first write = %v, %q; want nothing changed", changed, left)
	}
}

// What could not be put back is named in the audit row and in the answer, through response.Public (no address of the
// Secret store): after a database failure, whose own text stays out of the answer, and after a refused write. A row
// gone is a 404 with a failure row.
func TestWhatCannotBePutBackIsInTheFailureRowAndTheAnswer(t *testing.T) {
	box := newSecretBox() // no kubeconfig stored before
	store := &memAuditStore{}
	h := &ClustersHandler{secrets: box, auditStore: store}
	staged := []*stagedSecret{h.stageKubeconfig("prod", "apiVersion: v1\nkind: Config\n")}
	writes := secretWrites(staged)
	if err := writes.Store(context.Background()); err != nil {
		t.Fatal(err)
	}
	changed, left := writes.PutBack(context.Background())
	if !changed || left != "kubeconfig (the value before was not read)" {
		t.Fatalf("PutBack = %v, %q", changed, left)
	}
	err := &cluster.PutBackError{Err: errors.New("commit: connection reset"), Left: "left as written: " + left}
	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, map[string]string{"kubeconfig": "replace"}, staged, err)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "left as written: kubeconfig (the value before was not read)") || strings.Contains(w.Body.String(), "connection reset") {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if rec := store.written[0]; rec.Result != audit.ResultFailure || rec.Error != "commit: connection reset; left as written: kubeconfig (the value before was not read)" {
		t.Fatalf("row %s %q", rec.Result, rec.Error)
	}

	refusedStore := &memAuditStore{}
	h = &ClustersHandler{secrets: newSecretBox(), auditStore: refusedStore}
	refused := []*stagedSecret{h.stageValue("log search auth", "logs", cluster.LogSearchAuthKey, "Bearer new-logs")}
	refused[0].err = errors.New("the API server refused logs")
	unreachable := `prometheus auth (Put "https://10.0.0.1:6443/api/v1/namespaces/kubeast/secrets/prom": dial tcp 10.0.0.1:6443: connect: connection refused)`
	err = &cluster.PutBackError{Err: errors.New("store log search auth: the API server refused logs"), Left: "left as written: " + unreachable}
	w = httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, nil, refused, err)
	body := w.Body.String()
	if w.Code != http.StatusInternalServerError || !strings.Contains(body, "store log search auth") || !strings.Contains(body, "left as written: prometheus auth (server unreachable") || strings.Contains(body, "10.0.0.1") {
		t.Fatalf("answer %d %s", w.Code, body)
	}
	if rec := refusedStore.written[0]; rec.Result != audit.ResultFailure || !strings.Contains(rec.Error, "left as written: prometheus auth") {
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

// A store that runs past its deadline (changeRow's, short here) fails like any other: the Secrets written before it
// and the one it may have applied are put back, the answer is a 500 with the reason and the audit row a failure.
func TestAStoreThatRunsOutOfTimeIsAFailureLikeAnyOther(t *testing.T) {
	box := newSecretBox()
	promName, lsName := cluster.PrometheusSecretName("prod"), cluster.LogSearchSecretName("prod")
	box.values[promName] = map[string]string{cluster.PrometheusAuthKey: "Bearer old-prom"}
	box.values[lsName] = map[string]string{cluster.LogSearchAuthKey: "Bearer old-logs"}
	box.stall[lsName] = true
	store := &memAuditStore{}
	h := &ClustersHandler{secrets: box, auditStore: store}
	staged := []*stagedSecret{
		h.stageValue("prometheus auth", promName, cluster.PrometheusAuthKey, "Bearer new-prom"),
		h.stageValue("log search auth", lsName, cluster.LogSearchAuthKey, "Bearer new-logs"),
	}
	writes := secretWrites(staged)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := writes.Store(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("store = %v, want the deadline", err)
	}
	if changed, left := writes.PutBack(context.Background()); !changed || left != "" {
		t.Fatalf("PutBack = %v, %q", changed, left)
	}
	if got := box.values[promName][cluster.PrometheusAuthKey]; got != "Bearer old-prom" {
		t.Errorf("prometheus header %q, want the one before", got)
	}
	if got := box.values[lsName][cluster.LogSearchAuthKey]; got != "Bearer old-logs" {
		t.Errorf("log store header %q after its write ran out of time, want the one before", got)
	}

	w := httptest.NewRecorder()
	h.failClusterChange(w, changeRequest(), auth.TokenPayload{UserID: "a1"}, "prod", nil, nil, staged, err)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "store log search auth") || !strings.Contains(w.Body.String(), "deadline exceeded") {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 || store.written[0].Result != audit.ResultFailure || !strings.Contains(store.written[0].Error, "deadline exceeded") {
		t.Fatalf("rows %+v", store.written)
	}
}

// With nothing staged the row change writes nothing.
func TestNothingStagedIsNoStore(t *testing.T) {
	if w := secretWrites(nil); w.Store != nil || w.PutBack != nil {
		t.Fatal("writes for nothing staged")
	}
}
