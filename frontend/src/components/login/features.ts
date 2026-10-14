// The words around the sign-in page's logo: Kubernetes resources, as the console names them (English in every
// locale). The near layer holds the ones people open most; the far layer the rest.
const words = (names: string[]) => names.map((text) => ({ id: text, text }))

export const LOGIN_WORDS = words([
  'Pods',
  'Deployments',
  'StatefulSets',
  'DaemonSets',
  'Services',
  'Ingress',
  'ConfigMaps',
  'Secrets',
  'Jobs',
  'CronJobs',
  'Nodes',
  'Namespaces',
])

export const LOGIN_AMBIENT = words([
  'ReplicaSets',
  'EndpointSlices',
  'PersistentVolumes',
  'PersistentVolumeClaims',
  'StorageClasses',
  'ServiceAccounts',
  'Roles',
  'RoleBindings',
  'ClusterRoles',
  'NetworkPolicies',
  'PodDisruptionBudgets',
  'ResourceQuotas',
  'LimitRanges',
  'PriorityClasses',
  'CustomResourceDefinitions',
  'HorizontalPodAutoscalers',
  'Leases',
  'Events',
  'IngressClasses',
  'GatewayClasses',
  'HTTPRoutes',
  'VolumeAttachments',
  'RuntimeClasses',
  'CSIDrivers',
])
