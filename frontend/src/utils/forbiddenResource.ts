// Names the resource kind behind a cluster API path, for the "no permission",
// "not installed" and "could not load" notices: /cluster/roles/all → "Role",
// /cluster/namespaces/web/rolebindings → "RoleBinding", /cluster/helm/releases
// → "Helm release". Kubernetes kinds stay English in every locale (the screen
// names do too). Unknown shapes fall back to the first path segment after
// /cluster/.
const KIND_LABELS: Record<string, string> = {
  pods: 'Pod',
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
  services: 'Service',
  endpoints: 'Endpoints',
  endpointslices: 'EndpointSlice',
  ingresses: 'Ingress',
  ingressclasses: 'IngressClass',
  networkpolicies: 'NetworkPolicy',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  hpas: 'HorizontalPodAutoscaler',
  vpas: 'VerticalPodAutoscaler',
  pdbs: 'PodDisruptionBudget',
  priorityclasses: 'PriorityClass',
  runtimeclasses: 'RuntimeClass',
  leases: 'Lease',
  resourcequotas: 'ResourceQuota',
  limitranges: 'LimitRange',
  mutatingwebhookconfigurations: 'MutatingWebhookConfiguration',
  validatingwebhookconfigurations: 'ValidatingWebhookConfiguration',
  pvcs: 'PersistentVolumeClaim',
  pvs: 'PersistentVolume',
  storageclasses: 'StorageClass',
  volumeattachments: 'VolumeAttachment',
  serviceaccounts: 'ServiceAccount',
  roles: 'Role',
  rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole',
  clusterrolebindings: 'ClusterRoleBinding',
  nodes: 'Node',
  namespaces: 'Namespace',
  events: 'Event',
  crds: 'CustomResourceDefinition',
  gateways: 'Gateway',
  gatewayclasses: 'GatewayClass',
  httproutes: 'HTTPRoute',
  grpcroutes: 'GRPCRoute',
  referencegrants: 'ReferenceGrant',
  backendtlspolicies: 'BackendTLSPolicy',
  deviceclasses: 'DeviceClass',
  resourceclaims: 'ResourceClaim',
  resourceclaimtemplates: 'ResourceClaimTemplate',
  resourceslices: 'ResourceSlice',
}

export function forbiddenResourceFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const parts = path.replace(/^\/api\/v1/, '').replace(/^\/cluster\//, '').split('/').filter(Boolean)
  if (parts.length === 0) return 'cluster resources'
  if (parts[0] === 'namespaces') {
    // /namespaces/{ns}/{kind}[/...]: the kind follows the namespace; a bare
    // /namespaces list is the namespaces themselves
    return parts.length >= 3 ? label(parts[2]) : 'Namespace'
  }
  if (parts[0] === 'helm') return 'Helm release'
  if (parts[0] === 'custom-resources') return 'custom resources'
  if (parts[0] === 'gateway-policies') return 'gateway policies'
  return label(parts[0])
}

const label = (segment: string) => KIND_LABELS[segment] || segment

/** The list's API segment a table keys on: /cluster/vpas/all → "vpas", /cluster/namespaces/web/rolebindings → "rolebindings". */
export function listSegmentFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const parts = path.replace(/^\/api\/v1/, '').replace(/^\/cluster\//, '').split('/').filter(Boolean)
  if (parts.length === 0) return ''
  if (parts[0] === 'namespaces') return parts.length >= 3 ? parts[2] : 'namespaces'
  return parts[0]
}

/** Dedupes and sorts resource names for display: "Role, RoleBinding". */
export function joinResources(names: Iterable<string>): string {
  return Array.from(new Set(names)).sort().join(', ')
}
