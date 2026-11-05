import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page, type Request, type Response } from '@playwright/test'

// Safety net (c), the permission matrix: four users — an Admin, a Write and a Read grant on `self`, and a Read grant
// limited to one namespace — open every screen the sidebar lists, /account and a drawer of every kind. What each is
// shown (the menu, a list or its "no permission", the create and delete buttons, the drawer) is held to the cluster's
// answer for the identity Kubeast acts as for that user (X-Kubeast-Access, then `kubectl auth can-i <verb>
// <resource>` with --as and --as-group, one verb and resource at a time) or, for Kubeast's own admin pages, to the
// user's Kubeast role. Every cell is attached as JSON and every cell where the two differ fails softly with both values.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const CLUSTER = 'self'
const KIND_CLUSTER = 'kubeast'
const PW = 'E2e-guard-throwaway-1!'
const REPO = path.join(__dirname, '..', '..')
const STAMP = Date.now().toString(36)
const PREFIX = `e2e-guard-${STAMP}`
const NS_A = `${PREFIX}-a`
const NS_B = `${PREFIX}-b`
const CR_GROUP = `g${STAMP}.guard.kubeast.io`
const CRD = `guardchecks.${CR_GROUP}`
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const LABELS = { 'kubeast.io/e2e': 'guard' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const source = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8')

// Screen words come from the en catalog, the locale this project runs in.
const EN: unknown = JSON.parse(source('frontend/src/i18n/locales/en.json'))
function tr(key: string, vars: Record<string, string> = {}): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BANNER_BODY = new RegExp(escape(tr('layout.forbidden.body')).replace(escape('{{resources}}'), '(.+?)'))
const FORBIDDEN_PHRASE = tr('common.forbiddenEmpty').split('{{resource}}')[0].trim()
const FORBIDDEN_EMPTY = new RegExp(escape(tr('common.forbiddenEmpty')).replace(escape('{{resource}}'), '(.+?)'))

// What the code lists: the sidebar's entries and groups, the admin pages' permissions, the drawer's kinds.
const LAYOUT = source('frontend/src/components/Layout.tsx')
const SIDEBAR = [...LAYOUT.matchAll(/href: '([^']+)'/g)].map((m) => m[1])
const NAV = LAYOUT.slice(LAYOUT.indexOf('const navGroups'), LAYOUT.indexOf('const active = useMemo'))
const GROUPS = NAV.split(/\n\s*\{\n\s*id: '/).slice(1).map((chunk) => ({
  id: chunk.slice(0, chunk.indexOf("'")),
  menu: chunk.match(/requiredPermission: '([^']+)'/)?.[1] ?? null,
  adminOnly: /adminOnly: true/.test(chunk),
  hrefs: [...chunk.matchAll(/href: '([^']+)'/g)].map((m) => m[1]),
}))
const ADMIN_KEYS: Record<string, string[]> = Object.fromEntries(
  [...source('frontend/src/utils/adminAccess.ts').matchAll(/'(\/[^']*)': \[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1])]),
)
const DRAWER_SRC = source('frontend/src/components/ResourceDetailDrawer.tsx')
const RENDER_AT = DRAWER_SRC.indexOf('const renderInfoContent')
const DRAWER_KINDS = [...new Set([
  ...[...DRAWER_SRC.slice(RENDER_AT, DRAWER_SRC.indexOf('return (', RENDER_AT)).matchAll(/kind === '(\w+)'/g)].map((m) => m[1]),
  ...[...source('frontend/src/components/resource-detail/utils.ts').matchAll(/export const (?:WORKLOAD|NETWORK|CONFIG_STORAGE)_KINDS = new Set\(\[([^\]]+)\]\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((k) => k[1])),
])].sort()

// The comparison table: what each sidebar screen (and /account) is compared with. A list names its Kubernetes
// resource as kubectl does (plural.group) and the Kind its "no permission" notice names; `create` is the catalog key
// of its create button; a page that says "no permission", "not installed" or "empty" its own way names that too. A
// summary screen names the lists it reads (cluster-wide). An admin page is Kubeast's own: its keys are
// adminAccess.ts's. A screen left out says why.
type ListScreen = {
  type: 'list'; resource: string; kind: string; namespaced: boolean; create: string | null
  forbiddenId?: string; notInstalledId?: string; emptyKey?: string; count?: false; grantList?: true
}
// crRows: the screen lists every custom resource the user may list; this run's GuardCheck instances are its rows or a refusal.
// inNamespace: the screen is opened on the namespace under test (?namespace=) and reads these kinds there; its notice
// names the kinds it was refused.
type GraphRead = { kind: string; resource: string; namespaced: boolean }
type SummaryScreen = { type: 'summary'; reads: string[]; forbiddenId?: string; cards?: true; menuRead?: string; crRows?: true; inNamespace?: GraphRead[] }
// what the Resource Graph lists for its chosen namespaces (k8s-service internal/k8s/resource_graph_fetch.go: fetch,
// fetchCluster), each kind it may not list named in forbidden_kinds
const GRAPH_READS: GraphRead[] = [
  ...([
    ['Pod', 'pods'], ['Service', 'services'], ['ConfigMap', 'configmaps'], ['Secret', 'secrets'], ['PersistentVolumeClaim', 'persistentvolumeclaims'],
    ['Ingress', 'ingresses.networking.k8s.io'], ['RoleBinding', 'rolebindings.rbac.authorization.k8s.io'], ['ServiceAccount', 'serviceaccounts'],
    ['ReplicaSet', 'replicasets.apps'], ['Deployment', 'deployments.apps'], ['StatefulSet', 'statefulsets.apps'], ['DaemonSet', 'daemonsets.apps'],
    ['Job', 'jobs.batch'], ['CronJob', 'cronjobs.batch'], ['HorizontalPodAutoscaler', 'horizontalpodautoscalers.autoscaling'],
    ['NetworkPolicy', 'networkpolicies.networking.k8s.io'], ['EndpointSlice', 'endpointslices.discovery.k8s.io'],
  ] as const).map(([kind, resource]) => ({ kind, resource, namespaced: true })),
  { kind: 'PersistentVolume', resource: 'persistentvolumes', namespaced: false },
  { kind: 'StorageClass', resource: 'storageclasses.storage.k8s.io', namespaced: false },
]
type AdminScreen = { type: 'admin'; probe?: string }
type Screen = ListScreen | SummaryScreen | AdminScreen | { type: 'account' } | { type: 'skip'; why: string }
const list = (resource: string, kind: string, namespaced: boolean, create: string | null, more: Partial<ListScreen> = {}): ListScreen =>
  ({ type: 'list', resource, kind, namespaced, create, ...more })
const ADM = 'admissionregistration.k8s.io'
const SCREENS: Record<string, Screen> = {
  '/': { type: 'summary', reads: ['namespaces', 'pods', 'services', 'deployments.apps', 'persistentvolumeclaims', 'nodes'], cards: true },
  '/cluster-view': { type: 'summary', reads: ['nodes', 'pods', 'namespaces'] },
  '/monitoring': { type: 'summary', reads: ['nodes', 'pods', 'namespaces'] },
  '/alerts': { type: 'summary', reads: ['pods'], forbiddenId: 'alert-inbox-forbidden', menuRead: 'pods' },
  '/cost': { type: 'skip', why: 'OpenCost runs on the second cluster only; on self the page is off (costEnabled) and only its menu entry is compared' },
  '/ai-chat': { type: 'skip', why: 'a chat: opening it reads no cluster list; what the AI tools may read is the AI symmetry test (2-2)' },
  '/cluster/resource-graph': { type: 'summary', reads: [], forbiddenId: 'resource-graph-forbidden', inNamespace: GRAPH_READS },
  '/timeline': { type: 'summary', reads: ['events'], forbiddenId: 'timeline-forbidden' },
  '/cluster/search': { type: 'skip', why: 'reads nothing until a search is typed; search results per grant are number-check-search and ns-scope-api' },
  '/cluster/namespaces': list('namespaces', 'Namespace', false, 'namespaces.create.button', { grantList: true }),
  '/cluster/nodes': list('nodes', 'Node', false, 'nodes.create'),
  '/cluster/priorityclasses': list('priorityclasses.scheduling.k8s.io', 'PriorityClass', false, 'priorityClasses.create'),
  '/cluster/runtimeclasses': list('runtimeclasses.node.k8s.io', 'RuntimeClass', false, 'runtimeClasses.create'),
  '/cluster/mutatingwebhookconfigurations': list(`mutatingwebhookconfigurations.${ADM}`, 'MutatingWebhookConfiguration', false, 'mutatingWebhooks.create'),
  '/cluster/validatingwebhookconfigurations': list(`validatingwebhookconfigurations.${ADM}`, 'ValidatingWebhookConfiguration', false, 'validatingWebhooks.create'),
  '/cluster/validatingadmissionpolicies': list(`validatingadmissionpolicies.${ADM}`, 'ValidatingAdmissionPolicy', false, null),
  '/cluster/mutatingadmissionpolicies': list(`mutatingadmissionpolicies.${ADM}`, 'MutatingAdmissionPolicy', false, null),
  '/workloads/pods': list('pods', 'Pod', true, 'pods.create'),
  '/workloads/deployments': list('deployments.apps', 'Deployment', true, 'deployments.create'),
  '/workloads/statefulsets': list('statefulsets.apps', 'StatefulSet', true, 'statefulsets.create'),
  '/workloads/daemonsets': list('daemonsets.apps', 'DaemonSet', true, 'daemonsets.create'),
  '/workloads/replicasets': list('replicasets.apps', 'ReplicaSet', true, 'replicasets.create'),
  '/workloads/jobs': list('jobs.batch', 'Job', true, 'jobs.create'),
  '/workloads/cronjobs': list('cronjobs.batch', 'CronJob', true, 'cronjobs.create'),
  '/workloads/hpas': list('horizontalpodautoscalers.autoscaling', 'HorizontalPodAutoscaler', true, 'hpas.create'),
  '/workloads/vpas': list('verticalpodautoscalers.autoscaling.k8s.io', 'VerticalPodAutoscaler', true, 'vpas.create'),
  '/workloads/pdbs': list('poddisruptionbudgets.policy', 'PodDisruptionBudget', true, 'pdbs.create'),
  '/storage?tab=pvcs': list('persistentvolumeclaims', 'PersistentVolumeClaim', true, 'pvcs.create'),
  '/storage?tab=pvs': list('persistentvolumes', 'PersistentVolume', false, 'pvs.create'),
  '/storage?tab=storageclasses': list('storageclasses.storage.k8s.io', 'StorageClass', false, 'storageclasses.create'),
  '/storage?tab=volumeattachments': list('volumeattachments.storage.k8s.io', 'VolumeAttachment', false, 'volumeattachments.create'),
  '/network/services': list('services', 'Service', true, 'servicesPage.create'),
  '/network/endpoints': list('endpoints', 'Endpoints', true, 'endpointsPage.create'),
  '/network/endpointslices': list('endpointslices.discovery.k8s.io', 'EndpointSlice', true, 'endpointSlicesPage.create'),
  '/network/ingresses': list('ingresses.networking.k8s.io', 'Ingress', true, 'ingressesPage.create'),
  '/network/ingressclasses': list('ingressclasses.networking.k8s.io', 'IngressClass', false, 'ingressClassesPage.create'),
  '/network/networkpolicies': list('networkpolicies.networking.k8s.io', 'NetworkPolicy', true, 'networkPoliciesPage.create'),
  '/gateway/gateways': list('gateways.gateway.networking.k8s.io', 'Gateway', true, 'gatewaysPage.create'),
  '/gateway/gatewayclasses': list('gatewayclasses.gateway.networking.k8s.io', 'GatewayClass', false, 'gatewayClassesPage.create'),
  '/gateway/httproutes': list('httproutes.gateway.networking.k8s.io', 'HTTPRoute', true, 'httpRoutesPage.create'),
  '/gateway/grpcroutes': list('grpcroutes.gateway.networking.k8s.io', 'GRPCRoute', true, 'grpcRoutesPage.create'),
  '/gateway/referencegrants': list('referencegrants.gateway.networking.k8s.io', 'ReferenceGrant', true, 'referenceGrantsPage.create'),
  '/gateway/backendtlspolicies': list('backendtlspolicies.gateway.networking.k8s.io', 'BackendTLSPolicy', true, 'backendTLSPoliciesPage.create'),
  '/gateway/policies': { type: 'summary', reads: ['customresourcedefinitions.apiextensions.k8s.io'] },
  '/gpu/dashboard': { type: 'summary', reads: ['nodes', 'pods'] },
  '/gpu/nodes': { type: 'summary', reads: ['nodes'] },
  '/gpu/pods': { type: 'summary', reads: ['nodes', 'pods'] },
  '/gpu/deviceclasses': list('deviceclasses.resource.k8s.io', 'DeviceClass', false, 'deviceClassesPage.create'),
  '/gpu/resourceclaims': list('resourceclaims.resource.k8s.io', 'ResourceClaim', true, 'resourceClaimsPage.create'),
  '/gpu/resourceclaimtemplates': list('resourceclaimtemplates.resource.k8s.io', 'ResourceClaimTemplate', true, 'resourceClaimTemplatesPage.create'),
  '/gpu/resourceslices': list('resourceslices.resource.k8s.io', 'ResourceSlice', false, null),
  '/security/serviceaccounts': list('serviceaccounts', 'ServiceAccount', true, 'serviceAccountsPage.create'),
  '/security/roles': list('roles.rbac.authorization.k8s.io', 'Role', true, 'rolesPage.create'),
  '/security/clusterroles': list('clusterroles.rbac.authorization.k8s.io', 'ClusterRole', false, 'clusterRolesPage.create'),
  '/security/rolebindings': list('rolebindings.rbac.authorization.k8s.io', 'RoleBinding', true, 'roleBindingsPage.create'),
  '/security/clusterrolebindings': list('clusterrolebindings.rbac.authorization.k8s.io', 'ClusterRoleBinding', false, 'clusterRoleBindingsPage.create'),
  '/security/policyreports': list('policyreports.wgpolicyk8s.io', 'PolicyReport', true, null, { notInstalledId: 'policy-reports-not-installed' }),
  '/configuration/configmaps': list('configmaps', 'ConfigMap', true, 'configMapsPage.create'),
  '/configuration/secrets': list('secrets', 'Secret', true, 'secretsPage.create', { forbiddenId: 'secrets-forbidden' }),
  '/cluster/resourcequotas': list('resourcequotas', 'ResourceQuota', true, 'resourceQuotas.create'),
  '/cluster/limitranges': list('limitranges', 'LimitRange', true, 'limitRanges.create'),
  '/cluster/leases': list('leases.coordination.k8s.io', 'Lease', true, 'leases.create'),
  // Helm keeps each release in a Secret of its namespace
  '/helm/releases': list('secrets', 'Helm release', true, null, { forbiddenId: 'helm-forbidden', emptyKey: 'helmReleases.empty.title', count: false }),
  '/custom-resources/instances': { type: 'summary', reads: ['customresourcedefinitions.apiextensions.k8s.io'], crRows: true },
  '/custom-resources/groups': list('customresourcedefinitions.apiextensions.k8s.io', 'CustomResourceDefinition', false, 'crdPage.create'),
  '/admin/clusters': { type: 'admin' },
  '/admin/users': { type: 'admin', probe: '/api/v1/auth/admin/users?limit=1' },
  '/admin/roles': { type: 'admin' },
  '/admin/access-requests': { type: 'admin' },
  '/admin/access-review': { type: 'admin' },
  '/admin/cluster-hygiene': { type: 'admin' },
  '/admin/organizations': { type: 'admin' },
  '/admin/ai-models': { type: 'admin' },
  '/admin/audit': { type: 'admin', probe: '/api/v1/auth/admin/audit-logs?limit=1' },
  '/admin/session-recordings': { type: 'admin' },
  '/admin/ai-usage': { type: 'admin' },
  '/admin/investigations': { type: 'admin' },
  '/admin/node-shell': { type: 'admin' },
  '/account': { type: 'account' },
}

// The drawer kinds: the object each is opened on by link (?detail=), and the resource kubectl asks about. `ns` = the
// fixture's object of that name in the namespace under test; `cluster` = this run's cluster-scoped object of that
// suffix. A kind left out says why.
type DrawerAt = 'ns' | 'cluster' | 'node' | 'namespace' | 'lease' | 'crd' | 'cr'
type DrawerRow = { resource: string; at: DrawerAt; name?: string; noDelete?: string } | { skip: string }
const NOT_SERVED = 'self does not serve this kind (the Gateway API and VPA CRDs are on test2 only, number check §6-3d)'
const DRAWERS: Record<string, DrawerRow> = {
  Node: { resource: 'nodes', at: 'node' },
  Namespace: { resource: 'namespaces', at: 'namespace' },
  Pod: { resource: 'pods', at: 'ns', name: 'guard-pod' },
  Service: { resource: 'services', at: 'ns', name: 'guard-svc' },
  Gateway: { skip: NOT_SERVED },
  GatewayClass: { skip: NOT_SERVED },
  HTTPRoute: { skip: NOT_SERVED },
  GRPCRoute: { skip: NOT_SERVED },
  ReferenceGrant: { skip: NOT_SERVED },
  BackendTLSPolicy: { skip: NOT_SERVED },
  VerticalPodAutoscaler: { skip: NOT_SERVED },
  DeviceClass: { resource: 'deviceclasses.resource.k8s.io', at: 'cluster', name: 'dc' },
  ResourceClaim: { resource: 'resourceclaims.resource.k8s.io', at: 'ns', name: 'guard-claim' },
  ResourceClaimTemplate: { resource: 'resourceclaimtemplates.resource.k8s.io', at: 'ns', name: 'guard-claim-tpl' },
  ResourceSlice: { skip: 'a DRA driver writes ResourceSlices; self has no driver, and its empty ResourceSlices list is the allowed-but-empty case' },
  ServiceAccount: { resource: 'serviceaccounts', at: 'ns', name: 'guard-sa' },
  Role: { resource: 'roles.rbac.authorization.k8s.io', at: 'ns', name: 'guard-role' },
  RoleBinding: { resource: 'rolebindings.rbac.authorization.k8s.io', at: 'ns', name: 'guard-rb' },
  ClusterRole: { resource: 'clusterroles.rbac.authorization.k8s.io', at: 'cluster', name: 'cr' },
  ClusterRoleBinding: { resource: 'clusterrolebindings.rbac.authorization.k8s.io', at: 'cluster', name: 'crb' },
  ConfigMap: { resource: 'configmaps', at: 'ns', name: 'guard-cm' },
  Secret: { resource: 'secrets', at: 'ns', name: 'guard-secret' },
  HorizontalPodAutoscaler: { resource: 'horizontalpodautoscalers.autoscaling', at: 'ns', name: 'guard-hpa' },
  PodDisruptionBudget: { resource: 'poddisruptionbudgets.policy', at: 'ns', name: 'guard-pdb' },
  PriorityClass: { resource: 'priorityclasses.scheduling.k8s.io', at: 'cluster', name: 'pc' },
  RuntimeClass: { resource: 'runtimeclasses.node.k8s.io', at: 'cluster', name: 'rc' },
  // the node's own Lease: the namespace under test has none, so its Leases list is allowed and empty
  Lease: { resource: 'leases.coordination.k8s.io', at: 'lease' },
  ResourceQuota: { resource: 'resourcequotas', at: 'ns', name: 'guard-quota' },
  LimitRange: { resource: 'limitranges', at: 'ns', name: 'guard-limits' },
  MutatingWebhookConfiguration: { resource: `mutatingwebhookconfigurations.${ADM}`, at: 'cluster', name: 'mwc' },
  ValidatingWebhookConfiguration: { resource: `validatingwebhookconfigurations.${ADM}`, at: 'cluster', name: 'vwc' },
  ValidatingAdmissionPolicy: { resource: `validatingadmissionpolicies.${ADM}`, at: 'cluster', name: 'vap', noDelete: 'Kubeast has no delete for admission policies (ResourceDetailDrawer readOnlyKind)' },
  MutatingAdmissionPolicy: { resource: `mutatingadmissionpolicies.${ADM}`, at: 'cluster', name: 'map', noDelete: 'Kubeast has no delete for admission policies (ResourceDetailDrawer readOnlyKind)' },
  CustomResourceDefinition: { resource: 'customresourcedefinitions.apiextensions.k8s.io', at: 'crd' },
  CustomResourceInstance: { resource: `guardchecks.${CR_GROUP}`, at: 'cr', name: 'guard-cr' },
  Deployment: { resource: 'deployments.apps', at: 'ns', name: 'guard-deploy' },
  StatefulSet: { resource: 'statefulsets.apps', at: 'ns', name: 'guard-sts' },
  DaemonSet: { resource: 'daemonsets.apps', at: 'ns', name: 'guard-ds' },
  ReplicaSet: { resource: 'replicasets.apps', at: 'ns', name: 'guard-rs' },
  Job: { resource: 'jobs.batch', at: 'ns', name: 'guard-job' },
  CronJob: { resource: 'cronjobs.batch', at: 'ns', name: 'guard-cron' },
  Ingress: { resource: 'ingresses.networking.k8s.io', at: 'ns', name: 'guard-ing' },
  IngressClass: { resource: 'ingressclasses.networking.k8s.io', at: 'cluster', name: 'ic' },
  NetworkPolicy: { resource: 'networkpolicies.networking.k8s.io', at: 'ns', name: 'guard-np' },
  Endpoints: { resource: 'endpoints', at: 'ns', name: 'guard-svc' },
  EndpointSlice: { resource: 'endpointslices.discovery.k8s.io', at: 'ns', name: 'guard-svc-hand' },
  PersistentVolume: { resource: 'persistentvolumes', at: 'cluster', name: 'pv' },
  PersistentVolumeClaim: { resource: 'persistentvolumeclaims', at: 'ns', name: 'guard-pvc' },
  StorageClass: { resource: 'storageclasses.storage.k8s.io', at: 'cluster', name: 'sc' },
  VolumeAttachment: { resource: 'volumeattachments.storage.k8s.io', at: 'cluster', name: 'va' },
}

// The objects: one of every namespaced kind in each of the two namespaces (none acts on anything: no pod is scheduled,
// nothing scales, the claims are never allocated) and one of every cluster-scoped kind that self has none of or that a
// run should own (the webhooks and policies match a group nobody serves).
const PAUSE = { name: 'c', image: 'registry.k8s.io/pause:3.10' }
const NOWHERE = { 'kubeast.io/e2e-guard': 'nowhere' }
const RBAC = 'rbac.authorization.k8s.io'
function namespacedObjects(ns: string): object[] {
  const meta = (name: string, labels: Record<string, string> = {}) => ({ name, namespace: ns, labels: { ...LABELS, ...labels } })
  const template = (app: string) => ({ metadata: { labels: { app } }, spec: { nodeSelector: NOWHERE, containers: [PAUSE] } })
  const now = new Date().toISOString()
  const claim = { devices: { requests: [{ name: 'dev', exactly: { deviceClassName: `${PREFIX}-dc` } }] } }
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('guard-cm'), data: { k: 'v' } },
    { apiVersion: 'v1', kind: 'Secret', metadata: meta('guard-secret'), stringData: { k: 'guard' } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('guard-sa') },
    { apiVersion: 'v1', kind: 'Service', metadata: meta('guard-svc'), spec: { ports: [{ port: 80 }] } },
    { apiVersion: 'v1', kind: 'Endpoints', metadata: meta('guard-svc') },
    { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: meta('guard-svc-hand', { 'kubernetes.io/service-name': 'guard-svc' }), addressType: 'IPv4', endpoints: [] },
    { apiVersion: 'v1', kind: 'Pod', metadata: meta('guard-pod'), spec: { nodeSelector: NOWHERE, containers: [PAUSE] } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('guard-deploy'), spec: { replicas: 0, selector: { matchLabels: { app: 'guard-deploy' } }, template: template('guard-deploy') } },
    { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: meta('guard-sts'), spec: { replicas: 0, serviceName: 'guard-svc', selector: { matchLabels: { app: 'guard-sts' } }, template: template('guard-sts') } },
    { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: meta('guard-ds'), spec: { selector: { matchLabels: { app: 'guard-ds' } }, template: template('guard-ds') } },
    { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: meta('guard-rs'), spec: { replicas: 0, selector: { matchLabels: { app: 'guard-rs' } }, template: template('guard-rs') } },
    { apiVersion: 'batch/v1', kind: 'Job', metadata: meta('guard-job'), spec: { suspend: true, template: { spec: { restartPolicy: 'Never', nodeSelector: NOWHERE, containers: [PAUSE] } } } },
    { apiVersion: 'batch/v1', kind: 'CronJob', metadata: meta('guard-cron'), spec: { schedule: '0 0 1 1 *', suspend: true, jobTemplate: { spec: { template: { spec: { restartPolicy: 'Never', nodeSelector: NOWHERE, containers: [PAUSE] } } } } } },
    { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: meta('guard-hpa'), spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'guard-deploy' }, minReplicas: 1, maxReplicas: 2 } },
    { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: meta('guard-pdb'), spec: { minAvailable: 0, selector: { matchLabels: { app: 'guard-none' } } } },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta('guard-pvc'), spec: { accessModes: ['ReadWriteOnce'], storageClassName: `${PREFIX}-claims`, resources: { requests: { storage: '1Mi' } } } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta('guard-ing'), spec: { ingressClassName: `${PREFIX}-ic`, rules: [{ host: 'guard.invalid', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'guard-svc', port: { number: 80 } } } }] } }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta('guard-np'), spec: { podSelector: { matchLabels: { app: 'guard-none' } }, policyTypes: ['Ingress'] } },
    { apiVersion: `${RBAC}/v1`, kind: 'Role', metadata: meta('guard-role'), rules: [{ apiGroups: [''], resources: ['configmaps'], resourceNames: ['guard-cm'], verbs: ['get'] }] },
    { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: meta('guard-rb'), roleRef: { apiGroup: RBAC, kind: 'Role', name: 'guard-role' }, subjects: [{ apiGroup: RBAC, kind: 'User', name: 'guard-nobody@kubeast.invalid' }] },
    { apiVersion: 'resource.k8s.io/v1', kind: 'ResourceClaim', metadata: meta('guard-claim'), spec: claim },
    { apiVersion: 'resource.k8s.io/v1', kind: 'ResourceClaimTemplate', metadata: meta('guard-claim-tpl'), spec: { spec: claim } },
    { apiVersion: 'v1', kind: 'Event', metadata: meta('guard-cm.guard'), involvedObject: { apiVersion: 'v1', kind: 'ConfigMap', namespace: ns, name: 'guard-cm' }, type: 'Normal', reason: 'GuardCheck', message: `guard event in ${ns}`, count: 1, firstTimestamp: now, lastTimestamp: now, source: { component: 'e2e' } },
    // last: a quota and a limit that nothing here comes near
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('guard-quota'), spec: { hard: { 'services.loadbalancers': '0' } } },
    { apiVersion: 'v1', kind: 'LimitRange', metadata: meta('guard-limits'), spec: { limits: [{ type: 'PersistentVolumeClaim', max: { storage: '1Gi' } }] } },
  ]
}
function clusterObjects(node: string): object[] {
  const meta = (name: string) => ({ name, labels: LABELS })
  const nothing = [{ apiGroups: ['guard.kubeast.io'], apiVersions: ['v1'], operations: ['CREATE'], resources: ['nothing'] }]
  const webhook = (name: string) => ({ name, admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Ignore', clientConfig: { url: 'https://guard.invalid/hook' }, rules: nothing })
  return [
    { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: meta(`${PREFIX}-ic`), spec: { controller: 'guard.kubeast.io/none' } },
    { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: meta(`${PREFIX}-sc`), provisioner: 'guard.kubeast.io/none', volumeBindingMode: 'WaitForFirstConsumer' },
    { apiVersion: 'v1', kind: 'PersistentVolume', metadata: meta(`${PREFIX}-pv`), spec: { capacity: { storage: '1Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: `${PREFIX}-volumes`, csi: { driver: 'guard.kubeast.io', volumeHandle: 'none' } } },
    { apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: meta(`${PREFIX}-va`), spec: { attacher: 'guard.kubeast.io', nodeName: node, source: { persistentVolumeName: `${PREFIX}-pv` } } },
    { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: meta(`${PREFIX}-pc`), value: 7, preemptionPolicy: 'Never' },
    { apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: meta(`${PREFIX}-rc`), handler: 'guard-none' },
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRole', metadata: meta(`${PREFIX}-cr`), rules: [{ apiGroups: ['guard.kubeast.io'], resources: ['nothing'], verbs: ['get'] }] },
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRoleBinding', metadata: meta(`${PREFIX}-crb`), roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: `${PREFIX}-cr` }, subjects: [{ apiGroup: RBAC, kind: 'User', name: 'guard-nobody@kubeast.invalid' }] },
    { apiVersion: `${ADM}/v1`, kind: 'ValidatingWebhookConfiguration', metadata: meta(`${PREFIX}-vwc`), webhooks: [webhook('v.guard.kubeast.io')] },
    { apiVersion: `${ADM}/v1`, kind: 'MutatingWebhookConfiguration', metadata: meta(`${PREFIX}-mwc`), webhooks: [webhook('m.guard.kubeast.io')] },
    { apiVersion: `${ADM}/v1`, kind: 'ValidatingAdmissionPolicy', metadata: meta(`${PREFIX}-vap`), spec: { failurePolicy: 'Ignore', matchConstraints: { resourceRules: nothing }, validations: [{ expression: 'true' }] } },
    { apiVersion: `${ADM}/v1`, kind: 'MutatingAdmissionPolicy', metadata: meta(`${PREFIX}-map`), spec: { failurePolicy: 'Ignore', reinvocationPolicy: 'Never', matchConstraints: { resourceRules: nothing }, mutations: [{ patchType: 'ApplyConfiguration', applyConfiguration: { expression: 'Object{metadata: Object.metadata{labels: {"guard.kubeast.io/seen": "true"}}}' } }] } },
    { apiVersion: 'resource.k8s.io/v1', kind: 'DeviceClass', metadata: meta(`${PREFIX}-dc`), spec: { selectors: [{ cel: { expression: 'device.driver == "guard.kubeast.io"' } }] } },
    { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: meta(CRD), spec: { group: CR_GROUP, scope: 'Namespaced', names: { kind: 'GuardCheck', plural: 'guardchecks', singular: 'guardcheck', listKind: 'GuardCheckList' }, versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }] } },
  ]
}
const asList = (items: object[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })

// kubectl with an admin kubeconfig of the kind cluster (not the shell's KUBECONFIG)
let kubeconfig = ''
function kubectl(args: string[], input?: string, tolerate = false): string {
  const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !tolerate) throw new Error(`kubectl ${args.slice(0, 4).join(' ')}: ${(r.stderr || '').slice(0, 400)}`)
  return (r.stdout || '').trim()
}
// in one namespace, across all of them (allNamespaces) or, for a cluster-scoped kind, all
const countOf = (resource: string, namespace: string | null, allNamespaces = false) =>
  kubectl(['get', resource, ...(namespace ? ['-n', namespace] : allNamespaces ? ['-A'] : []), '-o', 'name']).split('\n').filter(Boolean).length

// The cluster's answer for the identity Kubeast acts as: one verb on one resource (and name), in one namespace or,
// with null, across all of them (-A, namespace "" — the attribute a cluster-scoped request carries).
type Who = { user: string; groups: string[] }
const answers = new Map<string, boolean>()
function canI(who: Who, verb: string, resource: string, namespace: string | null, name?: string): { ok: boolean; basis: string } {
  const target = name ? `${resource}/${name}` : resource
  const args = ['auth', 'can-i', verb, target, ...(namespace ? ['-n', namespace] : ['-A']), '--as', who.user, ...who.groups.flatMap((g) => ['--as-group', g])]
  const key = args.join(' ')
  let ok = answers.get(key)
  if (ok === undefined) {
    const out = kubectl(args, undefined, true).split('\n').pop() ?? ''
    if (!/^(yes|no)\b/.test(out)) throw new Error(`kubectl auth can-i ${verb} ${target} answered "${out}"`)
    ok = out.startsWith('yes')
    answers.set(key, ok)
  }
  return { ok, basis: `can-i ${verb} ${target} ${namespace ? `-n ${namespace}` : '-A'} → ${ok ? 'yes' : 'no'}` }
}

// pkg/auth permMatches: "*" alone grants all, a "*" segment matches one segment, a trailing "*" matches the rest
function permMatches(pattern: string, perm: string): boolean {
  if (pattern === '*' || pattern === perm) return true
  const ps = pattern.split('.')
  const qs = perm.split('.')
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return qs.length >= ps.length
    if (i >= qs.length || (ps[i] !== '*' && ps[i] !== qs[i])) return false
  }
  return ps.length === qs.length
}
const holds = (perms: string[], perm: string) => perms.some((p) => permMatches(p, perm))

// The API requests in flight (fetch and XHR; the live streams are EventSource), so a read waits until the page
// stopped asking.
type Tracker = { inflight: number; last: number }
function track(page: Page): Tracker {
  const t: Tracker = { inflight: 0, last: Date.now() }
  const api = (r: Request) => ['fetch', 'xhr'].includes(r.resourceType()) && new URL(r.url()).pathname.startsWith('/api/')
  page.on('request', (r) => { if (api(r)) { t.inflight += 1; t.last = Date.now() } })
  const done = (r: Request) => { if (api(r)) { t.inflight = Math.max(0, t.inflight - 1); t.last = Date.now() } }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return t
}
async function quiet(page: Page, t: Tracker, idleMs = 300, capMs = 8_000): Promise<boolean> {
  const end = Date.now() + capMs
  while (Date.now() < end) {
    if (t.inflight === 0 && Date.now() - t.last >= idleMs) return true
    await page.waitForTimeout(50)
  }
  return false
}

// Every state a page's main area passes through after a load (rows, a refusal, the banner's text), so a refusal that
// first showed rows — or rows that first showed a refusal — is seen, not waited away.
const FORBIDDEN_IDS = ['table-forbidden', 'secrets-forbidden', 'helm-forbidden', 'timeline-forbidden', 'resource-graph-forbidden', 'alert-inbox-forbidden']
type Seen = { t: number; b: string | null; f: boolean; r: number }
function recorder(ids: string[]) {
  const w = window as unknown as { __guard: { states: Seen[] } }
  w.__guard = { states: [] }
  let last = ''
  let queued = false
  const sample = () => {
    queued = false
    const main = document.querySelector('main')
    if (!main) return
    const banner = document.querySelector<HTMLElement>('[data-testid="forbidden-banner"]')
    const f = ids.some((id) => main.querySelector(`[data-testid="${id}"]`) !== null)
    const r = [...main.querySelectorAll('table tbody:not([aria-hidden="true"]) > tr')].filter((tr) => !tr.querySelector('td[colspan]') && tr.querySelectorAll('td').length > 1).length
    const state = { b: banner ? banner.innerText : null, f, r }
    const key = JSON.stringify(state)
    if (key !== last) {
      last = key
      w.__guard.states.push({ t: Math.round(performance.now()), ...state })
    }
  }
  new MutationObserver(() => {
    if (!queued) {
      queued = true
      requestAnimationFrame(sample)
    }
  }).observe(document, { subtree: true, childList: true, characterData: true })
}

// how one list screen says each thing: the refusal and "not installed" testids, its own empty text
type ListSigns = { forbidden: string[]; notInstalled: string[]; empty: string | null }
type ListRead = { banner: string | null; forbidden: boolean; notInstalled: boolean; error: boolean; empty: boolean; rows: number; single: string | null; namespaces: string[]; names: string[]; pager: string | null }
async function readList(page: Page, signs: ListSigns): Promise<ListRead> {
  return page.evaluate(({ forbidden, notInstalled, empty }) => {
    const main = document.querySelector('main')
    const banner = document.querySelector<HTMLElement>('[data-testid="forbidden-banner"]')
    const has = (id: string) => !!main?.querySelector(`[data-testid="${id}"]`)
    const trs = [...(main?.querySelectorAll('table tbody:not([aria-hidden="true"]) > tr') ?? [])]
    const data = trs.filter((tr) => !tr.querySelector('td[colspan]') && tr.querySelectorAll('td').length > 1)
    const heads = [...(main?.querySelectorAll('table thead th') ?? [])].map((th) => (th as HTMLElement).innerText.trim())
    const column = (re: RegExp) => {
      const at = heads.findIndex((h) => re.test(h))
      return at < 0 ? [] : data.map((tr) => (tr.querySelectorAll('td')[at] as HTMLElement | undefined)?.innerText.trim() ?? '')
    }
    const single = trs.find((tr) => tr.querySelector('td[colspan]'))
    return {
      banner: banner ? banner.innerText : null,
      forbidden: forbidden.some(has),
      notInstalled: notInstalled.some(has),
      error: has('table-load-error'),
      empty: empty !== null && (main?.innerText ?? '').includes(empty),
      rows: data.length,
      single: single ? (single as HTMLElement).innerText.trim() : null,
      namespaces: column(/^namespace$/i),
      names: column(/^name$/i),
      pager: main?.querySelector('[data-testid="list-pager"]')?.textContent ?? null,
    }
  }, signs)
}
const bannerKinds = (banner: string | null) => (banner?.match(BANNER_BODY)?.[1] ?? '').split(', ').filter(Boolean)
const shownCount = (r: ListRead) => {
  const total = r.pager?.match(/of (\d+)/)?.[1]
  return total === undefined ? r.rows : Number(total)
}

// A list shows its rows, a refusal, "not installed", its empty text or a load error; anything else (a loading row) is
// not read yet.
async function settleList(page: Page, t: Tracker, signs: ListSigns): Promise<ListRead & { timedOut: boolean }> {
  const loading = tr('common.loading')
  const end = Date.now() + 20_000
  let prev = ''
  let since = Date.now()
  let timedOut = false
  for (;;) {
    const r = await readList(page, signs)
    const done = r.rows > 0 || r.forbidden || r.notInstalled || r.error || r.empty || (r.single !== null && !r.single.includes(loading))
    const key = JSON.stringify([r.rows, r.forbidden, r.notInstalled, r.error, r.single, r.banner, r.pager])
    if (!done || key !== prev) {
      prev = key
      since = Date.now()
    } else if (Date.now() - since >= 400) break
    if (Date.now() > end) {
      timedOut = true
      break
    }
    await page.waitForTimeout(100)
  }
  await quiet(page, t)
  return { ...(await readList(page, signs)), timedOut }
}

// What Kubeast shows of a list: its rows, the refusal (the table's or the banner naming the kind), "not installed"
function kubeastList(r: ListRead, kind: string): string {
  if (r.notInstalled) return 'notInstalled'
  if (r.forbidden || bannerKinds(r.banner).includes(kind)) return r.rows > 0 ? 'rows and a refusal' : 'forbidden'
  if (r.error) return 'error'
  return 'allowed' // an empty list is not a refusal
}

type Cell = { screen: string; view: string; check: string; kubeast: string; cluster: string | null; basis: string; detail?: unknown }
type Role = { key: string; grant: 'Admin' | 'Write' | 'Read'; scoped: boolean }
const ROLES: Role[] = [
  { key: 'admin', grant: 'Admin', scoped: false },
  { key: 'operator', grant: 'Write', scoped: false },
  { key: 'viewer', grant: 'Read', scoped: false },
  { key: 'nsread', grant: 'Read', scoped: true },
]

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}
type RoleRow = { id: number; name: string; permissions: string[] | null }
async function roleTable(request: APIRequestContext, admin: string): Promise<RoleRow[]> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  return (Array.isArray(raw) ? raw : raw.roles || raw.items || []) as RoleRow[]
}

