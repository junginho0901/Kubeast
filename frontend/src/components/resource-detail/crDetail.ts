// How a drawer is picked for an object named by Kind and apiVersion, what a custom resource's drawer shows beside
// its spec and status, and the resource its delete acts on. kubectl picks a describer by group and Kind (describerMap's
// GroupKind keys); the same Kind of another group is described from the object (the generic describer).
import type { ResourceDetailTarget } from '../ResourceDetailContext'
import type { CRDInfo } from '@/services/api/types'
import type { AccessTarget } from '@/hooks/useCanCreate'
import { kindToPlural } from './utils'

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

// A drawer kind's resource name: apimachinery's meta.UnsafeGuessKindToResource, but a vowel before a final y keeps it
// (Gateway → gateways, where that guess says gatewaies); drawerAccess.test.ts holds every kind above to the API server.
export function kindResource(kind: string): string {
  const k = kind.toLowerCase()
  if (k.endsWith('endpoints')) return k
  if (k.endsWith('s')) return `${k}es`
  if (/[^aeiou]y$/.test(k)) return `${k.slice(0, -1)}ies`
  return `${k}s`
}

// The type a drawer's own object read and YAML window name (resource_type): a kind of a group as <resource>.<group>, as
// kubectl takes it. The name alone may go to another group that serves the same Kind (k8s-service's matchResource takes
// the first preferred version serving it), whose object would then be read and saved instead.
export function drawerResourceType(kind: string): string {
  const group = DRAWER_GROUPS[kind]
  return group ? `${kindResource(kind)}.${group}` : kindToPlural(kind)
}

type ObjectNamed = Pick<ResourceDetailTarget, 'kind' | 'name' | 'namespace' | 'apiVersion'> & { rawJson?: unknown }

const crdOf = (t: { kind: string; rawJson?: unknown }): string => {
  const crd = t.kind === 'CustomResourceInstance' ? (t.rawJson as Record<string, unknown> | undefined)?.crd_name : undefined
  return typeof crd === 'string' ? crd : ''
}

// The type a drawer's object is read and saved as: a custom resource by its CRD's name (<plural>.<group>), since two
// CRDs may serve a Kind of one name and their objects may share a namespace and name (Karpenter's NodePool and
// EC2NodeClass "default"); another kind as drawerResourceType names it.
export function objectResourceType(t: { kind: string; rawJson?: unknown }): string {
  return crdOf(t) || drawerResourceType(t.kind)
}

// One object as the drawer's views know it: its kind, namespace and name, and what tells two of one Kind and name apart
// — a custom resource's CRD, another kind's apiVersion when the caller named one. A view keyed by it starts over for
// another object instead of showing what it held of the one before.
export function drawerObjectKey(t: ObjectNamed): string {
  return JSON.stringify([t.kind, t.namespace ?? '', t.name, crdOf(t) || t.apiVersion || ''])
}

// What a drawer's delete acts on, for the cluster's answer (SelfSubjectAccessReview): the group and resource, the
// object's namespace — a Namespace's own name, the namespace the API server authorizes it in — and its name. A custom
// resource carries its group and plural (crd_name = <plural>.<group>); none for a kind without a drawer of its own.
export function deleteTarget(kind: string, namespace: string | undefined, name: string, rawJson?: Record<string, unknown>): AccessTarget | undefined {
  if (kind === 'CustomResourceInstance') {
    const group = typeof rawJson?.group === 'string' ? rawJson.group : ''
    const plural = typeof rawJson?.crd_name === 'string' ? rawJson.crd_name.split('.')[0] : ''
    return group && plural ? { group, resource: plural, namespace: namespace ?? '', name } : undefined
  }
  if (!(kind in DRAWER_GROUPS)) return undefined
  return { group: DRAWER_GROUPS[kind], resource: kindResource(kind), namespace: kind === 'Namespace' ? name : namespace ?? '', name }
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

// Kubernetes' version priority (apimachinery version.CompareKubeAwareVersionStrings): GA, then beta, then alpha, higher
// major then minor first; a version not of that form after them, by name. Above 0 when a comes first.
export function compareKubeAwareVersions(a: string, b: string): number {
  if (a === b) return 0
  const parse = (v: string) => {
    const m = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(v)
    return m ? { type: m[2] === 'alpha' ? 0 : m[2] === 'beta' ? 1 : 2, major: Number(m[1]), minor: Number(m[3] ?? 0) } : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return x ? 1 : y ? -1 : a < b ? 1 : -1
  return x.type - y.type || x.major - y.major || x.minor - y.minor
}

// Whether such a reference needs the CRD list: a group other than the core group and the Kind's own drawer's.
export const referenceNeedsVersion = (group: string, kind: string): boolean => !!group && DRAWER_GROUPS[kind] !== group

// The apiVersion of an object a reference names by group and Kind without a version (a Gateway API parentRef or
// backendRef): the version of its CRD that comes first by that priority, as discovery orders a group's versions and
// kubectl get <kind>.<group> reads it. None for the core group, the group of the Kind's own drawer or a Kind no CRD of
// that group serves — the link then opens by Kind, as before.
export function referenceApiVersion(group: string, kind: string, crds: CRDInfo[] | undefined): string | undefined {
  if (!referenceNeedsVersion(group, kind) || !Array.isArray(crds)) return undefined
  const crd = crds.find((c) => c.group === group && c.kind === kind)
  const served = crd ? (crd.served_versions ?? [crd.version]).filter(Boolean) : []
  return served.length ? `${group}/${[...served].sort((a, b) => compareKubeAwareVersions(b, a))[0]}` : undefined
}

// What a custom resource keeps beside apiVersion, kind, metadata, spec and status (a PolicyReport's results, scope and
// summary — describe's `fields`), by name as kubectl describe prints them.
export function otherFields(fields: unknown): [string, unknown][] {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return []
  return Object.entries(fields as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
