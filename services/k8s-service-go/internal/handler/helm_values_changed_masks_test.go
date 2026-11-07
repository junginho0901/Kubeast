package handler

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"helm.sh/helm/v3/pkg/chart"
)

// helmSecretManifest is what the chart below renders of a password.
func helmSecretManifest(password string) string {
	return "---\n# Source: app/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app-conf\n  namespace: team-a\nstringData:\n  password: \"" + password + "\"\n"
}

// newHelmSecretOnlyRig has a chart that renders the password into a Secret and nothing else, so a masked diff has nothing
// to show for it.
func newHelmSecretOnlyRig(t *testing.T, perms ...string) *helmValuesRig {
	t.Helper()
	ch := helmValuesChart()
	ch.Templates = []*chart.File{{Name: "templates/secret.yaml", Data: []byte("apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-conf\n  namespace: team-a\nstringData:\n  password: {{ .Values.adminPassword | default \"fake-chart-default\" | quote }}\n")}}
	return newHelmValuesRigOf(t, ch, helmValuesConfig(), helmSecretManifest("fake-admin-value"), perms...)
}

// newHelmPlainValueRig renders replicaCount where a masked diff cannot show it, or nowhere when template is empty.
func newHelmPlainValueRig(t *testing.T, template, manifest string, perms ...string) *helmValuesRig {
	t.Helper()
	ch := helmValuesChart()
	if template != "" {
		ch.Templates = []*chart.File{{Name: "templates/x.yaml", Data: []byte(template)}}
	}
	return newHelmValuesRigOf(t, ch, helmValuesConfig(), manifest, perms...)
}

const (
	helmSecretTemplate = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-conf\n  namespace: team-a\nstringData:\n  plain: {{ .Values.replicaCount | quote }}\n"
	helmSecretRendered = "---\n# Source: app/templates/x.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app-conf\n  namespace: team-a\nstringData:\n  plain: \"2\"\n"
	helmHookTemplate   = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-hook\n  namespace: team-a\n  annotations:\n    helm.sh/hook: pre-upgrade\ndata:\n  plain: {{ .Values.replicaCount | quote }}\n"
)

func helmEditAPlainValue(shown string) string {
	return strings.Replace(shown, "replicaCount: 2", "replicaCount: 5", 1)
}

// A plain value can change with nothing to show in a masked diff or in the manifest at all. The stored values still
// change, so the preview says they do and the upgrade can be applied.
func TestHelmPreviewSaysTheValuesChangeWithNoDiffToShow(t *testing.T) {
	reveal := append(helmEditorPerms(), "resource.secret.reveal")
	for _, c := range []struct {
		title              string
		template, manifest string
		perms              []string
		wantDiff           bool
	}{
		{"only a Secret holds it, without reveal", helmSecretTemplate, helmSecretRendered, helmEditorPerms(), false},
		{"only a Secret holds it, with reveal", helmSecretTemplate, helmSecretRendered, reveal, true},
		{"nothing renders it, without reveal", "", "", helmEditorPerms(), false},
		{"nothing renders it, with reveal", "", "", reveal, false},
		{"only a hook uses it, without reveal", helmHookTemplate, "", helmEditorPerms(), false},
		{"only a hook uses it, with reveal", helmHookTemplate, "", reveal, false},
	} {
		t.Run(c.title, func(t *testing.T) {
			r := newHelmPlainValueRig(t, c.template, c.manifest, c.perms...)
			w := r.upgrade(helmEditAPlainValue(r.shown()), true)
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			answer := helmAnswer(t, w.Body.Bytes())
			if diff, _ := answer["diff"].(string); (diff != "") != c.wantDiff {
				t.Errorf("the diff = %q, want something to show: %v", diff, c.wantDiff)
			}
			if answer["values_changed"] != true {
				t.Errorf("values_changed = %v, want true: %s", answer["values_changed"], w.Body)
			}
			if strings.Contains(w.Body.String(), "changed_masked") {
				t.Errorf("no hidden value was touched: %s", w.Body)
			}
		})
	}
}