async function loginUI(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
}

// The sidebar's entries once it stopped changing (the admin items wait for their settings), and the account link
// under it, which the layout draws for everyone once it has drawn the sidebar
async function sidebar(page: Page, t: Tracker): Promise<{ hrefs: string[]; account: boolean }> {
  await page.goto(`/account?cluster=${CLUSTER}`)
  await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 20_000 })
  await quiet(page, t, 600)
  let prev: string[] = []
  for (let i = 0; i < 20; i++) {
    const hrefs = [...new Set(await page.getByTestId('sidebar-nav').locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')))].sort()
    if (hrefs.join(' ') === prev.join(' ')) break
    prev = hrefs
    await page.waitForTimeout(500)
  }
  const account = await page.locator('a[href="/account"]').first().waitFor({ state: 'attached', timeout: 10_000 }).then(() => true, () => false)
  return { hrefs: prev, account }
}

const screenUrl = (p: string, namespace?: string, extra = '') =>
  `${p}${p.includes('?') ? '&' : '?'}cluster=${CLUSTER}${namespace ? `&namespace=${namespace}` : ''}${extra}`

// Shared by the four users: the objects, the served kinds, the node, and what the global admin's sidebar holds on
// self (an entry the installation turned off is not on anyone's).
let ready = ''
let served = new Set<string>()
let node = ''
let adminMenu = new Set<string>()

// Read from the code only, so a new menu entry or drawer kind fails here before anything is opened.
test('the table has every sidebar screen, /account and every drawer kind', () => {
  const screens = [...SIDEBAR, '/account']
  expect(SIDEBAR.length, 'menu entries read from Layout.tsx').toBeGreaterThan(70)
  expect(screens.filter((p) => !(p in SCREENS)), 'screens with no place in the table').toEqual([])
  expect(Object.keys(SCREENS).filter((p) => !screens.includes(p)), 'table rows for screens that are gone').toEqual([])
  expect(GROUPS.flatMap((g) => g.hrefs).sort(), 'the menu groups read from Layout.tsx hold every entry').toEqual([...SIDEBAR].sort())
  const admin = GROUPS.find((g) => g.adminOnly)?.hrefs ?? []
  expect(admin.filter((p) => SCREENS[p]?.type !== 'admin'), 'admin entries not compared as admin pages').toEqual([])
  expect(admin.filter((p) => !ADMIN_KEYS[p]), 'admin entries adminAccess.ts gives no permission').toEqual([])
  expect(DRAWER_KINDS.length, 'drawer kinds read from ResourceDetailDrawer.tsx').toBeGreaterThan(40)
  expect(DRAWER_KINDS.filter((k) => !(k in DRAWERS)), 'drawer kinds with no place in the table').toEqual([])
  expect(Object.keys(DRAWERS).filter((k) => !DRAWER_KINDS.includes(k)), 'table rows for drawer kinds that are gone').toEqual([])
  const missing: string[] = []
  for (const s of Object.values(SCREENS)) {
    if (s.type !== 'list' || !s.create) continue
    try { tr(s.create) } catch { missing.push(s.create) }
  }
  expect(missing, 'create button keys the en catalog does not have').toEqual([])
})

test.describe('permission matrix — what each role is shown is what the cluster allows it', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const which = spawnSync('kind', ['get', 'kubeconfig', '--name', KIND_CLUSTER], { encoding: 'utf8' })
    if (which.status !== 0) {
      ready = `no kind cluster ${KIND_CLUSTER} (kind get kubeconfig)`
      return
    }
    kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-guard-')), 'kubeconfig')
    fs.writeFileSync(kubeconfig, which.stdout, { mode: 0o600 })
    const impersonator = JSON.parse(kubectl(['get', 'clusterrole', 'kubeast-impersonator', '-o', 'json'], undefined, true) || '{}')
    if (!(impersonator.rules ?? []).some((r: { resourceNames?: string[] }) => (r.resourceNames ?? []).includes('kubeast:role:read'))) {
      ready = 'the impersonator may not act as kubeast:role:read (helm/kubeast/files/impersonation-rbac.yaml)'
      return
    }
    node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
    kubectl(['apply', '-f', '-'], asList([NS_A, NS_B].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: LABELS } }))))
    kubectl(['apply', '-f', '-'], asList(clusterObjects(node)))
    kubectl(['apply', '-f', '-'], asList([...namespacedObjects(NS_A), ...namespacedObjects(NS_B)]))
    // the namespace-limited Read grant acts as kubeast:role:read: the cluster lets that group read (view) in NS_A only
    kubectl(['apply', '-f', '-'], asList([{
      apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: `${PREFIX}-view`, namespace: NS_A, labels: LABELS },
      roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: 'view' }, subjects: [{ apiGroup: RBAC, kind: 'Group', name: 'kubeast:role:read' }],
    }]))
    kubectl(['wait', '--for', 'condition=Established', `crd/${CRD}`, '--timeout=60s'])
    const instances = asList([NS_A, NS_B].map((namespace) => ({ apiVersion: `${CR_GROUP}/v1`, kind: 'GuardCheck', metadata: { name: 'guard-cr', namespace, labels: LABELS }, spec: { note: 'guard' } })))
    for (let i = 0; ; i++) {
      try {
        kubectl(['apply', '-f', '-'], instances)
        break
      } catch (e) {
        if (i >= 10) throw e
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    served = new Set(kubectl(['api-resources', '-o', 'name'], undefined, true).split('\n').filter(Boolean))

    const ctx = await browser.newContext({ baseURL: BASE, storageState: path.join(__dirname, '..', '.auth', 'user.json') })
    try {
      const page = await ctx.newPage()
      adminMenu = new Set((await sidebar(page, track(page))).hrefs)
    } finally {
      await ctx.close()
    }
  })

  test.afterAll(() => {
    if (!kubeconfig) return
    kubectl(['delete', 'namespace', NS_A, NS_B, '--ignore-not-found', '--wait=false'], undefined, true)
    kubectl(['delete', '-f', '-', '--ignore-not-found', '--wait=false'], asList(clusterObjects(node || 'none')), true)
  })

  for (const role of ROLES) {
    test(`${role.key} (${role.grant}${role.scoped ? ' limited to one namespace' : ''}): every screen and drawer as the cluster answers`, async ({ browser, request }) => {
      test.skip(ready !== '', ready)
      test.setTimeout(1_500_000)
      const cells: Cell[] = []
      try {
        await walk(browser, request, role, cells)
      } finally {
        await test.info().attach(`permission-matrix-${role.key}.json`, { body: JSON.stringify(cells, null, 2), contentType: 'application/json' })
      }
      const differing = cells.filter((c) => c.cluster !== null && c.kubeast !== c.cluster)
      for (const c of differing) {
        expect.soft(c.kubeast, `${role.key} ${c.screen}${c.view ? ` [${c.view}]` : ''} ${c.check} — ${c.basis}`).toBe(c.cluster)
      }
      // every row of the table was compared: a step that stopped running fails here, not by passing
      const visited = (check: string, view?: string) => new Set(cells.filter((c) => c.check === check && (view === undefined || c.view === view)).map((c) => c.screen))
      const lists = Object.entries(SCREENS).filter(([, s]) => s.type === 'list')
      expect.soft(lists.map(([p]) => p).filter((p) => !visited('list').has(p)), 'list screens with no list cell').toEqual([])
      expect.soft(Object.keys(SCREENS).filter((p) => !visited('menu').has(p)), 'screens with no menu cell').toEqual([])
      if (role.scoped) {
        const others = lists.filter(([, s]) => s.type === 'list' && s.namespaced && served.has(s.resource)).map(([p]) => p)
        expect.soft(others.filter((p) => !visited('list', 'other namespace').has(p)), 'namespaced screens not opened on the other namespace').toEqual([])
      }
      const drawers = Object.entries(DRAWERS).filter(([, d]) => !('skip' in d)).map(([k]) => `drawer ${k}`)
      expect.soft(drawers.filter((k) => !visited('get').has(k)), 'drawer kinds with no get cell').toEqual([])
      expect(cells.length, 'cells compared').toBeGreaterThan(150)
    })
  }
})

