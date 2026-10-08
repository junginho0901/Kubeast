package logfiles

import (
	"reflect"
	"testing"
)

func TestParseRejectsUnsafePatterns(t *testing.T) {
	bad := []string{
		"var/log/app.log",        // relative
		"/var/log/../etc/passwd", // ..
		"/var/log/./app.log",     // .
		"/var/log//app.log",      // not clean
		"/var/*/app.log",         // glob in a directory
		"/var/log/",              // no file name
		"/var/log/[ab].log",      // character class
		"/var/log/a\\b.log",      // escape
		"/var/log/a\nb.log",      // control character
	}
	for _, p := range bad {
		if _, err := Parse([]string{p}); err == nil {
			t.Errorf("Parse(%q) accepted", p)
		}
	}
	if _, err := Parse(nil); err == nil {
		t.Error("Parse(nil) accepted")
	}
}

func TestParseAcceptsAndDedups(t *testing.T) {
	ps, err := Parse([]string{"/var/log/app/*.log", "/srv/app/log/production.log", "/var/log/app/*.log", "/var/log/app/access-?.log"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := ps.List(), []string{"/var/log/app/*.log", "/srv/app/log/production.log", "/var/log/app/access-?.log"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("List = %v, want %v", got, want)
	}
	if got, want := ps.Dirs(), []string{"/srv/app/log", "/var/log/app"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Dirs = %v, want %v", got, want)
	}
}

func TestAllowed(t *testing.T) {
	ps, err := Parse([]string{"/var/log/app/*.log", "/srv/app/log/production.log"})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{
		"/var/log/app/app.log":            true,
		"/var/log/app/.log":               true, // * matches the empty string, still inside the directory
		"/srv/app/log/production.log":     true,
		"/srv/app/log/development.log":    false,
		"/var/log/app/sub/app.log":        false, // * never crosses a slash
		"/var/log/app/../../../etc/x.log": false,
		"/var/log/app/./app.log":          false,
		"/var/log/app//app.log":           false,
		"var/log/app/app.log":             false,
		"/var/log/app/app.log\n":          false,
		"/var/log/app/app.txt":            false,
		"/etc/passwd":                     false,
		"":                                false,
	}
	for p, want := range cases {
		if got := ps.Allowed(p); got != want {
			t.Errorf("Allowed(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestMatchFiltersListing(t *testing.T) {
	ps, err := Parse([]string{"/var/log/app/*.log"})
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"b.log", "a.log", "archive/", "notes.txt", "", "c.log\r", "x/y.log"}
	got := ps.Match("/var/log/app", names)
	want := []string{"/var/log/app/a.log", "/var/log/app/b.log", "/var/log/app/c.log"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Match = %v, want %v", got, want)
	}
}
