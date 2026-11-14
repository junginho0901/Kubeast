package probe

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

func TestLiveAsksNothingAndAnswersWhileLeaving(t *testing.T) {
	p := New()
	p.Leave()
	if code, _ := answer(t, p.Live); code != http.StatusOK {
		t.Fatalf("live answered %d while leaving", code)
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

// Merge plan S21: without a hand-over a terminal ends on Leave like a followed log or a live list; handed over (the
// drain of #824 owns terminals), its context stays after Leave and Wait does not wait for it, while the others still end.
func TestTerminalsEndOnLeaveUnlessHandedOver(t *testing.T) {
	ended := func(ctx context.Context) bool {
		select {
		case <-ctx.Done():
			return true
		case <-time.After(200 * time.Millisecond):
			return false
		}
	}

	own := New()
	terminal, releaseTerminal := own.HoldTerminal(context.Background())
	defer releaseTerminal()
	stream, releaseStream := own.Hold(context.Background())
	defer releaseStream()
	own.Leave()
	if !ended(terminal) || !IsLeaving(terminal) || !ended(stream) {
		t.Fatal("without a hand-over the terminal and the stream end on Leave")
	}

	handed := New()
	handed.HandOverTerminals()
	terminal2, releaseTerminal2 := handed.HoldTerminal(context.Background())
	defer releaseTerminal2()
	stream2, releaseStream2 := handed.Hold(context.Background())
	if handed.Held() != 1 {
		t.Fatalf("held = %d, want the stream alone", handed.Held())
	}
	handed.Leave()
	if ended(terminal2) {
		t.Fatal("a handed-over terminal ended on Leave")
	}
	if !ended(stream2) || !IsLeaving(stream2) {
		t.Fatal("a followed log or live list must still end on Leave")
	}
	releaseStream2()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if !handed.Wait(ctx) {
		t.Fatalf("Wait waited for a handed-over terminal (held %d)", handed.Held())
	}
}