// One user's walk: the identity Kubeast acts as, the sidebar, each screen, each drawer — every cell recorded. A step
// that throws is a cell of its own and the walk goes on, so one broken screen does not hide the others.
async function walk(browser: Browser, request: APIRequestContext, role: Role, cells: Cell[]): Promise<void> {
  const add = (c: Cell) => { cells.push(c) }
  const step = async (screen: string, view: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (e) {
      add({ screen, view, check: 'ran', kubeast: `failed: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 300)}`, cluster: 'ran', basis: 'every step runs to its end' })
    }
  }
  const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
  const roles = await roleTable(request, admin)
  const perms = (name: string) => roles.find((r) => r.name.toLowerCase() === name.toLowerCase())?.permissions ?? []
  const member = roles.find((r) => r.name.toLowerCase() === 'member')
  expect(member, 'the Member role').toBeTruthy()
  // what auth-service puts in the token: the global role's "*" and admin.* keys for all clusters, the grant's for self
  const global = perms('Member').filter((p) => p === '*' || p.startsWith('admin.'))
  const onCluster = perms(role.grant)
  const hasGlobal = (p: string) => holds(global, p)
  const hasCluster = (p: string) => holds(global, p) || holds(onCluster, p)

  const email = `e2e-guard-${Date.now().toString(36)}-${role.key}@kubeast.local`
  const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E guard ${role.key}`, email, password: PW, role_id: member!.id } })
  expect(created.status(), `create ${email}`).toBe(201)
  const userId = (await created.json()).id as string
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  try {
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: role.grant, ...(role.scoped ? { namespaces: [NS_A] } : {}) } })
    expect(grant.status(), await grant.text()).toBe(200)

    // The identity: Kubeast says on every cluster answer whom it acted as (X-Kubeast-Access).
    const token = await login(request, email, PW)
    const answer = await request.get(`/api/v1/cluster/namespaces?cluster=${CLUSTER}`, { headers: bearer(token), failOnStatusCode: false })
    const header = answer.headers()['x-kubeast-access']
    expect(header, 'X-Kubeast-Access on a cluster answer').toBeTruthy()
    const access = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { user?: string; groups?: string[]; role?: string; namespaces?: string[]; impersonation?: boolean }
    test.skip(access.impersonation !== true, 'impersonation is off: Kubeast acts as its own service account, there is no per-user identity to ask about')
    expect(access.role, 'the role Kubeast acts with on self').toBe(role.grant)
    expect(access.namespaces ?? [], 'the namespaces the grant is limited to').toEqual(role.scoped ? [NS_A] : [])
    const who: Who = { user: access.user ?? '', groups: access.groups ?? [] }
    add({ screen: 'identity', view: '', check: 'X-Kubeast-Access', kubeast: JSON.stringify(access), cluster: null, basis: 'what kubectl is asked as' })
    // ...and the cluster gives the same answers to Kubeast (SelfSubjectAccessReview as the user) as to kubectl --as.
    const probes: [string, string, string, string | null][] = [
      ['list', '', 'secrets', null], ['list', '', 'nodes', null], ['create', 'apps', 'deployments', NS_A],
      ['list', '', 'pods', NS_A], ['list', '', 'pods', NS_B], ['delete', RBAC, 'clusterroles', null],
    ]
    for (const [verb, group, resource, namespace] of probes) {
      const q = new URLSearchParams({ verb, group, resource, namespace: namespace ?? '', cluster: CLUSTER })
      const res = await request.get(`/api/v1/cluster/can-i?${q}`, { headers: bearer(token), failOnStatusCode: false })
      const kubeast = res.ok() ? ((await res.json()).allowed ? 'yes' : 'no') : `HTTP ${res.status()}`
      const c = canI(who, verb, group ? `${resource}.${group}` : resource, namespace)
      add({ screen: 'identity', view: namespace ?? 'all', check: `can-i ${verb} ${resource}`, kubeast, cluster: c.ok ? 'yes' : 'no', basis: `Kubeast /can-i vs kubectl ${c.basis}` })
    }

    await ctx.addInitScript(recorder, FORBIDDEN_IDS)
    const page = await ctx.newPage()
    const t = track(page)
    await loginUI(page, email)
    const drawn = await sidebar(page, t)
    const menu = new Set(drawn.hrefs)
    const leak = async (screen: string, view: string) => {
      if (!role.scoped) return
      const text = await page.locator('body').innerText()
      add({ screen, view, check: 'other namespace on screen', kubeast: text.includes(NS_B) ? `shows ${NS_B}` : 'none', cluster: 'none', basis: `the grant is ${NS_A} only` })
    }
    // the namespaces a namespace-limited user may get, as the namespace list should hold them
    const grantNamespaces = role.scoped ? [NS_A].filter((n) => canI(who, 'get', 'namespaces', n, n).ok) : []

    for (const [p, s] of Object.entries(SCREENS)) {
      // the menu: shown when the installation has the entry on (the global admin's sidebar) and the role may open it
      if (s.type === 'account') {
        add({ screen: p, view: '', check: 'menu', kubeast: drawn.account ? 'shown' : 'hidden', cluster: 'shown', basis: 'every signed-in user has an account page (read with the sidebar, once drawn)' })
      } else {
        const group = GROUPS.find((g) => g.hrefs.includes(p))
        let want = adminMenu.has(p)
        let basis = want ? 'on for this installation (global admin sidebar)' : 'off for this installation (not on the global admin sidebar)'
        if (want && group?.menu) {
          want = hasCluster(group.menu)
          basis += ` · role ${role.grant} ${want ? 'holds' : 'lacks'} ${group.menu}`
        }
        if (want && s.type === 'admin') {
          const keys = ADMIN_KEYS[p] ?? []
          want = keys.some((k) => (k.startsWith('admin.') ? hasGlobal(k) : hasCluster(k)))
          basis += ` · Kubeast role table: any of ${keys.join(', ')} (admin.* from the global role only, pkg/auth HasPermission)`
        }
        if (want && s.type === 'summary' && s.menuRead) {
          const c = canI(who, 'list', s.menuRead, null)
          want = c.ok
          basis += ` · for whoever reads the whole cluster: ${c.basis}`
        }
        add({ screen: p, view: '', check: 'menu', kubeast: menu.has(p) ? 'shown' : 'hidden', cluster: want ? 'shown' : 'hidden', basis })
      }

      if (s.type === 'skip') {
        add({ screen: p, view: '', check: 'screen', kubeast: '-', cluster: null, basis: `not compared: ${s.why}` })
      } else if (s.type === 'list') {
        await compareList(p, s)
      } else if (s.type === 'summary') {
        await step(p, '', () => compareSummary(p, s))
      } else if (s.type === 'admin') {
        await step(p, '', () => compareAdmin(p, s))
      } else {
        await step(p, '', async () => {
          await page.goto(screenUrl(p))
          await expect(page.getByTestId('account-cluster-access')).toBeVisible({ timeout: 20_000 })
          await quiet(page, t)
          const ids = (await page.locator('[data-testid^="account-cluster-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? '')))
            .map((id) => id.replace('account-cluster-', '')).filter((id) => id !== 'access' && !/^(until|pending)-/.test(id)).sort()
          const roleShown = ids.includes(CLUSTER) ? (await page.getByTestId(`account-cluster-${CLUSTER}`).locator('.text-xs').first().innerText()).trim().split(/\s/)[0] : ''
          add({ screen: p, view: '', check: 'cluster access', kubeast: `${ids.join(',')} ${roleShown}`, cluster: `${CLUSTER} ${role.grant}`, basis: 'the grant made for this user' })
          await leak(p, '')
        })
      }
    }

    for (const [kind, d] of Object.entries(DRAWERS)) {
      if ('skip' in d) {
        add({ screen: `drawer ${kind}`, view: '', check: 'drawer', kubeast: '-', cluster: null, basis: `not compared: ${d.skip}` })
        continue
      }
      for (const target of drawerTargets(kind, d, role)) await step(`drawer ${kind}`, target.view, () => compareDrawer(kind, d, target))
    }

    async function compareList(p: string, s: ListScreen) {
      const signs: ListSigns = {
        forbidden: ['table-forbidden', ...(s.forbiddenId ? [s.forbiddenId] : [])],
        notInstalled: ['table-not-installed', ...(s.notInstalledId ? [s.notInstalledId] : [])],
        empty: s.emptyKey ? tr(s.emptyKey) : null,
      }
      const isServed = served.has(s.resource)
      const views: { view: string; namespace?: string; scope: string | null }[] = s.namespaced
        ? [
            // every namespace: a namespace-limited grant is fanned out over its namespaces
            { view: 'all namespaces', scope: role.scoped ? NS_A : null },
            { view: 'namespace under test', namespace: NS_A, scope: NS_A },
            ...(role.scoped && isServed ? [{ view: 'other namespace', namespace: NS_B, scope: NS_B }] : []),
          ]
        : [{ view: 'cluster', scope: null }]
      for (const v of views) await step(p, v.view, () => compareListView(p, s, signs, isServed, v))
    }

    async function compareListView(p: string, s: ListScreen, signs: ListSigns, isServed: boolean, v: { view: string; namespace?: string; scope: string | null }) {
      await page.goto(screenUrl(p, v.namespace))
      const r = await settleList(page, t, signs)
      let want: string
      let basis: string
      if (!isServed) {
        want = 'notInstalled'
        basis = `self does not serve ${s.resource} (kubectl api-resources)`
      } else if (s.grantList && role.scoped) {
        want = grantNamespaces.length > 0 ? 'allowed' : 'forbidden'
        basis = `the namespace list of a limited grant is the namespaces it may get: ${grantNamespaces.join(', ') || 'none'}`
      } else {
        const c = canI(who, 'list', s.resource, v.scope)
        want = c.ok ? 'allowed' : 'forbidden'
        basis = c.basis
      }
      add({ screen: p, view: v.view, check: 'list', kubeast: kubeastList(r, s.kind), cluster: want, basis, detail: { banner: r.banner, rows: r.rows, pager: r.pager, timedOut: r.timedOut } })

      // the screen never showed the opposite on its way there
      const states = await page.evaluate(() => (window as unknown as { __guard?: { states: Seen[] } }).__guard?.states ?? [])
      const against = want === 'forbidden'
        ? states.filter((x) => x.r > 0).map((x) => `${x.r} rows at ${x.t} ms`)
        : want === 'allowed' ? states.filter((x) => x.f || bannerKinds(x.b).includes(s.kind)).map((x) => `a refusal at ${x.t} ms`) : []
      add({ screen: p, view: v.view, check: 'on the way', kubeast: against.length ? against.join('; ') : 'steady', cluster: 'steady', basis: `the states the list passed through until it showed "${want}"` })

      if (want === 'allowed' && s.count !== false && !(s.grantList && role.scoped) && (v.scope !== null || !s.namespaced)) {
        // the rows are the objects the user may list there, as the admin's kubectl counts them
        let kubeast = shownCount(r)
        let cluster = countOf(s.resource, v.scope)
        const end = Date.now() + 15_000
        while (kubeast !== cluster && Date.now() < end) {
          await page.waitForTimeout(500)
          kubeast = shownCount(await readList(page, signs))
          cluster = countOf(s.resource, v.scope)
        }
        add({ screen: p, view: v.view, check: 'rows', kubeast: String(kubeast), cluster: String(cluster), basis: `kubectl get ${s.resource}${v.scope ? ` -n ${v.scope}` : ''} (admin)` })
      }
      if (s.grantList && role.scoped && want === 'allowed') {
        add({ screen: p, view: v.view, check: 'rows', kubeast: [...r.names].sort().join(','), cluster: grantNamespaces.join(','), basis: 'the namespaces of the grant the user may get' })
      }
      if (role.scoped && s.namespaced && v.namespace === undefined && want === 'allowed') {
        // fanned out over the grant: nothing of another namespace
        add({ screen: p, view: v.view, check: 'namespaces of the rows', kubeast: [...new Set(r.namespaces)].filter((n) => n !== NS_A).sort().join(',') || 'none', cluster: 'none', basis: `the grant is ${NS_A} only` })
      }
      if (v.view !== 'other namespace') await leak(p, v.view)

      if (s.create && (v.scope === NS_A || !s.namespaced) && v.view !== 'all namespaces') {
        const label = tr(s.create)
        const shown = (await page.locator('main').getByRole('button', { name: label, exact: true }).count()) > 0
        let allowed = false
        let why = `self does not serve ${s.resource}`
        if (isServed) {
          const c = canI(who, 'create', s.resource, s.namespaced ? NS_A : null)
          allowed = c.ok
          why = c.basis
        }
        add({ screen: p, view: v.view, check: `create button "${label}"`, kubeast: shown ? 'shown' : 'hidden', cluster: allowed ? 'shown' : 'hidden', basis: why })
      }
      const creates = (await page.locator('main button').allInnerTexts()).map((x) => x.trim()).filter((x) => /^Create\b/.test(x) && x !== (s.create ? tr(s.create) : ''))
      add({ screen: p, view: v.view, check: 'create buttons the table does not know', kubeast: creates.join(', ') || 'none', cluster: 'none', basis: 'a create button on a list is compared only when the table names it' })
    }

    async function compareSummary(p: string, s: SummaryScreen) {
      await page.goto(screenUrl(p, s.inNamespace ? NS_A : undefined))
      await expect(page.locator('main')).toBeVisible({ timeout: 20_000 })
      if (s.cards) {
        // the six count cards hold a number or "—" once the overview answered (a skeleton before)
        const drawn = async () => (await page.locator('[data-testid^="stat-value-"]').allInnerTexts()).filter((x) => /^(\d+|—)$/.test(x.trim())).length
        const end = Date.now() + 30_000
        while ((await drawn()) < 6 && Date.now() < end) await page.waitForTimeout(200)
      }
      // a refused read is asked again a second later (react-query retry 1): wait past it
      await quiet(page, t, 1_200, 15_000)
      const main = page.locator('main')
      const text = await main.innerText()
      const banner = await page.getByTestId('forbidden-banner').count()
      const own = s.forbiddenId ? await page.getByTestId(s.forbiddenId).count() : 0
      const kubeast = banner > 0 || own > 0 || text.includes(FORBIDDEN_PHRASE) ? 'forbidden' : 'allowed'
      const detail = { banner: banner > 0 ? await page.getByTestId('forbidden-banner').innerText() : null, own: own > 0, phrase: text.includes(FORBIDDEN_PHRASE) }
      if (s.inNamespace) {
        // in one namespace the cluster's answer is clear for every user: the namespaced kinds there, the rest cluster-wide
        const reads = s.inNamespace.map((r) => ({ kind: r.kind, c: canI(who, 'list', r.resource, r.namespaced ? NS_A : null) }))
        const denied = reads.filter((r) => !r.c.ok).map((r) => r.kind).sort()
        const basis = `opened on ${NS_A}: ${reads.map((r) => r.c.basis).join('; ')}`
        add({ screen: p, view: 'namespace under test', check: 'notice', kubeast, cluster: denied.length ? 'forbidden' : 'allowed', basis, detail })
        // the kinds its notice names (common.forbiddenEmpty with the kinds joined by ", ") are the ones refused
        const said = own > 0 ? await page.getByTestId(s.forbiddenId!).innerText() : ''
        const named = (said.match(FORBIDDEN_EMPTY)?.[1] ?? '').split(', ').filter(Boolean).sort()
        add({ screen: p, view: 'namespace under test', check: 'kinds the notice names', kubeast: named.join(', ') || 'none', cluster: denied.join(', ') || 'none', basis, detail: { said } })
      } else if (role.scoped) {
        add({ screen: p, view: '', check: 'notice', kubeast, cluster: null, basis: 'not compared for a limited grant: a cluster-wide screen may be narrowed to the grant or refused; the other-namespace check decides', detail })
      } else {
        const denied = s.reads.map((r) => canI(who, 'list', r, null)).filter((c) => !c.ok)
        add({ screen: p, view: '', check: 'notice', kubeast, cluster: denied.length ? 'forbidden' : 'allowed', basis: s.reads.length ? s.reads.map((r) => canI(who, 'list', r, null).basis).join('; ') : 'reads nothing on opening', detail })
      }
      if (s.crRows) {
        // the GuardCheck rows the screen lists, or its refusal; the cluster: may the user list them (where the grant reaches)
        const rows = await page.locator('main table tbody:not([aria-hidden="true"]) > tr').filter({ hasText: 'GuardCheck' }).count()
        const scope = role.scoped ? NS_A : null
        const c = canI(who, 'list', `guardchecks.${CR_GROUP}`, scope)
        add({ screen: p, view: '', check: 'GuardCheck rows', kubeast: kubeast === 'forbidden' && rows === 0 ? 'refused' : String(rows), cluster: c.ok ? String(countOf(`guardchecks.${CR_GROUP}`, scope, true)) : 'refused', basis: c.basis, detail })
      }
      if (s.cards) {
        const cards: [string, string][] = [['namespaces', 'namespaces'], ['pods', 'pods'], ['services', 'services'], ['deployments', 'deployments.apps'], ['pvcs', 'persistentvolumeclaims'], ['nodes', 'nodes']]
        for (const [card, resource] of cards) {
          const value = (await page.getByTestId(`stat-value-${card}`).innerText()).trim()
          let want: string
          let basis: string
          if (role.scoped) {
            // counted within the grant: the namespaces it may get, the objects there; nodes are not counted
            want = card === 'nodes' ? '—' : card === 'namespaces' ? String(grantNamespaces.length) : String(countOf(resource, NS_A))
            basis = card === 'nodes' ? 'a limited grant does not count nodes' : `kubectl get ${resource} in ${NS_A} (admin)`
            add({ screen: p, view: '', check: `card ${card}`, kubeast: value, cluster: want, basis })
          } else {
            const c = canI(who, 'list', resource, null)
            want = c.ok ? 'a number' : '—'
            add({ screen: p, view: '', check: `card ${card}`, kubeast: /^\d+$/.test(value) ? 'a number' : value, cluster: want, basis: c.basis })
          }
        }
      }
      await leak(p, '')
    }

    async function compareAdmin(p: string, s: AdminScreen) {
      const keys = ADMIN_KEYS[p] ?? []
      const allowed = keys.some((k) => (k.startsWith('admin.') ? hasGlobal(k) : hasCluster(k)))
      const basis = `Kubeast role table: any of ${keys.join(', ')} (admin.* from the global role only, pkg/auth HasPermission)`
      if (adminMenu.has(p)) {
        await page.goto(screenUrl(p))
        // RequirePermission draws a blank page at the address while /auth/me loads, then sends a refused user to "/":
        // read the address once it stayed put for 1.2 s with a page heading drawn (at most 10 s), keeping every one seen
        const paths = [new URL(page.url()).pathname]
        await quiet(page, t, 300)
        const end = Date.now() + 10_000
        let since = Date.now()
        for (;;) {
          const at = new URL(page.url()).pathname
          if (at !== paths[paths.length - 1]) {
            paths.push(at)
            since = Date.now()
          } else if (Date.now() - since >= 1_200 && (await page.locator('main h1').count()) > 0) break
          if (Date.now() > end) break
          await page.waitForTimeout(100)
        }
        const at = paths[paths.length - 1]
        const heading = (await page.locator('main h1').first().innerText({ timeout: 1_000 }).catch(() => '')).trim()
        add({ screen: p, view: '', check: 'open', kubeast: at === p ? 'open' : `sent to ${at}`, cluster: allowed ? 'open' : 'sent to /', basis, detail: { paths, heading } })
        await leak(p, '')
      }
      if (s.probe) {
        const res = await request.get(s.probe, { headers: bearer(token), failOnStatusCode: false })
        add({ screen: p, view: '', check: 'its API', kubeast: res.status() === 200 ? 'answers' : res.status() === 403 ? 'refuses' : `HTTP ${res.status()}`, cluster: allowed ? 'answers' : 'refuses', basis: `${s.probe} · ${basis}` })
      }
    }

    async function compareDrawer(kind: string, d: Exclude<DrawerRow, { skip: string }>, target: DrawerTarget) {
      const statuses: number[] = []
      const onResponse = (r: Response) => { if (target.primary(new URL(r.url()))) statuses.push(r.status()) }
      page.on('response', onResponse)
      const screen = `drawer ${kind}`
      try {
        await page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(target.ref)}${target.api ? `&detailApi=${encodeURIComponent(target.api)}` : ''}`)
        const drawer = page.locator(DRAWER).last()
        await expect(drawer).toBeVisible({ timeout: 20_000 })
        const refusals = [tr('nodes.detail.error'), tr('namespaces.detail.error')]
        const end = Date.now() + 20_000
        let refusedAt = 0
        for (;;) {
          const text = await drawer.innerText()
          if ((await drawer.getByTestId('detail-unreadable').count()) > 0 || refusals.some((x) => text.includes(x))) break
          if (statuses.some((x) => x >= 200 && x < 300) && !(target.loading && text.includes(target.loading))) break
          // refused twice (the retry) and nothing said so: wait a moment for a notice, then read what is there
          if (statuses.filter((x) => x >= 400).length >= 2) {
            refusedAt ||= Date.now()
            if (Date.now() - refusedAt > 1_500) break
          }
          if (Date.now() > end) break
          await page.waitForTimeout(100)
        }
        await quiet(page, t)
        const text = await drawer.innerText()
        const unreadable = await drawer.getByTestId('detail-unreadable').count() > 0 ? await drawer.getByTestId('detail-unreadable').innerText() : ''
        let kubeast = 'timeout'
        if (unreadable) kubeast = unreadable.includes(tr('common.objectForbidden')) ? 'forbidden' : unreadable.includes(tr('common.objectNotFound')) ? 'notFound' : 'unreadable'
        else if (refusals.some((x) => text.includes(x))) kubeast = 'error'
        else if (statuses.some((x) => x >= 200 && x < 300)) kubeast = 'shown'
        else if (statuses.some((x) => x >= 400)) kubeast = 'blank'
        const get = canI(who, 'get', d.resource, target.scope, target.name)
        add({ screen, view: target.view, check: 'get', kubeast, cluster: get.ok ? 'shown' : 'forbidden', basis: get.basis, detail: { ref: target.ref, statuses } })
        if (d.noDelete) {
          add({ screen, view: target.view, check: 'delete', kubeast: '-', cluster: null, basis: `not compared: ${d.noDelete}` })
        } else {
          const label = tr('common.deleteKind', { kind: target.displayKind })
          const shown = (await drawer.getByRole('button', { name: label, exact: true }).count()) > 0
          const del = canI(who, 'delete', d.resource, target.scope, target.name)
          add({ screen, view: target.view, check: `delete button "${label}"`, kubeast: shown ? 'shown' : 'hidden', cluster: del.ok ? 'shown' : 'hidden', basis: del.basis })
        }
      } finally {
        page.off('response', onResponse)
      }
    }
  } finally {
    await ctx.close()
    await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
  }
}

