package spec

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Prefix is the annotation prefix of the keys the renderer reads. Kubeast
// already labels and annotates with it elsewhere.
const Prefix = "kubeast.io/"

// The keys a Score file may set under metadata.annotations. Each is optional;
// without it the environment's default applies.
const (
	KeyReplicas              = Prefix + "replicas"
	KeyAutoscale             = Prefix + "autoscale"
	KeyAutoscaleTarget       = Prefix + "autoscale-target"
	KeyPDB                   = Prefix + "pdb"
	KeyStrategy              = Prefix + "strategy"
	KeyReadOnlyRoot          = Prefix + "read-only-root"
	KeyReadOnlyRootReason    = Prefix + "read-only-root-reason"
	KeyRunAsUser             = Prefix + "run-as-user"
	KeyHostUsers             = Prefix + "host-users"
	KeySpread                = Prefix + "spread"
	KeyScrape                = Prefix + "scrape"
	KeyProfile               = Prefix + "profile"
	KeyPolicyException       = Prefix + "policy-exception"
	KeyPolicyExceptionReason = Prefix + "policy-exception-reason"
)

// KeyScoreKind is score-k8s's workload kind annotation, read for compatibility.
const KeyScoreKind = "k8s.score.dev/kind"

// Keys lists the kubeast.io/* keys in a fixed order (documentation, schema).
var Keys = []string{
	KeyReplicas, KeyAutoscale, KeyAutoscaleTarget, KeyPDB, KeyStrategy,
	KeyReadOnlyRoot, KeyReadOnlyRootReason, KeyRunAsUser, KeyHostUsers,
	KeySpread, KeyScrape, KeyProfile, KeyPolicyException, KeyPolicyExceptionReason,
}

// Autoscale is kubeast.io/autoscale with kubeast.io/autoscale-target.
type Autoscale struct {
	Min, Max int
	Resource string // cpu or memory
	Target   int    // average utilization, percent
}

// PDBMode says how the PodDisruptionBudget is chosen.
type PDBMode int

const (
	PDBAuto PDBMode = iota // maxUnavailable 1 from two replicas up, none below
	PDBOff
	PDBMaxUnavailable
	PDBMinAvailable
)

// PDB is kubeast.io/pdb.
type PDB struct {
	Mode  PDBMode
	Value int
}

// Scrape is kubeast.io/scrape: the Service port name and path to collect.
type Scrape struct {
	Port, Path string
}

// Spread zones the renderer knows.
const (
	SpreadZone     = "zone"
	SpreadHostname = "hostname"
)

// Ext is what the kubeast.io/* annotations ask for.
type Ext struct {
	Replicas  *int
	Autoscale *Autoscale
	PDB       PDB
	// Strategy is the rollout strategy; this version renders "rolling" only.
	Strategy string
	// ReadOnlyRoot is the container root filesystem setting (default true).
	ReadOnlyRoot       bool
	ReadOnlyRootReason string
	RunAsUser          *int64
	HostUsers          *bool
	// Spread is nil for the environment default, empty for none.
	Spread  []string
	Scrape  *Scrape
	Profile string
	// PolicyExceptions are gate rules this workload is let off, with the
	// reason everyone sees.
	PolicyExceptions      []string
	PolicyExceptionReason string
}

var (
	ruleName  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	rangeExpr = regexp.MustCompile(`^(\d+)-(\d+)$`)
)

