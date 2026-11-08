package k8s

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

// turnRequest is a request that comes at at, or chained a gap after the one before it in its chain got its token.
type turnRequest struct {
	at     time.Duration
	again  bool
	person int // -1 = not one of a crowd
	chain  []bool
}

type turnGrant struct {
	req     turnRequest
	arrived time.Duration
	given   time.Duration
}

// runTurns plays requests through l on a clock of its own, as Wait and serve do, and returns who got which token when.
func runTurns(l *turnLimiter, start time.Time, requests []turnRequest, gap time.Duration) []turnGrant {
	type pending struct {
		req turnRequest
		at  time.Duration
	}
	var queue []pending
	push := func(p pending) {
		i := sort.Search(len(queue), func(i int) bool { return queue[i].at > p.at })
		queue = slices.Insert(queue, i, p)
	}
	for _, r := range requests {
		push(pending{r, r.at})
	}
	waiting := map[*turnWaiter]pending{}
	var out []turnGrant
	granted := func(p pending, at time.Duration) {
		out = append(out, turnGrant{req: p.req, arrived: p.at, given: at})
		if len(p.req.chain) > 0 {
			next := p.req
			next.again, next.chain = p.req.chain[0], p.req.chain[1:]
			push(pending{next, at + gap})
		}
	}
	admit := func(until time.Duration) {
		for len(queue) > 0 && queue[0].at <= until {
			p := queue[0]
			queue = queue[1:]
			if w := l.arrive(start.Add(p.at), p.req.again); w != nil {
				waiting[w] = p
			} else {
				granted(p, p.at)
			}
		}
	}
	now := time.Duration(0)
	if len(queue) > 0 {
		now = queue[0].at
	}
	for len(queue) > 0 || l.waiting() > 0 {
		admit(now)
		if l.waiting() == 0 {
			if len(queue) > 0 {
				now = queue[0].at
			}
			continue
		}
		r, delay, _ := l.reserve(start.Add(now))
		admit(now + delay)
		now += delay
		w := l.give(r, start.Add(now))
		p := waiting[w]
		delete(waiting, w)
		granted(p, now)
	}
	return out
}

func withPassOverLimit(t *testing.T, d time.Duration) {
	t.Helper()
	old := passOverLimit
	passOverLimit = d
	t.Cleanup(func() { passOverLimit = old })
}

// A check asked again while later requests keep coming faster than the rate gets its token once it has waited the bound.
func TestACheckAskedAgainWaitsNoLongerThanTheBound(t *testing.T) {
	withPassOverLimit(t, 10*time.Second)
	l := newTurnLimiter(100, 1)
	reqs := []turnRequest{{at: 0, person: -1}, {at: time.Millisecond, again: true, person: 1}}
	for at := 2 * time.Millisecond; at < 20*time.Second; at += 5 * time.Millisecond {
		reqs = append(reqs, turnRequest{at: at, person: -1})
	}
	grants := runTurns(l, time.Unix(0, 0), reqs, 0)
	var again turnGrant
	firstsBefore := 0
	for _, g := range grants {
		if g.req.again {
			again = g
			break
		}
		firstsBefore++
	}
	wait := again.given - again.arrived
	t.Logf("the check asked again waited %v; %d later requests went first", wait, firstsBefore-1)
	if wait > passOverLimit+20*time.Millisecond || wait < passOverLimit-time.Second {
		t.Errorf("the check asked again waited %v, want the bound %v (later requests first until then, not after)", wait, passOverLimit)
	}
}

// Turns change who gets a token, never how many there are or when: the tokens are given at the times client-go's token bucket gives them, each request once.
func TestTurnsKeepTheRateAndEveryRequest(t *testing.T) {
	withPassOverLimit(t, 10*time.Second)
	var reqs []turnRequest
	for i := 0; i < 3000; i++ {
		reqs = append(reqs, turnRequest{at: time.Duration(i) * 3 * time.Millisecond, again: i%3 == 0, person: i})
	}
	for i := 0; i < 500; i++ {
		reqs = append(reqs, turnRequest{at: 2 * time.Second, person: 3000 + i})
	}
	start := time.Unix(0, 0)
	grants := runTurns(newTurnLimiter(100, 200), start, reqs, 0)
	if len(grants) != len(reqs) {
		t.Fatalf("%d tokens given for %d requests", len(grants), len(reqs))
	}
	seen := map[int]bool{}
	var times []time.Duration
	for _, g := range grants {
		if seen[g.req.person] {
			t.Fatalf("request %d got two tokens", g.req.person)
		}
		seen[g.req.person] = true
		times = append(times, g.given)
	}
	// client-go's own bucket: each request reserves the next token as it comes
	bucket := rate.NewLimiter(100, 200)
	arrivals := make([]time.Duration, len(reqs))
	for i, r := range reqs {
		arrivals[i] = r.at
	}
	slices.Sort(arrivals)
	var want []time.Duration
	for _, at := range arrivals {
		r := bucket.ReserveN(start.Add(at), 1)
		want = append(want, at+r.DelayFrom(start.Add(at)))
	}
	slices.Sort(times)
	for i := range want {
		if d := times[i] - want[i]; d > time.Microsecond || d < -time.Microsecond {
			t.Fatalf("token %d given at %v, client-go's bucket gives it at %v", i, times[i], want[i])
		}
	}
	t.Logf("%d requests, the last token at %v as client-go's bucket", len(reqs), times[len(times)-1])
}