// Only what the values mean counts: a comment or another spacing changes nothing, for anyone.
func TestHelmPreviewSaysNothingChangesForTheSameValues(t *testing.T) {
	reveal := append(helmEditorPerms(), "resource.secret.reveal")
	for title, perms := range map[string][]string{"without reveal": helmEditorPerms(), "with reveal": reveal} {
		t.Run(title, func(t *testing.T) {
			r := newHelmPlainValueRig(t, "", "", perms...)
			shown := r.shown()
			for what, draft := range map[string]string{
				"as shown":     shown,
				"a comment":    "# a note\n" + shown,
				"blank lines":  "\n\n" + shown + "\n",
				"another form": strings.Replace(shown, "replicaCount: 2", "replicaCount: 2.0", 1),
			} {
				w := r.upgrade(draft, true)
				if w.Code != http.StatusOK {
					t.Fatalf("%s: status %d: %s", what, w.Code, w.Body)
				}
				if strings.Contains(w.Body.String(), "values_changed") {
					t.Errorf("%s: %s", what, w.Body)
				}
			}
		})
	}
}

// An empty release and empty values are the same values.
func TestHelmPreviewOfAnEmptyReleaseWithNoValuesChangesNothing(t *testing.T) {
	r := newHelmValuesRigOf(t, helmValuesChart(), map[string]any{}, "", helmEditorPerms()...)
	for _, draft := range []string{"", "# a note\n", "{}\n"} {
		w := r.upgrade(draft, true)
		if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "values_changed") {
			t.Errorf("%q: status %d: %s", draft, w.Code, w.Body)
		}
	}
}

// The values sent are compared with the values shown and never with what those hide, so a right guess and a wrong one
// read the same to the byte, each saying the values change, whatever the chart does with the value.
func TestHelmPreviewAnswersARightGuessAsAWrongOneWhateverTheChartRenders(t *testing.T) {
	for _, c := range []struct {
		title              string
		template, manifest string
		key, right, wrong  string
	}{
		{"a string nothing renders", "", "", "adminPassword", "fake-admin-value", "fake-wrong-guess"},
		{"a number nothing renders", "", "", "dbPassword", "87654321", "87654322"},
		{"a string a Secret holds", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-conf\n  namespace: team-a\nstringData:\n  password: {{ .Values.adminPassword | default \"fake-chart-default\" | quote }}\n", strings.Replace(helmSecretManifest("fake-admin-value"), "secret.yaml", "x.yaml", 1), "adminPassword", "fake-admin-value", "fake-wrong-guess"},
		{"a value inside a list", "", "", "password", "fake-nested-value", "fake-wrong-guess"},
		{"a whole url", "", "", "url", "postgres://app:fake-url-password@db.shop:5432/app", "postgres://app:fake-wrong-guess@db.shop:5432/app"},
	} {
		t.Run(c.title, func(t *testing.T) {
			r := newHelmPlainValueRig(t, c.template, c.manifest, helmEditorPerms()...)
			shown := r.shown()
			right := r.upgrade(helmLine(t, shown, c.key, c.right), true)
			wrong := r.upgrade(helmLine(t, shown, c.key, c.wrong), true)
			if right.Code != http.StatusOK || wrong.Code != http.StatusOK {
				t.Fatalf("status %d %d: %s %s", right.Code, wrong.Code, right.Body, wrong.Body)
			}
			if right.Body.String() != wrong.Body.String() {
				t.Errorf("a right guess reads %s, a wrong one %s", right.Body, wrong.Body)
			}
			if helmAnswer(t, right.Body.Bytes())["values_changed"] != true {
				t.Errorf("values_changed is not true: %s", right.Body)
			}
		})
	}
}

// A list item moved keeps its value through the handler too: the place named is where it was shown.
func TestHelmUpgradeWithoutRevealKeepsAMovedListItemsValue(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	shown := r.shown()
	draft := strings.Replace(shown, "extraObjects:\n", "extraObjects:\n- kind: ConfigMap\n", 1)
	if draft == shown {
		t.Fatalf("no list in %s", shown)
	}
	w := r.upgrade(draft, false)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	stored, ok := r.stored(2)
	if !ok {
		t.Fatal("no new revision")
	}
	want := helmValuesConfig()
	want["extraObjects"] = append([]any{map[string]any{"kind": "ConfigMap"}}, want["extraObjects"].([]any)...)
	if !reflect.DeepEqual(stored, want) {
		t.Errorf("the stored values = %v, want %v", stored, want)
	}
	if kept := keptMaskedOf(t, w.Body.Bytes()); !reflect.DeepEqual(kept, helmValuesKept) {
		t.Errorf("kept %v, want %v", kept, helmValuesKept)
	}
	r.wantNoSecretIn("the answer", w.Body.String())
}

// Two items that read alike cannot say which value is meant once one is gone: nothing is written, the place is named and
// no value comes back.
func TestHelmUpgradeWithoutRevealRefusesARemovalThatCannotSayWhichValue(t *testing.T) {
	// the same answer whether or not the two hidden values are the same, so it does not say which
	answer := ""
	for title, second := range map[string]string{"different values": "fake-second-password", "the same value": "fake-first-password"} {
		t.Run(title, func(t *testing.T) {
			config := map[string]any{"users": []any{
				map[string]any{"name": "same", "password": "fake-first-password"},
				map[string]any{"name": "same", "password": second},
				map[string]any{"name": "other", "password": "fake-other-password"},
			}}
			r := newHelmValuesRigOf(t, helmValuesChart(), config, "", helmEditorPerms()...)
			draft := strings.Replace(r.shown(), "- name: same\n  password: <REDACTED:password>\n", "", 1)
			w := r.upgrade(draft, false)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "users[0].password") {
				t.Fatalf("status %d: %s, want 400 naming users[0].password", w.Code, w.Body)
			}
			if strings.Contains(w.Body.String(), "fake-") {
				t.Errorf("a value came back: %s", w.Body)
			}
			if _, ok := r.stored(2); ok {
				t.Error("a revision was made")
			}
			if answer != "" && answer != w.Body.String() {
				t.Errorf("one answer reads %s, another %s", answer, w.Body)
			}
			answer = w.Body.String()
		})
	}
}

// helmLine gives text with the first line of a key and those nested under it written over, or removed when replacement is empty.
func helmLine(t *testing.T, text, key, replacement string) string {
	t.Helper()
	indentOf := func(line string) int { return len(line) - len(strings.TrimLeft(line, " ")) }
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if !strings.HasPrefix(strings.TrimLeft(line, " "), key+":") {
			continue
		}
		end := i + 1
		for end < len(lines) && lines[end] != "" && indentOf(lines[end]) > indentOf(line) {
			end++
		}
		written := []string{}
		if replacement != "" {
			written = append(written, line[:indentOf(line)]+key+": "+replacement)
		}
		return strings.Join(append(append(append([]string{}, lines[:i]...), written...), lines[end:]...), "\n")
	}
	t.Fatalf("no line %q in %s", key, text)
	return ""
}

