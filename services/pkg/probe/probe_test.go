package probe

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func answer(t *testing.T, h http.HandlerFunc) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return rec.Code, body
}

type pinger struct {
	err   error
	block bool
}

func (p pinger) Ping(ctx context.Context) error {
	if p.block {
		<-ctx.Done()
		return ctx.Err()
	}
	return p.err
}

func TestLiveAsksNoDependency(t *testing.T) {
	p := New().Require("database", func(context.Context) error { return errors.New("down") })
	p.Leave()
	if code, _ := answer(t, p.Live); code != http.StatusOK {
		t.Fatalf("live answered %d with the database down and the server leaving", code)
	}
}

func TestReadyFollowsTheRequiredDependency(t *testing.T) {
	down := errors.New("dial tcp 10.0.0.5:5432: connection refused")
	db := &pinger{err: down}
	p := New().Require("database", Database(db, nil))
	code, body := answer(t, p.Ready)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("ready answered %d with the database down", code)
	}
	if got := body["waiting_for"].([]any); len(got) != 1 || got[0] != "database" {
		t.Fatalf("waiting_for = %v", got)
	}
	if b, _ := json.Marshal(body); strings.Contains(string(b), "10.0.0.5") || strings.Contains(string(b), "refused") {
		t.Fatalf("the body names the error: %s", b)
	}
	db.err = nil
	if code, _ := answer(t, p.Ready); code != http.StatusOK {
		t.Fatalf("ready answered %d with the database back", code)
	}
}

func TestABusyPoolIsNotADatabaseGone(t *testing.T) {
	db := pinger{block: true}
	busy := true
	p := New().Require("database", Database(db, func() bool { return busy }))
	if code, _ := answer(t, p.Ready); code != http.StatusOK {
		t.Fatalf("ready answered %d while every connection was taken", code)
	}
	busy = false
	if code, _ := answer(t, p.Ready); code != http.StatusServiceUnavailable {
		t.Fatalf("ready answered %d when a ping ran out of time with connections free", code)
	}
}

func TestLeaveEndsReadinessAndEveryHeldContext(t *testing.T) {
	p := New()
	ctx, release := p.Hold(context.Background())
	defer release()
	if code, _ := answer(t, p.Ready); code != http.StatusOK {
		t.Fatalf("ready answered %d before Leave", code)
	}
	p.Leave()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("the held context did not end on Leave")
	}
	if !IsLeaving(ctx) {
		t.Fatalf("cause = %v, want ErrLeaving", context.Cause(ctx))
	}
	code, body := answer(t, p.Ready)
	if code != http.StatusServiceUnavailable || body["status"] != "leaving" {
		t.Fatalf("ready answered %d %v after Leave", code, body)
	}
	late, releaseLate := p.Hold(context.Background())
	defer releaseLate()
	select {
	case <-late.Done():
	case <-time.After(time.Second):
		t.Fatal("a context held after Leave did not end")
	}
}

func TestAContextEndedByItsParentIsNotLeaving(t *testing.T) {
	p := New()
	parent, cancel := context.WithCancelCause(context.Background())
	ctx, release := p.Hold(parent)
	defer release()
	cause := errors.New("session ended")
	cancel(cause)
	<-ctx.Done()
	if IsLeaving(ctx) || !errors.Is(context.Cause(ctx), cause) {
		t.Fatalf("cause = %v: the parent's cause should stand", context.Cause(ctx))
	}
}

func TestWaitWaitsForTheHeldToBeReleased(t *testing.T) {
	p := New()
	_, release := p.Hold(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		release()
		release() // a second call changes nothing
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !p.Wait(ctx) {
		t.Fatal("Wait ended before the release")
	}
	if p.Held() != 0 {
		t.Fatalf("held = %d after the release", p.Held())
	}
	_, stay := p.Hold(context.Background())
	defer stay()
	short, cancelShort := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelShort()
	if p.Wait(short) {
		t.Fatal("Wait reported every connection released while one was held")
	}
}

func TestANilProbeHoldsNothing(t *testing.T) {
	var p *Probe
	ctx := context.Background()
	got, release := p.Hold(ctx)
	release()
	if got != ctx || p.Leaving() || !p.Wait(ctx) {
		t.Fatal("a nil Probe changed the context or reports leaving")
	}
}
