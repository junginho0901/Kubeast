package redisacl

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const chartHelpers = "../../../helm/kubeast/templates/_helpers.tpl"

// The chart's own lines read: each service's user and nothing more than its line names.
func TestCommandsReadTheChartsUsers(t *testing.T) {
	for user, want := range map[string][]string{
		"probe":       {"PING"},
		"tool-server": {"PING", "SELECT", "SUBSCRIBE", "UNSUBSCRIBE"},
	} {
		got, err := Commands(chartHelpers, user)
		if err != nil {
			t.Fatal(err)
		}
		wantSet := map[string]bool{}
		for _, c := range want {
			wantSet[c] = true
		}
		if !reflect.DeepEqual(got, wantSet) {
			t.Errorf("%s: %v, want %v", user, got, wantSet)
		}
	}
	k8s, err := Commands(chartHelpers, "k8s-service")
	if err != nil {
		t.Fatal(err)
	}
	if !k8s["GET"] || k8s["FLUSHDB"] {
		t.Errorf("k8s-service: %v, want GET and no FLUSHDB", k8s)
	}
}

func TestCommandsRefusesWhatItCannotCompare(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "_helpers.tpl")
	write := func(text string) {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("user a on resetkeys -@all +get\nuser a on resetkeys -@all +set\n")
	if _, err := Commands(path, "a"); err == nil || !strings.Contains(err.Error(), "more than one line") {
		t.Errorf("two lines: %v", err)
	}
	if _, err := Commands(path, "b"); err == nil || !strings.Contains(err.Error(), "no line") {
		t.Errorf("no line: %v", err)
	}
	write("user a on ~kubeast:* &kubeast:* -@all +@read\n")
	if _, err := Commands(path, "a"); err == nil || !strings.Contains(err.Error(), "category") {
		t.Errorf("category: %v", err)
	}
	write("  user a on ~kubeast:* -@all +ping +client|setinfo\n")
	got, err := Commands(path, "a")
	if err != nil || !reflect.DeepEqual(got, map[string]bool{"PING": true, "CLIENT": true}) {
		t.Errorf("subcommand: %v %v", got, err)
	}
}

func TestRefusedNamesEachCommandOutsideTheRuleOnce(t *testing.T) {
	sent := []string{"HELLO", "auth", "CLIENT", "SELECT", "GET", "flushdb", "EXPIRE", "FLUSHDB"}
	got := Refused(sent, map[string]bool{"SELECT": true, "GET": true})
	if !reflect.DeepEqual(got, []string{"FLUSHDB", "EXPIRE"}) {
		t.Errorf("refused %v, want FLUSHDB, EXPIRE", got)
	}
}
