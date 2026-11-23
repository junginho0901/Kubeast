package helm

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
)

// twoReplicas is the fixture's Service (replica a) and a second one (replica b) on the same releases, each with its
// own cache client of one Redis stand-in, as two k8s-service pods with the chart's Redis.
func twoReplicas(t *testing.T) (*miniredis.Miniredis, *helmFixture, *Service) {
	t.Helper()
	mr := miniredis.RunT(t)
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	a := newHelmFixture(t)
	a.svc.cache = cache.New(mr.Host(), port, 0, "")
	b := &Service{cache: cache.New(mr.Host(), port, 0, ""), configOverride: a.svc.configOverride}
	if !a.svc.cache.IsConnected() || !b.cache.IsConnected() {
		t.Fatal("not connected to the stand-in")
	}
	return mr, a, b
}

// Replica b's read began before replica a's uninstall and stores its list after a's invalidation: the generation mark a
// moved in Redis makes b drop it, so neither replica's next read is the old list.
func TestOnOneRedisAReadThatBeganBeforeTheOtherReplicasWriteDoesNotStay(t *testing.T) {
	_, a, b := twoReplicas(t)
	a.store.Driver = &lateListDriver{Driver: a.mem, during: func() {
		if _, err := a.svc.Uninstall(identity("admin"), testNS, testRelease, false, false); err != nil {
			t.Error(err)
		}
	}}
	first, err := b.ListReleases(identity("admin"), testNS, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if find(first, testRelease) == nil {
		t.Fatalf("the read that began first should answer what it read: %+v", first)
	}
	for name, svc := range map[string]*Service{"a": a.svc, "b": b} {
		next, err := svc.ListReleases(identity("admin"), testNS, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if web := find(next, testRelease); web != nil {
			t.Errorf("replica %s's next read got the old list: %+v", name, web)
		}
	}
}

// The mark outlives the request that moved it: a browser gone right after the write still leaves the mark moved for
// the other replica.
func TestTheGenerationMarkMovesAfterTheRequestEnded(t *testing.T) {
	mr, a, b := twoReplicas(t)
	ctx, cancel := context.WithCancel(identity("admin"))
	cancel()
	a.svc.invalidateListCache(ctx)
	var mark string
	if !b.cache.Peek(identity("admin"), listGenerationKey, &mark) || mark == "" {
		t.Fatalf("the mark did not move for the other replica (%q; keys %v)", mark, mr.Keys())
	}
}

// A list read while the generation mark could not be read (Redis left out) is not kept, even when Redis answers again
// before the list is stored: a write of another replica meanwhile could not be told from none.
func TestAListReadWhileTheMarkCouldNotBeReadIsNotKept(t *testing.T) {
	mr := miniredis.RunT(t)
	port, err := strconv.Atoi(mr.Port())
	if err != nil {
		t.Fatal(err)
	}
	a := newHelmFixture(t)
	a.svc.cache = cache.New(mr.Host(), port, 0, "")
	mr.Close() // the next read is not answered: the cache leaves Redis out for 3 s
	a.store.Driver = &lateListDriver{Driver: a.mem, during: func() {
		if err := mr.Restart(); err != nil {
			t.Error(err)
		}
		time.Sleep(3100 * time.Millisecond) // past the skip, before the list is stored
	}}
	if _, err := a.svc.ListReleases(identity("admin"), testNS, "", false); err != nil {
		t.Fatal(err)
	}
	for _, k := range mr.Keys() {
		if strings.HasPrefix(k, cache.Prefix+"helm|releases|") {
			t.Fatalf("a list read without the mark was kept: %s", k)
		}
	}
}
