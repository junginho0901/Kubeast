package ws

import (
	"context"
	"strings"
	"testing"
)

// panicsAskingClients panics where the cluster is asked whether the caller may list a kind.
type panicsAskingClients struct{ fakeClients }

func (panicsAskingClients) MayListKind(context.Context, string, string) (bool, error) {
	panic(panicText)
}

// The question put for a grant limited to namespaces runs before the watch's own recover.
func TestAPanicAskingWhetherAKindMayBeListedEndsThatWatchOnly(t *testing.T) {
	api := &apiSeen{object: watchEvent(t, nodeObjectForScopeTest)}
	base := muxOn(t, api.serve)
	m := NewMultiplexer(panicsAskingClients{base.provider.(fakeClients)})
	conn := socketAs(t, m, scopedToTeamA)
	request(t, conn, "REQUEST", "self", "/api/v1/nodes", "watch=1")
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || f.Error.Reason != reasonFailed {
		t.Fatalf("frame %s reason %q, want the failed refusal", f.Type, f.Error.Reason)
	}
	if strings.Contains(f.Error.Message, panicText) {
		t.Fatalf("the client was told the panic's text: %q", f.Error.Message)
	}
	waitForSubscriptions(t, m, 0)
	if asked := api.asked(); len(asked) != 0 {
		t.Errorf("the API server was asked for %v", asked)
	}
}
