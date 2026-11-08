package pdb

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

const selectorCasesFile = "../../../../frontend/src/components/resource-detail/pdbSelector.cases.json"

type selectorPod struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
}

// selectorCase is a budget's selector as the drawer gets it, the selector the disruption controller reads from the
// object, and the pods of the namespace that selector picks.
type selectorCase struct {
	Name             string        `json:"name"`
	Selector         interface{}   `json:"selector"`
	MatchExpressions interface{}   `json:"match_expressions,omitempty"`
	HasSelector      interface{}   `json:"has_selector"`
	LabelSelector    string        `json:"label_selector"`
	Pods             []selectorPod `json:"pods"`
	Protected        []string      `json:"protected"`
}

func selectorCases(t *testing.T) []selectorCase {
	t.Helper()
	pods := []selectorPod{
		{Name: "frontend-pod", Labels: map[string]string{"app": "web", "tier": "frontend", "env": "prod", "team": "a"}},
		{Name: "backend-pod", Labels: map[string]string{"app": "web", "tier": "backend", "env": "prod", "team": "a"}},
		{Name: "untiered-pod", Labels: map[string]string{"app": "web", "env": "dev", "team": "a"}},
		{Name: "canary-pod", Labels: map[string]string{"app": "web", "tier": "frontend", "env": "prod", "team": "a", "canary": "true"}},
		{Name: "zone-b-pod", Labels: map[string]string{"app": "web", "tier": "frontend", "env": "dev", "team": "a", "zone": "b"}},
		{Name: "other-app-pod", Labels: map[string]string{"app": "api", "tier": "frontend", "env": "prod", "team": "a"}},
	}
	raw := []struct {
		name string
		sel  *metav1.LabelSelector
	}{
		{"matchLabels only", &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}},
		{"matchLabels and In", &metav1.LabelSelector{
			MatchLabels:      map[string]string{"app": "web"},
			MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "tier", Operator: metav1.LabelSelectorOpIn, Values: []string{"frontend"}}},
		}},
		{"every operator", &metav1.LabelSelector{
			MatchLabels: map[string]string{"app": "web"},
			MatchExpressions: []metav1.LabelSelectorRequirement{
				{Key: "env", Operator: metav1.LabelSelectorOpIn, Values: []string{"prod", "dev"}},
				{Key: "zone", Operator: metav1.LabelSelectorOpNotIn, Values: []string{"b"}},
				{Key: "team", Operator: metav1.LabelSelectorOpExists},
				{Key: "canary", Operator: metav1.LabelSelectorOpDoesNotExist},
			},
		}},
		{"expressions only", &metav1.LabelSelector{
			MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "tier", Operator: metav1.LabelSelectorOpNotIn, Values: []string{"backend"}}},
		}},
		{"empty selector", &metav1.LabelSelector{}},
		{"no selector", nil},
	}
	cases := make([]selectorCase, 0, len(raw))
	for _, r := range raw {
		row := Info(&policyv1.PodDisruptionBudget{Spec: policyv1.PodDisruptionBudgetSpec{Selector: r.sel}})
		sel, err := metav1.LabelSelectorAsSelector(r.sel)
		if err != nil {
			t.Fatalf("%s: %v", r.name, err)
		}
		c := selectorCase{Name: r.name, Selector: row["selector"], MatchExpressions: row["match_expressions"], HasSelector: row["has_selector"], LabelSelector: sel.String(), Pods: pods, Protected: []string{}}
		for _, p := range pods {
			if sel.Matches(labels.Set(p.Labels)) {
				c.Protected = append(c.Protected, p.Name)
			}
		}
		cases = append(cases, c)
	}
	return cases
}

// In policy/v1 a budget with no selector protects no pod and one with an empty selector every pod of its namespace; both
// rows say `selector: {}`, so the row says which it is.
func TestABudgetsRowTellsNoSelectorFromAnEmptyOne(t *testing.T) {
	for _, c := range []struct {
		sel  *metav1.LabelSelector
		want bool
	}{{nil, false}, {&metav1.LabelSelector{}, true}, {&metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}, true}} {
		row := Info(&policyv1.PodDisruptionBudget{Spec: policyv1.PodDisruptionBudgetSpec{Selector: c.sel}})
		if got, ok := row["has_selector"].(bool); !ok || got != c.want {
			t.Errorf("selector %v: has_selector = %#v, want %v", c.sel, row["has_selector"], c.want)
		}
	}
}

// The selector text the drawer sends is read by the API server and the pod page (labels.Parse) as the same selector the
// disruption controller makes of the object, so the drawer lists the pods the budget protects and no others. A budget
// with no selector is not read at all (has_selector false): its text is empty like an empty selector's.
func TestASelectorsTextPicksThePodsTheBudgetProtects(t *testing.T) {
	for _, c := range selectorCases(t) {
		if c.HasSelector == false {
			if len(c.Protected) != 0 {
				t.Errorf("%s: a budget with no selector protects %v, want none", c.Name, c.Protected)
			}
			continue
		}
		parsed, err := labels.Parse(c.LabelSelector)
		if err != nil {
			t.Fatalf("%s: %q does not parse: %v", c.Name, c.LabelSelector, err)
		}
		picked := []string{}
		for _, p := range c.Pods {
			if parsed.Matches(labels.Set(p.Labels)) {
				picked = append(picked, p.Name)
			}
		}
		if got, want := len(picked), len(c.Protected); got != want {
			t.Errorf("%s: %q picks %v, the budget protects %v", c.Name, c.LabelSelector, picked, c.Protected)
			continue
		}
		for i := range picked {
			if picked[i] != c.Protected[i] {
				t.Errorf("%s: %q picks %v, the budget protects %v", c.Name, c.LabelSelector, picked, c.Protected)
				break
			}
		}
	}
}

// pdbSelector.cases.json holds the drawer's answer and the selector text the API server reads for it; the drawer's test
// (pdbProtectedPods.test.ts) holds the text it sends to the same value.
func TestPDBSelectorCasesFixture(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(selectorCases(t)); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_PDB_SELECTOR_CASES") == "1" {
		if err := os.WriteFile(selectorCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(selectorCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_PDB_SELECTOR_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("pdbSelector.cases.json is not what the budget's answer and selector give now: rerun with UPDATE_PDB_SELECTOR_CASES=1 and check the drawer's test")
	}
}
