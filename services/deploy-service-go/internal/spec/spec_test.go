package spec

import (
	"strings"
	"testing"
	"testing/fstest"
)

const base = `apiVersion: score.dev/v1b1
metadata:
  name: web
containers:
  app:
    image: nginx:1.27
    variables:
      A: one
      B: two
`

func TestLoadMergesOverridesInOrder(t *testing.T) {
	s, err := Load(Input{
		Score: []byte(base),
		Overrides: [][]byte{
			[]byte("containers: {app: {image: nginx:1.28, variables: {B: second}}}"),
			[]byte("containers: {app: {variables: {A: null, C: three}}}"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := s.Workload.Containers["app"]
	if c.Image != "nginx:1.28" {
		t.Errorf("image %q, want the override", c.Image)
	}
	want := map[string]string{"B": "second", "C": "three"}
	if len(c.Variables) != len(want) {
		t.Fatalf("variables %v, want %v (null removes A, maps merge)", c.Variables, want)
	}
	for k, v := range want {
		if c.Variables[k] != v {
			t.Errorf("variable %s = %q, want %q", k, c.Variables[k], v)
		}
	}
}

func TestLoadSchemaErrorNamesEveryPlace(t *testing.T) {
	_, err := Load(Input{Score: []byte(`apiVersion: score.dev/v1b1
metadata: {name: x}
containers: {app: {}}
`)})
	if err == nil {
		t.Fatal("loaded an invalid file")
	}
	for _, want := range []string{"/metadata/name", "/containers/app", "image"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q: %v", want, err)
		}
	}
}

func TestLoadFileSources(t *testing.T) {
	score := `apiVersion: score.dev/v1b1
metadata: {name: web}
containers:
  app:
    image: nginx:1.27
    files:
      /etc/a.txt: {source: ./conf/a.txt}
      /etc/b.bin: {source: conf/b.bin}
`
	fsys := fstest.MapFS{
		"conf/a.txt": {Data: []byte("hello\n")},
		"conf/b.bin": {Data: []byte{0xff, 0xfe, 0x00}},
	}
	s, err := Load(Input{Score: []byte(score), Files: fsys})
	if err != nil {
		t.Fatal(err)
	}
	files := s.Workload.Containers["app"].Files
	if got := files["/etc/a.txt"]; got.Content == nil || *got.Content != "hello\n" || got.Source != nil {
		t.Errorf("text source not embedded as content: %+v", got)
	}
	if got := files["/etc/b.bin"]; got.BinaryContent == nil || *got.BinaryContent != "//4A" {
		t.Errorf("binary source not embedded as base64: %+v", got)
	}
}

func TestLoadRefusesSourcesOutsideTheFolder(t *testing.T) {
	for _, src := range []string{"../secret.txt", "/etc/passwd", "a/../../b"} {
		score := "apiVersion: score.dev/v1b1\nmetadata: {name: web}\ncontainers: {app: {image: nginx:1.27, files: {/etc/x: {source: \"" + src + "\"}}}}\n"
		_, err := Load(Input{Score: []byte(score), Files: fstest.MapFS{}})
		if err == nil || !strings.Contains(err.Error(), "must stay next to the score file") {
			t.Errorf("source %q: %v", src, err)
		}
	}
	score := "apiVersion: score.dev/v1b1\nmetadata: {name: web}\ncontainers: {app: {image: nginx:1.27, files: {/etc/x: {source: a.txt}}}}\n"
	if _, err := Load(Input{Score: []byte(score)}); err == nil || !strings.Contains(err.Error(), "not available here") {
		t.Errorf("no file system: %v", err)
	}
}

func ext(t *testing.T, ann map[string]string) (Ext, error) {
	t.Helper()
	m := map[string]interface{}{}
	for k, v := range ann {
		m[k] = v
	}
	return ParseExt(map[string]interface{}{"name": "web", "annotations": m})
}

func TestParseExtDefaults(t *testing.T) {
	e, err := ext(t, map[string]string{"team.example.com/owner": "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if e.Strategy != "rolling" || !e.ReadOnlyRoot || e.Replicas != nil || e.Autoscale != nil ||
		e.Spread != nil || e.HostUsers != nil || e.PDB.Mode != PDBAuto {
		t.Errorf("defaults: %+v", e)
	}
}

func TestParseExtValues(t *testing.T) {
	e, err := ext(t, map[string]string{
		KeyAutoscale:             "2-10",
		KeyAutoscaleTarget:       "memory=80",
		KeyPDB:                   "min-available=2",
		KeyReadOnlyRoot:          "false",
		KeyReadOnlyRootReason:    " writes a cache ",
		KeyRunAsUser:             "1000",
		KeyHostUsers:             "true",
		KeySpread:                "hostname, zone, hostname",
		KeyScrape:                "metrics:/stats/prometheus",
		KeyProfile:               "arm",
		KeyPolicyException:       "b-rule, a-rule, b-rule",
		KeyPolicyExceptionReason: "vendor image",
	})
	if err != nil {
		t.Fatal(err)
	}
	switch {
	case *e.Autoscale != Autoscale{Min: 2, Max: 10, Resource: "memory", Target: 80}:
		t.Errorf("autoscale %+v", *e.Autoscale)
	case e.PDB != PDB{Mode: PDBMinAvailable, Value: 2}:
		t.Errorf("pdb %+v", e.PDB)
	case e.ReadOnlyRoot || e.ReadOnlyRootReason != "writes a cache":
		t.Errorf("read-only root %v %q", e.ReadOnlyRoot, e.ReadOnlyRootReason)
	case *e.RunAsUser != 1000 || !*e.HostUsers:
		t.Errorf("run as %d, host users %v", *e.RunAsUser, *e.HostUsers)
	case strings.Join(e.Spread, ",") != "hostname,zone":
		t.Errorf("spread %v", e.Spread)
	case *e.Scrape != Scrape{Port: "metrics", Path: "/stats/prometheus"}:
		t.Errorf("scrape %+v", *e.Scrape)
	case strings.Join(e.PolicyExceptions, ",") != "a-rule,b-rule":
		t.Errorf("exceptions %v", e.PolicyExceptions)
	}
	off, err := ext(t, map[string]string{KeySpread: "off", KeyPDB: "off"})
	if err != nil || off.Spread == nil || len(off.Spread) != 0 || off.PDB.Mode != PDBOff {
		t.Errorf("off: %+v %v", off, err)
	}
}

func TestParseExtRefuses(t *testing.T) {
	cases := map[string]map[string]string{
		"unknown key":               {"kubeast.io/replica": "2"},
		"replicas not a number":     {KeyReplicas: "two"},
		"negative replicas":         {KeyReplicas: "-1"},
		"autoscale shape":           {KeyAutoscale: "10"},
		"autoscale order":           {KeyAutoscale: "5-2"},
		"autoscale from zero":       {KeyAutoscale: "0-3"},
		"target without autoscale":  {KeyAutoscaleTarget: "cpu=50"},
		"target resource":           {KeyAutoscale: "1-2", KeyAutoscaleTarget: "gpu=50"},
		"target above 100":          {KeyAutoscale: "1-2", KeyAutoscaleTarget: "cpu=150"},
		"replicas and autoscale":    {KeyReplicas: "2", KeyAutoscale: "2-3"},
		"pdb max-unavailable zero":  {KeyPDB: "max-unavailable=0"},
		"pdb shape":                 {KeyPDB: "50%"},
		"strategy unknown":          {KeyStrategy: "recreate"},
		"strategy not yet":          {KeyStrategy: "blue-green"},
		"read-only root not a bool": {KeyReadOnlyRoot: "no"},
		"read-only root no reason":  {KeyReadOnlyRoot: "false"},
		"reason without false":      {KeyReadOnlyRootReason: "why"},
		"run as root":               {KeyRunAsUser: "0"},
		"host users not a bool":     {KeyHostUsers: "maybe"},
		"spread unknown":            {KeySpread: "rack"},
		"scrape no path":            {KeyScrape: "http"},
		"scrape relative path":      {KeyScrape: "http:metrics"},
		"profile name":              {KeyProfile: "GPU Nodes"},
		"exception no reason":       {KeyPolicyException: "a-rule"},
		"exception bad name":        {KeyPolicyException: "A Rule", KeyPolicyExceptionReason: "x"},
		"exception reason alone":    {KeyPolicyExceptionReason: "x"},
		"score kind statefulset":    {KeyScoreKind: "StatefulSet"},
		"score kind unknown":        {KeyScoreKind: "Job"},
	}
	for name, ann := range cases {
		if _, err := ext(t, ann); err == nil {
			t.Errorf("%s: accepted %v", name, ann)
		}
	}
	m := map[string]interface{}{"name": "web", "annotations": map[string]interface{}{KeyReplicas: 2}}
	if _, err := ParseExt(m); err == nil || !strings.Contains(err.Error(), "must be a string") {
		t.Errorf("unquoted number: %v", err)
	}
}
