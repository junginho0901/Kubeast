import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page, type Response } from '@playwright/test'

import {
  ADM, ADMIN_EMAIL, ADMIN_PASSWORD, BASE, CLUSTER, CR_GROUP, DRAWER, DRAWER_KINDS, DRAWERS, LAYOUT, NOT_SERVED_ON_SELF, NS_A, NS_B, PW, RBAC, ROLES, SIDEBAR, TEST2, TEST2_DRAWERS,
  applyFixtures, applyTest2Fixtures, bearer, drawerTargets, kubectl, login, loginUI, openCluster, quiet, removeFixtures, removeTest2Fixtures, roleTable, source, tr, track,
  type DrawerRow, type DrawerTarget, type Role, type Tracker,
} from './shared'

// Safety net (c), the permission matrix: four users — an Admin, a Write and a Read grant on `self`, and a Read grant
// limited to one namespace — open every screen the sidebar lists, /account and a drawer of every kind. What each is
// shown (the menu, a list or its "no permission", the create and delete buttons, the drawer) is held to the cluster's
// answer for the identity Kubeast acts as for that user (X-Kubeast-Access, then `kubectl auth can-i <verb>
// <resource>` with --as and --as-group, one verb and resource at a time) or, for Kubeast's own admin pages, to the
// user's Kubeast role. Every cell is attached as JSON and every cell where the two differ fails softly with both values.
// The same four users then do the same on test2 for what self does not serve: the Gateway API's six lists and drawers
// and the VPA's.


const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BANNER_BODY = new RegExp(escape(tr('layout.forbidden.body')).replace(escape('{{resources}}'), '(.+?)'))
const FORBIDDEN_PHRASE = tr('common.forbiddenEmpty').split('{{resource}}')[0].trim()
const FORBIDDEN_EMPTY = new RegExp(escape(tr('common.forbiddenEmpty')).replace(escape('{{resource}}'), '(.+?)'))

// What the code lists: the sidebar's entries and groups, the admin pages' permissions, the drawer's kinds.
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

// The comparison table: what each sidebar screen (and /account) is compared with. A list names its Kubernetes
// resource as kubectl does (plural.group) and the Kind its "no permission" notice names; `create` is the catalog key
// of its create button; a page that says "no permission", "not installed" or "empty" its own way names that too. A
// summary screen names the lists it reads (cluster-wide). An admin page is Kubeast's own: its keys are
// adminAccess.ts's. A screen left out says why.
type ListScreen = {
  type: 'list'; resource: string; kind: string; namespaced: boolean; create: string | null
  forbiddenId?: string; notInstalledId?: string; emptyKey?: string; count?: false; grantList?: true
}
// crRows: the screen lists every custom resource the user may list; this run's GuardCheck instances are its rows or a refusal,
// and it reads every CRD's list, its notice naming the ones refused.
// inNamespace: the screen is opened on the namespace under test (?namespace=) and reads these kinds there; its notice
// names the kinds it was refused.
type GraphRead = { kind: string; resource: string; namespaced: boolean }
// What a grant limited to namespaces is shown on a summary screen, the rule of each. `narrowed`: the screen shows what
// the grant's namespaces hold; `beyond` are the lists it also reads that no namespace holds (nodes, the CRDs), asked
// across the cluster, and what the cluster refuses of those is what the notice names, as `named`. `closed`: the screen's
// numbers span the cluster, so every such grant is told it may not see it; `named` is what its notice names.
// `may` is named as well where the installation has it. `shows`: text of a fixture object of the granted namespace.
type Limited =
  | { rule: 'narrowed'; beyond?: { resource: string; named: string }[]; may?: string[]; shows?: string }
  | { rule: 'closed'; why: string; named: string[]; may?: string[] }
