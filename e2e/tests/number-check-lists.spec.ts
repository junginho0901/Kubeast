import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Every list screen's numbers are the cluster's: in namespace e2e-numbers of `self`, or of test2 for the Gateway API and VPA
// (objects whose numbers are not zero and not alike, made here and removed after), each screen's rows are the cluster's objects, each column the
// API server also prints (the Table of `kubectl get`, Accept as=Table) holds the same value, the columns only Kubeast
// prints hold what the objects say, and the summary cards count what their labels mean. All values of a screen are
// compared before it fails (expect.soft), so one run lists every difference.

const NS = 'e2e-numbers'

// A registered cluster's kind cluster: kubectl, and the API server's Table — what `kubectl get` prints — through the
// kubeconfig's client certificate.
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string } } }[] }
type Kube = { kubectl: (args: string, input?: string) => string; apiTable: (apiPath: string) => Promise<Table> }
function kube(kindName: string): Kube {
  const kc = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-check-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
  const server = new URL(pick('server'))
  return {
    kubectl: (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim(),
    apiTable: (apiPath) => new Promise((resolve, reject) => {
      https.request({
        host: server.hostname, port: server.port, path: apiPath, method: 'GET',
        ca: Buffer.from(pick('certificate-authority-data'), 'base64'),
        cert: Buffer.from(pick('client-certificate-data'), 'base64'),
        key: Buffer.from(pick('client-key-data'), 'base64'),
        headers: { Accept: 'application/json;as=Table;g=meta.k8s.io;v=v1' },
      }, (r) => {
        let s = ''
        r.on('data', (c) => (s += c))
        r.on('end', () => (r.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))))
      }).on('error', reject).end()
    }),
  }
}
// the registered clusters the screens are read on, by kind cluster: self, test2, the one serving the Gateway API, and
// default, the second cluster, whose Kyverno serves PolicyReports
const KIND: Record<string, string> = { self: 'kubeast', test2: 'test2', default: 'kubeast-b' }
const kubes: Record<string, Kube> = {}
const on = (cluster = 'self') => (kubes[cluster] ??= kube(KIND[cluster]))
const { kubectl } = on()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const items = (plural: string, clusterScoped = false, allNamespaces = false, cluster = 'self'): Obj[] =>
  JSON.parse(on(cluster).kubectl(`get ${plural} ${allNamespaces ? '-A ' : clusterScoped ? '' : `-n ${NS} `}-o json`)).items
const cond = (o: Obj, type: string) => (o.status?.conditions ?? []).find((c: Obj) => c.type === type)?.status

const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.fixture.yaml'), 'utf8')
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

// a screen value and the cluster's are the same when they say the same thing in Kubeast's words: an empty value
// is "-", booleans are Yes/No, access modes are spelled out, RESTARTS without kubectl's "(… ago)"
const EMPTY = new Set(['', '-', '<none>', 'none', 'n/a', '<unset>'])
const MODES: Record<string, string> = { rwo: 'readwriteonce', rox: 'readonlymany', rwx: 'readwritemany', rwop: 'readwriteoncepod' }
function sameValue(screen: string, cluster: string): boolean {
  const a = screen.trim().toLowerCase()
  const b = cluster.trim().toLowerCase()
  if (EMPTY.has(a) && EMPTY.has(b)) return true
  if ((a === 'yes' && b === 'true') || (a === 'no' && b === 'false')) return true
  const modes = (s: string) => s.split(/[\s,]+/).filter(Boolean).map((m) => MODES[m] ?? m).sort().join(',')
  if (modes(a) === modes(b)) return true
  return a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ')
}
const norm = (h: string) => h.toLowerCase().replace(/[\s_()-]/g, '')
// a span that grows while it is read ("16s" then "17s"): kubectl's HumanDuration in seconds, the same within 15 s or 15 %
function spanSeconds(s: string): number {
  const units: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0
  for (const m of s.matchAll(/(\d+)([ydhms])/g)) total += Number(m[1]) * units[m[2]]
  return /\d/.test(s) ? total : NaN
}
const sameSpan = (screen: string, cluster: string) =>
  Math.abs(spanSeconds(screen) - spanSeconds(cluster)) <= Math.max(15, spanSeconds(cluster) * 0.15)

type Screen = {
  path: string
  api: string
  plural: string
  // the registered cluster the screen is read on (self when not set)
  cluster?: string
  // what to do on the screen after opening it (pick a kind)
  prepare?: (page: Page) => Promise<void>
  // a cluster-scoped kind: the screen is opened without a namespace and holds every object of the kind
  clusterScoped?: boolean
  // a namespaced kind listed over every namespace (rows told apart by namespace/name)
  allNamespaces?: boolean
  // screen header → Table column, where the names differ
  alias?: Record<string, string>
  // how a screen column differs from kubectl's on purpose: the cluster value is turned into Kubeast's first
  shape?: Record<string, (cluster: string, o: Obj) => string>
  // columns kubectl does not print: what the object says
  extra?: Record<string, (o: Obj) => string>
  // not compared, with why
  skip?: Record<string, string>
  // columns whose value is a span still growing for this object (a Job not complete): compared within sameSpan
  spans?: Record<string, (o: Obj) => boolean>
  // summary card label → the count that label means, over the namespace's objects
  cards?: (list: Obj[]) => Record<string, number>
}

// Healthy = all wanted replicas ready, Unavailable = none available, Degraded = the rest that want replicas, Idle =
// none wanted (the Deployments page has no Idle card)
const replicaCards = (desired: (o: Obj) => number, ready: (o: Obj) => number, available: (o: Obj) => number, idle = true) => (list: Obj[]) => ({
  Total: list.length,
  Healthy: list.filter((o) => desired(o) > 0 && ready(o) === desired(o)).length,
  ...(idle ? { Idle: list.filter((o) => desired(o) === 0).length } : {}),
  Degraded: list.filter((o) => desired(o) > 0 && available(o) > 0 && ready(o) < desired(o)).length,
  Unavailable: list.filter((o) => desired(o) > 0 && available(o) === 0).length,
})
const n = (v: unknown) => Number(v ?? 0)
const AGE = 'nice-to-have: dates-pages.spec.ts compares the Pods age with kubectl; the format is formatAge everywhere'

