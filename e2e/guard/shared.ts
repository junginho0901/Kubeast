import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, type APIRequestContext, type Page, type Request } from '@playwright/test'

// What the safety nets under e2e/guard share: the users, the objects, the screens and drawers the code lists.

export const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
export const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
export const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
export const CLUSTER = 'self'
// The dev cluster that serves the Gateway API and the VPA CRD: registered under the kind cluster's name.
export const TEST2 = 'test2'
const KIND_CLUSTER = 'kubeast'
export const PW = 'E2e-guard-throwaway-1!'
const REPO = path.join(__dirname, '..', '..')
const STAMP = Date.now().toString(36)
const PREFIX = `e2e-guard-${STAMP}`
export const NS_A = `${PREFIX}-a`
export const NS_B = `${PREFIX}-b`
export const CR_GROUP = `g${STAMP}.guard.kubeast.io`
const CRD = `guardchecks.${CR_GROUP}`
export const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const LABELS = { 'kubeast.io/e2e': 'guard' }
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
export const source = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8')

// Screen words come from the en catalog, the locale this project runs in.
const EN: unknown = JSON.parse(source('frontend/src/i18n/locales/en.json'))
export function tr(key: string, vars: Record<string, string> = {}): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}

export const LAYOUT = source('frontend/src/components/Layout.tsx')
export const SIDEBAR = [...LAYOUT.matchAll(/href: '([^']+)'/g)].map((m) => m[1])

const DRAWER_SRC = source('frontend/src/components/ResourceDetailDrawer.tsx')
const RENDER_AT = DRAWER_SRC.indexOf('const renderInfoContent')
export const DRAWER_KINDS = [...new Set([
  ...[...DRAWER_SRC.slice(RENDER_AT, DRAWER_SRC.indexOf('return (', RENDER_AT)).matchAll(/kind === '(\w+)'/g)].map((m) => m[1]),
  ...[...source('frontend/src/components/resource-detail/utils.ts').matchAll(/export const (?:WORKLOAD|NETWORK|CONFIG_STORAGE)_KINDS = new Set\(\[([^\]]+)\]\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((k) => k[1])),
])].sort()

export const ADM = 'admissionregistration.k8s.io'

// The drawer kinds: the object each is opened on by link (?detail=), and the resource kubectl asks about. `ns` = the
// fixture's object of that name in the namespace under test; `cluster` = this run's cluster-scoped object of that
// suffix. A kind left out says why.
type DrawerAt = 'ns' | 'cluster' | 'node' | 'namespace' | 'lease' | 'crd' | 'cr'
export type DrawerRow = { resource: string; at: DrawerAt; name?: string; noDelete?: string } | { skip: string }
const NOT_SERVED = 'self does not serve this kind (the Gateway API and VPA CRDs are on test2 only, number check §6-3d)'
export const DRAWERS: Record<string, DrawerRow> = {
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

// The kinds self does not serve, opened on test2 (applyTest2Fixtures makes the objects).
const GW = 'gateway.networking.k8s.io'
export const TEST2_DRAWERS: Record<string, DrawerRow> = {
  Gateway: { resource: `gateways.${GW}`, at: 'ns', name: 'guard-gw' },
  GatewayClass: { resource: `gatewayclasses.${GW}`, at: 'cluster', name: 'gc' },
  HTTPRoute: { resource: `httproutes.${GW}`, at: 'ns', name: 'guard-http' },
  GRPCRoute: { resource: `grpcroutes.${GW}`, at: 'ns', name: 'guard-grpc' },
  ReferenceGrant: { resource: `referencegrants.${GW}`, at: 'ns', name: 'guard-rg' },
  BackendTLSPolicy: { resource: `backendtlspolicies.${GW}`, at: 'ns', name: 'guard-btls' },
  VerticalPodAutoscaler: { resource: 'verticalpodautoscalers.autoscaling.k8s.io', at: 'ns', name: 'guard-vpa' },
}
export const NOT_SERVED_ON_SELF = Object.entries(DRAWERS).filter(([, d]) => 'skip' in d && d.skip === NOT_SERVED).map(([k]) => k)

// The objects: one of every namespaced kind in each of the two namespaces (none acts on anything: no pod is scheduled,
// nothing scales, the claims are never allocated) and one of every cluster-scoped kind that self has none of or that a
// run should own (the webhooks and policies match a group nobody serves).
const PAUSE = { name: 'c', image: 'registry.k8s.io/pause:3.10' }
const NOWHERE = { 'kubeast.io/e2e-guard': 'nowhere' }
export const RBAC = 'rbac.authorization.k8s.io'
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
export function kubectl(args: string[], input?: string, tolerate = false): string {
  const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !tolerate) throw new Error(`kubectl ${args.slice(0, 4).join(' ')}: ${(r.stderr || '').slice(0, 400)}`)
  return (r.stdout || '').trim()
}

// The API requests in flight (fetch and XHR; the live streams are EventSource), so a read waits until the page
// stopped asking.
export type Tracker = { inflight: number; last: number }
export function track(page: Page): Tracker {
  const t: Tracker = { inflight: 0, last: Date.now() }
  const api = (r: Request) => ['fetch', 'xhr'].includes(r.resourceType()) && new URL(r.url()).pathname.startsWith('/api/')
  page.on('request', (r) => { if (api(r)) { t.inflight += 1; t.last = Date.now() } })
  const done = (r: Request) => { if (api(r)) { t.inflight = Math.max(0, t.inflight - 1); t.last = Date.now() } }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  return t
}
export async function quiet(page: Page, t: Tracker, idleMs = 300, capMs = 8_000): Promise<boolean> {
  const end = Date.now() + capMs
  while (Date.now() < end) {
    if (t.inflight === 0 && Date.now() - t.last >= idleMs) return true
    await page.waitForTimeout(50)
  }
  return false
}

export type Role = { key: string; grant: 'Admin' | 'Write' | 'Read'; scoped: boolean }
export const ROLES: Role[] = [
  { key: 'admin', grant: 'Admin', scoped: false },
  { key: 'operator', grant: 'Write', scoped: false },
  { key: 'viewer', grant: 'Read', scoped: false },
  { key: 'nsread', grant: 'Read', scoped: true },
]

export async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}
type RoleRow = { id: number; name: string; permissions: string[] | null }
export async function roleTable(request: APIRequestContext, admin: string): Promise<RoleRow[]> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  return (Array.isArray(raw) ? raw : raw.roles || raw.items || []) as RoleRow[]
}