type SummaryScreen = { type: 'summary'; reads: string[]; limited: Limited; forbiddenId?: string; cards?: true; menuRead?: string; crRows?: true; inNamespace?: GraphRead[] }
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
// wholeCluster: the page reads the whole cluster, so the cluster's own key opens it only on a grant with no namespace
// limit. globalOnly: what its all-cluster keys add, an element of the page and the API that answers with the key.
type AdminScreen = {
  type: 'admin'; probe?: string; wholeCluster?: true
  globalOnly?: { key: string; testId: string; probe: { method: 'GET' | 'POST'; path: string } }[]
}
type Screen = ListScreen | SummaryScreen | AdminScreen | { type: 'account' } | { type: 'skip'; why: string }
const list = (resource: string, kind: string, namespaced: boolean, create: string | null, more: Partial<ListScreen> = {}): ListScreen =>
  ({ type: 'list', resource, kind, namespaced, create, ...more })
const NODES = { resource: 'nodes', named: 'Node' }
const GPU_CLOSED: Limited = { rule: 'closed', why: 'capacity, allocation and each node\'s numbers are the nodes\', which no namespace holds', named: ['gpu'] }
const SCREENS: Record<string, Screen> = {
  '/': { type: 'summary', reads: ['namespaces', 'pods', 'services', 'deployments.apps', 'persistentvolumeclaims', 'nodes'], cards: true, limited: { rule: 'narrowed', beyond: [NODES], may: ['prometheus'] } },
  '/cluster-view': { type: 'summary', reads: ['nodes', 'pods', 'namespaces'], limited: { rule: 'narrowed', beyond: [NODES] } },
  '/monitoring': { type: 'summary', reads: ['nodes', 'pods', 'namespaces'], limited: { rule: 'narrowed', beyond: [NODES, { resource: 'nodes.metrics.k8s.io', named: 'metrics' }] } },
  '/alerts': { type: 'summary', reads: ['pods'], forbiddenId: 'alert-inbox-forbidden', menuRead: 'pods', limited: { rule: 'closed', why: 'an alert\'s labels are not bounded by a namespace: for whoever reads the cluster as a whole', named: [] } },
  '/cost': { type: 'skip', why: 'OpenCost runs on the second cluster only; on self the page is off (costEnabled) and only its menu entry is compared' },
  '/ai-chat': { type: 'skip', why: 'a chat: opening it reads no cluster list; what the AI tools may read is the AI symmetry test (2-2)' },
  // limited: compared in one namespace like any other grant (inNamespace)
  '/cluster/resource-graph': { type: 'summary', reads: [], forbiddenId: 'resource-graph-forbidden', inNamespace: GRAPH_READS, limited: { rule: 'narrowed' } },
  '/timeline': { type: 'summary', reads: ['events'], forbiddenId: 'timeline-forbidden', limited: { rule: 'narrowed', shows: `guard event in ${NS_A}` } },
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
  '/gateway/policies': { type: 'summary', reads: ['customresourcedefinitions.apiextensions.k8s.io'], limited: { rule: 'narrowed' } },
  '/gpu/dashboard': { type: 'summary', reads: ['nodes', 'pods'], limited: GPU_CLOSED },
  '/gpu/nodes': { type: 'summary', reads: ['nodes'], limited: GPU_CLOSED },
  // the pods of its namespaces that ask for GPUs (self has none), without the cluster's GPU metrics
  '/gpu/pods': { type: 'summary', reads: ['nodes', 'pods'], limited: { rule: 'narrowed' } },
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
  // it finds the kinds in the CRD list, which no namespace holds
  '/custom-resources/instances': { type: 'summary', reads: ['customresourcedefinitions.apiextensions.k8s.io'], crRows: true, forbiddenId: 'cr-instances-forbidden', limited: { rule: 'narrowed', beyond: [{ resource: 'customresourcedefinitions.apiextensions.k8s.io', named: 'custom resources' }] } },
  '/custom-resources/groups': list('customresourcedefinitions.apiextensions.k8s.io', 'CustomResourceDefinition', false, 'crdPage.create'),
  '/admin/clusters': { type: 'admin' },
  '/admin/users': { type: 'admin', probe: '/api/v1/auth/admin/users?limit=1' },
  '/admin/roles': { type: 'admin' },
  '/admin/access-requests': { type: 'admin' },
  '/admin/access-review': { type: 'admin' },
  '/cluster/hygiene': {
    type: 'admin', wholeCluster: true, probe: `/api/v1/cluster/hygiene/history?cluster=${CLUSTER}`,
    globalOnly: [
      { key: 'admin.hygiene.export', testId: 'hygiene-export-csv', probe: { method: 'GET', path: `/api/v1/cluster/hygiene?cluster=${CLUSTER}&format=csv` } },
      { key: 'admin.hygiene.signoff', testId: 'hygiene-signoff', probe: { method: 'POST', path: `/api/v1/cluster/hygiene/signoff?cluster=${CLUSTER}` } },
    ],
  },
  '/admin/organizations': { type: 'admin' },
  '/admin/ai-models': { type: 'admin' },
  '/admin/audit': { type: 'admin', probe: '/api/v1/auth/admin/audit-logs?limit=1' },
  '/admin/session-recordings': { type: 'admin' },
  '/admin/ai-usage': { type: 'admin' },
  '/admin/investigations': { type: 'admin' },
  '/account': { type: 'account' },
}