const SCREENS: Screen[] = [
  {
    path: '/workloads/pods', api: `/api/v1/namespaces/${NS}/pods`, plural: 'pods',
    alias: { 'Pod IP': 'IP' },
    shape: { Restarts: (v) => v.replace(/\s*\(.*\)$/, '') },
    skip: { Age: AGE },
    cards: (list) => {
      const running = list.filter((p) => p.status.phase === 'Running')
      const allReady = (p: Obj) => (p.status.containerStatuses ?? []).length > 0 && (p.status.containerStatuses ?? []).every((c: Obj) => c.ready)
      const restarts = (p: Obj) => [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].reduce((s: number, c: Obj) => s + n(c.restartCount), 0)
      const reasonError = (p: Obj) => [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].some((c: Obj) =>
        /error|failed|backoff|errimagepull|oomkilled/i.test(c.state?.waiting?.reason ?? c.state?.terminated?.reason ?? ''))
      return {
        Total: list.length,
        Ready: running.filter(allReady).length,
        'Not Ready': running.filter((p) => !allReady(p)).length,
        Pending: list.filter((p) => p.status.phase === 'Pending').length,
        Error: list.filter((p) => p.status.phase === 'Failed' || reasonError(p)).length,
        Restarted: list.filter((p) => restarts(p) > 0).length,
        Completed: list.filter((p) => p.status.phase === 'Succeeded').length,
      }
    },
  },
  {
    path: '/workloads/deployments', api: `/apis/apps/v1/namespaces/${NS}/deployments`, plural: 'deployments',
    alias: { Image: 'Images' },
    skip: { Status: 'the cards below check what the status buckets mean', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas), false),
  },
  {
    path: '/workloads/statefulsets', api: `/apis/apps/v1/namespaces/${NS}/statefulsets`, plural: 'statefulsets',
    extra: {
      'Up to date': (o) => `${n(o.status.updatedReplicas ?? o.status.currentReplicas)}/${n(o.spec.replicas)}`,
      Available: (o) => String(n(o.status.availableReplicas)),
      Service: (o) => o.spec.serviceName ?? '-',
    },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas)),
  },
  {
    path: '/workloads/daemonsets', api: `/apis/apps/v1/namespaces/${NS}/daemonsets`, plural: 'daemonsets',
    // kubectl prints READY as the ready count; Kubeast as ready/desired
    shape: { Ready: (v, o) => `${v}/${n(o.status.desiredNumberScheduled)}` },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.status.desiredNumberScheduled), (o) => n(o.status.numberReady), (o) => n(o.status.numberAvailable)),
  },
  {
    path: '/workloads/replicasets', api: `/apis/apps/v1/namespaces/${NS}/replicasets`, plural: 'replicasets',
    extra: {
      Available: (o) => String(n(o.status.availableReplicas)),
      // the controller: a Deployment by name, another kind as kind/name
      Owner: (o) => {
        const refs: Obj[] = o.metadata.ownerReferences ?? []
        const ref = refs.find((r) => r.controller) ?? refs[0]
        return !ref ? '-' : ref.kind === 'Deployment' ? ref.name : `${ref.kind}/${ref.name}`
      },
    },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas)),
  },
  {
    path: '/workloads/jobs', api: `/apis/batch/v1/namespaces/${NS}/jobs`, plural: 'jobs',
    // num-fail's Duration runs on (start to now, as kubectl's printJob) — to the second while the Job is new
    spans: { Duration: (o) => !o.status.completionTime },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Completed: list.filter((j) => cond(j, 'Complete') === 'True').length,
      Failed: list.filter((j) => cond(j, 'Failed') === 'True').length,
      Running: list.filter((j) => cond(j, 'Complete') !== 'True' && cond(j, 'Failed') !== 'True').length,
    }),
  },
  {
    path: '/workloads/cronjobs', api: `/apis/batch/v1/namespaces/${NS}/cronjobs`, plural: 'cronjobs',
    skip: { 'Next Run': 'a time computed from the schedule; dates-pages.spec.ts compares it', Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Active: list.filter((c) => (c.status.active ?? []).length > 0).length,
      Suspended: list.filter((c) => c.spec.suspend === true).length,
      Scheduled: list.filter((c) => !!c.status.lastScheduleTime).length,
    }),
  },
  {
    path: '/workloads/hpas', api: `/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers`, plural: 'horizontalpodautoscalers',
    alias: { Min: 'MinPods', Max: 'MaxPods' },
    // Kubeast prints current/desired, desired "-" while the HPA has no current metric (HPATable.tsx)
    shape: { Replicas: (v, o) => `${v}/${(o.status.currentMetrics ?? []).some((m: Obj) => m.type) ? n(o.status.desiredReplicas) : '-'}` },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Active: list.filter((h) => cond(h, 'ScalingActive') === 'True').length,
      Inactive: list.filter((h) => cond(h, 'ScalingActive') !== 'True').length,
    }),
  },
  {
    path: '/workloads/pdbs', api: `/apis/policy/v1/namespaces/${NS}/poddisruptionbudgets`, plural: 'poddisruptionbudgets',
    extra: {
      Current: (o) => `${n(o.status.currentHealthy)}/${n(o.status.desiredHealthy)}`,
      Desired: (o) => String(n(o.status.desiredHealthy)),
    },
    skip: { Age: AGE },
    cards: (list) => {
      const healthy = (p: Obj) => n(p.status.disruptionsAllowed) > 0 || n(p.status.currentHealthy) >= n(p.status.desiredHealthy)
      return { Total: list.length, Healthy: list.filter(healthy).length, Disrupted: list.filter((p) => !healthy(p)).length }
    },
  },
  {
    path: '/network/services', api: `/api/v1/namespaces/${NS}/services`, plural: 'services',
    // kubectl prints 80/TCP; Kubeast prints the target port and the node port too
    extra: {
      Ports: (o) => (o.spec.ports ?? []).map((p: Obj) => `${p.protocol ?? 'TCP'} ${p.port}->${p.targetPort ?? p.port}${p.nodePort ? ` (node:${p.nodePort})` : ''}`).join(', '),
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      // by type: a headless Service is of type ClusterIP and is also counted under Headless
      ClusterIP: list.filter((s) => s.spec.type === 'ClusterIP').length,
      Exposed: list.filter((s) => s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer').length,
      Headless: list.filter((s) => s.spec.clusterIP === 'None').length,
    }),
  },
  {
    path: '/network/endpoints', api: `/api/v1/namespaces/${NS}/endpoints`, plural: 'endpoints',
    extra: {
      Ready: (o) => String((o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.addresses ?? []).length, 0)),
      'Not Ready': (o) => String((o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.notReadyAddresses ?? []).length, 0)),
    },
    skip: { Addresses: 'the address list; Ready and Not Ready count it', Ports: 'the port list', Age: AGE },
    cards: (list) => {
      const ready = (o: Obj) => (o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.addresses ?? []).length, 0)
      const notReady = (o: Obj) => (o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.notReadyAddresses ?? []).length, 0)
      return {
        Total: list.length,
        'With Ready': list.filter((o) => ready(o) > 0).length,
        'With NotReady': list.filter((o) => notReady(o) > 0).length,
        'Total Addresses': list.reduce((s, o) => s + ready(o) + notReady(o), 0),
      }
    },
  },
  {
    path: '/network/endpointslices', api: `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices`, plural: 'endpointslices',
    extra: {
      Service: (o) => o.metadata.labels?.['kubernetes.io/service-name'] ?? '-',
      // kubectl prints the port numbers; Kubeast name:port/protocol and the app protocol
      Ports: (o) => (o.ports ?? []).map((p: Obj) => `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}${p.appProtocol ? ` (${p.appProtocol})` : ''}`).join(', ') || '-',
      Total: (o) => String((o.endpoints ?? []).length),
      Ready: (o) => String((o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length),
      'Not Ready': (o) => String((o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready === false).length),
    },
    skip: { Age: AGE },
    cards: (list) => {
      const ready = (o: Obj) => (o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length
      const notReady = (o: Obj) => (o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready === false).length
      return {
        Total: list.length,
        'With Ready': list.filter((o) => ready(o) > 0).length,
        'With Not Ready': list.filter((o) => notReady(o) > 0).length,
        'Total Endpoints': list.reduce((s, o) => s + (o.endpoints ?? []).length, 0),
      }
    },
  },
  {
    path: '/network/ingresses', api: `/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`, plural: 'ingresses',
    extra: { Routes: (o) => (o.spec.rules ?? []).flatMap((r: Obj) => (r.http?.paths ?? []).map((p: Obj) => `${r.host ?? '*'}:${p.path ?? '/'}`)).join(', ') },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'With Class': list.filter((i) => !!i.spec.ingressClassName).length,
      'With TLS': list.filter((i) => (i.spec.tls ?? []).length > 0).length,
      'With Address': list.filter((i) => (i.status.loadBalancer?.ingress ?? []).length > 0).length,
    }),
  },
  {
    path: '/network/networkpolicies', api: `/apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies`, plural: 'networkpolicies',
    extra: {
      'Ingress Rules': (o) => String((o.spec.ingress ?? []).length),
      'Egress Rules': (o) => String((o.spec.egress ?? []).length),
    },
    skip: { Types: 'policy types as text', 'Default Deny': 'checked by the cards', Age: AGE },
    cards: (list) => {
      const types = (p: Obj): string[] => p.spec.policyTypes ?? ['Ingress']
      const all = (p: Obj) => Object.keys(p.spec.podSelector?.matchLabels ?? {}).length === 0 && (p.spec.podSelector?.matchExpressions ?? []).length === 0
      return {
        Total: list.length,
        'Default Deny Ingress': list.filter((p) => types(p).includes('Ingress') && (p.spec.ingress ?? []).length === 0).length,
        'Default Deny Egress': list.filter((p) => types(p).includes('Egress') && (p.spec.egress ?? []).length === 0).length,
        'Selects All Pods': list.filter(all).length,
      }
    },
  },
  {
    path: '/storage?tab=pvcs', api: `/api/v1/namespaces/${NS}/persistentvolumeclaims`, plural: 'persistentvolumeclaims',
    extra: { Requested: (o) => o.spec.resources?.requests?.storage ?? '-' },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Bound: list.filter((p) => p.status.phase === 'Bound').length,
      Pending: list.filter((p) => p.status.phase === 'Pending').length,
      Lost: list.filter((p) => p.status.phase === 'Lost').length,
    }),
  },
  {
    path: '/configuration/configmaps', api: `/api/v1/namespaces/${NS}/configmaps`, plural: 'configmaps',
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'Total Data Keys': list.reduce((s, c) => s + Object.keys(c.data ?? {}).length + Object.keys(c.binaryData ?? {}).length, 0),
    }),
  },
  {
    path: '/configuration/secrets', api: `/api/v1/namespaces/${NS}/secrets`, plural: 'secrets',
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, Opaque: list.filter((s) => s.type === 'Opaque').length }),
  },
  {
    path: '/security/serviceaccounts', api: `/api/v1/namespaces/${NS}/serviceaccounts`, plural: 'serviceaccounts',
    extra: { Secrets: (o) => String((o.secrets ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'With Image Pull Secrets': list.filter((s) => (s.imagePullSecrets ?? []).length > 0).length }),
  },
  {
    path: '/security/roles', api: `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/roles`, plural: 'roles',
    extra: { Rules: (o) => String((o.rules ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Rules': list.reduce((s, r) => s + (r.rules ?? []).length, 0) }),
  },
  {
    path: '/security/rolebindings', api: `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/rolebindings`, plural: 'rolebindings',
    extra: { Subjects: (o) => String((o.subjects ?? []).length) },
    skip: { 'Role Ref': 'kubectl prints Role as Kind/name; the name is compared through the row', Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Subjects': list.reduce((s, r) => s + (r.subjects ?? []).length, 0) }),
  },
  {
    path: '/cluster/resourcequotas', api: `/api/v1/namespaces/${NS}/resourcequotas`, plural: 'resourcequotas',
    extra: { Resources: (o) => String(Object.keys(o.status?.hard ?? o.spec.hard ?? {}).length) },
    skip: { Age: AGE },
    cards: (list) => {
      const keys = (q: Obj) => Object.keys(q.status?.hard ?? q.spec.hard ?? {})
      return {
        Total: list.length,
        'With CPU Quota': list.filter((q) => keys(q).some((k) => k === 'cpu' || k === 'requests.cpu' || k === 'limits.cpu')).length,
        'With Memory Quota': list.filter((q) => keys(q).some((k) => k === 'memory' || k === 'requests.memory' || k === 'limits.memory')).length,
      }
    },
  },
  {
    path: '/cluster/limitranges', api: `/api/v1/namespaces/${NS}/limitranges`, plural: 'limitranges',
    skip: { Types: 'limit types as text', Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'Container Limits': list.filter((l) => (l.spec.limits ?? []).some((x: Obj) => x.type === 'Container')).length,
      'Pod Limits': list.filter((l) => (l.spec.limits ?? []).some((x: Obj) => x.type === 'Pod')).length,
    }),
  },
]

// cluster screens on `self`: every object of the kind, with number-check.cluster-fixture.yaml so none is empty
const CLUSTER_FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.cluster-fixture.yaml'), 'utf8')
// kubectl marks a default class by its name: "standard (default)"
const defaultByName = (v: string) => (v.endsWith(' (default)') ? 'Yes' : 'No')
// storageutil.IsDefaultAnnotation, and kubectl's printStorageClassList: of the annotated classes the newest, at equal
// times the first name, is the default
const scAnnotated = (o: Obj) => ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
  .some((k) => o.metadata.annotations?.[k] === 'true')
const scDefault = (list: Obj[]) => list.filter(scAnnotated).sort((a, b) =>
  Date.parse(b.metadata.creationTimestamp) - Date.parse(a.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name))[0]?.metadata.name
const vaError = (o: Obj) => {
  const attach = o.status?.attachError?.message ?? ''
  const detach = o.status?.detachError?.message ?? ''
  return attach && detach ? `${attach} | ${detach}` : attach || detach
}
// the bindings that name a policy (spec.policyName), as the Bindings column counts them
const bindingsOf = (plural: string) => {
  const list = items(plural, true)
  return (policy: Obj) => list.filter((b) => b.spec?.policyName === policy.metadata.name).length
}
const policyScreen = (plural: string, bindings: string): Omit<Screen, 'path'> => ({
  api: `/apis/admissionregistration.k8s.io/v1/${plural}`, plural, clusterScoped: true,
  extra: {
    Bindings: (o) => String(bindingsOf(bindings)(o)),
    'Failure policy': (o) => o.spec.failurePolicy ?? 'Fail',
  },
  skip: { Age: AGE },
  cards: (list) => {
    const count = bindingsOf(bindings)
    return { 'Total Policies': list.length, 'Total Bindings': list.reduce((s, p) => s + count(p), 0) }
  },
})
const webhookScreen = (plural: string): Omit<Screen, 'path'> => ({
  api: `/apis/admissionregistration.k8s.io/v1/${plural}`, plural, clusterScoped: true,
  skip: { Age: AGE },
  cards: (list) => ({ 'Total Configurations': list.length, 'Total Webhooks': list.reduce((s, c) => s + (c.webhooks ?? []).length, 0) }),
})

const SCREENS_CLUSTER: Screen[] = [
  {
    path: '/cluster/namespaces', api: '/api/v1/namespaces', plural: 'namespaces', clusterScoped: true,
    extra: {
      // the labels but the one every namespace has, two of them and a count of the rest
      Labels: (o) => {
        const labels = Object.entries(o.metadata.labels ?? {}).filter(([k]) => k !== 'kubernetes.io/metadata.name')
        if (labels.length === 0) return '-'
        return [...labels.slice(0, 2).map(([k, v]) => `${k}=${v}`), ...(labels.length > 2 ? [`+${labels.length - 2}`] : [])].join(' ')
      },
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Active: list.filter((o) => o.status.phase === 'Active').length,
      Terminating: list.filter((o) => o.status.phase === 'Terminating').length,
    }),
  },
  {
    path: '/cluster/nodes', api: '/api/v1/nodes', plural: 'nodes', clusterScoped: true,
    // usage comes from metrics.k8s.io, which self does not serve (kind without metrics-server): nothing to show
    extra: { CPU: () => '-', Memory: () => '-' },
    skip: { Age: AGE },
  },
  {
    path: '/storage?tab=pvs', api: '/api/v1/persistentvolumes', plural: 'persistentvolumes', clusterScoped: true,
    // the volume's source by type; one Kubeast does not name shows "-"
    extra: { Source: (o) => (o.spec.csi ? 'CSI' : o.spec.nfs ? 'NFS' : o.spec.local ? 'Local' : o.spec.hostPath ? 'HostPath' : '-') },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      ...Object.fromEntries(['Bound', 'Available', 'Released', 'Failed'].map((p) => [p, list.filter((o) => o.status.phase === p).length])),
    }),
  },
  {
    path: '/storage?tab=storageclasses', api: '/apis/storage.k8s.io/v1/storageclasses', plural: 'storageclasses', clusterScoped: true,
    alias: { Default: 'Name' },
    shape: { Default: defaultByName },
    extra: { Parameters: (o) => String(Object.keys(o.parameters ?? {}).length) },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Default: list.filter((o) => o.metadata.name === scDefault(list)).length,
      Expandable: list.filter((o) => o.allowVolumeExpansion === true).length,
      'Binding mode: WaitForFirstConsumer': list.filter((o) => o.volumeBindingMode === 'WaitForFirstConsumer').length,
    }),
  },
  {
    path: '/storage?tab=volumeattachments', api: '/apis/storage.k8s.io/v1/volumeattachments', plural: 'volumeattachments', clusterScoped: true,
    alias: { 'Persistent Volume': 'PV' },
    // the column is a state badge: an error first, then attached or not
    shape: { Attached: (v, o) => (vaError(o) ? 'Error' : v === 'true' ? 'Attached' : 'Detached') },
    extra: { Error: (o) => vaError(o) || '-' },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Attached: list.filter((o) => o.status?.attached === true).length,
      Detached: list.filter((o) => o.status?.attached !== true).length,
      Errors: list.filter((o) => vaError(o) !== '').length,
    }),
  },
  {
    path: '/network/ingressclasses', api: '/apis/networking.k8s.io/v1/ingressclasses', plural: 'ingressclasses', clusterScoped: true,
    alias: { Default: 'Name' },
    // Kubeast adds the parameters' scope and namespace to kubectl's Kind.group/name
    shape: {
      Default: defaultByName,
      Parameters: (v, o) => {
        const p = o.spec.parameters
        return p ? `${v}${p.scope ? ` (${p.scope})` : ''}${p.namespace ? ` ns=${p.namespace}` : ''}` : v
      },
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Default: list.filter((o) => o.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true').length,
      'With Parameters': list.filter((o) => o.spec.parameters).length,
      'With Annotations': list.filter((o) => Object.keys(o.metadata.annotations ?? {}).length > 0).length,
    }),
  },
  {
    path: '/cluster/priorityclasses', api: '/apis/scheduling.k8s.io/v1/priorityclasses', plural: 'priorityclasses', clusterScoped: true,
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'Global Default': list.filter((o) => o.globalDefault === true).length,
      Preempting: list.filter((o) => (o.preemptionPolicy ?? 'PreemptLowerPriority') === 'PreemptLowerPriority').length,
    }),
  },
  {
    path: '/cluster/runtimeclasses', api: '/apis/node.k8s.io/v1/runtimeclasses', plural: 'runtimeclasses', clusterScoped: true,
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'Unique Handlers': new Set(list.map((o) => o.handler)).size }),
  },
  {
    path: '/security/clusterroles', api: '/apis/rbac.authorization.k8s.io/v1/clusterroles', plural: 'clusterroles', clusterScoped: true,
    extra: { Rules: (o) => String((o.rules ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Rules': list.reduce((s, r) => s + (r.rules ?? []).length, 0) }),
  },
  {
    path: '/security/clusterrolebindings', api: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', plural: 'clusterrolebindings', clusterScoped: true,
    alias: { 'Role Ref': 'Role' },
    extra: { Subjects: (o) => String((o.subjects ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Subjects': list.reduce((s, r) => s + (r.subjects ?? []).length, 0) }),
  },
  {
    path: '/cluster/leases', api: '/apis/coordination.k8s.io/v1/leases', plural: 'leases', allNamespaces: true,
    extra: { 'Duration (s)': (o) => (o.spec.leaseDurationSeconds === undefined ? '-' : String(o.spec.leaseDurationSeconds)) },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'With Holder': list.filter((o) => o.spec.holderIdentity).length,
      'Without Holder': list.filter((o) => !o.spec.holderIdentity).length,
    }),
  },
  { path: '/cluster/mutatingwebhookconfigurations', ...webhookScreen('mutatingwebhookconfigurations') },
  { path: '/cluster/validatingwebhookconfigurations', ...webhookScreen('validatingwebhookconfigurations') },
  { path: '/cluster/validatingadmissionpolicies', ...policyScreen('validatingadmissionpolicies', 'validatingadmissionpolicybindings') },
  { path: '/cluster/mutatingadmissionpolicies', ...policyScreen('mutatingadmissionpolicies', 'mutatingadmissionpolicybindings') },
  {
    path: '/custom-resources/groups', api: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions', plural: 'customresourcedefinitions', clusterScoped: true,
    // kubectl lists the served versions as "v1(storage),v1beta1"; Kubeast spaces them
    shape: { Versions: (v) => v.split(',').filter(Boolean).map((x) => x.replace('(storage)', ' (storage)')).join(', ') },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Namespaced: list.filter((o) => o.spec.scope === 'Namespaced').length,
      'Cluster-scoped': list.filter((o) => o.spec.scope !== 'Namespaced').length,
    }),
  },
]

// Gateway API screens on test2, with number-check.gateway-fixture.yaml: the CRDs print few columns (Hostnames, a
// GatewayClass's Controller, a Gateway's Class), so most are compared with what the objects say
const GATEWAY_FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.gateway-fixture.yaml'), 'utf8')
const GW = 'gateway.networking.k8s.io'
// the versions test2 serves the kinds at (they move between Gateway API releases), or null without them
function gatewayVersions(): Record<string, string> | null {
  try {
    const served = Object.fromEntries(on('test2').kubectl(`api-resources --api-group=${GW} --no-headers`).split('\n')
      .map((line) => line.trim().split(/\s+/))
      .map((cols) => [cols[0], cols.find((c) => c.startsWith(`${GW}/`))?.split('/')[1] ?? '']))
    const kinds = ['gatewayclasses', 'gateways', 'httproutes', 'grpcroutes', 'referencegrants', 'backendtlspolicies']
    return kinds.every((k) => served[k]) ? served : null
  } catch {
    return null
  }
}
// a condition list summed up as the list pages show it: the named conditions that hold first, then the first that
// holds, then the first that does not as "<type>(False)", else Unknown
const summary = (conds: Obj[] = [], ...first: string[]) => {
  const named = first.find((t) => conds.some((c) => c.type === t && c.status === 'True'))
  const yes = conds.find((c) => c.status === 'True')
  const no = conds.find((c) => c.status === 'False')
  return named ?? yes?.type ?? (no ? `${no.type}(False)` : 'Unknown')
}
// a route's conditions over every parent it reports on
const routeConds = (o: Obj): Obj[] => (o.status?.parents ?? []).flatMap((p: Obj) => p.conditions ?? [])
const routeHolds = (o: Obj, type: string) => routeConds(o).some((c) => c.type === type && c.status === 'True')
// a policy's conditions: the first ancestor that reports any
const policyConds = (o: Obj): Obj[] => (o.status?.ancestors ?? []).find((a: Obj) => (a.conditions ?? []).length)?.conditions ?? []
const routeScreen = (plural: string): Omit<Screen, 'path'> => ({
  api: `/apis/${GW}/v1/namespaces/${NS}/${plural}`, plural, cluster: 'test2',
  // kubectl prints the hostnames as JSON; Kubeast lists them, and a route with none matches every host
  shape: { Hostnames: (v) => (v ? (JSON.parse(v) as string[]).join(', ') : '*') },
  extra: {
    'Parent Refs': (o) => String((o.spec.parentRefs ?? []).length),
    Rules: (o) => String((o.spec.rules ?? []).length),
    'Backend Refs': (o) => String((o.spec.rules ?? []).reduce((s: number, r: Obj) => s + (r.backendRefs ?? []).length, 0)),
    Status: (o) => summary(routeConds(o), 'Accepted', 'ResolvedRefs'),
  },
  skip: { Age: AGE },
  cards: (list) => ({
    Total: list.length,
    Accepted: list.filter((o) => routeHolds(o, 'Accepted')).length,
    ResolvedRefs: list.filter((o) => routeHolds(o, 'ResolvedRefs')).length,
    'With Hostnames': list.filter((o) => (o.spec.hostnames ?? []).length > 0).length,
  }),
})
const gatewayScreens = (served: Record<string, string>): Screen[] => [
  {
    path: '/gateway/gatewayclasses', api: `/apis/${GW}/v1/gatewayclasses`, plural: 'gatewayclasses', clusterScoped: true, cluster: 'test2',
    extra: {
      Conditions: (o) => summary(o.status?.conditions, 'Accepted'),
      // Kind.group/name (ns: …), as Kubeast writes a reference
      'Parameters Ref': (o) => {
        const p = o.spec.parametersRef
        return p ? `${p.kind || '-'}${p.group ? `.${p.group}` : ''}${p.name ? `/${p.name}` : ''}${p.namespace ? ` (ns: ${p.namespace})` : ''}` : '-'
      },
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Accepted: list.filter((o) => cond(o, 'Accepted') === 'True').length,
      'With Parameters': list.filter((o) => o.spec.parametersRef).length,
      'With Annotations': list.filter((o) => Object.keys(o.metadata.annotations ?? {}).length > 0).length,
    }),
  },
  {
    path: '/gateway/gateways', api: `/apis/${GW}/v1/namespaces/${NS}/gateways`, plural: 'gateways', cluster: 'test2',
    alias: { 'Class Name': 'Class' },
    extra: {
      Conditions: (o) => summary(o.status?.conditions, 'Programmed', 'Accepted'),
      Listeners: (o) => String((o.spec.listeners ?? []).length),
      'Attached Routes': (o) => String((o.status?.listeners ?? []).reduce((s: number, l: Obj) => s + (l.attachedRoutes ?? 0), 0)),
      Addresses: (o) => String((o.status?.addresses ?? []).length),
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Programmed: list.filter((o) => cond(o, 'Programmed') === 'True').length,
      Accepted: list.filter((o) => cond(o, 'Accepted') === 'True').length,
      'With Address': list.filter((o) => (o.status?.addresses ?? []).length > 0).length,
    }),
  },
  { path: '/gateway/httproutes', ...routeScreen('httproutes') },
  { path: '/gateway/grpcroutes', ...routeScreen('grpcroutes') },
  {
    path: '/gateway/referencegrants', api: `/apis/${GW}/${served.referencegrants}/namespaces/${NS}/referencegrants`, plural: 'referencegrants', cluster: 'test2',
    extra: {
      From: (o) => (o.spec.from ?? []).map((f: Obj) => `${f.kind || '-'} (${f.namespace || '-'})`).join(', ') || '-',
      To: (o) => (o.spec.to ?? []).map((t: Obj) => `${t.kind || '-'}${t.name ? ` (${t.name})` : ''}`).join(', ') || '-',
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'With From': list.filter((o) => (o.spec.from ?? []).length > 0).length,
      'With To': list.filter((o) => (o.spec.to ?? []).length > 0).length,
      'With Labels': list.filter((o) => Object.keys(o.metadata.labels ?? {}).length > 0).length,
    }),
  },
  {
    path: '/gateway/backendtlspolicies', api: `/apis/${GW}/${served.backendtlspolicies}/namespaces/${NS}/backendtlspolicies`, plural: 'backendtlspolicies', cluster: 'test2',
    extra: {
      'Target Ref': (o) => (o.spec.targetRefs ?? []).map((r: Obj) => `${r.kind || 'Service'}/${r.name || '-'}`).join(', ') || '-',
      // the Accepted condition (its reason when it does not hold), else the first condition's type
      Status: (o) => {
        const conds = policyConds(o)
        const accepted = conds.find((c) => c.type === 'Accepted')
        if (accepted) return accepted.status === 'True' ? 'Accepted' : accepted.reason || 'Not Accepted'
        return conds[0]?.type || '-'
      },
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Accepted: list.filter((o) => policyConds(o).some((c) => c.type === 'Accepted' && c.status === 'True')).length,
      'With Targets': list.filter((o) => (o.spec.targetRefs ?? []).length > 0).length,
    }),
  },
]
// the statuses a controller would write (none runs on test2); num-gc-plain, num-gw-b and the routes not named keep
// the CRDs' default or none
const condition = (type: string, status: string, reason = status === 'True' ? type : 'Pending') =>
  ({ type, status, reason, message: '', lastTransitionTime: '2026-11-01T00:00:00Z' })
