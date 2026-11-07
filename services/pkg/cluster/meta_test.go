package cluster

import "testing"

// metaRow answers scanMeta's columns; the address is the fourth.
type metaRow struct{ apiURL *string }

func (r metaRow) Scan(dest ...any) error {
	*dest[3].(**string) = r.apiURL
	return nil
}

// A row an older build stored with a user keeps working: everything that reads it, an answer or an audit row's before,
// gets the address without the user.
func TestStoredAPIServerURLIsReadWithoutItsUser(t *testing.T) {
	for stored, want := range map[string]string{
		"https://bob:fake-url-password@10.0.0.1:6443":     "https://10.0.0.1:6443",
		"https://bob@10.0.0.1:6443/k8s/clusters/c":        "https://10.0.0.1:6443/k8s/clusters/c",
		"bob:fake-url-password@10.0.0.1:6443":             "10.0.0.1:6443",
		"https://bob:fake url password@10.0.0.1:6443/k8s": "https://10.0.0.1:6443/k8s",
		"https://10.0.0.1:6443":                           "https://10.0.0.1:6443",
		"https://api.example.test/k8s?x=a@b":              "https://api.example.test/k8s?x=a@b",
		"10.0.0.1:6443":                                   "10.0.0.1:6443",
	} {
		m, err := scanMeta(metaRow{apiURL: &stored})
		if err != nil {
			t.Fatal(err)
		}
		if m.APIServerURL != want {
			t.Errorf("%q read as %q, want %q", stored, m.APIServerURL, want)
		}
	}
	if m, err := scanMeta(metaRow{}); err != nil || m.APIServerURL != "" {
		t.Errorf("no address: %q %v", m.APIServerURL, err)
	}
}