// Where a drawer kind is opened: the object, the namespace kubectl is asked in (the object's own; for a Namespace its
// name, which is the namespace the API server authorizes a namespace's own reads in), and the request whose answer the
// drawer shows (the object's JSON, or the describe of the kinds that load themselves).
type DrawerTarget = { view: string; ref: string; api?: string; name: string; scope: string | null; displayKind: string; loading?: string; primary: (u: URL) => boolean }
function drawerTargets(kind: string, d: Exclude<DrawerRow, { skip: string }>, role: Role): DrawerTarget[] {
  const json = (name: string) => (u: URL) => u.pathname === '/api/v1/cluster/resources/json' && u.searchParams.get('resource_name') === name
  const namespaces = role.scoped ? [[NS_A, 'namespace under test'], [NS_B, 'other namespace']] : [[NS_A, 'namespace under test']]
  switch (d.at) {
    case 'ns':
      return namespaces.map(([ns, view]) => ({ view, ref: `${kind}/${ns}/${d.name}`, name: d.name!, scope: ns, displayKind: kind, primary: json(d.name!) }))
    case 'cluster':
      return [{ view: 'cluster', ref: `${kind}/${PREFIX}-${d.name}`, name: `${PREFIX}-${d.name}`, scope: null, displayKind: kind, primary: json(`${PREFIX}-${d.name}`) }]
    case 'crd':
      return [{ view: 'cluster', ref: `${kind}/${CRD}`, name: CRD, scope: null, displayKind: kind, primary: json(CRD) }]
    case 'node':
      return [{ view: 'cluster', ref: `${kind}/${node}`, name: node, scope: null, displayKind: kind, loading: tr('nodes.detail.loading'), primary: (u) => u.pathname === `/api/v1/cluster/nodes/${node}/describe` }]
    case 'namespace':
      return namespaces.map(([ns, view]) => ({ view, ref: `${kind}/${ns}`, name: ns, scope: ns, displayKind: kind, loading: tr('namespaces.detail.loading'), primary: (u: URL) => u.pathname === `/api/v1/cluster/namespaces/${ns}/describe` }))
    case 'lease':
      return [{ view: 'kube-node-lease', ref: `${kind}/kube-node-lease/${node}`, name: node, scope: 'kube-node-lease', displayKind: kind, primary: json(node) }]
    case 'cr':
      return namespaces.map(([ns, view]) => ({
        view, ref: `GuardCheck/${ns}/${d.name}`, api: `${CR_GROUP}/v1/guardchecks`, name: d.name!, scope: ns, displayKind: 'GuardCheck', loading: tr('common.loading'),
        primary: (u: URL) => u.pathname === `/api/v1/cluster/custom-resources/${CR_GROUP}/v1/guardchecks/${ns}/${d.name}/describe`,
      }))
  }
}