func helmAnswer(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var answer map[string]any
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return answer
}

const helmNewValue = "fake-written-value"

// What an editor changed may be all hidden from a masked diff. The preview still names it, by where it is, so the change
// can be seen and applied.
func TestHelmPreviewNamesAHiddenValueWrittenOverOrRemoved(t *testing.T) {
	for _, c := range []struct {
		title string
		edit  func(*testing.T, string) string
		want  []any
	}{
		{"a whole value written over", func(t *testing.T, s string) string { return helmLine(t, s, "adminPassword", helmNewValue) }, []any{"adminPassword"}},
		{"a number written over", func(t *testing.T, s string) string { return helmLine(t, s, "dbPassword", "12345678") }, []any{"dbPassword"}},
		{"a block written over", func(t *testing.T, s string) string { return helmLine(t, s, "token", helmNewValue) }, []any{"cert.token"}},
		{"a partly hidden value written whole", func(t *testing.T, s string) string {
			return helmLine(t, s, "url", "postgres://app:"+helmNewValue+"@db.shop:5432/app")
		}, []any{"db.url"}},
		{"a value in a list written over", func(t *testing.T, s string) string { return helmLine(t, s, "password", helmNewValue) }, []any{"extraObjects[0].stringData.password"}},
		{"its line removed", func(t *testing.T, s string) string { return helmLine(t, s, "adminPassword", "") }, []any{"adminPassword"}},
		{"its parent removed", func(t *testing.T, s string) string { return helmLine(t, s, "db", "") }, []any{"db.url"}},
		{"two at once", func(t *testing.T, s string) string {
			return helmLine(t, helmLine(t, s, "adminPassword", helmNewValue), "dbPassword", "")
		}, []any{"adminPassword", "dbPassword"}},
	} {
		t.Run(c.title, func(t *testing.T) {
			r := newHelmSecretOnlyRig(t, helmEditorPerms()...)
			draft := c.edit(t, r.shown())
			w := r.upgrade(draft, true)
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			answer := helmAnswer(t, w.Body.Bytes())
			if diff, _ := answer["diff"].(string); diff != "" {
				t.Errorf("the masked diff = %q, want nothing to show", diff)
			}
			got, _ := answer["changed_masked"].([]any)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("the preview names %v, want %v", got, c.want)
			}
			kept, _ := answer["kept_masked"].([]any)
			for _, name := range c.want {
				for _, stayed := range kept {
					if stayed == name {
						t.Errorf("%v is named as kept as well: %v", name, kept)
					}
				}
			}
			r.wantNoSecretIn("the preview", w.Body.String())
			if strings.Contains(w.Body.String(), helmNewValue) {
				t.Errorf("the preview holds what was written: %s", w.Body)
			}
		})
	}
}

