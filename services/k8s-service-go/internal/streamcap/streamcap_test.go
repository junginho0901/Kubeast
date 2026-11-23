package streamcap

import (
	"sync"
	"testing"
)

func TestAnAccountIsRefusedPastItsCapAndGetsThePlaceBackWhenOneEnds(t *testing.T) {
	c := New(2, 3)
	r1, ok1 := c.Take("u1", Terminal)
	_, ok2 := c.Take("u1", Terminal)
	if !ok1 || !ok2 {
		t.Fatal("refused under the cap")
	}
	if _, ok := c.Take("u1", Terminal); ok {
		t.Fatal("a third terminal was taken with a cap of 2")
	}
	if got := c.Open("u1", Terminal); got != 2 {
		t.Fatalf("open = %d after a refusal, want 2 (a refusal holds nothing)", got)
	}
	if c.Refused(Terminal) != 1 || c.Refused(FollowedLog) != 0 {
		t.Fatalf("refused = %d terminals, %d followed logs, want 1 and 0", c.Refused(Terminal), c.Refused(FollowedLog))
	}
	r1()
	r1() // given back once
	if got := c.Open("u1", Terminal); got != 1 {
		t.Fatalf("open = %d after one release called twice, want 1", got)
	}
	if _, ok := c.Take("u1", Terminal); !ok {
		t.Fatal("refused after a place was given back")
	}
}

func TestEachKindHasItsOwnCap(t *testing.T) {
	c := New(1, 2)
	if _, ok := c.Take("u1", Terminal); !ok {
		t.Fatal("first terminal refused")
	}
	for i := 0; i < 2; i++ {
		if _, ok := c.Take("u1", FollowedLog); !ok {
			t.Fatalf("followed log %d refused while the terminals were full", i+1)
		}
	}
	if _, ok := c.Take("u1", FollowedLog); ok {
		t.Fatal("a third followed log was taken with a cap of 2")
	}
	if c.Max(Terminal) != 1 || c.Max(FollowedLog) != 2 {
		t.Fatalf("max = %d, %d", c.Max(Terminal), c.Max(FollowedLog))
	}
}

func TestAccountsAreCountedApart(t *testing.T) {
	c := New(1, 1)
	if _, ok := c.Take("u1", Terminal); !ok {
		t.Fatal("u1 refused")
	}
	if _, ok := c.Take("u2", Terminal); !ok {
		t.Fatal("u2 refused because u1 holds the cap")
	}
	if _, ok := c.Take("u1", Terminal); ok {
		t.Fatal("u1 took a second terminal")
	}
}

func TestZeroIsNoCap(t *testing.T) {
	c := New(0, 0)
	for i := 0; i < 1000; i++ {
		if _, ok := c.Take("u1", Terminal); !ok {
			t.Fatalf("terminal %d refused with no cap", i+1)
		}
		if _, ok := c.Take("u1", FollowedLog); !ok {
			t.Fatalf("followed log %d refused with no cap", i+1)
		}
	}
	if New(-1, -5).Max(Terminal) != 0 {
		t.Fatal("a cap below 0 is not no cap")
	}
}

func TestANilCapsRefusesNothing(t *testing.T) {
	var c *Caps
	release, ok := c.Take("u1", Terminal)
	if !ok {
		t.Fatal("refused")
	}
	release()
	if c.Open("u1", Terminal) != 0 || c.Max(Terminal) != 0 || c.Accounts() != 0 || c.Refused(Terminal) != 0 {
		t.Fatal("a nil Caps counts")
	}
}

// The server's cap counts every account's terminals and followed logs together: at the cap the next one of any account
// and kind is refused before anything is held, and a place given back opens one again.
func TestTheServerRefusesOnePastItsCapOnEveryAccountTogether(t *testing.T) {
	c := NewWithServerCap(0, 0, 3)
	r1, _ := c.Try("u1", Terminal)
	if _, refusal := c.Try("u2", FollowedLog); refusal != Taken {
		t.Fatalf("u2's followed log refused under the server's cap: %v", refusal)
	}
	if _, refusal := c.Try("u3", Terminal); refusal != Taken {
		t.Fatalf("u3's terminal refused under the server's cap: %v", refusal)
	}
	for _, kind := range []Kind{Terminal, FollowedLog} {
		if _, refusal := c.Try("u4", kind); refusal != ByServer {
			t.Fatalf("a %v past the server's cap of 3: %v, want ByServer", kind, refusal)
		}
	}
	if _, ok := c.Take("u1", Terminal); ok {
		t.Fatal("Take took a place past the server's cap")
	}
	if got := c.Total(); got != 3 {
		t.Fatalf("total = %d after the refusals, want 3 (a refusal holds nothing)", got)
	}
	if c.ServerRefused(Terminal) != 2 || c.ServerRefused(FollowedLog) != 1 {
		t.Fatalf("server refused = %d terminals, %d followed logs, want 2 and 1", c.ServerRefused(Terminal), c.ServerRefused(FollowedLog))
	}
	if c.Refused(Terminal) != 0 || c.Refused(FollowedLog) != 0 {
		t.Fatal("a refusal at the server's cap counted as an account's")
	}
	if c.Open("u4", Terminal) != 0 || c.Accounts() != 3 {
		t.Fatalf("u4 holds %d, accounts %d, want 0 and 3", c.Open("u4", Terminal), c.Accounts())
	}
	r1()
	r1() // given back once
	if got := c.Total(); got != 2 {
		t.Fatalf("total = %d after one release called twice, want 2", got)
	}
	if _, refusal := c.Try("u4", FollowedLog); refusal != Taken {
		t.Fatalf("refused after a place was given back: %v", refusal)
	}
	if c.ServerMax() != 3 {
		t.Fatalf("server max = %d", c.ServerMax())
	}
}