export async function loginUI(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
}

// Where a drawer kind is opened: the object, the namespace kubectl is asked in (the object's own; for a Namespace its
// name, which is the namespace the API server authorizes a namespace's own reads in), and the request whose answer the
// drawer shows (the object's JSON, or the describe of the kinds that load themselves).
export type DrawerTarget = { view: string; ref: string; api?: string; name: string; scope: string | null; displayKind: string; loading?: string; primary: (u: URL) => boolean }
export function drawerTargets(kind: string, d: Exclude<DrawerRow, { skip: string }>, role: Role, node: string): DrawerTarget[] {
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

// A kind cluster's admin kubeconfig, used by kubectl() from here on: '' when it can be used, else why the run skips.
export function openCluster(kindCluster = KIND_CLUSTER): string {
  const which = spawnSync('kind', ['get', 'kubeconfig', '--name', kindCluster], { encoding: 'utf8' })
  if (which.status !== 0) return `no kind cluster ${kindCluster} (kind get kubeconfig)`
  kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-guard-')), 'kubeconfig')
  fs.writeFileSync(kubeconfig, which.stdout, { mode: 0o600 })
  const impersonator = JSON.parse(kubectl(['get', 'clusterrole', 'kubeast-impersonator', '-o', 'json'], undefined, true) || '{}')
  if (!(impersonator.rules ?? []).some((r: { resourceNames?: string[] }) => (r.resourceNames ?? []).includes('kubeast:role:read'))) {
    return 'the impersonator may not act as kubeast:role:read (helm/kubeast/files/impersonation-rbac.yaml)'
  }
  return ''
}

export async function applyFixtures(): Promise<{ node: string; served: Set<string> }> {
  const node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
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
  return { node, served: new Set(kubectl(['api-resources', '-o', 'name'], undefined, true).split('\n').filter(Boolean)) }
}

// The Gateway API and VPA objects on test2, in the same two namespaces. The limited Read grant may read them in NS_A,
// as a cluster would open them to a team, and in NS_B nothing.
const test2ClusterObjects = (v: string) => [
  { apiVersion: `${GW}/${v}`, kind: 'GatewayClass', metadata: { name: `${PREFIX}-gc`, labels: LABELS }, spec: { controllerName: 'guard.kubeast.io/none' } },
]
export function applyTest2Fixtures(): { node: string; served: Set<string> } {
  const version = (crd: string) => kubectl(['get', 'crd', crd, '-o', 'jsonpath={.spec.versions[?(@.storage==true)].name}'])
  const node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
  const served = new Set(kubectl(['api-resources', '-o', 'name'], undefined, true).split('\n').filter(Boolean))
  const wanted = Object.values(TEST2_DRAWERS).map((d) => ('skip' in d ? '' : d.resource))
  if (wanted.some((r) => !served.has(r))) return { node, served }
  const v = (plural: string) => version(`${plural}.${GW}`)
  kubectl(['apply', '-f', '-'], asList([NS_A, NS_B].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: LABELS } }))))
  kubectl(['apply', '-f', '-'], asList(test2ClusterObjects(v('gatewayclasses'))))
  const objects = (ns: string): object[] => {
    const meta = (name: string) => ({ name, namespace: ns, labels: LABELS })
    return [
      { apiVersion: `${GW}/${v('gateways')}`, kind: 'Gateway', metadata: meta('guard-gw'), spec: { gatewayClassName: `${PREFIX}-gc`, listeners: [{ name: 'http', port: 80, protocol: 'HTTP' }] } },
      { apiVersion: `${GW}/${v('httproutes')}`, kind: 'HTTPRoute', metadata: meta('guard-http'), spec: { parentRefs: [{ name: 'guard-gw' }] } },
      { apiVersion: `${GW}/${v('grpcroutes')}`, kind: 'GRPCRoute', metadata: meta('guard-grpc'), spec: { parentRefs: [{ name: 'guard-gw' }] } },
      { apiVersion: `${GW}/${v('referencegrants')}`, kind: 'ReferenceGrant', metadata: meta('guard-rg'), spec: { from: [{ group: GW, kind: 'HTTPRoute', namespace: ns }], to: [{ group: '', kind: 'Service' }] } },
      { apiVersion: `${GW}/${v('backendtlspolicies')}`, kind: 'BackendTLSPolicy', metadata: meta('guard-btls'), spec: { targetRefs: [{ group: '', kind: 'Service', name: 'guard-svc' }], validation: { hostname: 'guard.invalid', wellKnownCACertificates: 'System' } } },
      { apiVersion: 'autoscaling.k8s.io/v1', kind: 'VerticalPodAutoscaler', metadata: meta('guard-vpa'), spec: { targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'guard-deploy' }, updatePolicy: { updateMode: 'Off' } } },
    ]
  }
  kubectl(['apply', '-f', '-'], asList([...objects(NS_A), ...objects(NS_B)]))
  const group = [{ apiGroup: RBAC, kind: 'Group', name: 'kubeast:role:read' }]
  kubectl(['apply', '-f', '-'], asList([
    { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: `${PREFIX}-view`, namespace: NS_A, labels: LABELS }, roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: 'view' }, subjects: group },
    { apiVersion: `${RBAC}/v1`, kind: 'Role', metadata: { name: `${PREFIX}-read`, namespace: NS_A, labels: LABELS }, rules: [
      { apiGroups: [GW], resources: ['gateways', 'httproutes', 'grpcroutes', 'referencegrants', 'backendtlspolicies'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['autoscaling.k8s.io'], resources: ['verticalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
    ] },
    { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: `${PREFIX}-read`, namespace: NS_A, labels: LABELS }, roleRef: { apiGroup: RBAC, kind: 'Role', name: `${PREFIX}-read` }, subjects: group },
  ]))
  return { node, served }
}
export function removeTest2Fixtures(): void {
  if (!kubeconfig) return
  kubectl(['delete', 'namespace', NS_A, NS_B, '--ignore-not-found', '--wait=false'], undefined, true)
  kubectl(['delete', 'gatewayclass', `${PREFIX}-gc`, '--ignore-not-found', '--wait=false'], undefined, true)
}

export function removeFixtures(node: string): void {
  if (!kubeconfig) return
  kubectl(['delete', 'namespace', NS_A, NS_B, '--ignore-not-found', '--wait=false'], undefined, true)
  kubectl(['delete', '-f', '-', '--ignore-not-found', '--wait=false'], asList(clusterObjects(node || 'none')), true)
}
