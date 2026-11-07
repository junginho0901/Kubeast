package helm

import (
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