func TestNoServerCapWithZero(t *testing.T) {
	for _, c := range []*Caps{New(0, 0), NewWithServerCap(0, 0, 0), NewWithServerCap(0, 0, -2)} {
		if c.ServerMax() != 0 {
			t.Fatalf("server max = %d, want 0", c.ServerMax())
		}
		for i := 0; i < 1000; i++ {
			if _, refusal := c.Try([]string{"u1", "u2"}[i%2], Kind(i%2)); refusal != Taken {
				t.Fatalf("place %d refused with no cap: %v", i+1, refusal)
			}
		}
		if c.Total() != 1000 {
			t.Fatalf("total = %d, want 1000", c.Total())
		}
	}
}

// With both caps, whichever is reached first refuses; when both are full the account's is said, since closing one of its
// own gives the server a place back too.
func TestWhicheverCapIsReachedFirstRefusesAndTheAccountsIsSaidWhenBothAre(t *testing.T) {
	// The account's cap first: u1 holds 2 of 2, the server 2 of 5.
	c := NewWithServerCap(2, 2, 5)
	c.Try("u1", Terminal)
	c.Try("u1", Terminal)
	if _, refusal := c.Try("u1", Terminal); refusal != ByAccount {
		t.Fatalf("u1's third terminal under the server's cap: %v, want ByAccount", refusal)
	}
	if _, refusal := c.Try("u2", Terminal); refusal != Taken {
		t.Fatalf("u2 refused under both caps: %v", refusal)
	}

	// The server's cap first: three accounts under their own caps fill it.
	c = NewWithServerCap(2, 2, 3)
	c.Try("u1", Terminal)
	c.Try("u2", Terminal)
	c.Try("u3", FollowedLog)
	if _, refusal := c.Try("u1", Terminal); refusal != ByServer {
		t.Fatalf("u1 holding 1 of 2 on a full server: %v, want ByServer", refusal)
	}

	// Both full: the account's is said.
	c = NewWithServerCap(1, 1, 2)
	c.Try("u1", Terminal)
	c.Try("u2", Terminal)
	if _, refusal := c.Try("u1", Terminal); refusal != ByAccount {
		t.Fatalf("u1 at its cap on a full server: %v, want ByAccount", refusal)
	}
	if c.Refused(Terminal) != 1 || c.ServerRefused(Terminal) != 0 {
		t.Fatalf("refused = %d at the account's cap, %d at the server's, want 1 and 0", c.Refused(Terminal), c.ServerRefused(Terminal))
	}
}

func TestANilCapsHasNoServerCap(t *testing.T) {
	var c *Caps
	release, refusal := c.Try("u1", FollowedLog)
	if refusal != Taken {
		t.Fatalf("refused: %v", refusal)
	}
	release()
	if c.ServerMax() != 0 || c.Total() != 0 || c.ServerRefused(FollowedLog) != 0 {
		t.Fatal("a nil Caps counts")
	}
}

// Takes and releases from many goroutines at once never pass the server's cap and leave nothing held.
func TestServerPlacesTakenAndGivenBackAtOnceNeverPassTheCap(t *testing.T) {
	const serverN = 7
	c := NewWithServerCap(0, 0, serverN)
	var wg sync.WaitGroup
	var mu sync.Mutex
	most := 0
	for g := 0; g < 50; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				release, refusal := c.Try([]string{"u1", "u2", "u3"}[g%3], Kind(i%2))
				if refusal != Taken {
					continue
				}
				mu.Lock()
				most = max(most, c.Total())
				mu.Unlock()
				release()
			}
		}(g)
	}
	wg.Wait()
	if most > serverN {
		t.Fatalf("the server held %d at once with a cap of %d", most, serverN)
	}
	if c.Total() != 0 || c.Accounts() != 0 {
		t.Fatalf("total %d, accounts %d after every release, want 0 and 0", c.Total(), c.Accounts())
	}
}

// Takes and releases from many goroutines at once leave nothing held and never pass the cap.
func TestPlacesTakenAndGivenBackAtOnceLeaveNothingHeld(t *testing.T) {
	const capN = 5
	c := New(capN, capN)
	var wg sync.WaitGroup
	var mu sync.Mutex
	most := 0
	for g := 0; g < 50; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			account := []string{"u1", "u2"}[g%2]
			for i := 0; i < 200; i++ {
				release, ok := c.Take(account, Kind(i%2))
				if !ok {
					continue
				}
				mu.Lock()
				most = max(most, c.Open(account, Kind(i%2)))
				mu.Unlock()
				release()
			}
		}(g)
	}
	wg.Wait()
	if most > capN {
		t.Fatalf("an account held %d at once with a cap of %d", most, capN)
	}
	if c.Accounts() != 0 {
		t.Fatalf("%d accounts still hold places after every release", c.Accounts())
	}
}
