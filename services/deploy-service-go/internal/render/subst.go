package render

import (
	"regexp"
	"sort"
	"strings"

	"github.com/score-spec/score-go/framework"
)

// A secret output is never a value Kubeast sees: the lookup returns a marker,
// and the place it lands decides what it becomes — a secretKeyRef for a
// variable that is exactly one secret, a dependent variable $(…) for one that
// embeds it, an error anywhere else.
const secretMark = "\x00kubeast-secret\x00"

var secretRef = regexp.MustCompile(`\x00kubeast-secret\x00([^\x00]+)\x00([^\x00]+)\x00kubeast-secret\x00`)

func secretMarker(id, key string) string {
	return secretMark + id + "\x00" + key + secretMark
}

func hasSecret(v interface{}) bool {
	switch t := v.(type) {
	case string:
		return strings.Contains(t, secretMark)
	case map[string]interface{}:
		for _, x := range t {
			if hasSecret(x) {
				return true
			}
		}
	case []interface{}:
		for _, x := range t {
			if hasSecret(x) {
				return true
			}
		}
	}
	return false
}

func (r *renderer) subst(src string) (string, error) {
	return framework.SubstituteString(src, r.lookup)
}

func (r *renderer) secretName(id string) string {
	return r.name + "-" + id
}

func (r *renderer) secretKeyRef(id, key string) Object {
	return Object{"secretKeyRef": Object{"name": r.secretName(id), "key": key}}
}

// hiddenName is the variable a secret embedded in another variable comes
// through; Kubernetes expands $(NAME) from variables defined before it.
func hiddenName(id, key string) string {
	clean := func(s string) string {
		return strings.Map(func(c rune) rune {
			switch {
			case c >= 'a' && c <= 'z':
				return c - 'a' + 'A'
			case c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
				return c
			}
			return '_'
		}, s)
	}
	return "KUBEAST_SECRET_" + clean(id) + "_" + clean(key)
}

// envVars turns Score variables into container env, secrets as references.
func (r *renderer) envVars(container string, vars map[string]string) []interface{} {
	hidden := map[string]Object{}
	var regular []interface{}
	for _, name := range sortedKeys(vars) {
		if strings.HasPrefix(name, "KUBEAST_SECRET_") {
			r.fail("container %q variable %q: the KUBEAST_SECRET_ prefix is kept for secret references", container, name)
			continue
		}
		v, err := r.subst(vars[name])
		if err != nil {
			r.fail("container %q variable %q: %v", container, name, err)
			continue
		}
		m := secretRef.FindAllStringSubmatchIndex(v, -1)
		switch {
		case len(m) == 0:
			regular = append(regular, Object{"name": name, "value": v})
		case len(m) == 1 && m[0][0] == 0 && m[0][1] == len(v):
			regular = append(regular, Object{"name": name, "valueFrom": r.secretKeyRef(v[m[0][2]:m[0][3]], v[m[0][4]:m[0][5]])})
		default:
			out := secretRef.ReplaceAllStringFunc(v, func(s string) string {
				sm := secretRef.FindStringSubmatch(s)
				hn := hiddenName(sm[1], sm[2])
				hidden[hn] = Object{"name": hn, "valueFrom": r.secretKeyRef(sm[1], sm[2])}
				return "$(" + hn + ")"
			})
			regular = append(regular, Object{"name": name, "value": out})
		}
	}
	names := make([]string, 0, len(hidden))
	for n := range hidden {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]interface{}, 0, len(names)+len(regular))
	for _, n := range names {
		out = append(out, hidden[n])
	}
	return append(out, regular...)
}