const CONTROLLER = 'numbers.kubeast.io/gateway'
const listener = (name: string, attachedRoutes: number) =>
  ({ name, attachedRoutes, supportedKinds: [{ group: GW, kind: 'HTTPRoute' }], conditions: [condition('Programmed', 'True')] })
const parent = (name: string, conditions: Obj[]) => ({ parentRef: { name }, controllerName: CONTROLLER, conditions })
const ancestor = (name: string, conditions: Obj[]) => ({ ancestorRef: { name }, controllerName: CONTROLLER, conditions })
const GATEWAY_STATUS: [string, string, Obj][] = [
  ['gatewayclass', 'num-gc-ready', { conditions: [condition('Accepted', 'True')] }],
  ['gateway', 'num-gw-a', {
    conditions: [condition('Accepted', 'True'), condition('Programmed', 'True')],
    listeners: [listener('http', 2), listener('alt', 1)],
    addresses: [{ type: 'IPAddress', value: '10.0.0.7' }, { type: 'Hostname', value: 'gw.numbers.example' }],
  }],
  ['gateway', 'num-gw-c', {
    conditions: [condition('Accepted', 'True'), condition('Programmed', 'False')],
    listeners: [listener('web', 1), listener('api', 0), listener('admin', 0)],
  }],
  ['httproute', 'num-http-a', { parents: [parent('num-gw-a', [condition('Accepted', 'False')]), parent('num-gw-c', [condition('Accepted', 'True'), condition('ResolvedRefs', 'True')])] }],
  ['httproute', 'num-http-b', { parents: [parent('num-gw-a', [condition('ResolvedRefs', 'False'), condition('Accepted', 'False')])] }],
  ['grpcroute', 'num-grpc-a', { parents: [parent('num-gw-a', [condition('Accepted', 'True'), condition('ResolvedRefs', 'False')])] }],
  ['backendtlspolicy', 'num-btls-a', { ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')])] }],
  ['backendtlspolicy', 'num-btls-b', { ancestors: [ancestor('num-gw-c', [condition('Accepted', 'False', 'NoValidCACertificate')])] }],
]
// a JSON patch or body as one shell word
const arg = (v: unknown) => JSON.stringify(JSON.stringify(v))
// live updates that empty a value, which a row merged with the update kept (and three kinds had no live updates)
const GATEWAY_LIVE: { path: string; name: string; column: string; want: string; change: string }[] = [
  { path: '/gateway/gatewayclasses', name: 'num-gc-ready', column: 'Parameters Ref', want: '-', change: `patch gatewayclass num-gc-ready --type=json -p=${arg([{ op: 'remove', path: '/spec/parametersRef' }])}` },
  { path: '/gateway/gateways', name: 'num-gw-a', column: 'Conditions', want: 'Unknown', change: `patch gateway num-gw-a -n ${NS} --subresource=status --type=merge -p=${arg({ status: { conditions: [] } })}` },
  { path: '/gateway/httproutes', name: 'num-http-a', column: 'Hostnames', want: '*', change: `patch httproute num-http-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/hostnames' }])}` },
  { path: '/gateway/grpcroutes', name: 'num-grpc-a', column: 'Hostnames', want: '*', change: `patch grpcroute num-grpc-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/hostnames' }])}` },
  { path: '/gateway/referencegrants', name: 'num-rg-a', column: 'From', want: 'HTTPRoute (web)', change: `patch referencegrant num-rg-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/from/1' }])}` },
  { path: '/gateway/backendtlspolicies', name: 'num-btls-a', column: 'Status', want: '-', change: `patch backendtlspolicy num-btls-a -n ${NS} --subresource=status --type=merge -p=${arg({ status: { ancestors: [] } })}` },
]

// the VPA screen on test2, with number-check.vpa-fixture.yaml: Provided is the RecommendationProvided condition, as
// the CRD's printer column reads it (num-vpa-b lists another condition first)
const VPA_FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.vpa-fixture.yaml'), 'utf8')
const vpaProvided = (o: Obj) => (o.status?.conditions ?? []).find((c: Obj) => c.type === 'RecommendationProvided')?.status === 'True'
const VPA_SCREEN: Screen = {
  path: '/workloads/vpas', api: `/apis/autoscaling.k8s.io/v1/namespaces/${NS}/verticalpodautoscalers`, plural: 'verticalpodautoscalers', cluster: 'test2',
  alias: { Memory: 'Mem' },
  extra: { Reference: (o) => (o.spec.targetRef ? `${o.spec.targetRef.kind}/${o.spec.targetRef.name}` : '-') },
  skip: { Age: AGE },
  cards: (list) => ({ Total: list.length, Provided: list.filter(vpaProvided).length, 'Not Provided': list.filter((o) => !vpaProvided(o)).length }),
}
const VPA_STATUS: [string, Obj][] = [
  ['num-vpa-a', {
    conditions: [condition('RecommendationProvided', 'True')],
    recommendation: { containerRecommendations: [{ containerName: 'app', target: { cpu: '25m', memory: '64Mi' } }] },
  }],
  ['num-vpa-b', {
    conditions: [condition('LowConfidence', 'True'), condition('RecommendationProvided', 'False', 'NotEnoughData')],
    recommendation: { containerRecommendations: [
      { containerName: 'db', target: { cpu: '100m', memory: '256Mi' } },
      { containerName: 'sidecar', target: { cpu: '10m', memory: '16Mi' } },
    ] },
  }],
]
const registeredOn = async (page: Page, id: string) => {
  const body = await (await page.request.get('/api/v1/clusters')).json()
  return (Array.isArray(body) ? body : body.items ?? []).some((c: Obj) => c.id === id)
}

// the custom resource instances screen on test2: number-check.cr-crd.yaml's Widget sits next to test2's
// widgets.qa.example.com, whose Kind is Widget too; one CRD's columns are its printer columns as the API server prints them
const CR_CRD = fs.readFileSync(path.join(__dirname, 'number-check.cr-crd.yaml'), 'utf8')
const CR_INSTANCES = fs.readFileSync(path.join(__dirname, 'number-check.cr-instances.yaml'), 'utf8')
const CR_SCREEN: Screen = {
  path: '/custom-resources/instances', api: '/apis/numbers.kubeast.io/v1/widgets', plural: 'widgets.numbers.kubeast.io', allNamespaces: true, cluster: 'test2',
  prepare: async (page) => {
    await page.getByTestId('cr-instances-kind').click()
    // the picker tells the two Widget kinds apart by group; without that entry the plain "Widget" is read on
    const named = page.getByRole('button', { name: 'Widget (numbers.kubeast.io)', exact: true })
    const told = await named.waitFor({ timeout: 10_000 }).then(() => true, () => false)
    expect.soft(told, 'the kind picker names the group of a Kind two CRDs share').toBe(true)
    await (told ? named : page.getByRole('button', { name: 'Widget', exact: true })).click()
  },
  // the API server prints a date column as its age ("5m1s"), which grows while it is read
  spans: { Seen: (o) => !!o.status?.lastSeen },
  skip: { Age: AGE },
  cards: (list) => ({ 'Total Instances': list.length, 'Unique Kinds': 1, Namespaces: new Set(list.map((o) => o.metadata.namespace)).size }),
}
// every custom resource instance of a cluster, each CRD's as kubectl lists them
function allCustomResources(cluster: string) {
  const k = on(cluster)
  // the CRDs by name, Kind and group only: their schemas run to megabytes (the Gateway API's)
  const crds = k.kubectl(`get crd -o jsonpath='{range .items[*]}{.metadata.name} {.spec.names.kind} {.spec.group}{"\\n"}{end}'`)
    .split('\n').filter(Boolean).map((line) => line.split(' '))
  return crds.flatMap(([crd, kind, group]) =>
    (JSON.parse(k.kubectl(`get ${crd} -A -o json`)).items as Obj[]).map((o) => ({
      key: `${o.metadata.namespace || '-'}/${o.metadata.name}/${kind}/${group}`,
      crd, namespace: (o.metadata.namespace ?? '') as string,
    })))
}

// the policy reports screen on default: number-check.polr-fixture.yaml and num-polr-bulk, counted as the reports hold them
// — a policy is its name within its source, a result is about its first resource or else the report's scope
const POLR = { path: '/security/policyreports', cluster: 'default' }
const POLR_FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.polr-fixture.yaml'), 'utf8')
const POLR_BULK = 520
const polrBulk = () => JSON.stringify({
  apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name: 'num-polr-bulk', namespace: NS },
  scope: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'num-d', namespace: NS },
  summary: { pass: 0, fail: POLR_BULK, warn: 0, error: 0, skip: 0 },
  results: Array.from({ length: POLR_BULK }, (_, i) => ({
    policy: 'num-bulk', rule: `r-${String(i).padStart(3, '0')}`, result: 'fail', source: 'e2e', category: 'Bulk', severity: 'medium',
  })),
})
type PolrRow = { result: string; policy: string; source: string; resource: string; rule: string; category: string; severity: string; namespace: string }
function polrRows(reports: Obj[]): PolrRow[] {
  return reports.flatMap((rep) => (rep.results ?? []).map((r: Obj) => {
    const at = r.resources?.[0] ?? rep.scope ?? {}
    return {
      result: r.result, policy: r.policy, source: r.source ?? '', rule: r.rule ?? '', category: r.category ?? '', severity: r.severity ?? '',
      resource: at.kind ? `${at.kind}/${at.name}` : '', namespace: at.namespace ?? rep.scope?.namespace ?? rep.metadata.namespace ?? '',
    }
  }))
}
const RESULTS = ['fail', 'warn', 'error', 'pass', 'skip'] as const
const countBy = (rows: PolrRow[]) => Object.fromEntries(RESULTS.map((k) => [k, rows.filter((r) => r.result === k).length]))
const pagerTotal = async (page: Page) => Number((await page.getByTestId('list-pager').innerText()).match(/of (\d+)/)?.[1] ?? 0)

