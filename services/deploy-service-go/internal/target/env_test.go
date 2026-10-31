package target

import (
	"strings"
	"testing"
)

func TestParseFillsDefaults(t *testing.T) {
	e, err := Parse([]byte("name: alpha\n"))
	if err != nil {
		t.Fatal(err)
	}
	switch {
	case e.Namespace != "{service}-{env}" || e.Replicas != 1:
		t.Errorf("namespace %q replicas %d", e.Namespace, e.Replicas)
	case e.Resources.Requests.CPU != "100m" || e.Resources.Requests.Memory != "128Mi" || e.Resources.Limits.Memory != "256Mi":
		t.Errorf("resources %+v", e.Resources)
	case strings.Join(*e.Spread, ",") != "zone,hostname" || e.MaxSurge != "25%" || e.TmpSize != "64Mi":
		t.Errorf("spread %v surge %q tmp %q", *e.Spread, e.MaxSurge, e.TmpSize)
	case !*e.ReadinessFromPort || e.HostUsers || e.ServiceAccountClass != "none":
		t.Errorf("readiness %v hostUsers %v sa %q", *e.ReadinessFromPort, e.HostUsers, e.ServiceAccountClass)
	}
	ns, err := e.NamespaceFor("web")
	if err != nil || ns != "web-alpha" {
		t.Errorf("namespace for web: %q %v", ns, err)
	}
	if h := e.HostFor("web", "dns"); h != "" {
		t.Errorf("host without a domain: %q", h)
	}
}

func TestParseKeepsAnEmptySpread(t *testing.T) {
	e, err := Parse([]byte("name: dev\nspread: []\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(*e.Spread) != 0 {
		t.Errorf("spread %v, want none", *e.Spread)
	}
}

func TestParseRefuses(t *testing.T) {
	cases := map[string]string{
		"unknown field":        "name: alpha\nreplica: 2\n",
		"name not a label":     "name: Alpha_1\n",
		"spread key":           "name: alpha\nspread: [rack]\n",
		"surge shape":          "name: alpha\nmaxSurge: one\n",
		"sa class":             "name: alpha\nserviceAccountClass: gke\n",
		"default profile":      "name: alpha\ndefaultProfile: gpu\nprofiles: {general: {}}\n",
		"secret store no name": "name: alpha\nsecretStore: {kind: SecretStore}\n",
		"gateway no name":      "name: alpha\ngateway: {namespace: gw}\n",
	}
	for name, doc := range cases {
		if _, err := Parse([]byte(doc)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	e, err := Parse([]byte("name: alpha\nnamespace: \"{service}_{env}\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.NamespaceFor("web"); err == nil {
		t.Error("namespace web_alpha accepted")
	}
}
