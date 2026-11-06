package handler

// NamespaceRuleName is the rule a route falls under, for the route table test outside this package.
func NamespaceRuleName(method, pattern string) string { return namespaceRuleFor(method, pattern).name }

// NamespaceRouteKeys lists the routes the table names, for the same test.
func NamespaceRouteKeys() []string {
	out := make([]string, 0, len(namespaceRoutes))
	for key := range namespaceRoutes {
		out = append(out, key)
	}
	return out
}