// the Gateway → Policies screen on test2: every object of every policy kind (the CRDs labelled as policies, GEP-713)
// with its target and whether it was accepted; number-check.gwpol-crd.yaml's BackendTLSPolicy shares its Kind with the
// Gateway API's, so the screen names it with its group
const GWPOL = { path: '/gateway/policies', cluster: 'test2' }
const GWPOL_CRD = fs.readFileSync(path.join(__dirname, 'number-check.gwpol-crd.yaml'), 'utf8')
type PolicyKind = { plural: string; kind: string; group: string; version: string }
const policyKinds = (): PolicyKind[] => on(GWPOL.cluster)
  .kubectl(`get crd -l gateway.networking.k8s.io/policy -o jsonpath='{range .items[*]}{.spec.names.plural} {.spec.names.kind} {.spec.group} {.spec.versions[?(@.storage==true)].name}{"\\n"}{end}'`)
  .split('\n').filter(Boolean).map((line) => {
    const [plural, kind, group, version] = line.split(' ')
    return { plural, kind, group, version }
  })
const policyTarget = (spec: Obj = {}) => {
  const refs: Obj[] = spec.targetRefs?.length ? spec.targetRefs : spec.targetRef ? [spec.targetRef] : []
  return refs.map((t) => `${t.kind || '?'} ${t.namespace ? `${t.namespace}/` : ''}${t.name ?? ''}${t.sectionName ? `#${t.sectionName}` : ''}`).join(', ') || '-'
}
// Accepted on the object or on each ancestor (PolicyAncestorStatus): Yes when every one says True
const policyAccepted = (status: Obj = {}) => {
  const conds = [...(status.conditions ?? []), ...(status.ancestors ?? []).flatMap((a: Obj) => a.conditions ?? [])].filter((c: Obj) => c.type === 'Accepted')
  return conds.length === 0 ? '-' : conds.every((c: Obj) => c.status === 'True') ? 'Yes' : 'No'
}

type ScreenRead = { heads: string[]; rows: string[][]; cards: Record<string, number> }
async function readScreen(page: Page): Promise<ScreenRead> {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll('main thead th')].map((th) => (th as HTMLElement).innerText.trim())
    const rows = [...document.querySelectorAll('main tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.trim()))
    const cards: Record<string, number> = {}
    // a summary card: a bordered box of two lines, the label and a number
    for (const box of document.querySelectorAll('main div.rounded-lg.border')) {
      const lines = [...box.children] as HTMLElement[]
      if (lines.length === 2 && /^\d+$/.test(lines[1].innerText.trim())) cards[lines[0].innerText.trim()] = Number(lines[1].innerText.trim())
    }
    return { heads, rows, cards }
  })
}