// A placeholder left where it was shown is no change, whatever else was edited.
func TestHelmPreviewNamesNoHiddenValueLeftAsShown(t *testing.T) {
	r := newHelmSecretOnlyRig(t, helmEditorPerms()...)
	shown := r.shown()
	for title, draft := range map[string]string{
		"left as shown":      shown,
		"another key edited": strings.Replace(shown, "replicaCount: 2", "replicaCount: 5", 1),
		"a plain line added": shown + "zeta: 1\n",
	} {
		w := r.upgrade(draft, true)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", title, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), "changed_masked") {
			t.Errorf("%s: %s", title, w.Body)
		}
	}
}

// The value is not compared: a right guess and a wrong one get the same answer, so the preview confirms neither.
func TestHelmPreviewAnswersARightGuessAsAWrongOne(t *testing.T) {
	r := newHelmSecretOnlyRig(t, helmEditorPerms()...)
	shown := r.shown()
	right := r.upgrade(helmLine(t, shown, "adminPassword", "fake-admin-value"), true)
	wrong := r.upgrade(helmLine(t, shown, "adminPassword", "fake-wrong-guess"), true)
	if right.Code != http.StatusOK || wrong.Code != http.StatusOK {
		t.Fatalf("status %d %d: %s %s", right.Code, wrong.Code, right.Body, wrong.Body)
	}
	if right.Body.String() != wrong.Body.String() {
		t.Errorf("a right guess reads %s, a wrong one %s", right.Body, wrong.Body)
	}
	if got, _ := helmAnswer(t, right.Body.Bytes())["changed_masked"].([]any); !reflect.DeepEqual(got, []any{"adminPassword"}) {
		t.Errorf("the preview names %v", got)
	}
}

// The applied upgrade names it too, in the answer and the row, with no value of either side.
func TestHelmUpgradeNamesAHiddenValueWrittenOverInItsRow(t *testing.T) {
	r := newHelmValuesRig(t, helmValuesChart(), helmEditorPerms()...)
	w := r.upgrade(helmLine(t, r.shown(), "adminPassword", helmNewValue), false)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	stored, ok := r.stored(2)
	if !ok || stored["adminPassword"] != helmNewValue {
		t.Fatalf("the stored values = %v", stored)
	}
	want := []any{"adminPassword"}
	if got, _ := helmAnswer(t, w.Body.Bytes())["changed_masked"].([]any); !reflect.DeepEqual(got, want) {
		t.Errorf("the answer names %v, want %v", got, want)
	}
	row := r.lastRow()
	if got, _ := helmAnswer(t, row.After)["changed_masked"].([]any); !reflect.DeepEqual(got, want) {
		t.Errorf("the row names %v, want %v", got, want)
	}
	for where, text := range map[string]string{"the answer": w.Body.String(), "the row": rowText(row)} {
		r.wantNoSecretIn(where, text)
		if strings.Contains(text, helmNewValue) {
			t.Errorf("%s holds what was written: %s", where, text)
		}
	}
}

// Whoever may reveal reads the values and a diff that shows them: there is nothing hidden to name.
func TestHelmPreviewWithRevealNamesNoHiddenValue(t *testing.T) {
	r := newHelmSecretOnlyRig(t, append(helmEditorPerms(), "resource.secret.reveal")...)
	values := helmLine(t, r.shown(), "adminPassword", helmNewValue)
	w := r.upgrade(values, true)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "changed_masked") {
		t.Errorf("%s", w.Body)
	}
	if diff, _ := helmAnswer(t, w.Body.Bytes())["diff"].(string); !strings.Contains(diff, helmNewValue) {
		t.Errorf("the diff = %q, want the written value", diff)
	}
}