// What the four users compare on each cluster. On test2 only what self does not serve: its other screens are self's.
const TEST2_SCREENS: Record<string, Screen> = Object.fromEntries(
  ['/gateway/gateways', '/gateway/gatewayclasses', '/gateway/httproutes', '/gateway/grpcroutes', '/gateway/referencegrants', '/gateway/backendtlspolicies', '/workloads/vpas']
    .map((p) => [p, SCREENS[p]]),
)
type Target = { cluster: string; screens: Record<string, Screen>; drawers: Record<string, DrawerRow>; minCells: number; title: string; attachment: string; prepare: () => Promise<string>; cleanUp: () => void }
const TARGETS: Target[] = [
  {
    cluster: CLUSTER, screens: SCREENS, drawers: DRAWERS, minCells: 150, title: 'permission matrix — what each role is shown is what the cluster allows it', attachment: 'permission-matrix',
    prepare: async () => {
      const why = openCluster()
      if (why === '') ({ node, served } = await applyFixtures())
      return why
    },
    cleanUp: () => removeFixtures(node),
  },
  {
    cluster: TEST2, screens: TEST2_SCREENS, drawers: TEST2_DRAWERS, minCells: 40, title: 'permission matrix on test2 — the Gateway API and VPA screens and drawers', attachment: 'permission-matrix-test2',
    prepare: async () => {
      const why = openCluster(TEST2)
      if (why !== '') return `needs the kind cluster test2: ${why}`
      ;({ node, served } = applyTest2Fixtures())
      const missing = Object.values(TEST2_DRAWERS).flatMap((d) => ('skip' in d || served.has(d.resource) ? [] : [d.resource]))
      return missing.length ? `test2 does not serve ${missing.join(', ')}` : ''
    },
    cleanUp: () => removeTest2Fixtures(),
  },
]
let on: Target = TARGETS[0]

// in one namespace, across all of them (allNamespaces) or, for a cluster-scoped kind, all
const countOf = (resource: string, namespace: string | null, allNamespaces = false) =>
  kubectl(['get', resource, ...(namespace ? ['-n', namespace] : allNamespaces ? ['-A'] : []), '-o', 'name']).split('\n').filter(Boolean).length
// every CRD as the custom resource instances screen names it: the Kind, with its group where another CRD has that Kind
function crdKinds(): { resource: string; label: string }[] {
  const crds = kubectl(['get', 'crd', '-o', 'jsonpath={range .items[*]}{.spec.names.kind}{"\\t"}{.spec.group}{"\\t"}{.spec.names.plural}{"\\n"}{end}'])
    .split('\n').filter(Boolean).map((l) => { const [kind, group, plural] = l.split('\t'); return { kind, group, plural } })
  return crds.map((c) => ({
    resource: `${c.plural}.${c.group}`,
    label: crds.some((o) => o.kind === c.kind && o.group !== c.group) ? `${c.kind} (${c.group})` : c.kind,
  }))
}

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