const screenUrl = (s: Screen) =>
  `${s.path}${s.path.includes('?') ? '&' : '?'}cluster=${s.cluster ?? 'self'}${s.clusterScoped || s.allNamespaces ? '' : `&namespace=${NS}`}`

// one screen read one way: its rows, every column and every card against the cluster, each difference a soft failure
// (open = false: the screen already on the page, as live updates left it)
async function compareScreen(page: Page, s: Screen, way: string, open = true) {
  const { apiTable } = on(s.cluster)
  if (open) {
    await page.goto(screenUrl(s))
    await s.prepare?.(page)
  }
  // a row is its name, or namespace/name on a screen of every namespace
  const metaKey = (m: { name: string; namespace?: string }) => (s.allNamespaces ? `${m.namespace}/${m.name}` : m.name)
  const rowKey = (heads: string[], r: string[]) => {
    const name = r[heads.findIndex((h) => /^name$/i.test(h))]
    return s.allNamespaces && name ? `${r[heads.findIndex((h) => /^namespace$/i.test(h))]}/${name}` : name
  }
  const table = await apiTable(s.api)
  const want = table.rows.map((r) => metaKey(r.object.metadata)).sort()
  // the rows on screen are the cluster's objects (re-read until the list has caught up)
  const names = async () => {
    const { heads, rows } = await readScreen(page)
    return rows.map((r) => rowKey(heads, r)).filter(Boolean).sort()
  }
  try {
    await expect.poll(names, { timeout: 20_000 }).toEqual(want)
  } catch {
    expect.soft(await names(), `${s.path} (${way}): names on screen`).toEqual(want)
  }
  expect.soft(await page.locator('main [data-fold]').count(), `${s.path} (${way}): a column folded at 2560 px`).toBe(0)

  // the cluster again, then the screen, so a value that moves (RESTARTS) is read close together
  const fresh = await apiTable(s.api)
  const objects = Object.fromEntries(items(s.plural, s.clusterScoped, s.allNamespaces, s.cluster).map((o) => [metaKey(o.metadata), o]))
  const { heads, rows, cards } = await readScreen(page)
  // a screen with cards and no expectation for them fails, so a card cannot go unchecked
  if (!s.cards) expect.soft(cards, `${s.path} (${way}): summary cards with nothing to compare against`).toEqual({})
  const nameAt = heads.findIndex((h) => /^name$/i.test(h))
  const nsAt = s.allNamespaces ? heads.findIndex((h) => /^namespace$/i.test(h)) : -1
  const tableCols = fresh.columnDefinitions.map((c) => norm(c.name))
  const byName = Object.fromEntries(fresh.rows.map((r) => [metaKey(r.object.metadata), r.cells.map((c) => String(c ?? ''))]))
  const unknown: string[] = []
  for (const row of rows) {
    const name = rowKey(heads, row)
    if (!name || !byName[name]) continue
    heads.forEach((h, i) => {
      if (!h || i === nameAt || i === nsAt || s.skip?.[h] !== undefined) return
      const o = objects[name]
      const extra = s.extra?.[h]
      if (extra) {
        // chips in one cell read with line breaks between them
        const squash = (v: string) => v.replace(/\s+/g, ' ').trim()
        expect.soft(squash(row[i]), `${s.path} (${way}) · ${name} · ${h} (from the object)`).toBe(squash(extra(o)))
        return
      }
      const j = tableCols.indexOf(norm(s.alias?.[h] ?? h))
      if (j < 0) {
        if (!unknown.includes(h)) unknown.push(h)
        return
      }
      const cluster = s.shape?.[h] ? s.shape[h](byName[name][j], o) : byName[name][j]
      const same = s.spans?.[h]?.(o) ? sameSpan(row[i], cluster) : sameValue(row[i], cluster)
      expect.soft(same, `${s.path} (${way}) · ${name} · ${h}: screen "${row[i]}", kubectl "${byName[name][j]}"`).toBe(true)
    })
  }
  expect.soft(unknown, `${s.path} (${way}): columns with nothing to compare against`).toEqual([])
  if (s.cards) {
    const expected = s.cards(Object.values(objects))
    for (const [label, value] of Object.entries(expected)) {
      expect.soft(cards[label], `${s.path} (${way}) · card "${label}" (cards on screen: ${JSON.stringify(cards)})`).toBe(value)
    }
  }
}

