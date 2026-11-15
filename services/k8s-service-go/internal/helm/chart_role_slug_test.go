package helm

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chartutil"
	"helm.sh/helm/v3/pkg/engine"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// chartRoleSlug renders the chart's helper for a value of auth.impersonation.customRoles, as helm does.
func chartRoleSlug(t *testing.T, helpers []byte, name string) string {
	t.Helper()
	const slugFile = "kubeast/templates/slug.txt"
	rendered, err := engine.Render(&chart.Chart{
		Metadata: &chart.Metadata{Name: "kubeast", Version: "0.0.0", APIVersion: chart.APIVersionV2},
		Templates: []*chart.File{
			{Name: "templates/_helpers.tpl", Data: helpers},
			{Name: "templates/slug.txt", Data: []byte(`{{ include "kubeast.roleSlug" .Values.name }}`)},
		},
	}, chartutil.Values{"Values": map[string]any{"name": name}})
	if err != nil {
		t.Fatal(err)
	}
	return rendered[slugFile]
}

// The chart binds a group by a role's name and a user acts as the group the same name makes: a name that gave two
// groups would bind one nobody can use.
func TestTheChartBindsTheGroupARoleActsAs(t *testing.T) {
	helpers, err := os.ReadFile("../../../../helm/kubeast/templates/_helpers.tpl")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"ops",
		" ops ",
		"\tops\n",
		"SRE Readonly",
		"  SRE Readonly  ",
		"a.b_c-d",
		"a,b:c/d",
		"운영 담당",
		"Ops Ünit",
	} {
		t.Run(name, func(t *testing.T) {
			got := chartRoleSlug(t, helpers, name)
			if want := auth.RoleGroupSlug(name); got != want {
				t.Errorf("the chart makes %q, the service %q", got, want)
			}
			_, groups := auth.TokenPayload{Email: "a@example.com", Roles: map[string]string{"c": name}}.Impersonation("c")
			if group := "kubeast:role:" + got; !slices.Contains(groups, group) {
				t.Errorf("the chart binds %q, a user with this role acts as %v", group, groups)
			}
		})
	}
}

// The chart's helper is the fourth place of one slug rule: it makes from each name of
// frontend/src/utils/roleGroupSlug.cases.json the slug auth.RoleGroupSlug, the database's role_group_slug and the
// frontend's roleGroupSlug make.
func TestTheChartMakesEachSlugOfTheSharedCases(t *testing.T) {
	helpers, err := os.ReadFile("../../../../helm/kubeast/templates/_helpers.tpl")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../frontend/src/utils/roleGroupSlug.cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct{ Name, Slug string }
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Cases) == 0 {
		t.Fatalf("roleGroupSlug.cases.json: %v", err)
	}
	for _, c := range file.Cases {
		if got := chartRoleSlug(t, helpers, c.Name); got != c.Slug {
			t.Errorf("the chart makes %q of %q, want %q", got, c.Name, c.Slug)
		}
	}
}