// A crowd of first screens: 100 people (80 wide, 10 with 5 namespaces, 10 with 20, the calls the code makes counted in TestFirstScreensOfOnePersonListNoPodsAsThatPerson, eight side by side each) while 500 open screens ask their checks again at 59 a second, on the client's 100 a second and burst of 200.
func TestACrowdsFirstChecksFinishSoonerAndChecksAskedAgainWaitAtMostTheBound(t *testing.T) {
	crowd := func(wide, five, twenty int) []turnRequest {
		var reqs []turnRequest
		for at := -12 * time.Second; at < 90*time.Second; at += time.Second / 59 {
			reqs = append(reqs, turnRequest{at: at, again: true, person: -1})
		}
		person := 0
		add := func(n, calls int) {
			for ; n > 0; n-- {
				for c := 0; c < 8; c++ {
					length := calls / 8
					if c < calls%8 {
						length++
					}
					if length > 0 {
						reqs = append(reqs, turnRequest{person: person, chain: make([]bool, length-1)})
					}
				}
				person++
			}
		}
		add(80, wide)
		add(10, five)
		add(10, twenty)
		return reqs
	}
	type result struct{ last, p50, againMax, againP95 time.Duration }
	play := func(reqs []turnRequest, firstsFirst bool) result {
		if !firstsFirst {
			reqs = slices.Clone(reqs)
			for i := range reqs {
				reqs[i].again = false
			}
		}
		grants := runTurns(newTurnLimiter(100, 200), time.Unix(0, 0), reqs, 10*time.Millisecond)
		done := map[int]time.Duration{}
		var againWaits []time.Duration
		for _, g := range grants {
			if g.req.person >= 0 {
				done[g.req.person] = max(done[g.req.person], g.given)
			} else if g.arrived >= 0 && g.arrived < 30*time.Second {
				againWaits = append(againWaits, g.given-g.arrived)
			}
		}
		var people []time.Duration
		for _, d := range done {
			people = append(people, d)
		}
		slices.Sort(people)
		slices.Sort(againWaits)
		return result{people[len(people)-1], people[len(people)/2], againWaits[len(againWaits)-1], againWaits[len(againWaits)*95/100]}
	}
	round := func(d time.Duration) time.Duration { return d.Round(100 * time.Millisecond) }
	chosen := passOverLimit
	t.Cleanup(func() { passOverLimit = chosen })
	for _, c := range []struct {
		name               string
		wide, five, twenty int
	}{
		{"cold (1 930 calls)", 8, 27, 102},
		{"warmer (1 290 calls)", 5, 17, 72},
	} {
		reqs := crowd(c.wide, c.five, c.twenty)
		fifo := play(reqs, false)
		t.Logf("%s, one queue as now: the last person %v, half by %v; checks asked again waited at most %v, 95%% within %v", c.name, round(fifo.last), round(fifo.p50), round(fifo.againMax), round(fifo.againP95))
		if fifo.last < 20*time.Second {
			t.Fatalf("%s: the last person %v in one queue, want a crowd that fills the rate past 20 s", c.name, fifo.last)
		}
		for _, bound := range []time.Duration{5 * time.Second, chosen, 15 * time.Second, time.Hour} {
			passOverLimit = bound
			got := play(reqs, true)
			t.Logf("%s, first checks first, bound %v: the last person %v, half by %v; checks asked again waited at most %v, 95%% within %v", c.name, bound, round(got.last), round(got.p50), round(got.againMax), round(got.againP95))
			if bound == chosen && (got.last > fifo.last*3/4 || got.againMax > bound+time.Second) {
				t.Errorf("%s, bound %v: the last person %v (want within three quarters of %v), checks asked again waited at most %v (want within the bound)", c.name, bound, got.last, fifo.last, got.againMax)
			}
		}
	}
}

// A request that leaves while waiting takes no token and the next one gets it at once; a request that leaves with a token gives it back.
func TestAWaitThatEndsWithItsRequestLeavesItsTokenToTheNext(t *testing.T) {
	l := newTurnLimiter(5, 1)
	if err := l.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := l.Wait(ctx); err == nil {
		t.Fatal("a request that left while waiting got a token")
	}
	start := time.Now()
	if err := l.Wait(askingAgain(context.Background())); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 250*time.Millisecond {
		t.Errorf("the next request waited %v, want the 200 ms token the one that left did not take", took)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.waiting() != 0 {
		t.Errorf("%d requests left in the queue", l.waiting())
	}
}

// A question counts as asked again from its answer until a minute after that answer ran out, and no other question does.
func TestAQuestionCountsAsAskedAgainForAMinutePastItsAnswer(t *testing.T) {
	var a answeredChecks
	now := time.Now()
	if a.askedAgain("default|pods_list_allowed:|as:a", now) {
		t.Fatal("a question never answered counts as asked again")
	}
	a.answered("default|pods_list_allowed:|as:a", now.Add(50*time.Second))
	for _, c := range []struct {
		key   string
		at    time.Duration
		again bool
	}{
		{"default|pods_list_allowed:|as:a", 10 * time.Second, true},
		{"default|pods_list_allowed:|as:a", 109 * time.Second, true},
		{"default|pods_list_allowed:|as:a", 111 * time.Second, false},
		{"default|pods_list_allowed:|as:b", 10 * time.Second, false},
	} {
		if got := a.askedAgain(c.key, now.Add(c.at)); got != c.again {
			t.Errorf("%s at %v: asked again %v, want %v", c.key, c.at, got, c.again)
		}
	}
	for i := 0; i < answeredMax+10; i++ {
		a.answered(fmt.Sprintf("key-%d", i), now.Add(time.Minute))
	}
	if len(a.until) > answeredMax {
		t.Errorf("%d questions held, want at most %d", len(a.until), answeredMax)
	}
}
