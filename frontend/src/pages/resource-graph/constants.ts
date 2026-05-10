// Resource Graph 페이지의 상수 / 순수 데이터 + statusColor helper
//
// frontend/src/pages/ResourceGraph.tsx 의 상단 lookup 테이블 + statusColor 추출.
// 행동 변화 0 — kind/edge 정의는 그대로 유지.

import type { ResourceGraphEdgeType } from '@/services/api'

// Kind → emoji icon
export const kindIcon: Record<string, string> = {
  Pod: '🔵', Deployment: '🚀', ReplicaSet: '📋', StatefulSet: '📊',
  DaemonSet: '👾', Job: '⚡', CronJob: '⏰', Service: '🌐',
  Ingress: '🔀', ConfigMap: '📝', Secret: '🔑',
  PersistentVolumeClaim: '💿', PersistentVolume: '💾',
  StorageClass: '🗄', ServiceAccount: '👤', Role: '🔐', ClusterRole: '🔐',
  RoleBinding: '🔗', ClusterRoleBinding: '🔗',
  HorizontalPodAutoscaler: '📈', NetworkPolicy: '🛡',
  EndpointSlice: '📡', Endpoints: '📡',
}

// Kind weight for layered layout (higher = further left/top)
export const kindWeight: Record<string, number> = {
  HorizontalPodAutoscaler: 1000,
  Ingress: 950,
  Service: 900,
  Deployment: 850, StatefulSet: 850, DaemonSet: 850,
  CronJob: 820, Job: 810,
  ReplicaSet: 800,
  Pod: 700,
  NetworkPolicy: 650,
  PersistentVolumeClaim: 600, PersistentVolume: 550, StorageClass: 500,
  ConfigMap: 400, Secret: 400,
  ServiceAccount: 300, Role: 250, ClusterRole: 250,
  RoleBinding: 200, ClusterRoleBinding: 200,
  EndpointSlice: 150, Endpoints: 150,
}

// Status → border color
export function statusColor(status: string): string {
  const s = status.toLowerCase()
  if (['running', 'active', 'bound', 'succeeded', 'clusterip', 'nodeport', 'loadbalancer'].some(k => s.includes(k))) return '#22c55e'
  if (['pending', 'terminating', 'progressing'].some(k => s.includes(k))) return '#eab308'
  if (['failed', 'error', 'crashloopbackoff', 'imagepullbackoff'].some(k => s.includes(k))) return '#ef4444'
  return '#64748b'
}

// Edge type → style
export const edgeStyles: Record<string, { stroke: string; strokeDasharray?: string; label: string }> = {
  owns:           { stroke: '#94a3b8', label: 'owns' },
  selects:        { stroke: '#3b82f6', strokeDasharray: '5 5', label: 'selects' },
  mounts:         { stroke: '#a855f7', strokeDasharray: '5 5', label: 'mounts' },
  routes:         { stroke: '#22c55e', label: 'routes' },
  binds:          { stroke: '#f97316', strokeDasharray: '5 5', label: 'binds' },
  bound_to:       { stroke: '#d946ef', label: 'bound_to' },
  provisions:     { stroke: '#6b7280', strokeDasharray: '8 4', label: 'provisions' },
  hpa_targets:    { stroke: '#eab308', label: 'targets' },
  network_policy: { stroke: '#ef4444', strokeDasharray: '4 4', label: 'policy' },
  endpoint_of:    { stroke: '#06b6d4', strokeDasharray: '4 4', label: 'endpoint' },
  sa_used_by:     { stroke: '#f97316', strokeDasharray: '4 4', label: 'uses SA' },
}

export const SOURCE_GROUPS = [
  { id: 'workloads', label: 'Workloads', kinds: ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'], default: true },
  { id: 'network', label: 'Network', kinds: ['Service', 'Ingress', 'Endpoints', 'EndpointSlice', 'NetworkPolicy'], default: true },
  { id: 'storage', label: 'Storage', kinds: ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'], default: true },
  { id: 'security', label: 'Security', kinds: ['ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'], default: false },
  { id: 'configuration', label: 'Configuration', kinds: ['ConfigMap', 'Secret', 'HorizontalPodAutoscaler'], default: false },
]

export const ALL_KINDS = SOURCE_GROUPS.flatMap(g => g.kinds)
export const DEFAULT_KINDS = new Set(SOURCE_GROUPS.filter(g => g.default).flatMap(g => g.kinds))
export const ALL_EDGE_TYPES: ResourceGraphEdgeType[] = [
  'owns', 'selects', 'mounts', 'routes', 'binds',
  'bound_to', 'provisions', 'hpa_targets', 'network_policy', 'endpoint_of', 'sa_used_by',
]

export type GroupBy = 'none' | 'namespace' | 'node' | 'instance'
