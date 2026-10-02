// Names the resource kind behind a cluster API path, for the "no permission"
// banner: /cluster/roles/all → "roles", /cluster/namespaces/web/rolebindings →
// "rolebindings", /cluster/helm/releases → "helm releases",
// /cluster/custom-resources/... → "custom resources". Unknown shapes fall back
// to the first path segment after /cluster/.
export function forbiddenResourceFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const parts = path.replace(/^\/api\/v1/, '').replace(/^\/cluster\//, '').split('/').filter(Boolean)
  if (parts.length === 0) return 'cluster resources'
  if (parts[0] === 'namespaces') {
    // /namespaces/{ns}/{kind}[/...]: the kind follows the namespace; a bare
    // /namespaces list is the namespaces themselves
    return parts.length >= 3 ? parts[2] : 'namespaces'
  }
  if (parts[0] === 'helm') return 'helm releases'
  if (parts[0] === 'custom-resources') return 'custom resources'
  if (parts[0] === 'gateway-policies') return 'gateway policies'
  return parts[0]
}

/** Dedupes and sorts resource names for display: "roles, rolebindings". */
export function joinResources(names: Iterable<string>): string {
  return Array.from(new Set(names)).sort().join(', ')
}