test.describe('number check — list screens', () => {
  test.beforeAll(async () => {
    test.setTimeout(200_000)
    kubectl('apply -f -', FIXTURE)
    // a ReplicaSet whose controller is not a Deployment (an Argo Rollout's is not): an owner needs the uid of an object
    // that exists, so it is made here with num-cm's
    const cm = JSON.parse(kubectl(`get configmap num-cm -n ${NS} -o json`))
    kubectl('apply -f -', JSON.stringify({
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: { name: 'num-owned', namespace: NS, ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'num-cm', uid: cm.metadata.uid, controller: true }] },
      spec: {
        replicas: 0, selector: { matchLabels: { app: 'num-owned' } },
        template: { metadata: { labels: { app: 'num-owned' } }, spec: { containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent' }] } },
      },
    }))
    // settled: the ready Deployment and the StatefulSet ready, both Jobs finished, the crashing Pod restarted, the two
    // pods that are never ready Running (the first test reads their phase)
    const deadline = Date.now() + 150_000
    for (;;) {
      const got = kubectl(`get deploy/num-ready sts/num-db job/num-done job/num-fail pod/num-crash -n ${NS} -o jsonpath='{.items[*].status.readyReplicas} {.items[*].status.succeeded} {.items[*].status.failed} {.items[4].status.containerStatuses[0].restartCount}'`)
      const [deployReady, stsReady, , , restarts] = got.split(/\s+/)
      const jobs = items('jobs')
      const done = jobs.every((j) => cond(j, 'Complete') === 'True' || cond(j, 'Failed') === 'True')
      const notReady = items('pods').filter((p) => p.metadata.labels?.app === 'num-notready')
      const notReadyRunning = notReady.length === 2 && notReady.every((p) => p.status.phase === 'Running')
      if (deployReady === '3' && stsReady === '2' && done && Number(restarts) >= 1 && notReadyRunning) break
      if (Date.now() > deadline) throw new Error(`fixture did not settle: ${got}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  })

  // waits, so a worker started after a failure does not apply into a namespace still being removed
  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
  })

  test('a Running pod that is not ready reads Running, drawn yellow with its ready count on hover', async ({ page }) => {
    const pods = items('pods').filter((p) => p.metadata.labels?.app === 'num-notready')
    expect(pods.map((p) => p.status.phase)).toEqual(pods.map(() => 'Running'))
    await page.addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}`)
    for (const p of pods) {
      const statuses: Obj[] = p.status.containerStatuses ?? []
      const ready = `${statuses.filter((c) => c.ready).length}/${statuses.length}`
      const badge = page.locator('main tbody tr').filter({ hasText: p.metadata.name }).getByTestId('pod-status-not-ready')
      await expect(badge).toHaveText('Running', { timeout: 20_000 })
      await expect(badge).toHaveClass(/badge-warning/)
      await expect(badge).toHaveAttribute('title', new RegExp(`(Not ready|준비 안 됨) \\(${ready}\\)`))
    }
    // the Pod drawer's Status tile says the same
    const first = pods[0]
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${first.metadata.name}`)}`)
    const tile = page.getByTestId('pod-drawer-status-not-ready')
    await expect(tile).toHaveText('Running', { timeout: 20_000 })
    await expect(tile).toHaveClass(/badge-warning/)
  })

  // one test, a step per screen and way: the fixture is made once and a screen that differs does not stop the others.
  // Each screen is read twice: from the list API alone (a page whose live updates are held back), and with the live
  // updates the page applies on top (a watch first sends every object as ADDED, so a plain read can be either). The
  // window is wide enough that no column folds: a folded column's header reads empty and would not be compared.
  test('every list screen shows the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(900_000)
    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    const held = await page.context().newPage()
    await held.routeWebSocket(/wsMultiplexer/, () => {})
    for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
    for (const s of SCREENS) {
      for (const [way, p] of [['list API', held], ['live', page]] as const) await test.step(`${s.path} · ${way}`, () => compareScreen(p, s, way))
    }
    await held.close()
  })

  // the cluster screens the same way, with the cluster-scoped fixture made for the test and removed after it
  test('every cluster list screen shows the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(900_000)
    kubectl('apply -f -', CLUSTER_FIXTURE)
    try {
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      const held = await page.context().newPage()
      await held.routeWebSocket(/wsMultiplexer/, () => {})
      for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
      for (const s of SCREENS_CLUSTER) {
        for (const [way, p] of [['list API', held], ['live', page]] as const) await test.step(`${s.path} · ${way}`, () => compareScreen(p, s, way))
      }
      await held.close()
    } finally {
      kubectl('delete -f - --ignore-not-found --wait=false', CLUSTER_FIXTURE)
    }
  })

  // the Gateway API screens the same way on test2, then a live update on each that empties a value
  test('every Gateway API list screen shows the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(600_000)
    const served = gatewayVersions()
    const clusters = await (await page.request.get('/api/v1/clusters')).json()
    const registered = (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((c: Obj) => c.id === 'test2')
    test.skip(!served || !registered, 'needs the kind cluster test2, registered as test2, serving the Gateway API (experimental channel CRDs)')
    const t2 = on('test2')
    const screens = gatewayScreens(served!)
    const cellOf = async (p: Page, name: string, column: string) => {
      const { heads, rows } = await readScreen(p)
      return rows.find((r) => r[heads.findIndex((h) => /^name$/i.test(h))] === name)?.[heads.indexOf(column)]
    }
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', GATEWAY_FIXTURE.replace(/\{\{(\w+)\}\}/g, (_, k) => served![k]))
    try {
      for (const [kind, name, status] of GATEWAY_STATUS) {
        t2.kubectl(`patch ${kind} ${name}${kind === 'gatewayclass' ? '' : ` -n ${NS}`} --subresource=status --type=merge -p=${arg({ status })}`)
      }
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      const held = await page.context().newPage()
      await held.routeWebSocket(/wsMultiplexer/, () => {})
      for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
      for (const s of screens) {
        for (const [way, p] of [['list API', held], ['live', page]] as const) await test.step(`${s.path} · ${way}`, () => compareScreen(p, s, way))
      }
      await held.close()

      for (const change of GATEWAY_LIVE) {
        const s = screens.find((x) => x.path === change.path)!
        await test.step(`${s.path} · a live update that empties ${change.column}`, async () => {
          // the watch has sent the object (its first events are the objects there are) before the object changes
          const socket = page.waitForEvent('websocket', (ws) => /wsMultiplexer/.test(ws.url()))
          await page.goto(screenUrl(s))
          const sent = await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes(change.name), timeout: 20_000 }).then(() => true, () => false)
          expect.soft(sent, `${s.path}: the live updates send ${change.name}`).toBe(true)
          if (!sent) return
          t2.kubectl(change.change)
          try {
            await expect.poll(() => cellOf(page, change.name, change.column), { timeout: 20_000 }).toBe(change.want)
          } catch {
            expect.soft(await cellOf(page, change.name, change.column), `${s.path} · ${change.name} · ${change.column} after the live update`).toBe(change.want)
          }
          await compareScreen(page, s, 'live, after the update', false)
        })
      }
    } finally {
      t2.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      t2.kubectl('delete gatewayclass/num-gc-ready gatewayclass/num-gc-plain --ignore-not-found')
    }
  })

  // the VPA screen the same way on test2, then a live update that empties a value
  test('the VPA list screen shows the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(300_000)
    let served = false
    try {
      served = /^verticalpodautoscalers\./m.test(on('test2').kubectl('api-resources --api-group=autoscaling.k8s.io -o name'))
    } catch {
      served = false
    }
    test.skip(!served || !(await registeredOn(page, 'test2')), 'needs the kind cluster test2, registered as test2, serving the VPA CRD')
    const t2 = on('test2')
    const cellOf = async (p: Page, name: string, column: string) => {
      const { heads, rows } = await readScreen(p)
      return rows.find((r) => r[heads.findIndex((h) => /^name$/i.test(h))] === name)?.[heads.indexOf(column)]
    }
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', VPA_FIXTURE)
    try {
      for (const [name, status] of VPA_STATUS) {
        t2.kubectl(`patch verticalpodautoscaler ${name} -n ${NS} --subresource=status --type=merge -p=${arg({ status })}`)
      }
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      const held = await page.context().newPage()
      await held.routeWebSocket(/wsMultiplexer/, () => {})
      for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
      for (const [way, p] of [['list API', held], ['live', page]] as const) await test.step(`${VPA_SCREEN.path} · ${way}`, () => compareScreen(p, VPA_SCREEN, way))
      await held.close()

      await test.step(`${VPA_SCREEN.path} · a live update that empties Provided and the recommendation`, async () => {
        const socket = page.waitForEvent('websocket', (ws) => /wsMultiplexer/.test(ws.url()))
        await page.goto(screenUrl(VPA_SCREEN))
        const sent = await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes('num-vpa-a'), timeout: 20_000 }).then(() => true, () => false)
        expect.soft(sent, 'the live updates send num-vpa-a').toBe(true)
        if (!sent) return
        t2.kubectl(`patch verticalpodautoscaler num-vpa-a -n ${NS} --subresource=status --type=merge -p=${arg({ status: { conditions: [], recommendation: null } })}`)
        try {
          await expect.poll(() => cellOf(page, 'num-vpa-a', 'Provided'), { timeout: 20_000 }).toBe('-')
        } catch {
          expect.soft(await cellOf(page, 'num-vpa-a', 'Provided'), 'num-vpa-a · Provided after the live update').toBe('-')
        }
        await compareScreen(page, VPA_SCREEN, 'live, after the update', false)
      })
    } finally {
      t2.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
    }
  })

  // the custom resource instances screen on test2: every instance with its Kind and group, then one CRD's instances with
  // its printer columns as the API server prints them — a Kind of the same name in another group kept apart
  test('the custom resource instances screen shows what the cluster has, one CRD at a time', async ({ page }) => {
    test.setTimeout(300_000)
    test.skip(!(await registeredOn(page, 'test2')), 'needs the kind cluster test2, registered as test2')
    const t2 = on('test2')
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', CR_CRD)
    try {
      t2.kubectl('wait --for=condition=Established crd/widgets.numbers.kubeast.io --timeout=60s')
      t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', CR_INSTANCES)
      const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      // num-w1 changed once (generation 2), two statuses with the Ready condition after another one
      t2.kubectl(`patch widget.numbers.kubeast.io num-w1 -n ${NS} --type=merge -p=${arg({ spec: { size: 'xlarge' } })}`)
      t2.kubectl(`patch widget.numbers.kubeast.io num-w1 -n ${NS} --subresource=status --type=merge -p=${arg({ status: { conditions: [condition('Ready', 'True')], lastSeen: ago(5) } })}`)
      t2.kubectl(`patch widget.numbers.kubeast.io num-w3 -n ${NS} --subresource=status --type=merge -p=${arg({ status: { conditions: [condition('Synced', 'True'), condition('Ready', 'False')], lastSeen: ago(90) } })}`)
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      await page.setViewportSize({ width: 2560, height: 1200 })

      await test.step(`${CR_SCREEN.path} · every kind: each instance with its Kind and group, and the cards`, async () => {
        await page.goto('/custom-resources/instances?cluster=test2')
        const want = allCustomResources('test2')
        const shown = async () => {
          const { heads, rows } = await readScreen(page)
          const at = (h: string) => heads.indexOf(h)
          return rows.filter((r) => r[at('Name')]).map((r) => `${r[at('Namespace')] || '-'}/${r[at('Name')]}/${r[at('Kind')]}/${r[at('Group')]}`).sort()
        }
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want.map((w) => w.key).sort())
        } catch {
          expect.soft(await shown(), 'every instance with its Kind and group').toEqual(want.map((w) => w.key).sort())
        }
        const { cards } = await readScreen(page)
        expect.soft(cards['Total Instances'], 'card Total Instances').toBe(want.length)
        expect.soft(cards['Unique Kinds'], 'card Unique Kinds — one per CRD').toBe(new Set(want.map((w) => w.crd)).size)
        expect.soft(cards.Namespaces, 'card Namespaces').toBe(new Set(want.filter((w) => w.namespace).map((w) => w.namespace)).size)
      })
      await test.step(`${CR_SCREEN.path} · Widget (numbers.kubeast.io)`, () => compareScreen(page, CR_SCREEN, 'one CRD'))
    } finally {
      t2.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      t2.kubectl('delete crd/widgets.numbers.kubeast.io --ignore-not-found')
    }
  })

  // the policy reports screen on default: the cards, the rows by policy (a name within its source) and by namespace as
  // the reports hold them, and every result row reachable page by page, sorted over all of them, not one page
  test('the policy reports screen counts what the reports hold, and every result page is reachable', async ({ page }) => {
    test.setTimeout(300_000)
    const b = on(POLR.cluster)
    test.skip(!b.kubectl('api-resources --api-group=wgpolicyk8s.io -o name').includes('policyreports'), 'needs the PolicyReport CRD on the second cluster')
    b.kubectl('apply --server-side --field-manager=e2e-numbers -f -', POLR_FIXTURE)
    try {
      b.kubectl('apply --server-side --field-manager=e2e-numbers -f -', polrBulk())
      const reports: Obj[] = JSON.parse(b.kubectl(`get policyreports -n ${NS} -o json`)).items
      const rows = polrRows(reports)
      const groups = new Map<string, PolrRow[]>()
      for (const r of rows) groups.set(`${r.source}\n${r.policy}`, [...(groups.get(`${r.source}\n${r.policy}`) ?? []), r])
      const resultKey = (r: { result: string; policy: string; resource: string; rule: string }) => `${r.result} | ${r.policy} | ${r.resource || '-'} | ${r.rule || '-'}`
      const shownRows = async (...columns: string[]) => {
        const { heads, rows: shown } = await readScreen(page)
        return shown.filter((r) => r.length > 1 && r[0]).map((r) => columns.map((c) => r[heads.indexOf(c)]).join(' | '))
      }
      const shownResults = async () => (await shownRows('Result', 'Policy', 'Resource', 'Rule')).map((r) => r.replace(/^\w+/, (w) => w.toLowerCase()))
      const shownCards = async () => {
        const { cards } = await readScreen(page)
        const lower = Object.fromEntries(Object.entries(cards).map(([k, v]) => [k.toLowerCase(), v]))
        return Object.fromEntries(RESULTS.map((k) => [k, lower[k]]))
      }
      const refreshed = () => Promise.all([
        page.waitForResponse((r) => r.url().includes('/policyreports/summary') && r.url().includes('force_refresh=true')),
        page.getByRole('button', { name: 'Refresh', exact: true }).click(),
      ])
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      await page.setViewportSize({ width: 2560, height: 1200 })
      await page.goto(`${POLR.path}?cluster=${POLR.cluster}`)
      await page.getByTestId('policy-reports-namespace').click()
      await page.getByTestId(`policy-reports-namespace-opt-${NS}`).click()
      // the server keeps a read for a minute: the refresh reads the reports now
      await refreshed()

      await test.step('cards: the summaries of the namespace\'s reports added up', async () => {
        const held = Object.fromEntries(RESULTS.map((k) => [k, reports.reduce((sum, rep) => sum + (rep.summary?.[k] ?? 0), 0)]))
        expect(held, 'the summaries the fixture writes agree with its results').toEqual(countBy(rows))
        await expect.poll(shownCards, { timeout: 20_000 }).toEqual(held)
      })
      await test.step('by policy: a row per policy and source, its first category and severity, counts and namespaces', async () => {
        const want = [...groups.values()].map((g) => [
          g[0].policy, g.find((r) => r.category)?.category || '-', g.find((r) => r.severity)?.severity || '-', g[0].source || '-',
          ...RESULTS.map((k) => String(g.filter((r) => r.result === k).length)), String(new Set(g.map((r) => r.namespace).filter(Boolean)).size),
        ].join(' | ')).sort()
        const shown = async () => (await shownRows('Policy', 'Category', 'Severity', 'Source', 'Fail', 'Warn', 'Error', 'Pass', 'Skip', 'Namespaces')).sort()
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
        } catch {
          expect.soft(await shown(), 'by policy').toEqual(want)
        }
      })
      await test.step('by namespace: its policies and counts', async () => {
        await page.getByTestId('policy-reports-tab-namespaces').click()
        const all = countBy(rows)
        const want = [[NS, String(groups.size), ...RESULTS.map((k) => String(all[k]))].join(' | ')]
        const shown = () => shownRows('Namespace', 'Policies', 'Fail', 'Warn', 'Error', 'Pass', 'Skip')
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
        } catch {
          expect.soft(await shown(), 'by namespace').toEqual(want)
        }
      })
      await test.step(`results: the pager counts every fail, warn and error row, and the pages hold each once`, async () => {
        await page.getByTestId('policy-reports-tab-results').click()
        const problems = rows.filter((r) => ['fail', 'warn', 'error'].includes(r.result))
        await expect.poll(() => pagerTotal(page), { timeout: 20_000 }).toBeGreaterThan(0)
        expect.soft(await pagerTotal(page), 'the pager counts every matching row').toBe(problems.length)
        const pages = Math.ceil((await pagerTotal(page)) / 100)
        await expect.poll(async () => (await shownResults()).length, { timeout: 20_000 }).toBe(Math.min(100, await pagerTotal(page)))
        const seen = await shownResults()
        for (let p = 2; p <= pages; p++) {
          const before = (await shownResults())[0]
          await page.getByTestId('list-pager').getByRole('button', { name: 'Next' }).click()
          await expect.poll(async () => (await shownResults())[0], { timeout: 20_000 }).not.toBe(before)
          seen.push(...await shownResults())
        }
        expect.soft(seen.sort(), 'every row on some page, none twice').toEqual(problems.map(resultKey).sort())
      })
      await test.step('the policy picker keeps one policy name of two sources apart', async () => {
        await page.getByTestId('policy-reports-result').click()
        await page.getByTestId('policy-reports-result-opt-all').click()
        await page.getByTestId('policy-reports-policy').click()
        const named = page.getByRole('button', { name: 'num-no-root (kubewarden)', exact: true })
        const told = await named.waitFor({ timeout: 10_000 }).then(() => true, () => false)
        expect.soft(told, 'the picker names the source of a policy name two sources share').toBe(true)
        if (told) {
          await named.click()
          const want = rows.filter((r) => r.policy === 'num-no-root' && r.source === 'kubewarden').map(resultKey).sort()
          await expect.poll(async () => (await shownResults()).sort(), { timeout: 20_000 }).toEqual(want)
          await page.getByTestId('policy-reports-policy').click()
        }
        await page.getByRole('button', { name: 'All policies', exact: true }).click()
        try {
          await expect.poll(() => pagerTotal(page), { timeout: 20_000 }).toBe(rows.length)
        } catch {
          expect.soft(await pagerTotal(page), 'the pager counts every result of every policy').toBe(rows.length)
        }
      })
      await test.step('sorting the results by policy orders all of them before the page', async () => {
        const names = [...new Set(rows.map((r) => r.policy))].sort()
        const header = page.locator('main thead th', { hasText: /^Policy$/ })
        await header.click()
        await expect.poll(async () => (await shownResults())[0]?.split(' | ')[1], { timeout: 20_000 }).toBe(names[0])
        await header.click()
        await expect.poll(async () => (await shownResults())[0]?.split(' | ')[1], { timeout: 20_000 }).toBe(names[names.length - 1])
      })
      await test.step('cards of every namespace: the summaries of every report in the cluster', async () => {
        await page.getByTestId('policy-reports-tab-policies').click()
        await page.getByTestId('policy-reports-namespace').click()
        await page.getByRole('button', { name: 'All namespaces', exact: true }).click()
        // Kyverno writes its reports as it goes: read both again until they meet
        await expect(async () => {
          await refreshed()
          const all = [
            ...JSON.parse(b.kubectl('get policyreports -A -o json')).items,
            ...JSON.parse(b.kubectl('get clusterpolicyreports -o json')).items,
          ] as Obj[]
          const held = Object.fromEntries(RESULTS.map((k) => [k, all.reduce((sum, rep) => sum + (rep.summary?.[k] ?? 0), 0)]))
          expect(await shownCards()).toEqual(held)
        }).toPass({ timeout: 60_000 })
      })
    } finally {
      b.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
    }
  })

  // the Gateway policies screen on test2: every object of every policy kind with its target and acceptance, the cards
  // and the scanned kinds, and the kind picker telling a Kind two groups share apart
  test('the Gateway policies screen shows every policy object, a Kind of two groups kept apart', async ({ page }) => {
    test.setTimeout(300_000)
    test.skip(!(await registeredOn(page, GWPOL.cluster)), 'needs the kind cluster test2, registered as test2')
    const served = gatewayVersions()
    test.skip(!served || !policyKinds().some((k) => k.plural === 'xbackendtrafficpolicies'), 'needs the Gateway API experimental-channel CRDs on test2')
    const t2 = on(GWPOL.cluster)
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', GWPOL_CRD)
    try {
      t2.kubectl('wait --for=condition=Established crd/backendtlspolicies.numbers.kubeast.io --timeout=60s')
      const xbtp = policyKinds().find((k) => k.plural === 'xbackendtrafficpolicies')!
      const svc = { group: '', kind: 'Service', name: 'num-svc' }
      const objects = [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
        { apiVersion: 'numbers.kubeast.io/v1', kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-1', namespace: NS }, spec: { targetRefs: [{ ...svc, sectionName: 'https' }] } },
        { apiVersion: 'numbers.kubeast.io/v1', kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-2', namespace: NS }, spec: { targetRef: { group: GW, kind: 'Gateway', name: 'num-gw-a' } } },
        { apiVersion: `${GW}/${served!.backendtlspolicies}`, kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-up', namespace: NS },
          spec: { targetRefs: [svc], validation: { hostname: 'num-svc.e2e-numbers.svc', wellKnownCACertificates: 'System' } } },
        { apiVersion: `${xbtp.group}/${xbtp.version}`, kind: xbtp.kind, metadata: { name: 'num-gp-x', namespace: NS }, spec: { targetRefs: [svc] } },
      ]
      t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }))
      // what an implementation would write: accepted by its one Gateway, by one of two, by the other; num-gp-x says nothing
      const status = (plural: string, group: string, name: string, s: Obj) =>
        t2.kubectl(`patch ${plural}.${group} ${name} -n ${NS} --subresource=status --type=merge -p=${arg({ status: s })}`)
      status('backendtlspolicies', 'numbers.kubeast.io', 'num-gp-1', { ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')])] })
      status('backendtlspolicies', 'numbers.kubeast.io', 'num-gp-2', {
        ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')]), ancestor('num-gw-b', [condition('Accepted', 'False', 'Conflicted')])],
      })
      status('backendtlspolicies', GW, 'num-gp-up', { ancestors: [ancestor('num-gw-a', [condition('Accepted', 'True')])] })

      const kinds = policyKinds()
      const shared = new Set(kinds.filter((k) => kinds.some((o) => o.kind === k.kind && o.group !== k.group)).map((k) => k.kind))
      const label = (k: PolicyKind) => (shared.has(k.kind) ? `${k.kind} (${k.group})` : k.kind)
      const held = kinds.map((k) => ({
        k, items: (JSON.parse(t2.kubectl(`get ${k.plural}.${k.group} -A -o json`)).items as Obj[]).map((o) => ({
          row: [label(k), o.metadata.name, o.metadata.namespace || '-', policyTarget(o.spec), policyAccepted(o.status)].join(' | '),
          accepted: policyAccepted(o.status) === 'Yes',
        })),
      }))
      const shown = async () => {
        const { heads, rows } = await readScreen(page)
        const at = (h: string) => heads.indexOf(h)
        return rows.filter((r) => r.length > 1 && r[at('Name')]).map((r) => ['Kind', 'Name', 'Namespace', 'Target', 'Accepted'].map((h) => r[at(h)]).join(' | ')).sort()
      }
      const chips = () => page.locator('[data-testid="policy-kinds"] > span.rounded-full').evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).sort())
      const expectCards = async (items: { accepted: boolean }[], kindCount: number, what: string) => {
        const { cards } = await readScreen(page)
        expect.soft(cards.Total, `${what}: card Total`).toBe(items.length)
        expect.soft(cards.Kinds, `${what}: card Kinds — a Kind of two groups counts twice`).toBe(kindCount)
        expect.soft(cards.Accepted, `${what}: card Accepted`).toBe(items.filter((i) => i.accepted).length)
      }
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      await page.setViewportSize({ width: 2560, height: 1200 })
      await page.goto(`${GWPOL.path}?cluster=${GWPOL.cluster}`)

      await test.step('every policy object of every kind, its target and acceptance; the cards and the scanned kinds', async () => {
        const want = held.flatMap((h) => h.items.map((i) => i.row)).sort()
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
        } catch {
          expect.soft(await shown(), 'every policy object').toEqual(want)
        }
        await expectCards(held.flatMap((h) => h.items), held.filter((h) => h.items.length).length, 'every kind')
        expect.soft(await chips(), 'the scanned kinds, each with its count').toEqual(held.map((h) => `${label(h.k)} ${h.items.length}`).sort())
      })
      await test.step('the kind picker names the shared Kind with its group and keeps to that kind', async () => {
        const mine = held.find((h) => h.k.group === 'numbers.kubeast.io')!
        await page.getByTestId('policies-kind').click()
        const named = page.getByRole('button', { name: label(mine.k), exact: true })
        const told = await named.waitFor({ timeout: 10_000 }).then(() => true, () => false)
        expect.soft(told, 'the kind picker names the group of a Kind two groups share').toBe(true)
        await (told ? named : page.getByRole('button', { name: mine.k.kind, exact: true })).click()
        const want = mine.items.map((i) => i.row).sort()
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want)
        } catch {
          expect.soft(await shown(), `${label(mine.k)} only`).toEqual(want)
        }
        await expectCards(mine.items, 1, label(mine.k))
      })
    } finally {
      t2.kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
      t2.kubectl('delete crd/backendtlspolicies.numbers.kubeast.io --ignore-not-found')
    }
  })

  // An EndpointSlice row and its drawer are the slice the cluster has whichever way they came: from the list API (live
  // updates held back), from a live update, and by link (the object itself). Last in the file: it changes num-hand.
  test('an EndpointSlice row and drawer show the slice from the list API, a live update and a link alike', async ({ page }) => {
    test.setTimeout(180_000)
    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    const slice = () => JSON.parse(kubectl(`get endpointslice num-hand -n ${NS} -o json`))
    const list = `/network/endpointslices?cluster=self&namespace=${NS}`
    const squash = (s: string) => s.replace(/\s+/g, '')
    const ready = (o: Obj) => (o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length
    // the row's Endpoints preview and counts, read by column header
    const rowShows = async (p: Page = page) => {
      const { heads, rows } = await readScreen(p)
      const r = rows.find((cells) => cells[heads.findIndex((h) => /^name$/i.test(h))] === 'num-hand') ?? []
      return Object.fromEntries(['Endpoints', 'Total', 'Ready', 'Not Ready'].map((h) => [h, r[heads.indexOf(h)]]))
    }
    const rowWants = (o: Obj) => {
      const addresses = (o.endpoints ?? []).flatMap((e: Obj) => e.addresses)
      const total = (o.endpoints ?? []).length
      return { Endpoints: addresses.length ? addresses.join(', ') : '-', Total: String(total), Ready: String(ready(o)), 'Not Ready': String(total - ready(o)) }
    }
    // what the drawer says of the slice, whitespace aside: its info rows, each endpoint, each port, labels, annotations
    const drawerWants = (o: Obj): string[] => [
      `AddressType${o.addressType}`,
      `ManagedBy${o.metadata.labels?.['endpointslice.kubernetes.io/managed-by'] ?? '-'}`,
      `Endpoints(Ready/Total)${ready(o)}/${(o.endpoints ?? []).length}`,
      ...(o.endpoints ?? []).flatMap((e: Obj) => [
        `Addresses:${e.addresses.join(',')}`,
        ...(e.hostname ? [`Hostname:${e.hostname}`] : []),
        ...(e.nodeName ? [`Node:${e.nodeName}`] : []),
        ...(e.zone ? [`Zone:${e.zone}`] : []),
        ...(e.targetRef ? [`TargetRef:${e.targetRef.kind}:${e.targetRef.name}`] : []),
        ...(e.hints?.forZones ? [`Hints(forzones):${e.hints.forZones.map((z: Obj) => z.name).join(',')}`] : []),
        ...(e.hints?.forNodes ? [`Hints(fornodes):${e.hints.forNodes.map((z: Obj) => z.name).join(',')}`] : []),
      ]),
      ...(o.ports ?? []).map((p: Obj) => `${p.name}${p.port}${p.protocol}${p.appProtocol ?? '-'}`),
      ...Object.entries({ ...o.metadata.labels, ...o.metadata.annotations }).map(([k, v]) => squash(`${k}:${v}`)),
    ]
    const openDrawer = async (p: Page = page) => {
      await p.locator('main tbody tr').getByRole('cell', { name: 'num-hand', exact: true }).click()
      return drawerText(p)
    }
    const drawerText = async (p: Page = page) => {
      const drawer = p.locator(DRAWER).last()
      await expect(drawer).toContainText('EndpointSlice Info', { timeout: 20_000 })
      await expect(drawer).toContainText('num-hand')
      return squash(await drawer.innerText())
    }
    const missing = (text: string, o: Obj) => drawerWants(o).filter((w) => !text.includes(w))
    const patch = (ops: Obj[]) => kubectl(`patch endpointslice num-hand -n ${NS} --type=json -p=${JSON.stringify(JSON.stringify(ops))}`)

    await test.step('from the list API, live updates held back', async () => {
      // a page of its own: a WebSocket route lasts as long as its page (unrouteAll leaves it)
      const held = await page.context().newPage()
      await held.routeWebSocket(/wsMultiplexer/, () => {})
      await held.goto(list)
      const o = slice()
      await expect(held.locator('main tbody tr').getByRole('cell', { name: 'num-hand', exact: true })).toBeVisible({ timeout: 20_000 })
      expect.soft(await rowShows(held), 'row from the list API').toEqual(rowWants(o))
      expect.soft(missing(await openDrawer(held), o), 'drawer from a list API row').toEqual([])
      await held.close()
    })

    await test.step('from a live update', async () => {
      // the watch has sent the slice (its first events are the objects there are) before the slice changes
      const socket = page.waitForEvent('websocket', (ws) => /wsMultiplexer/.test(ws.url()))
      await page.goto(list)
      await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes('num-hand'), timeout: 20_000 })
      // a new address, a zone hint and a label gone, an annotation added
      patch([
        { op: 'replace', path: '/endpoints/1/addresses/0', value: '10.255.0.9' },
        { op: 'replace', path: '/endpoints/0/hints/forZones', value: [{ name: 'zone-b' }] },
        { op: 'remove', path: '/metadata/labels/team' },
        { op: 'add', path: '/metadata/annotations/numbers.kubeast.io~1live', value: 'yes' },
      ])
      const changed = slice()
      await expect.poll(rowShows, { timeout: 20_000, message: 'row after a live update' }).toEqual(rowWants(changed))
      const text = await openDrawer()
      expect.soft(missing(text, changed), 'drawer from a live-updated row').toEqual([])
      expect.soft(text, 'the removed label is gone').not.toContain('team:numbers')
      expect.soft(text, 'the replaced zone hint is gone').not.toContain('zone-a,zone-b')
      await page.keyboard.press('Escape')

      // then every endpoint gone
      patch([{ op: 'replace', path: '/endpoints', value: [] }])
      const emptied = slice()
      await expect.poll(rowShows, { timeout: 20_000, message: 'row after its endpoints went' }).toEqual(rowWants(emptied))
      expect.soft(await openDrawer(), 'a slice with no endpoints lists none').not.toContain('Addresses:')
      await page.keyboard.press('Escape')
      kubectl('apply -f -', FIXTURE)
    })

    await test.step('by link', async () => {
      const o = slice()
      expect(o.endpoints.length, 'num-hand back as in the fixture').toBe(2)
      await page.goto(`${list}&detail=${encodeURIComponent(`EndpointSlice/${NS}/num-hand`)}`)
      expect.soft(missing(await drawerText(), o), 'drawer opened by link').toEqual([])
    })
  })
})
