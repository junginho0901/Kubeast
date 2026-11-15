package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drains"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Two servers on one database: a drain started on one answers its status on the other, with the same
// end, and only one finished audit row is written for it.
func TestADrainStartedOnOneServerIsReadOnTheOther(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), guardRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	db := drains.NewMemory(nil)
	rows := make(drainRows, 4)
	a := &Handler{svc: svc, auditStore: rows, drains: drains.NewTracker(db, rows)}
	b := &Handler{svc: svc, auditStore: rows, drains: drains.NewTracker(db, rows)}
	perms := auth.PermissionMatrix{"a": {"resource.node.drain"}}
	request := func(method, target string) *http.Request {
		r := httptest.NewRequest(method, target, nil)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("name", "n1")
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
		ctx = auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: perms})
		return r.WithContext(cluster.WithID(ctx, "a"))
	}

	w := httptest.NewRecorder()
	a.DrainNode(w, request(http.MethodPost, "/api/v1/nodes/n1/drain"))
	var started struct {
		DrainID string `json:"drain_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &started); w.Code != http.StatusOK || err != nil || started.DrainID == "" {
		t.Fatalf("drain not started: %d %s", w.Code, w.Body)
	}
	var got []audit.Record
	for range 2 { // this registry has no cluster a, so the drain ends at once
		select {
		case rec := <-rows:
			got = append(got, rec)
		case <-time.After(10 * time.Second):
			t.Fatal("the drain did not end")
		}
	}
	if !strings.Contains(string(got[1].After), `"phase":"finished"`) || got[1].ActorUserID != "u1" || got[1].Cluster != "a" {
		t.Fatalf("finished row %+v", got[1])
	}

	read := func(h *Handler) DrainStatus {
		w := httptest.NewRecorder()
		h.DrainNodeStatus(w, request(http.MethodGet, "/api/v1/nodes/n1/drain/status?drain_id="+started.DrainID))
		var ds DrainStatus
		if err := json.Unmarshal(w.Body.Bytes(), &ds); w.Code != http.StatusOK || err != nil {
			t.Fatalf("status: %d %s", w.Code, w.Body)
		}
		return ds
	}
	onA, onB := read(a), read(b)
	if onA.Status != drains.StatusError || onB.Status != onA.Status || onB.Message != onA.Message || onB.Node != "n1" {
		t.Fatalf("server a %+v, server b %+v", onA, onB)
	}
	select {
	case rec := <-rows:
		t.Fatalf("a third audit row: %+v", rec)
	default:
	}
}

// The nodes left cordoned are read from the cluster: a node still cordoned is named, an uncordoned one is
// not, and a node that cannot be read leaves the list out rather than guess.
func TestTheNodesLeftCordonedAreReadFromTheCluster(t *testing.T) {
	cs := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "held"}, Spec: corev1.NodeSpec{Unschedulable: true}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "free"}},
	)
	ctx := context.Background()
	if got := cordonedOf(ctx, cs, []string{"held", "free"}); len(got) != 1 || got[0] != "held" {
		t.Fatalf("cordoned %v, want [held]", got)
	}
	if got := cordonedOf(ctx, cs, []string{"free"}); got == nil || len(got) != 0 {
		t.Fatalf("an uncordoned node: %v, want an empty list", got)
	}
	if got := cordonedOf(ctx, cs, []string{"held", "gone"}); got != nil {
		t.Fatalf("a node that cannot be read: %v, want nil", got)
	}
}

// The answer says [] when no node is left cordoned and null when the nodes were not read, so the screen
// tells "none" from "not read".
func TestTheAnswerTellsNoCordonedNodeFromNotRead(t *testing.T) {
	for _, c := range []struct {
		nodes []string
		want  string
	}{{[]string{}, `"cordoned_nodes":[]`}, {nil, `"cordoned_nodes":null`}, {[]string{"n1"}, `"cordoned_nodes":["n1"]`}} {
		b, err := json.Marshal(DrainStatus{ID: "d1", Node: "n1", Status: drains.StatusInterrupted, CordonedNodes: c.nodes})
		if err != nil || !strings.Contains(string(b), c.want) {
			t.Errorf("%v: %s, want %s", c.nodes, b, c.want)
		}
	}
}

// Once the server has begun to shut down a new drain answers 503 and leaves a failure row; nothing runs.
func TestADrainIsRefusedOnceTheServerShutsDown(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), guardRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	db := drains.NewMemory(nil)
	rows := make(drainRows, 4)
	tr := drains.NewTracker(db, rows)
	h := &Handler{svc: svc, auditStore: rows, drains: tr}
	tr.Shutdown(context.Background())

	r := httptest.NewRequest(http.MethodPost, "/api/v1/nodes/n1/drain", nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("name", "n1")
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
	ctx = auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: auth.PermissionMatrix{"a": {"resource.node.drain"}}})
	w := httptest.NewRecorder()
	h.DrainNode(w, r.WithContext(cluster.WithID(ctx, "a")))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "shutting down") {
		t.Fatalf("drain during shutdown: %d %s, want 503", w.Code, w.Body)
	}
	select {
	case rec := <-rows:
		if rec.Action != "k8s.node.drain" || rec.Result != audit.ResultFailure || !strings.Contains(rec.Error, "shutting down") || rec.ActorUserID != "u1" {
			t.Fatalf("audit row %+v", rec)
		}
	default:
		t.Fatal("no audit row for the refused drain")
	}
	select {
	case rec := <-rows:
		t.Fatalf("a second audit row: %+v", rec)
	case <-time.After(100 * time.Millisecond):
	}
}
