package repository

import "testing"

func TestAIUsageKeyExpr(t *testing.T) {
	for _, g := range []string{"user", "model", "cluster"} {
		if expr, ok := aiUsageKeyExpr(g); !ok || expr == "" {
			t.Fatalf("group %q must map to a SQL expression", g)
		}
	}
	for _, g := range []string{"", "actor_email; DROP TABLE x", "namespace"} {
		if _, ok := aiUsageKeyExpr(g); ok {
			t.Fatalf("group %q must be rejected", g)
		}
	}
}
