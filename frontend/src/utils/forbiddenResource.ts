// Names the resource kind behind a cluster API path, for the "no permission"
// banner: /cluster/roles/all → "roles", /cluster/namespaces/web/rolebindings →
// "rolebindings", /cluster/helm/releases → "helm releases",
// /cluster/custom-resources/... → "custom resources". Unknown shapes fall back
// to the first path segment after /cluster/.
// API path segments that read badly as-is ("vpas", "ingressclasses").
const KIND_LABELS: Record<string, string> = {
  hpas: 'horizontal pod autoscalers',
  vpas: 'vertical pod autoscalers',
  pdbs: 'pod disruption budgets',
  pvcs: 'persistent volume claims',
  pvs: 'persistent volumes',
  crds: 'custom resource definitions',
  configmaps: 'config maps',
  cronjobs: 'cron jobs',
  daemonsets: 'daemon sets',
  statefulsets: 'stateful sets',
  replicasets: 'replica sets',
  serviceaccounts: 'service accounts',
  rolebindings: 'role bindings',
  clusterroles: 'cluster roles',
  clusterrolebindings: 'cluster role bindings',
  networkpolicies: 'network policies',
  endpointslices: 'endpoint slices',
  ingressclasses: 'ingress classes',
  gatewayclasses: 'gateway classes',
  httproutes: 'HTTP routes',
  grpcroutes: 'gRPC routes',
  referencegrants: 'reference grants',
  backendtlspolicies: 'backend TLS policies',
  storageclasses: 'storage classes',
  volumeattachments: 'volume attachments',
  priorityclasses: 'priority classes',
  runtimeclasses: 'runtime classes',
  resourcequotas: 'resource quotas',
  limitranges: 'limit ranges',
  deviceclasses: 'device classes',
  resourceclaims: 'resource claims',
  resourceclaimtemplates: 'resource claim templates',
  resourceslices: 'resource slices',
  mutatingwebhookconfigurations: 'mutating webhook configurations',
  validatingwebhookconfigurations: 'validating webhook configurations',
}

export function forbiddenResourceFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const parts = path.replace(/^\/api\/v1/, '').replace(/^\/cluster\//, '').split('/').filter(Boolean)
  if (parts.length === 0) return 'cluster resources'
  if (parts[0] === 'namespaces') {
    // /namespaces/{ns}/{kind}[/...]: the kind follows the namespace; a bare
    // /namespaces list is the namespaces themselves
    return parts.length >= 3 ? label(parts[2]) : 'namespaces'
  }
  if (parts[0] === 'helm') return 'helm releases'
  if (parts[0] === 'custom-resources') return 'custom resources'
  if (parts[0] === 'gateway-policies') return 'gateway policies'
  return label(parts[0])
}

const label = (segment: string) => KIND_LABELS[segment] || segment

/** Dedupes and sorts resource names for display: "roles, rolebindings". */
export function joinResources(names: Iterable<string>): string {
  return Array.from(new Set(names)).sort().join(', ')
}
