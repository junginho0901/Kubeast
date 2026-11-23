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