// ParseExt reads the kubeast.io/* annotations from Score metadata. An unknown
// kubeast.io/* key is an error, so a typo does not quietly fall back to the
// default; keys under other prefixes are left alone.
func ParseExt(metadata map[string]interface{}) (Ext, error) {
	ext := Ext{Strategy: "rolling", ReadOnlyRoot: true}
	ann, err := annotations(metadata)
	if err != nil {
		return ext, err
	}

	var errs []error
	bad := func(key, format string, args ...interface{}) {
		errs = append(errs, fmt.Errorf("annotation %s: %s", key, fmt.Sprintf(format, args...)))
	}
	known := make(map[string]bool, len(Keys))
	for _, k := range Keys {
		known[k] = true
	}
	for _, k := range sortedKeys(ann) {
		if strings.HasPrefix(k, Prefix) && !known[k] {
			bad(k, "unknown key (known: %s)", strings.Join(Keys, ", "))
		}
	}

	if v, ok := ann[KeyScoreKind]; ok && v != "Deployment" {
		if v == "StatefulSet" {
			bad(KeyScoreKind, "StatefulSet is not supported in this version")
		} else {
			bad(KeyScoreKind, "%q is not a workload kind (Deployment)", v)
		}
	}

	if v, ok := ann[KeyReplicas]; ok {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			bad(KeyReplicas, "%q is not a whole number of 0 or more", v)
		} else {
			ext.Replicas = &n
		}
	}

	if v, ok := ann[KeyAutoscale]; ok {
		m := rangeExpr.FindStringSubmatch(v)
		if m == nil {
			bad(KeyAutoscale, "%q is not <min>-<max>, as \"2-10\"", v)
		} else {
			lo, _ := strconv.Atoi(m[1])
			hi, _ := strconv.Atoi(m[2])
			if lo < 1 || hi < lo {
				bad(KeyAutoscale, "%q needs 1 <= min <= max", v)
			} else {
				ext.Autoscale = &Autoscale{Min: lo, Max: hi, Resource: "cpu", Target: 70}
			}
		}
	}
	if v, ok := ann[KeyAutoscaleTarget]; ok {
		res, pct, found := strings.Cut(v, "=")
		n, err := strconv.Atoi(pct)
		switch {
		case !found || (res != "cpu" && res != "memory") || err != nil || n < 1 || n > 100:
			bad(KeyAutoscaleTarget, "%q is not cpu=<1-100> or memory=<1-100>", v)
		case ext.Autoscale == nil && ann[KeyAutoscale] == "":
			bad(KeyAutoscaleTarget, "set only together with %s", KeyAutoscale)
		case ext.Autoscale != nil:
			ext.Autoscale.Resource, ext.Autoscale.Target = res, n
		}
	}
	if ext.Replicas != nil && ext.Autoscale != nil {
		bad(KeyReplicas, "set %s or %s, not both", KeyReplicas, KeyAutoscale)
	}

	if v, ok := ann[KeyPDB]; ok {
		if p, err := parsePDB(v); err != nil {
			bad(KeyPDB, "%v", err)
		} else {
			ext.PDB = p
		}
	}

	if v, ok := ann[KeyStrategy]; ok {
		switch v {
		case "rolling":
		case "blue-green", "canary":
			bad(KeyStrategy, "%q is not supported in this version (rolling)", v)
		default:
			bad(KeyStrategy, "%q is not a strategy (rolling, blue-green, canary)", v)
		}
	}

	if v, ok := ann[KeyReadOnlyRoot]; ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			bad(KeyReadOnlyRoot, "%q is not true or false", v)
		} else {
			ext.ReadOnlyRoot = b
		}
	}
	ext.ReadOnlyRootReason = strings.TrimSpace(ann[KeyReadOnlyRootReason])
	if !ext.ReadOnlyRoot && ext.ReadOnlyRootReason == "" {
		bad(KeyReadOnlyRoot, "\"false\" needs %s, one line on why the container writes to its root", KeyReadOnlyRootReason)
	}
	if ext.ReadOnlyRoot && ext.ReadOnlyRootReason != "" {
		bad(KeyReadOnlyRootReason, "only together with %s: \"false\"", KeyReadOnlyRoot)
	}

	if v, ok := ann[KeyRunAsUser]; ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			bad(KeyRunAsUser, "%q is not a user ID above 0", v)
		} else {
			ext.RunAsUser = &n
		}
	}

	if v, ok := ann[KeyHostUsers]; ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			bad(KeyHostUsers, "%q is not true or false", v)
		} else {
			ext.HostUsers = &b
		}
	}

	if v, ok := ann[KeySpread]; ok {
		if s, err := ParseSpread(v); err != nil {
			bad(KeySpread, "%v", err)
		} else {
			ext.Spread = s
		}
	}

	if v, ok := ann[KeyScrape]; ok {
		port, p, found := strings.Cut(v, ":")
		if !found || port == "" || !strings.HasPrefix(p, "/") {
			bad(KeyScrape, "%q is not <service port name>:<path>, as \"http:/metrics\"", v)
		} else {
			ext.Scrape = &Scrape{Port: port, Path: p}
		}
	}

	if v, ok := ann[KeyProfile]; ok {
		if !ruleName.MatchString(v) {
			bad(KeyProfile, "%q is not a profile name", v)
		} else {
			ext.Profile = v
		}
	}

	if v, ok := ann[KeyPolicyException]; ok {
		seen := map[string]bool{}
		for _, r := range strings.Split(v, ",") {
			r = strings.TrimSpace(r)
			if !ruleName.MatchString(r) {
				bad(KeyPolicyException, "%q is not a rule name", r)
				continue
			}
			if !seen[r] {
				seen[r] = true
				ext.PolicyExceptions = append(ext.PolicyExceptions, r)
			}
		}
		sort.Strings(ext.PolicyExceptions)
	}
	ext.PolicyExceptionReason = strings.TrimSpace(ann[KeyPolicyExceptionReason])
	if len(ext.PolicyExceptions) > 0 && ext.PolicyExceptionReason == "" {
		bad(KeyPolicyException, "needs %s, one line on why", KeyPolicyExceptionReason)
	}
	if _, ok := ann[KeyPolicyException]; !ok && ext.PolicyExceptionReason != "" {
		bad(KeyPolicyExceptionReason, "only together with %s", KeyPolicyException)
	}

	return ext, errors.Join(errs...)
}

