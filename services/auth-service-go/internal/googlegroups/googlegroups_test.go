package googlegroups

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fakeDirectory(t *testing.T, pages map[string]any, status int) (*Client, *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/directory/v1/groups" {
			t.Errorf("path %s", r.URL.Path)
		}
		seen = append(seen, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		if status != http.StatusOK {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "Domain not found."}})
			return
		}
		_ = json.NewEncoder(w).Encode(pages[r.URL.Query().Get("pageToken")])
	}))
	t.Cleanup(srv.Close)
	return &Client{http: srv.Client(), base: srv.URL}, &seen
}

func TestGroupsNamesTheDomainAndFollowsPages(t *testing.T) {
	c, seen := fakeDirectory(t, map[string]any{
		"":   map[string]any{"groups": []map[string]string{{"email": "Kubeast-Test1@jobplanet.com"}}, "nextPageToken": "p2"},
		"p2": map[string]any{"groups": []map[string]string{{"email": "all@jobplanet.com"}}},
	}, http.StatusOK)
	got, err := c.Groups(context.Background(), "inho-admin@jobplanet.com")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"kubeast-test1@jobplanet.com", "all@jobplanet.com"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("groups %v, want %v", got, want)
	}
	// without delegation the domain must be named: here it comes from the email
	if len(*seen) != 2 || !strings.Contains((*seen)[0], "domain=jobplanet.com") || !strings.Contains((*seen)[0], "userKey=inho-admin%40jobplanet.com") || !strings.Contains((*seen)[1], "pageToken=p2") {
		t.Fatalf("queries %v", *seen)
	}
}

func TestGroupsUsesTheConfiguredDomainAndReportsErrors(t *testing.T) {
	c, seen := fakeDirectory(t, map[string]any{"": map[string]any{}}, http.StatusOK)
	c.domain = "corp.example.com"
	if got, err := c.Groups(context.Background(), "a@sub.corp.example.com"); err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
	if !strings.Contains((*seen)[0], "domain=corp.example.com") {
		t.Fatalf("query %s", (*seen)[0])
	}
	bad, _ := fakeDirectory(t, nil, http.StatusNotFound)
	if _, err := bad.Groups(context.Background(), "a@b.com"); err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "Domain not found") {
		t.Fatalf("error %v", err)
	}
}

func TestNewTakesOnlyServiceAccountAndExternalAccountFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if _, err := New(write("user.json", `{"type":"authorized_user","client_id":"x","client_secret":"y","refresh_token":"z"}`), ""); err == nil || !strings.Contains(err.Error(), "authorized_user") {
		t.Fatalf("authorized_user accepted: %v", err)
	}
	if _, err := New(filepath.Join(dir, "missing.json"), ""); err == nil {
		t.Fatal("missing file accepted")
	}
	ext := write("wif.json", `{"type":"external_account","audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/k","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"https://sts.googleapis.com/v1/token","service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken","credential_source":{"file":"/var/run/secrets/google/token","format":{"type":"text"}}}`)
	if c, err := New(ext, "jobplanet.com"); err != nil || c.domain != "jobplanet.com" {
		t.Fatalf("external_account: %v", err)
	}
}