// The sidebar's entries once it stopped changing (the admin items wait for their settings), and the account link
// under it, which the layout draws for everyone once it has drawn the sidebar
async function sidebar(page: Page, t: Tracker): Promise<{ hrefs: string[]; account: boolean }> {
  await page.goto(`/account?cluster=${on.cluster}`)
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
  `${p}${p.includes('?') ? '&' : '?'}cluster=${on.cluster}${namespace ? `&namespace=${namespace}` : ''}${extra}`

// Shared by the four users: the objects, the served kinds, the node, and what the global admin's sidebar holds on
// the cluster (an entry the installation turned off is not on anyone's).
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
  expect(NOT_SERVED_ON_SELF.sort(), 'the drawer kinds self does not serve are compared on test2').toEqual(Object.keys(TEST2_DRAWERS).sort())
  expect(Object.entries(TEST2_SCREENS).filter(([, s]) => s?.type !== 'list').map(([p]) => p), 'test2\'s screens are list screens of the table').toEqual([])
  const missing: string[] = []
  for (const s of Object.values(SCREENS)) {
    if (s.type !== 'list' || !s.create) continue
    try { tr(s.create) } catch { missing.push(s.create) }
  }
  expect(missing, 'create button keys the en catalog does not have').toEqual([])
})

for (const target of TARGETS) {
  test.describe(target.title, () => {
    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000)
      on = target
      ready = await target.prepare()
      if (ready !== '') return

      const ctx = await browser.newContext({ baseURL: BASE, storageState: path.join(__dirname, '..', '.auth', 'user.json') })
      try {
        const registered = await ctx.request.get(`/api/v1/cluster/namespaces?cluster=${target.cluster}`, { failOnStatusCode: false })
        if (!registered.ok()) {
          ready = `the cluster ${target.cluster} does not answer (${registered.status()}): scripts/add-kind-cluster.sh ${target.cluster}`
          return
        }
        const page = await ctx.newPage()
        adminMenu = new Set((await sidebar(page, track(page))).hrefs)
      } finally {
        await ctx.close()
      }
    })

    test.afterAll(() => target.cleanUp())

    for (const role of ROLES) {
      test(`${role.key} (${role.grant}${role.scoped ? ' limited to one namespace' : ''}): every screen and drawer as the cluster answers`, async ({ browser, request }) => {
        test.skip(ready !== '', ready)
        test.setTimeout(1_500_000)
        const cells: Cell[] = []
        try {
          await walk(browser, request, role, cells)
        } finally {
          await test.info().attach(`${target.attachment}-${role.key}.json`, { body: JSON.stringify(cells, null, 2), contentType: 'application/json' })
        }
        const differing = cells.filter((c) => c.cluster !== null && c.kubeast !== c.cluster)
        for (const c of differing) {
          expect.soft(c.kubeast, `${role.key} ${c.screen}${c.view ? ` [${c.view}]` : ''} ${c.check} — ${c.basis}`).toBe(c.cluster)
        }
        // every row of the table was compared: a step that stopped running fails here, not by passing
        const visited = (check: string, view?: string) => new Set(cells.filter((c) => c.check === check && (view === undefined || c.view === view)).map((c) => c.screen))
        const lists = Object.entries(target.screens).filter(([, s]) => s.type === 'list')
        expect.soft(lists.map(([p]) => p).filter((p) => !visited('list').has(p)), 'list screens with no list cell').toEqual([])
        expect.soft(Object.keys(target.screens).filter((p) => !visited('menu').has(p)), 'screens with no menu cell').toEqual([])
        if (role.scoped) {
          const others = lists.filter(([, s]) => s.type === 'list' && s.namespaced && served.has(s.resource)).map(([p]) => p)
          expect.soft(others.filter((p) => !visited('list', 'other namespace').has(p)), 'namespaced screens not opened on the other namespace').toEqual([])
        }
        const drawers = Object.entries(target.drawers).filter(([, d]) => !('skip' in d)).map(([k]) => `drawer ${k}`)
        expect.soft(drawers.filter((k) => !visited('get').has(k)), 'drawer kinds with no get cell').toEqual([])
        expect(cells.length, 'cells compared').toBeGreaterThan(target.minCells)
      })
    }
  })
}

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
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${on.cluster}`, { headers: bearer(admin), data: { role: role.grant, ...(role.scoped ? { namespaces: [NS_A] } : {}) } })
    expect(grant.status(), await grant.text()).toBe(200)

    // The identity: Kubeast says on every cluster answer whom it acted as (X-Kubeast-Access).
    const token = await login(request, email, PW)
    const answer = await request.get(`/api/v1/cluster/namespaces?cluster=${on.cluster}`, { headers: bearer(token), failOnStatusCode: false })
    const header = answer.headers()['x-kubeast-access']
    expect(header, 'X-Kubeast-Access on a cluster answer').toBeTruthy()
    const access = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { user?: string; groups?: string[]; role?: string; namespaces?: string[]; impersonation?: boolean }
    test.skip(access.impersonation !== true, 'impersonation is off: Kubeast acts as its own service account, there is no per-user identity to ask about')
    expect(access.role, `the role Kubeast acts with on ${on.cluster}`).toBe(role.grant)
    expect(access.namespaces ?? [], 'the namespaces the grant is limited to').toEqual(role.scoped ? [NS_A] : [])
    const who: Who = { user: access.user ?? '', groups: access.groups ?? [] }
    add({ screen: 'identity', view: '', check: 'X-Kubeast-Access', kubeast: JSON.stringify(access), cluster: null, basis: 'what kubectl is asked as' })
    // ...and the cluster gives the same answers to Kubeast (SelfSubjectAccessReview as the user) as to kubectl --as.
    const probes: [string, string, string, string | null][] = [
      ['list', '', 'secrets', null], ['list', '', 'nodes', null], ['create', 'apps', 'deployments', NS_A],
      ['list', '', 'pods', NS_A], ['list', '', 'pods', NS_B], ['delete', RBAC, 'clusterroles', null],
    ]
    for (const [verb, group, resource, namespace] of probes) {
      const q = new URLSearchParams({ verb, group, resource, namespace: namespace ?? '', cluster: on.cluster })
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
    // Every other namespace the cluster has, as a whole word. `default` and `kubeast` are words of the console itself
    // (the product, a cluster's name, a setting), so they say nothing.
    const otherNamespaces = role.scoped
      ? kubectl(['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}']).split(/\s+/).filter((n) => n && n !== NS_A && n !== 'default' && n !== 'kubeast')
      : []
    const leak = async (screen: string, view: string) => {
      if (!role.scoped) return
      const text = await page.locator('body').innerText()
      const seen = otherNamespaces.filter((n) => new RegExp(`(^|[^a-z0-9-])${escape(n)}($|[^a-z0-9-])`).test(text))
      add({ screen, view, check: 'other namespace on screen', kubeast: seen.length ? `shows ${seen.join(', ')}` : 'none', cluster: 'none', basis: `the grant is ${NS_A} only` })
    }
    // the namespaces a namespace-limited user may get, as the namespace list should hold them
    const grantNamespaces = role.scoped ? [NS_A].filter((n) => canI(who, 'get', 'namespaces', n, n).ok) : []

    // an admin page's keys: admin.* from the global role only (pkg/auth HasPermission); a whole-cluster page's own key
    // not on a grant limited to namespaces
    const adminAllowed = (p: string, s: AdminScreen) => (ADMIN_KEYS[p] ?? []).some((k) => (k.startsWith('admin.') ? hasGlobal(k) : hasCluster(k) && !(s.wholeCluster && role.scoped)))

    for (const [p, s] of Object.entries(on.screens)) {
      // the menu: shown when the installation has the entry on (the global admin's sidebar) and the role may open it
      if (s.type === 'account') {
        add({ screen: p, view: '', check: 'menu', kubeast: drawn.account ? 'shown' : 'hidden', cluster: 'shown', basis: 'every signed-in user has an account page (read with the sidebar, once drawn)' })
      } else {
        const group = GROUPS.find((g) => g.hrefs.includes(p))
        let want = adminMenu.has(p)
        let basis = want ? 'on for this installation (global admin sidebar)' : 'off for this installation (not on the global admin sidebar)'
        // an admin-type entry has keys of its own, in whichever group it is listed
        if (want && group?.menu && s.type !== 'admin') {
          want = hasCluster(group.menu)
          basis += ` · role ${role.grant} ${want ? 'holds' : 'lacks'} ${group.menu}`
        }
        if (want && s.type === 'admin') {
          const keys = ADMIN_KEYS[p] ?? []
          want = adminAllowed(p, s)
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
          const roleShown = ids.includes(on.cluster) ? (await page.getByTestId(`account-cluster-${on.cluster}`).locator('.text-xs').first().innerText()).trim().split(/\s/)[0] : ''
          add({ screen: p, view: '', check: 'cluster access', kubeast: `${ids.join(',')} ${roleShown}`, cluster: `${on.cluster} ${role.grant}`, basis: 'the grant made for this user' })
          // the Node Shell settings are this browser's own, for whoever may open a node shell
          const nodeShell = hasCluster('resource.node.shell')
          add({ screen: p, view: '', check: 'Node Shell settings', kubeast: (await page.getByTestId('account-node-shell').count()) > 0 ? 'shown' : 'hidden', cluster: nodeShell ? 'shown' : 'hidden', basis: `Kubeast role table: ${role.grant} ${nodeShell ? 'holds' : 'lacks'} resource.node.shell` })
          await leak(p, '')
        })
      }
    }

    for (const [kind, d] of Object.entries(on.drawers)) {
      if ('skip' in d) {
        add({ screen: `drawer ${kind}`, view: '', check: 'drawer', kubeast: '-', cluster: null, basis: `not compared: ${d.skip}` })
        continue
      }
      for (const target of drawerTargets(kind, d, role, node)) await step(`drawer ${kind}`, target.view, () => compareDrawer(kind, d, target))
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
        // the screen's rule for a grant limited to namespaces, each list it reads beyond them asked of the cluster
        const rule = s.limited
        const beyond = rule.rule === 'narrowed' ? (rule.beyond ?? []).map((b) => ({ ...b, c: canI(who, 'list', b.resource, null) })) : []
        const wantNamed = rule.rule === 'closed' ? rule.named : beyond.filter((b) => !b.c.ok).map((b) => b.named)
        const want = rule.rule === 'closed' || wantNamed.length ? 'forbidden' : 'allowed'
        const basis = rule.rule === 'closed' ? `closed to a limited grant: ${rule.why}` : `narrowed to ${NS_A}${beyond.length ? `; ${beyond.map((b) => b.c.basis).join('; ')}` : ''}`
        add({ screen: p, view: '', check: 'notice', kubeast, cluster: want, basis, detail })
        const may = rule.may ?? []
        const named = bannerKinds(detail.banner).filter((k) => !may.includes(k)).sort()
        add({ screen: p, view: '', check: 'what the notice names', kubeast: named.join(', ') || 'none', cluster: [...wantNamed].sort().join(', ') || 'none', basis, detail })
        if (rule.rule === 'narrowed' && rule.shows) {
          const onPage = async () => (await main.innerText()).includes(rule.shows!)
          let shown = await expect.poll(onPage, { timeout: 15_000 }).toBe(true).then(() => true, () => false)
          // a paged screen (Change History) can hold the fixture's row on a later page: turn its footer's pages until it shows
          const next = main.locator('[data-testid$="pager"]').first().getByRole('button', { name: /^(Next|다음)$/ })
          for (let i = 0; !shown && i < 50 && (await next.count()) > 0 && !(await next.isDisabled()); i++) {
            const before = await main.innerText()
            await next.click()
            await expect.poll(() => main.innerText(), { timeout: 15_000 }).not.toBe(before)
            shown = await onPage()
          }
          add({ screen: p, view: '', check: `shows "${rule.shows}"`, kubeast: shown ? 'shown' : 'not shown', cluster: 'shown', basis: `an object of ${NS_A}, which the grant reaches` })
        }
      } else {
        const crds = s.crRows ? crdKinds() : []
        const reads = [...s.reads, ...crds.map((c) => c.resource)]
        const denied = reads.map((r) => canI(who, 'list', r, null)).filter((c) => !c.ok)
        add({ screen: p, view: '', check: 'notice', kubeast, cluster: denied.length ? 'forbidden' : 'allowed', basis: reads.length ? reads.map((r) => canI(who, 'list', r, null).basis).join('; ') : 'reads nothing on opening', detail })
        if (s.crRows) {
          const said = own > 0 ? (await page.getByTestId(s.forbiddenId!).allInnerTexts()).join('\n') : ''
          const named = (said.match(FORBIDDEN_EMPTY)?.[1] ?? '').split(', ').filter(Boolean).sort()
          const refused = crds.filter((c) => !canI(who, 'list', c.resource, null).ok).map((c) => c.label).sort()
          add({ screen: p, view: '', check: 'kinds the notice names', kubeast: named.join(', ') || 'none', cluster: refused.join(', ') || 'none', basis: crds.map((c) => canI(who, 'list', c.resource, null).basis).join('; '), detail: { said } })
        }
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
      // Monitoring's second tab lists pods: a limited grant's own
      if (p === '/monitoring' && role.scoped) {
        await page.getByRole('button', { name: tr('monitoring.tabs.pods'), exact: true }).click()
        await quiet(page, t, 600)
        await leak(p, 'Pods tab')
      }
    }

    async function compareAdmin(p: string, s: AdminScreen) {
      const keys = ADMIN_KEYS[p] ?? []
      const allowed = adminAllowed(p, s)
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
        // what its all-cluster keys add, for whoever opens it
        for (const g of s.globalOnly ?? []) {
          if (!allowed) continue
          const held = hasGlobal(g.key)
          add({ screen: p, view: '', check: g.testId, kubeast: (await page.getByTestId(g.testId).count()) > 0 ? 'shown' : 'hidden', cluster: held ? 'shown' : 'hidden', basis: `${g.key}: ${held ? 'held' : 'not held'} in the global role` })
        }
      }
      if (s.probe) {
        const res = await request.get(s.probe, { headers: bearer(token), failOnStatusCode: false })
        add({ screen: p, view: '', check: 'its API', kubeast: res.status() === 200 ? 'answers' : res.status() === 403 ? 'refuses' : `HTTP ${res.status()}`, cluster: allowed ? 'answers' : 'refuses', basis: `${s.probe} · ${basis}` })
      }
      for (const g of s.globalOnly ?? []) {
        // none of the four users holds an all-cluster key, so the call is refused before it does anything
        if (hasGlobal(g.key)) continue
        const res = await request.fetch(g.probe.path, { method: g.probe.method, headers: bearer(token), data: g.probe.method === 'POST' ? {} : undefined, failOnStatusCode: false })
        add({ screen: p, view: '', check: `${g.key} API`, kubeast: res.status() === 403 ? 'refuses' : `HTTP ${res.status()}`, cluster: 'refuses', basis: `${g.probe.path} · ${g.key} is an all-cluster key` })
      }
    }

    async function compareDrawer(kind: string, d: Exclude<DrawerRow, { skip: string }>, target: DrawerTarget) {
      const statuses: number[] = []
      const onResponse = (r: Response) => { if (target.primary(new URL(r.url()))) statuses.push(r.status()) }
      page.on('response', onResponse)
      const screen = `drawer ${kind}`
      try {
        await page.goto(`/account?cluster=${on.cluster}&detail=${encodeURIComponent(target.ref)}${target.api ? `&detailApi=${encodeURIComponent(target.api)}` : ''}`)
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