// ParseSpread reads "off" or a comma list of zone and hostname.
func ParseSpread(v string) ([]string, error) {
	if strings.TrimSpace(v) == "off" {
		return []string{}, nil
	}
	var out []string
	seen := map[string]bool{}
	for _, s := range strings.Split(v, ",") {
		s = strings.TrimSpace(s)
		if s != SpreadZone && s != SpreadHostname {
			return nil, fmt.Errorf("%q is not off or a list of zone, hostname", v)
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func parsePDB(v string) (PDB, error) {
	if v == "off" {
		return PDB{Mode: PDBOff}, nil
	}
	key, val, found := strings.Cut(v, "=")
	n, err := strconv.Atoi(val)
	if !found || err != nil || n < 0 {
		return PDB{}, fmt.Errorf("%q is not off, max-unavailable=<n> or min-available=<n>", v)
	}
	switch key {
	case "max-unavailable":
		if n < 1 {
			return PDB{}, fmt.Errorf("%q: max-unavailable=0 would block every drain", v)
		}
		return PDB{Mode: PDBMaxUnavailable, Value: n}, nil
	case "min-available":
		return PDB{Mode: PDBMinAvailable, Value: n}, nil
	}
	return PDB{}, fmt.Errorf("%q is not off, max-unavailable=<n> or min-available=<n>", v)
}

// annotations returns metadata.annotations as strings; the schema allows
// any values there, but every key the renderer reads is a string.
func annotations(metadata map[string]interface{}) (map[string]string, error) {
	raw, ok := metadata["annotations"]
	if !ok || raw == nil {
		return map[string]string{}, nil
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, errors.New("metadata.annotations is not a map")
	}
	out := make(map[string]string, len(m))
	var errs []error
	for _, k := range sortedKeys(m) {
		s, ok := m[k].(string)
		if !ok {
			if strings.HasPrefix(k, Prefix) || k == KeyScoreKind {
				errs = append(errs, fmt.Errorf("annotation %s: the value must be a string (quote it)", k))
			}
			continue
		}
		out[k] = s
	}
	return out, errors.Join(errs...)
}
