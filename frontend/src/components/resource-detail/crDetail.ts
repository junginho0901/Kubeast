// How a drawer is picked for an object named by Kind and apiVersion, and what a custom resource's drawer shows beside
// its spec and status. kubectl picks a describer by group and Kind (describerMap's GroupKind keys); the same Kind of
// another group is described from the object (the generic describer).
import type { ResourceDetailTarget } from '../ResourceDetailContext'
import type { CRDInfo } from '@/services/api/types'

// The API group of each kind that has a drawer of its own ('' = core).
export const DRAWER_GROUPS: Record<string, string> = {
  Pod: '', Node: '', Namespace: '', Service: '', ConfigMap: '', Secret: '', ServiceAccount: '', Endpoints: '',
  PersistentVolume: '', PersistentVolumeClaim: '', ResourceQuota: '', LimitRange: '',
  Deployment: 'apps', StatefulSet: 'apps', DaemonSet: 'apps', ReplicaSet: 'apps', Job: 'batch', CronJob: 'batch',
  HorizontalPodAutoscaler: 'autoscaling', VerticalPodAutoscaler: 'autoscaling.k8s.io', PodDisruptionBudget: 'policy',
  Ingress: 'networking.k8s.io', IngressClass: 'networking.k8s.io', NetworkPolicy: 'networking.k8s.io', EndpointSlice: 'discovery.k8s.io',
  StorageClass: 'storage.k8s.io', VolumeAttachment: 'storage.k8s.io',
  Role: 'rbac.authorization.k8s.io', RoleBinding: 'rbac.authorization.k8s.io', ClusterRole: 'rbac.authorization.k8s.io', ClusterRoleBinding: 'rbac.authorization.k8s.io',
  PriorityClass: 'scheduling.k8s.io', RuntimeClass: 'node.k8s.io', Lease: 'coordination.k8s.io',
  MutatingWebhookConfiguration: 'admissionregistration.k8s.io', ValidatingWebhookConfiguration: 'admissionregistration.k8s.io',
  ValidatingAdmissionPolicy: 'admissionregistration.k8s.io', MutatingAdmissionPolicy: 'admissionregistration.k8s.io',
  CustomResourceDefinition: 'apiextensions.k8s.io',
  Gateway: 'gateway.networking.k8s.io', GatewayClass: 'gateway.networking.k8s.io', HTTPRoute: 'gateway.networking.k8s.io',
  GRPCRoute: 'gateway.networking.k8s.io', ReferenceGrant: 'gateway.networking.k8s.io', BackendTLSPolicy: 'gateway.networking.k8s.io',
  DeviceClass: 'resource.k8s.io', ResourceClaim: 'resource.k8s.io', ResourceClaimTemplate: 'resource.k8s.io', ResourceSlice: 'resource.k8s.io',
}

const groupVersion = (apiVersion?: string) => {
  const m = /^([^/]+)\/([^/]+)$/.exec(apiVersion ?? '')
  return m ? { group: m[1], version: m[2] } : null
}

// Whether the object's group is not the one its Kind's drawer reads — then the CRD list says whether a CRD serves it.
export function needsCustomResourceLookup(t: Pick<ResourceDetailTarget, 'kind' | 'apiVersion'>): boolean {
  const gv = t.kind === 'CustomResourceInstance' ? null : groupVersion(t.apiVersion)
  return !!gv && DRAWER_GROUPS[t.kind] !== gv.group
}

// A drawer target for an object a list names by Kind and apiVersion: the apiVersion kept only where it picks the drawer,
// so the link of a built-in kind stays ?detail=<Kind>/<namespace>/<name>.
export function detailTarget(kind: string, name: string, namespace?: string, apiVersion?: string, rawJson?: Record<string, unknown>): ResourceDetailTarget {
  const t: ResourceDetailTarget = { kind, name, namespace: namespace || undefined, ...(rawJson ? { rawJson } : {}) }
  return apiVersion && needsCustomResourceLookup({ kind, apiVersion }) ? { ...t, apiVersion } : t
}

// The custom resource drawer's target when a CRD of the object's group serves its Kind (at that version if served,
// else the CRD's storage version); the target as it is otherwise.
export function customResourceTarget(t: ResourceDetailTarget, crds: CRDInfo[] | undefined): ResourceDetailTarget {
  const gv = needsCustomResourceLookup(t) ? groupVersion(t.apiVersion) : null
  const crd = gv && Array.isArray(crds) ? crds.find((c) => c.group === gv.group && c.kind === t.kind) : undefined
  if (!gv || !crd) return t
  const version = (crd.served_versions ?? [crd.version]).includes(gv.version) ? gv.version : crd.version
  return {
    kind: 'CustomResourceInstance', name: t.name, namespace: t.namespace,
    rawJson: { ...(t.rawJson ?? {}), kind: t.kind, group: gv.group, version, crd_name: crd.name },
  }
}

// What a custom resource keeps beside apiVersion, kind, metadata, spec and status (a PolicyReport's results, scope and
// summary — describe's `fields`), by name as kubectl describe prints them.
export function otherFields(fields: unknown): [string, unknown][] {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return []
  return Object.entries(fields as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
