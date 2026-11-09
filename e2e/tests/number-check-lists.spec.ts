import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test, expect, type Page, type WebSocket } from '@playwright/test'

import { GW, ancestor, arg, condition, gatewayFixture, gatewayVersions, routeConds, summary, writeGatewayStatus } from './number-check.gateway-shared'
import { CR_CRD, GWPOL_CRD, NUM_SVC, VPA17_MISSING, crInstances, numbersPolicies, vpa17, vpaFixture, vpaPrintsWideColumns, writeNumbersPolicyStatus, writeVpaStatus, writeWidgetStatus } from './number-check.cr-shared'

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
  // every column the API server's Table prints — the wide ones (priority 1) too — is on the screen
  allColumns?: boolean
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
      // a pod is in one state card, so they add up to the total: what names an error first, then what is being deleted
      const error = (p: Obj) => p.status.phase === 'Failed' || reasonError(p)
      const other = list.filter((p) => !error(p) && !p.metadata.deletionTimestamp)
      const terminating = list.filter((p) => !error(p) && p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded')
      return {
        Total: list.length,
        Ready: running.filter((p) => other.includes(p) && allReady(p)).length,
        'Not Ready': running.filter((p) => other.includes(p) && !allReady(p)).length,
        Pending: other.filter((p) => p.status.phase === 'Pending').length,
        Terminating: terminating.length,
        Error: list.filter(error).length,
        Restarted: list.filter((p) => restarts(p) > 0).length,
        Completed: list.filter((p) => !error(p) && p.status.phase === 'Succeeded').length,
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
    // num-fail's Duration runs on (start to now, as kubectl's printJob) — to the second while the Job is new; num-held never started
    spans: { Duration: (o) => !!o.status.startTime && !o.status.completionTime },
    skip: { Age: AGE },
    // Suspended as kubectl's printJob reads it: not ended, not being deleted, a Suspended condition
    cards: (list) => {
      const ended = (j: Obj) => cond(j, 'Complete') === 'True' || cond(j, 'Failed') === 'True'
      const suspended = (j: Obj) => !ended(j) && !j.metadata.deletionTimestamp && cond(j, 'Suspended') === 'True'
      return {
        Total: list.length,
        Completed: list.filter((j) => cond(j, 'Complete') === 'True').length,
        Failed: list.filter((j) => cond(j, 'Failed') === 'True').length,
        Suspended: list.filter(suspended).length,
        Running: list.filter((j) => !ended(j) && !suspended(j)).length,
      }
    },
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
      Ports: (o) => (o.spec.ports ?? []).map((p: Obj) => `${p.protocol ?? 'TCP'} ${p.port}->${p.targetPort ?? p.port}${p.nodePort ? ` (node:${p.nodePort})` : ''}`).join(', ') || '-',
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

// Gateway API screens on test2, with number-check.gateway-fixture.yaml (number-check.gateway-shared.ts): the CRDs
// print few columns (Hostnames, a GatewayClass's Controller, a Gateway's Class), so most are compared with what the
// objects say
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
// live updates that empty a value, which a row merged with the update kept (and three kinds had no live updates)
const GATEWAY_LIVE: { path: string; name: string; column: string; want: string; change: string }[] = [
  { path: '/gateway/gatewayclasses', name: 'num-gc-ready', column: 'Parameters Ref', want: '-', change: `patch gatewayclass num-gc-ready --type=json -p=${arg([{ op: 'remove', path: '/spec/parametersRef' }])}` },
  { path: '/gateway/gateways', name: 'num-gw-a', column: 'Conditions', want: 'Unknown', change: `patch gateway num-gw-a -n ${NS} --subresource=status --type=merge -p=${arg({ status: { conditions: [] } })}` },
  { path: '/gateway/httproutes', name: 'num-http-a', column: 'Hostnames', want: '*', change: `patch httproute num-http-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/hostnames' }])}` },
  { path: '/gateway/grpcroutes', name: 'num-grpc-a', column: 'Hostnames', want: '*', change: `patch grpcroute num-grpc-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/hostnames' }])}` },
  { path: '/gateway/referencegrants', name: 'num-rg-a', column: 'From', want: 'HTTPRoute (web)', change: `patch referencegrant num-rg-a -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/from/1' }])}` },
  { path: '/gateway/backendtlspolicies', name: 'num-btls-a', column: 'Status', want: '-', change: `patch backendtlspolicy num-btls-a -n ${NS} --subresource=status --type=merge -p=${arg({ status: { ancestors: [] } })}` },
]

// the VPA screen on test2, with number-check.vpa-fixture.yaml (number-check.cr-shared.ts): Provided is the
// RecommendationProvided condition, as the CRD's printer column reads it (num-vpa-b lists another condition first);
// the wide columns MinReplicas and OOMSeconds (VPA 1.7) are on the screen too
const vpaProvided = (o: Obj) => (o.status?.conditions ?? []).find((c: Obj) => c.type === 'RecommendationProvided')?.status === 'True'
const VPA_SCREEN: Screen = {
  path: '/workloads/vpas', api: `/apis/autoscaling.k8s.io/v1/namespaces/${NS}/verticalpodautoscalers`, plural: 'verticalpodautoscalers', cluster: 'test2',
  allColumns: true,
  alias: { Memory: 'Mem' },
  extra: { Reference: (o) => (o.spec.targetRef ? `${o.spec.targetRef.kind}/${o.spec.targetRef.name}` : '-') },
  skip: { Age: AGE },
  cards: (list) => ({ Total: list.length, Provided: list.filter(vpaProvided).length, 'Not Provided': list.filter((o) => !vpaProvided(o)).length }),
}
const registeredOn = async (page: Page, id: string) => {
  const body = await (await page.request.get('/api/v1/clusters')).json()
  return (Array.isArray(body) ? body : body.items ?? []).some((c: Obj) => c.id === id)
}

// the custom resource instances screen on test2: number-check.cr-crd.yaml's Widget (number-check.cr-shared.ts) sits next
// to test2's widgets.qa.example.com, whose Kind is Widget too; one CRD's columns are its printer columns as the API
// server prints them
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
// Gateway API's, so the screen names it with its group (number-check.cr-shared.ts)
const GWPOL = { path: '/gateway/policies', cluster: 'test2' }
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
// the Helm releases screen on self: Helm keeps each revision of a release in its own Secret (type helm.sh/release.v1,
// labels name, owner=helm, status, version), the payload base64 of gzipped JSON — written here by hand in e2e-numbers,
// so the dev install's own release is not touched; the screen shows each release's newest revision
const HELM = { path: '/helm/releases', cluster: 'self' }
const helmSecret = (name: string, version: number, status: string) => {
  const at = new Date().toISOString()
  const release = {
    name, namespace: NS, version, config: {}, manifest: '',
    info: { status, first_deployed: at, last_deployed: at, description: `number check ${status}` },
    chart: { metadata: { apiVersion: 'v2', name: 'num-chart', version: '0.1.0', appVersion: '1.0.0' } },
  }
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1',
    metadata: { name: `sh.helm.release.v1.${name}.v${version}`, namespace: NS, labels: { name, owner: 'helm', status, version: String(version) } },
    data: { release: Buffer.from(payload).toString('base64') },
  }
}
// every release's newest revision on the cluster, from the Secrets' labels
function helmReleases(): { key: string; ns: string; name: string; revision: number; status: string }[] {
  const newest = new Map<string, { key: string; ns: string; name: string; revision: number; status: string }>()
  for (const line of on(HELM.cluster).kubectl(`get secrets -A -l owner=helm -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.labels.name} {.metadata.labels.version} {.metadata.labels.status}{"\\n"}{end}'`).split('\n').filter(Boolean)) {
    const [ns, name, version, status] = line.split(' ')
    const key = `${ns}/${name}`
    if ((newest.get(key)?.revision ?? 0) < Number(version)) newest.set(key, { key, ns, name, revision: Number(version), status })
  }
  return [...newest.values()]
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
  if (s.allColumns) {
    const shownCols = heads.map((h) => norm(s.alias?.[h] ?? h))
    const missing = fresh.columnDefinitions.map((c) => c.name).filter((c) => !shownCols.includes(norm(c)) && s.skip?.[c] === undefined)
    expect.soft(missing, `${s.path} (${way}): kubectl's columns (-o wide too) not on the screen`).toEqual([])
  }
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
    // addresses no controller will write over: kind has no load balancer controller
    kubectl(`patch service num-lb-both -n ${NS} --subresource=status --type=merge -p=${arg({ status: { loadBalancer: { ingress: [{ ip: '192.0.2.40' }, { hostname: 'lb.numbers.example' }, { ip: '192.0.2.31' }] } } })}`)
    // settled: the ready Deployment and the StatefulSet ready, both Jobs finished or suspended, the crashing Pod restarted,
    // the two pods that are never ready Running (the first test reads their phase), the sidecar's pod up
    const deadline = Date.now() + 150_000
    for (;;) {
      const got = kubectl(`get deploy/num-ready sts/num-db job/num-done job/num-fail pod/num-crash -n ${NS} -o jsonpath='{.items[*].status.readyReplicas} {.items[*].status.succeeded} {.items[*].status.failed} {.items[4].status.containerStatuses[0].restartCount}'`)
      const [deployReady, stsReady, , , restarts] = got.split(/\s+/)
      const jobs = items('jobs')
      const done = jobs.every((j) => cond(j, j.spec.suspend ? 'Suspended' : 'Complete') === 'True' || cond(j, 'Failed') === 'True')
      const pods = items('pods')
      const notReady = pods.filter((p) => p.metadata.labels?.app === 'num-notready')
      const notReadyRunning = notReady.length === 2 && notReady.every((p) => p.status.phase === 'Running')
      const sidecar = pods.find((p) => p.metadata.name === 'num-sidecar')?.status
      const sidecarUp = sidecar?.phase === 'Running' && [...(sidecar.initContainerStatuses ?? []), ...(sidecar.containerStatuses ?? [])].every((c: Obj) => c.ready)
      if (deployReady === '3' && stsReady === '2' && done && Number(restarts) >= 1 && notReadyRunning && sidecarUp) break
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
    const served = gatewayVersions((args) => on('test2').kubectl(args))
    const clusters = await (await page.request.get('/api/v1/clusters')).json()
    const registered = (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((c: Obj) => c.id === 'test2')
    test.skip(!served || !registered, 'needs the kind cluster test2, registered as test2, serving the Gateway API (experimental channel CRDs)')
    const t2 = on('test2')
    const screens = gatewayScreens(served!)
    const cellOf = async (p: Page, name: string, column: string) => {
      const { heads, rows } = await readScreen(p)
      return rows.find((r) => r[heads.findIndex((h) => /^name$/i.test(h))] === name)?.[heads.indexOf(column)]
    }
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', gatewayFixture(served!, NS))
    try {
      writeGatewayStatus(t2.kubectl, NS)
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
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', vpaFixture(NS))
    try {
      writeVpaStatus(t2.kubectl, NS)
      // VPA 1.7's wide columns: a VPA that sets them, where the CRD has them; on an older CRD the two columns are left out
      const wide = vpaPrintsWideColumns(t2.kubectl)
      const vpaWide = `num-vpa-wide-${Date.now().toString(36)}`
      if (wide) t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', JSON.stringify(vpa17(NS, vpaWide)))
      else test.info().annotations.push({ type: 'skip', description: `MinReplicas and OOMSeconds: ${VPA17_MISSING}` })
      const screen: Screen = wide ? VPA_SCREEN : { ...VPA_SCREEN, allColumns: false, skip: { ...VPA_SCREEN.skip, 'Min Replicas': VPA17_MISSING, 'OOM Seconds': VPA17_MISSING } }
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      const held = await page.context().newPage()
      await held.routeWebSocket(/wsMultiplexer/, () => {})
      for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })
      for (const [way, p] of [['list API', held], ['live', page]] as const) await test.step(`${VPA_SCREEN.path} · ${way}`, () => compareScreen(p, screen, way))
      await held.close()

      if (wide) {
        await test.step(`${VPA_SCREEN.path} · a live update that removes ${vpaWide}'s minReplicas`, async () => {
          await page.goto(screenUrl(VPA_SCREEN))
          await expect.poll(() => cellOf(page, vpaWide, 'Min Replicas'), { timeout: 20_000 }).toBe('2')
          t2.kubectl(`patch verticalpodautoscaler ${vpaWide} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/updatePolicy/minReplicas' }])}`)
          try {
            await expect.poll(() => cellOf(page, vpaWide, 'Min Replicas'), { timeout: 20_000 }).toBe('-')
          } catch {
            expect.soft(await cellOf(page, vpaWide, 'Min Replicas'), `${vpaWide} · Min Replicas after the live update`).toBe('-')
          }
          await compareScreen(page, screen, 'live, after minReplicas went', false)
        })
      }

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
        await compareScreen(page, screen, 'live, after the update', false)
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
      t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', crInstances(NS))
      writeWidgetStatus(t2.kubectl, NS)
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
          await page.getByRole('button', { name: 'All policies', exact: true }).click()
        } else {
          // nothing picked: close the list, the picker still reads All policies
          await page.getByTestId('policy-reports-policy').click()
        }
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
    const served = gatewayVersions((args) => on('test2').kubectl(args))
    test.skip(!served || !policyKinds().some((k) => k.plural === 'xbackendtrafficpolicies'), 'needs the Gateway API experimental-channel CRDs on test2')
    const t2 = on(GWPOL.cluster)
    t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', GWPOL_CRD)
    try {
      t2.kubectl('wait --for=condition=Established crd/backendtlspolicies.numbers.kubeast.io --timeout=60s')
      const xbtp = policyKinds().find((k) => k.plural === 'xbackendtrafficpolicies')!
      const objects = [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
        ...numbersPolicies(NS),
        { apiVersion: `${GW}/${served!.backendtlspolicies}`, kind: 'BackendTLSPolicy', metadata: { name: 'num-gp-up', namespace: NS },
          spec: { targetRefs: [NUM_SVC], validation: { hostname: 'num-svc.e2e-numbers.svc', wellKnownCACertificates: 'System' } } },
        { apiVersion: `${xbtp.group}/${xbtp.version}`, kind: xbtp.kind, metadata: { name: 'num-gp-x', namespace: NS }, spec: { targetRefs: [NUM_SVC] } },
      ]
      t2.kubectl('apply --server-side --field-manager=e2e-numbers -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }))
      // what an implementation would write: accepted by its one Gateway, by one of two, by the other; num-gp-x says nothing
      const status = (plural: string, group: string, name: string, s: Obj) =>
        t2.kubectl(`patch ${plural}.${group} ${name} -n ${NS} --subresource=status --type=merge -p=${arg({ status: s })}`)
      writeNumbersPolicyStatus(t2.kubectl, NS)
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

  // the Helm releases screen on self: its cards and rows are each release's newest revision, it follows the release
  // Secrets live, and a revision Helm prunes past --history-max (the oldest) leaves its release on screen
  test('the Helm releases screen counts each release by its newest revision, and a pruned old revision keeps it', async ({ page }) => {
    test.setTimeout(300_000)
    const k = on(HELM.cluster)
    const put = (...secrets: Obj[]) => k.kubectl('apply -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: secrets }))
    const drop = (name: string, ...versions: number[]) => k.kubectl(`delete -n ${NS} ${versions.map((v) => `secret/sh.helm.release.v1.${name}.v${v}`).join(' ')}`)
    put(
      helmSecret('num-rel', 1, 'superseded'), helmSecret('num-rel', 2, 'superseded'), helmSecret('num-rel', 3, 'deployed'),
      helmSecret('num-fail', 1, 'failed'), helmSecret('num-pend', 1, 'deployed'), helmSecret('num-pend', 2, 'pending-upgrade'),
      helmSecret('num-old', 1, 'uninstalled'),
    )
    try {
      const want = () => {
        const all = helmReleases()
        const count = (f: (s: string) => boolean) => all.filter((r) => f(r.status)).length
        return {
          cards: { Total: all.length, Deployed: count((s) => s === 'deployed'), Failed: count((s) => s === 'failed'), Pending: count((s) => s.startsWith('pending')), Superseded: count((s) => s === 'superseded') },
          rows: all.filter((r) => r.ns === NS).map((r) => `${r.name} | ${r.revision} | ${r.status}`).sort(),
        }
      }
      const shown = async () => {
        const { heads, rows, cards } = await readScreen(page)
        const at = (h: string) => heads.indexOf(h)
        return {
          cards: { Total: cards.Total, Deployed: cards.Deployed, Failed: cards.Failed, Pending: cards.Pending, Superseded: cards.Superseded },
          rows: rows.filter((r) => r[at('Namespace')] === NS).map((r) => `${r[at('Name')]} | ${r[at('Revision')]} | ${r[at('Status')]}`).sort(),
        }
      }
      const compare = async (what: string) => {
        try {
          await expect.poll(shown, { timeout: 20_000 }).toEqual(want())
        } catch {
          expect.soft(await shown(), what).toEqual(want())
        }
      }
      await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
      await page.setViewportSize({ width: 2560, height: 1200 })
      await page.goto(`${HELM.path}?cluster=${HELM.cluster}`)

      await test.step('every release by its newest revision: the rows and the cards', () => compare('the list'))
      await test.step('Helm prunes num-rel revision 1 (the oldest): the release stays at revision 3', async () => {
        drop('num-rel', 1)
        // a later change in the same stream: once it shows, the pruning before it has been taken in
        put(helmSecret('num-fail', 2, 'deployed'))
        await expect.poll(async () => (await shown()).rows, { timeout: 20_000 }).toContain('num-fail | 2 | deployed')
        await compare('after an old revision was pruned')
      })
      await test.step('num-rel uninstalled (every revision deleted): the release leaves the list', async () => {
        drop('num-rel', 2, 3)
        await compare('after an uninstall')
      })
    } finally {
      k.kubectl(`delete secrets -n ${NS} -l owner=helm --ignore-not-found`)
    }
  })

  // the Helm releases screen's Refresh reads the cluster past the server's 30-second list cache (a release written
  // outside Kubeast does not clear it), and its namespace picker offers every namespace with the choice in the address
  test('the Helm releases Refresh reads the cluster again, and the namespace picker keeps every namespace', async ({ page }) => {
    test.setTimeout(180_000)
    const k = on(HELM.cluster)
    const names = async (force: boolean) => ((await (await page.request.get(
      `/api/v1/helm/releases?cluster=${HELM.cluster}&namespace=${NS}${force ? '&force_refresh=true' : ''}`)).json()).items ?? []).map((r: Obj) => r.name)
    try {
      await test.step('the API: a list read now is kept; a release written right after shows on a forced read', async () => {
        expect(await names(false)).not.toContain('num-ext')
        k.kubectl('apply -f -', JSON.stringify(helmSecret('num-ext', 1, 'deployed')))
        expect(await names(false), 'the cached list, read again within 30 s').not.toContain('num-ext')
        expect.soft(await names(true), 'a forced read').toContain('num-ext')
      })
      await page.goto(`${HELM.path}?cluster=${HELM.cluster}&namespace=${NS}`)
      await test.step('the Refresh button asks for the forced read', async () => {
        const [req] = await Promise.all([
          page.waitForRequest((r) => r.url().includes('/helm/releases?') && r.url().includes('force_refresh=true'), { timeout: 10_000 }).catch(() => null),
          page.getByRole('button', { name: 'Refresh', exact: true }).click(),
        ])
        expect.soft(req?.url() ?? 'no forced request', 'the Refresh request').toContain(`namespace=${NS}`)
      })
      await test.step('the picker: the namespace from the address, every namespace offered, the next choice kept on reload', async () => {
        await expect.soft(page.getByTestId('helm-namespace'), 'the address picks the namespace').toHaveText(NS)
        await page.getByTestId('helm-namespace').click()
        const offered = await page.locator('[data-testid^="helm-namespace-opt-"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-testid')!.replace('helm-namespace-opt-', '')).filter((n) => n !== 'all').sort())
        const all = k.kubectl(`get namespaces -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}'`).split('\n').filter(Boolean).sort()
        expect.soft(offered, 'every namespace of the cluster, whichever is picked').toEqual(all)
        await page.getByTestId('helm-namespace-opt-kubeast').click()
        await expect.poll(() => new URL(page.url()).searchParams.get('namespace'), { timeout: 10_000 }).toBe('kubeast')
        await page.reload()
        await expect(page.getByTestId('helm-namespace')).toHaveText('kubeast')
      })
    } finally {
      k.kubectl(`delete secrets -n ${NS} -l owner=helm --ignore-not-found`)
    }
  })

  // A live update carries the list's own row (internal/ingress, cronjob, volumeattachment, service, endpoints,
  // ingressclass, networkpolicy and pv), so the row it leaves reads as a fresh read of the list API does, a value that
  // went away included. The objects are made here and removed after.
  test('a live update leaves a row as the list API shows it, emptied values too', async ({ page }) => {
    test.setTimeout(600_000)
    const ING = 'num-live-ing'
    const CRON = 'num-live-cron'
    const VA = 'num-live-va'
    const SVC = 'num-live-svc'
    const EP = 'num-live-ep'
    const CLASS = 'num-live-class'
    const NP = 'num-live-np'
    const PV = 'num-live-pv'
    const RS = 'num-live-rs'
    const HPA = 'num-live-hpa'
    const CM = 'num-live-cm'
    const SECRET = 'num-live-secret'
    const SA = 'num-live-sa'
    const ROLE = 'num-live-role'
    const DS = 'num-live-ds'
    const JOB = 'num-live-job'
    const POD = 'num-live-pod'
    const ENV_VALUE = 'fake-env-value-for-tests'
    const SECRET_VALUE = 'fake-secret-value-for-tests'
    const SECRET_ENCODED = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXRlc3Rz'
    const CONFIG_VALUE = 'fake-config-value-for-tests'
    const screenOf =(path: string) => [...SCREENS, ...SCREENS_CLUSTER].find((s) => s.path === path) as Screen
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')

    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    const held = await page.context().newPage()
    await held.routeWebSocket(/wsMultiplexer/, () => {})
    for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })

    // what a page shows of one object: the cells by column (no Age, which moves), their hover text as title:<column>, and the cards
    const shows = async (p: Page, name: string) => {
      const { heads, rows, cards } = await readScreen(p)
      const row = rows.find((cells) => cells[heads.findIndex((h) => /^name$/i.test(h))] === name) ?? []
      const titles = await p.locator('main tbody tr').filter({ has: p.getByRole('cell', { name, exact: true }) }).locator('td')
        .evaluateAll((tds) => tds.map((td) => td.getAttribute('title') ?? td.querySelector('[title]')?.getAttribute('title') ?? ''))
      const columns = heads.map((h, i) => [h, i] as const).filter(([h]) => h !== 'Age')
      return {
        row: Object.fromEntries([...columns.map(([h, i]) => [h, row[i]]), ...columns.map(([h, i]) => [`title:${h}`, titles[i]])]),
        cards,
      }
    }
    // the screen, with the watch past its first events
    const watching = async (s: Screen, name: string) => {
      const socket = page.waitForEvent('websocket', (ws) => /wsMultiplexer/.test(ws.url()))
      await page.goto(screenUrl(s))
      await (await socket).waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes(name), timeout: 20_000 })
    }
    // the changes, then the live row holds the values they should leave and a fresh read of the list API reads the same
    const follows = async (s: Screen, name: string, changes: string[], wants: Record<string, unknown>) => {
      for (const change of changes) kubectl(change)
      const live = async () => {
        const { row } = await shows(page, name)
        return Object.fromEntries(Object.keys(wants).map((k) => [k, row[k]]))
      }
      await expect.poll(live, { timeout: 20_000, message: `${name}: the row after a live update` }).toEqual(wants)
      const after = await shows(page, name)
      await expect.poll(async () => {
        await held.goto(screenUrl(s))
        // the page's first answer, or there is nothing to read yet and each round of this poll opens it again
        await held.getByRole('cell', { name, exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {})
        return shows(held, name)
      }, { timeout: 40_000, message: `${name}: a fresh read of the list API` }).toEqual(after)
    }
    // what one object's live frames say after a change: the change is made once the watch runs, and the last frame of it
    // is held to the row the list API gives for the same object
    const frameIsTheListRow = async (s: Screen | string, name: string, listPath: string, change: string, forbidden: string[] = []) => {
      const frames: string[] = []
      const collect = (ws: WebSocket) => {
        if (/wsMultiplexer/.test(ws.url())) ws.on('framereceived', (f) => { if (String(f.payload).includes(`"${name}"`)) frames.push(String(f.payload)) })
      }
      page.on('websocket', collect)
      await page.goto(typeof s === 'string' ? s : screenUrl(s))
      await expect.poll(() => frames.length, { timeout: 20_000, message: `${name}: the watch's first frame` }).toBeGreaterThan(0)
      const before = frames.length
      kubectl(change)
      await expect.poll(() => frames.length, { timeout: 20_000, message: `${name}: the frame of the change` }).toBeGreaterThan(before)
      const listed = async () => (await (await page.request.get(`/api/v1/cluster/namespaces/${NS}/${listPath}?cluster=self&force_refresh=true`)).json()) as Obj[]
      await expect(async () => {
        const row = (await listed()).find((r) => r.name === name)
        expect(JSON.parse(frames[frames.length - 1]).data.object, `${name}: the live frame is the list row`).toEqual(row)
      }).toPass({ timeout: 20_000 })
      const list = JSON.stringify(await listed())
      for (const value of forbidden) {
        expect.soft(frames.join('\n'), `${name}: a live frame holds no value`).not.toContain(value)
        expect.soft(list, `${name}: the list API holds no value`).not.toContain(value)
      }
      page.off('websocket', collect)
    }

    try {
      await test.step('an Ingress that lost its class, rules, TLS and address shows none', async () => {
        const s = screenOf('/network/ingresses')
        const patch = (ops: Obj[]) => `patch ingress ${ING} -n ${NS} --type=json -p=${arg(ops)}`
        const lbStatus = (ingress: Obj) => `patch ingress ${ING} -n ${NS} --subresource=status --type=merge -p=${arg({ status: { loadBalancer: { ingress } } })}`
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: { name: ING, namespace: NS },
          spec: {
            ingressClassName: 'num-live',
            tls: [{ hosts: ['live.numbers.example'], secretName: 'num-live-tls' }],
            rules: [{ host: 'live.numbers.example', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'num-db', port: { number: 5432 } } } }] } }],
          },
        }))
        kubectl(lbStatus([{ ip: '192.0.2.10' }]))
        await watching(s, ING)
        await follows(s, ING, [], { Class: 'num-live', Hosts: 'live.numbers.example', Routes: 'live.numbers.example:/', Address: '192.0.2.10' })
        await follows(s, ING, [
          patch([
            { op: 'remove', path: '/spec/ingressClassName' },
            { op: 'remove', path: '/spec/tls' },
            { op: 'remove', path: '/spec/rules' },
            { op: 'add', path: '/spec/defaultBackend', value: { service: { name: 'num-db', port: { number: 5432 } } } },
          ]),
          lbStatus(null),
        ], { Class: '-', Hosts: '-', Routes: '-', Address: '-' })
      })

      await test.step('a CronJob follows its time zone and last run, and shows none once they are gone', async () => {
        const s = screenOf('/workloads/cronjobs')
        const specPatch = (ops: Obj[]) => `patch cronjob ${CRON} -n ${NS} --type=json -p=${arg(ops)}`
        const statusPatch = (ops: Obj[]) => `patch cronjob ${CRON} -n ${NS} --subresource=status --type=json -p=${arg(ops)}`
        // the first of a month six months away: no run comes due while the test reads the row
        const month = ((new Date().getUTCMonth() + 6) % 12) + 1
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'batch/v1',
          kind: 'CronJob',
          metadata: { name: CRON, namespace: NS },
          spec: {
            schedule: `0 0 1 ${month} *`,
            timeZone: 'Asia/Seoul',
            jobTemplate: { spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'app', image: 'busybox:1.37', command: ['true'] }] } } } },
          },
        }))
        kubectl(statusPatch([{ op: 'add', path: '/status/lastScheduleTime', value: ago(10) }]))
        await watching(s, CRON)
        await follows(s, CRON, [], { 'Last Schedule': '10d', 'title:Next Run': expect.stringContaining('Asia/Seoul') })
        await follows(s, CRON, [
          specPatch([{ op: 'replace', path: '/spec/timeZone', value: 'Etc/UTC' }]),
          statusPatch([{ op: 'replace', path: '/status/lastScheduleTime', value: ago(3) }]),
        ], { 'Last Schedule': '3d', 'title:Next Run': expect.stringContaining('Etc/UTC') })
        await follows(s, CRON, [
          specPatch([{ op: 'remove', path: '/spec/timeZone' }]),
          statusPatch([{ op: 'remove', path: '/status/lastScheduleTime' }]),
        ], { 'Last Schedule': '-', 'title:Next Run': expect.not.stringMatching(/Asia\/Seoul|Etc\/UTC/) })
      })

      await test.step('a VolumeAttachment reads its state from each update, and no error stays after it clears', async () => {
        const s = screenOf('/storage?tab=volumeattachments')
        const status = (st: Obj) => `patch volumeattachment ${VA} --subresource=status --type=merge -p=${arg({ status: st })}`
        const at = ago(1)
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'storage.k8s.io/v1',
          kind: 'VolumeAttachment',
          metadata: { name: VA },
          spec: { attacher: 'numbers.kubeast.io', nodeName: 'kubeast-control-plane', source: { persistentVolumeName: 'num-live-pv' } },
        }))
        kubectl(status({ attached: false, attachError: { time: at, message: 'num-live attach failed' } }))
        await watching(s, VA)
        await follows(s, VA, [], { Attached: 'Error', Error: 'num-live attach failed' })
        await follows(s, VA, [status({ attached: true, attachError: null })], { Attached: 'Attached', Error: '-' })
        await follows(s, VA, [status({ attached: true, detachError: { time: at, message: 'num-live detach failed' } })], { Attached: 'Error', Error: 'num-live detach failed' })
        await follows(s, VA, [status({ attached: false, detachError: null })], { Attached: 'Detached', Error: '-' })
      })

      await test.step('a Service that became ExternalName shows no cluster IP, port or selector', async () => {
        const s = screenOf('/network/services')
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: SVC, namespace: NS },
          spec: { selector: { app: 'num-live' }, ports: [{ name: 'http', port: 80, targetPort: 8080 }] },
        }))
        await watching(s, SVC)
        await follows(s, SVC, [], { Type: 'ClusterIP', Ports: 'TCP 80->8080', Selector: 'app=num-live' })
        await follows(s, SVC, [
          `patch service ${SVC} -n ${NS} --type=merge -p=${arg({ spec: { type: 'ExternalName', externalName: 'live.numbers.example', ports: null, selector: null } })}`,
        ], { Type: 'ExternalName', 'Cluster IP': '-', 'External IP': 'live.numbers.example', Ports: '-', Selector: '-' })
      })

      await test.step('Endpoints show the addresses each update leaves, and none once their subsets are gone', async () => {
        const s = screenOf('/network/endpoints')
        const port = { name: 'http', port: 80, protocol: 'TCP' }
        const subsets = (value: Obj | null) => `patch endpoints ${EP} -n ${NS} --type=merge -p=${arg({ subsets: value })}`
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'Endpoints',
          metadata: { name: EP, namespace: NS },
          subsets: [{ addresses: [{ ip: '192.0.2.20' }], notReadyAddresses: [{ ip: '192.0.2.21' }], ports: [port] }],
        }))
        await watching(s, EP)
        await follows(s, EP, [], { Addresses: '192.0.2.20 | not-ready: 192.0.2.21', Ports: 'http:80/TCP', Ready: '1', 'Not Ready': '1' })
        await follows(s, EP, [subsets([{ addresses: [{ ip: '192.0.2.20' }, { ip: '192.0.2.21' }], ports: [port] }])],
          { Addresses: '192.0.2.20, 192.0.2.21', Ports: 'http:80/TCP', Ready: '2', 'Not Ready': '0' })
        await follows(s, EP, [subsets(null)], { Addresses: '-', Ports: '-', Ready: '0', 'Not Ready': '0' })
      })

      await test.step('an IngressClass follows its parameters and its row goes when it is deleted', async () => {
        const s = screenOf('/network/ingressclasses')
        const names = async () => {
          const { heads, rows } = await readScreen(page)
          return rows.map((r) => r[heads.findIndex((h) => /^name$/i.test(h))])
        }
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'IngressClass',
          metadata: { name: CLASS },
          spec: { controller: 'numbers.kubeast.io/live', parameters: { apiGroup: 'numbers.kubeast.io', kind: 'Params', name: 'live', scope: 'Cluster' } },
        }))
        await watching(s, CLASS)
        await follows(s, CLASS, [], { Controller: 'numbers.kubeast.io/live', Default: 'No', Parameters: 'Params.numbers.kubeast.io/live (Cluster)' })
        await follows(s, CLASS, [`patch ingressclass ${CLASS} --type=json -p=${arg([{ op: 'remove', path: '/spec/parameters' }])}`],
          { Controller: 'numbers.kubeast.io/live', Default: 'No', Parameters: '-' })
        kubectl(`delete ingressclass ${CLASS} --wait=false`)
        await expect.poll(names, { timeout: 20_000, message: `${CLASS}: the row after the class was deleted` }).not.toContain(CLASS)
      })

      await test.step('a NetworkPolicy drops the rules it lost, and its drawer words the rules it has as the object does', async () => {
        const s = screenOf('/network/networkpolicies')
        const squash = (text: string) => text.replace(/\s+/g, '')
        // the drawer opened from the row on that page
        const opened = async (p: Page) => {
          await p.locator('main tbody tr').getByRole('cell', { name: NP, exact: true }).click()
          const drawer = p.locator(DRAWER).last()
          await expect(drawer).toContainText('NetworkPolicy Info', { timeout: 20_000 })
          const read = {
            peers: await p.getByTestId('netpol-rule-peers').allInnerTexts(),
            ports: await p.getByTestId('netpol-rule-ports').allInnerTexts(),
            text: squash(await drawer.innerText()),
          }
          await p.keyboard.press('Escape')
          return read
        }
        const rules = {
          peers: [
            'From: pods role=client in this namespace ; every pod in namespaces team=back ; pods tier in (a,b) in every namespace',
            'To: pods app=db in namespaces team=db',
          ],
          ports: ['Ports: TCP 8000-9000', 'Ports: TCP 5432'],
        }
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: { name: NP, namespace: NS, labels: { team: 'live' }, annotations: { note: 'kept' }, finalizers: ['numbers.kubeast.io/keep'] },
          spec: {
            podSelector: { matchLabels: { app: 'num-live' } },
            policyTypes: ['Ingress', 'Egress'],
            ingress: [{
              from: [
                { podSelector: { matchLabels: { role: 'client' } } },
                { namespaceSelector: { matchLabels: { team: 'back' } } },
                { podSelector: { matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }] }, namespaceSelector: {} },
              ],
              ports: [{ protocol: 'TCP', port: 8000, endPort: 9000 }],
            }],
            egress: [{ to: [{ podSelector: { matchLabels: { app: 'db' } }, namespaceSelector: { matchLabels: { team: 'db' } } }], ports: [{ protocol: 'TCP', port: 5432 }] }],
          },
        }))
        await watching(s, NP)
        await follows(s, NP, [], { 'Pod Selector': 'app=num-live', Types: 'Ingress, Egress', 'Ingress Rules': '1', 'Egress Rules': '1', 'Default Deny': '-' })
        // held has only the list API's row, page the row a live update left; each says what the object has
        for (const [way, p] of [['from the list API', held], ['from a live update', page]] as const) {
          const { peers, ports, text } = await opened(p)
          expect.soft({ peers, ports }, `${NP} drawer ${way}`).toEqual(rules)
          expect.soft(text, `${NP} drawer ${way}: its label`).toContain('team:live')
          expect.soft(text, `${NP} drawer ${way}: its annotation`).toContain('note:kept')
          expect.soft(text, `${NP} drawer ${way}: its finalizer`).toContain('numbers.kubeast.io/keep')
        }
        // a drawer left open follows the object, from the list and from a link on another page
        const egressTo = (app: string) => `patch networkpolicy ${NP} -n ${NS} --type=json -p=${arg([{ op: 'replace', path: '/spec/egress/0/to/0/podSelector/matchLabels/app', value: app }])}`
        await page.locator('main tbody tr').getByRole('cell', { name: NP, exact: true }).click()
        await expect(page.locator(DRAWER).last()).toContainText('NetworkPolicy Info', { timeout: 20_000 })
        kubectl(egressTo('db-next'))
        await expect.poll(() => page.getByTestId('netpol-rule-peers').allInnerTexts(), { timeout: 20_000, message: `${NP} open drawer after a change` })
          .toEqual([rules.peers[0], 'To: pods app=db-next in namespaces team=db'])
        await page.keyboard.press('Escape')
        await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=NetworkPolicy/${NS}/${NP}`)
        await expect(page.locator(DRAWER).last()).toContainText('NetworkPolicy Info', { timeout: 20_000 })
        await expect.poll(() => page.getByTestId('netpol-rule-peers').allInnerTexts(), { timeout: 20_000, message: `${NP} drawer by link` })
          .toEqual([rules.peers[0], 'To: pods app=db-next in namespaces team=db'])
        kubectl(egressTo('db'))
        await expect.poll(() => page.getByTestId('netpol-rule-peers').allInnerTexts(), { timeout: 20_000, message: `${NP} drawer by link after a change` })
          .toEqual(rules.peers)
        await watching(s, NP)
        await follows(s, NP, [`patch networkpolicy ${NP} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/ingress' }, { op: 'remove', path: '/spec/egress' }])}`],
          { 'Pod Selector': 'app=num-live', Types: 'Ingress, Egress', 'Ingress Rules': '0', 'Egress Rules': '0', 'Default Deny': 'Ingress + Egress' })
        const { peers, text } = await opened(page)
        expect.soft(peers, `${NP} drawer after its rules went`).toEqual([])
        expect.soft(text, `${NP} drawer after its rules went: its label`).toContain('team:live')
      })

      await test.step('a ReplicaSet freed of its owner shows none', async () => {
        const s = screenOf('/workloads/replicasets')
        const uid = kubectl(`get configmap num-cm -n ${NS} -o jsonpath={.metadata.uid}`)
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          metadata: { name: RS, namespace: NS, ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'num-cm', uid, controller: true }] },
          spec: {
            replicas: 0,
            selector: { matchLabels: { app: RS } },
            template: { metadata: { labels: { app: RS } }, spec: { containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }] } },
          },
        }))
        await watching(s, RS)
        await follows(s, RS, [], { Owner: 'ConfigMap/num-cm', Containers: 'app', Status: 'Idle' })
        await follows(s, RS, [`patch replicaset ${RS} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/metadata/ownerReferences' }])}`],
          { Owner: '-', Containers: 'app', Status: 'Idle' })
      })

      await test.step('an HPA frame carries the targets and readings the list row has', async () => {
        const s = screenOf('/workloads/hpas')
        // a target no scale can be read of: the controller leaves the status this test writes
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'autoscaling/v2',
          kind: 'HorizontalPodAutoscaler',
          metadata: { name: HPA, namespace: NS, labels: { team: 'live' } },
          spec: {
            scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'num-live-nowhere' },
            minReplicas: 2,
            maxReplicas: 5,
            metrics: [
              { type: 'Pods', pods: { metric: { name: 'qps' }, target: { type: 'AverageValue', averageValue: '10' } } },
              { type: 'External', external: { metric: { name: 'queue' }, target: { type: 'Value', value: '5' } } },
            ],
          },
        }))
        await frameIsTheListRow(s, HPA, 'hpas', `patch horizontalpodautoscaler ${HPA} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/metadata/labels' }])}`)
      })

      await test.step('a ConfigMap frame is the list row, with no value in it', async () => {
        const s = screenOf('/configuration/configmaps')
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: CM, namespace: NS, labels: { team: 'live' } },
          data: { b: CONFIG_VALUE, a: CONFIG_VALUE },
          binaryData: { c: 'eA==' },
        }))
        await frameIsTheListRow(s, CM, 'configmaps', `patch configmap ${CM} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/data/b' }, { op: 'remove', path: '/binaryData' }, { op: 'remove', path: '/metadata/labels' }])}`, [CONFIG_VALUE])
        await follows(s, CM, [], { Data: '1' })
      })

      await test.step('a Secret frame is the list row, with no value in it, and the row follows its keys', async () => {
        const s = screenOf('/configuration/secrets')
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          type: 'Opaque',
          metadata: {
            name: SECRET,
            namespace: NS,
            labels: { team: 'live' },
            annotations: { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ stringData: { password: SECRET_VALUE } }) },
          },
          data: { password: SECRET_ENCODED, user: SECRET_ENCODED },
        }))
        await frameIsTheListRow(s, SECRET, 'secrets', `patch secret ${SECRET} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/data/user' }, { op: 'remove', path: '/metadata/labels' }])}`, [SECRET_VALUE, SECRET_ENCODED])
        await follows(s, SECRET, [], { Type: 'Opaque', Data: '1' })
      })

      await test.step('a ServiceAccount shows the Secrets it lost, on its row, its card and an open Secret drawer', async () => {
        const s = screenOf('/security/serviceaccounts')
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: { name: SA, namespace: NS, labels: { team: 'live' }, annotations: { note: 'kept' } },
          secrets: [{ name: 'num-live-token' }],
          imagePullSecrets: [{ name: 'num-live-pull' }],
        }))
        await watching(s, SA)
        await follows(s, SA, [], { Secrets: '1' })
        await follows(s, SA, [`patch serviceaccount ${SA} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/secrets' }, { op: 'remove', path: '/imagePullSecrets' }, { op: 'remove', path: '/metadata/labels' }])}`], { Secrets: '0' })

        // the Secret drawer's "Used By ServiceAccounts" takes a ServiceAccount's live rows
        await page.goto(`${screenUrl(screenOf('/configuration/secrets'))}&detail=Secret/${NS}/${SECRET}`)
        const drawer = page.locator(DRAWER).last()
        await expect(drawer).toContainText('Used By ServiceAccounts (0)', { timeout: 20_000 })
        kubectl(`patch serviceaccount ${SA} -n ${NS} --type=merge -p=${arg({ imagePullSecrets: [{ name: SECRET }] })}`)
        await expect(drawer).toContainText('Used By ServiceAccounts (1)', { timeout: 20_000 })
        await expect(drawer).toContainText(SA)
        kubectl(`patch serviceaccount ${SA} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/imagePullSecrets' }])}`)
        await expect(drawer).toContainText('Used By ServiceAccounts (0)', { timeout: 20_000 })
        await page.keyboard.press('Escape')
      })

      await test.step('a Role frame is the list row, and the row follows its rules', async () => {
        const s = screenOf('/security/roles')
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'Role',
          metadata: { name: ROLE, namespace: NS, labels: { team: 'live' }, annotations: { note: 'kept' } },
          rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }, { apiGroups: ['apps'], resources: ['deployments'], verbs: ['list'] }],
        }))
        await frameIsTheListRow(s, ROLE, 'roles', `patch role ${ROLE} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/rules/1' }, { op: 'remove', path: '/metadata/labels' }, { op: 'remove', path: '/metadata/annotations' }])}`)
        await follows(s, ROLE, [], { Rules: '1' })
      })

      await test.step('a PersistentVolume freed of its claim shows none, every other cell kept', async () => {
        const s = screenOf('/storage?tab=pvs')
        const kept = { StorageClass: 'num-live', Capacity: '1Gi', 'Access Modes': 'ReadWriteOnce', 'Reclaim Policy': 'Retain', 'Volume Mode': 'Filesystem', Source: 'HostPath' }
        // a claim uid no claim has: the volume controller reads it as a claim that went away, and leaves a Retain volume Released
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'PersistentVolume',
          metadata: { name: PV },
          spec: {
            capacity: { storage: '1024Mi' },
            accessModes: ['ReadWriteOnce'],
            persistentVolumeReclaimPolicy: 'Retain',
            storageClassName: 'num-live',
            hostPath: { path: '/tmp/num-live-pv' },
            claimRef: { namespace: NS, name: 'num-live-claim', uid: '00000000-0000-0000-0000-00000000aaaa' },
          },
        }))
        await watching(s, PV)
        await follows(s, PV, [], { ...kept, Status: 'Released', Claim: `${NS}/num-live-claim` })
        await follows(s, PV, [`patch persistentvolume ${PV} --type=json -p=${arg([{ op: 'remove', path: '/spec/claimRef' }])}`], { ...kept, Status: 'Available', Claim: '-' })
      })

      await test.step('a DaemonSet whose node selector went away shows none', async () => {
        const s = screenOf('/workloads/daemonsets')
        // an affinity no node meets, so no pod runs whatever the selector says
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'apps/v1',
          kind: 'DaemonSet',
          metadata: { name: DS, namespace: NS },
          spec: {
            selector: { matchLabels: { app: DS } },
            template: {
              metadata: { labels: { app: DS } },
              spec: {
                nodeSelector: { 'kubeast.io/e2e': 'nowhere' },
                affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubeast.io/e2e', operator: 'In', values: ['nowhere'] }] }] } } },
                containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }],
              },
            },
          },
        }))
        await watching(s, DS)
        await follows(s, DS, [], { 'Node Selector': 'kubeast.io/e2e=nowhere', Status: 'Idle' })
        await follows(s, DS, [`patch daemonset ${DS} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/spec/template/spec/nodeSelector' }])}`], { 'Node Selector': '-', Status: 'Idle' })
      })

      await test.step('a Job frame is the list row, its owner gone with the object', async () => {
        const s = screenOf('/workloads/jobs')
        const uid = kubectl(`get configmap num-cm -n ${NS} -o jsonpath={.metadata.uid}`)
        // suspended, so no pod runs and its Duration stays
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name: JOB, namespace: NS, ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'num-cm', uid, controller: true }] },
          spec: { suspend: true, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'app', image: 'busybox:1.37', command: ['true'] }] } } },
        }))
        await frameIsTheListRow(s, JOB, 'jobs', `patch job ${JOB} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/metadata/ownerReferences' }])}`)
        await follows(s, JOB, [], { Containers: 'app', Duration: '-' })
      })

      await test.step('a pod frame is the list row, with no environment value in it', async () => {
        // a node selector no node has: the pod stays Pending and no image is pulled. The ConfigMap drawer watches the namespace's pods.
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: POD, namespace: NS, labels: { team: 'live' } },
          spec: {
            nodeSelector: { 'kubeast.io/e2e': 'nowhere' },
            containers: [{ name: 'app', image: 'busybox:1.37', env: [{ name: 'MODE', value: ENV_VALUE }], envFrom: [{ configMapRef: { name: 'num-cm' } }] }],
          },
        }))
        await frameIsTheListRow(`/configuration/configmaps?cluster=self&namespace=${NS}&detail=ConfigMap/${NS}/num-cm`, POD, 'pods',
          `patch pod ${POD} -n ${NS} --type=json -p=${arg([{ op: 'remove', path: '/metadata/labels' }])}`, [ENV_VALUE])
        const drawer = page.locator(DRAWER).last()
        await expect(drawer).toContainText(POD, { timeout: 20_000 })
        await page.keyboard.press('Escape')
      })
    } finally {
      await held.close()
      kubectl(`delete ingress ${ING} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete cronjob ${CRON} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete volumeattachment ${VA} --ignore-not-found --wait=false`)
      kubectl(`delete service ${SVC} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete endpoints ${EP} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete ingressclass ${CLASS} --ignore-not-found --wait=false`)
      // its finalizer holds it until this removes it
      if (kubectl(`get networkpolicy ${NP} -n ${NS} --ignore-not-found -o name`)) {
        kubectl(`patch networkpolicy ${NP} -n ${NS} --type=merge -p=${arg({ metadata: { finalizers: null } })}`)
      }
      kubectl(`delete networkpolicy ${NP} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete persistentvolume ${PV} --ignore-not-found --wait=false`)
      kubectl(`delete replicaset ${RS} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete horizontalpodautoscaler ${HPA} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete configmap ${CM} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete secret ${SECRET} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete serviceaccount ${SA} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete role ${ROLE} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete daemonset ${DS} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete job ${JOB} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete pod ${POD} -n ${NS} --ignore-not-found --wait=false`)
    }
  })

  // An open drawer reads its answer again when its object changes, whichever page opened it, and what is on screen stays
  // meanwhile. No pod runs: nothing is scaled up, a selector no node meets, the Job and the CronJob suspended.
  test('an open workload or HPA drawer follows its object, opened from its list or by a link', async ({ page }) => {
    test.setTimeout(300_000)
    const labels = { app: 'num-follow' }
    const selector = { matchLabels: labels }
    const template = { metadata: { labels }, spec: { nodeSelector: { 'kubeast.io/e2e': 'nowhere' }, containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }] } }
    const objects: { kind: string; apiVersion: string; list: string; spec: Obj }[] = [
      { kind: 'Deployment', apiVersion: 'apps/v1', list: '/workloads/deployments', spec: { replicas: 0, selector, template } },
      { kind: 'ReplicaSet', apiVersion: 'apps/v1', list: '/workloads/replicasets', spec: { replicas: 0, selector, template } },
      { kind: 'StatefulSet', apiVersion: 'apps/v1', list: '/workloads/statefulsets', spec: { replicas: 0, serviceName: 'num-follow', selector, template } },
      { kind: 'DaemonSet', apiVersion: 'apps/v1', list: '/workloads/daemonsets', spec: { selector, template } },
      { kind: 'Job', apiVersion: 'batch/v1', list: '/workloads/jobs', spec: { suspend: true, template: { spec: { ...template.spec, restartPolicy: 'Never' } } } },
      { kind: 'CronJob', apiVersion: 'batch/v1', list: '/workloads/cronjobs', spec: { schedule: '0 9 * * *', suspend: true, jobTemplate: { spec: { template: { spec: { ...template.spec, restartPolicy: 'Never' } } } } } },
      {
        kind: 'HorizontalPodAutoscaler',
        apiVersion: 'autoscaling/v2',
        list: '/workloads/hpas',
        spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'num-follow-nowhere' }, minReplicas: 1, maxReplicas: 2 },
      },
    ]
    const name = (kind: string) => `num-follow-${kind.toLowerCase()}`
    const label = (kind: string, value: string) => kubectl(`label ${kind.toLowerCase()} ${name(kind)} -n ${NS} num-follow=${value} --overwrite`)
    try {
      for (const o of objects) {
        // A drawer draws its Labels section once there is a label.
        kubectl('apply -f -', JSON.stringify({ apiVersion: o.apiVersion, kind: o.kind, metadata: { name: name(o.kind), namespace: NS, labels: { 'e2e-follow': 'yes' } }, spec: o.spec }))
      }
      for (const o of objects) {
        await test.step(`${o.kind}: from its list, then by a link from another page`, async () => {
          const detail = `cluster=self&namespace=${NS}&detail=${o.kind}/${NS}/${name(o.kind)}`
          const drawer = page.locator(DRAWER).last()

          await page.goto(`${o.list}?${detail}`)
          await expect(drawer).toContainText(name(o.kind), { timeout: 20_000 })
          const section = drawer.getByText('Labels', { exact: true }).first()
          await expect(section).toBeVisible({ timeout: 20_000 })
          await expect(drawer).not.toContainText('num-follow:')
          // the same element after the update: the section was not drawn again from a loading state
          await section.evaluate((el) => el.setAttribute('data-e2e-kept', 'yes'))
          label(o.kind, 'one')
          await expect(drawer, `${o.kind} drawer opened from its list`).toContainText('num-follow:one', { timeout: 20_000 })
          await expect(section).toHaveAttribute('data-e2e-kept', 'yes')

          await page.goto(`/workloads/pods?${detail}`)
          await expect(drawer).toContainText('num-follow:one', { timeout: 20_000 })
          label(o.kind, 'two')
          await expect(drawer, `${o.kind} drawer opened by a link`).toContainText('num-follow:two', { timeout: 20_000 })
          await expect(drawer).not.toContainText('num-follow:one')
          kubectl(`label ${o.kind.toLowerCase()} ${name(o.kind)} -n ${NS} num-follow-`)
          await expect(drawer, `${o.kind} drawer after its label went`).not.toContainText('num-follow:', { timeout: 20_000 })
        })
      }
    } finally {
      for (const o of objects) kubectl(`delete ${o.kind.toLowerCase()} ${name(o.kind)} -n ${NS} --ignore-not-found --wait=false`)
    }
  })

  // These lists had no live updates: the server refused each watch as an unsupported resource. Each object is made here
  // and removed after; none limits a pod (a limit on claims only, a quota on ConfigMaps and Secrets, webhooks of a group
  // no API serves, no default PriorityClass).
  test('a live update of a binding, class, webhook, Lease, limit, quota, budget or definition leaves its row as the list API shows it', async ({ page }) => {
    test.setTimeout(480_000)
    const RBAC = 'rbac.authorization.k8s.io/v1'
    const ADMISSION = 'admissionregistration.k8s.io/v1'
    const namedInNs = (name: string) => ({ name, namespace: NS })
    const hook = (name: string) => ({
      name, admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Ignore',
      clientConfig: { url: 'https://num-live.invalid/' },
      rules: [{ apiGroups: ['num-live.invalid'], apiVersions: ['v1'], operations: ['CREATE'], resources: ['things'] }],
    })
    const subjects = [{ kind: 'ServiceAccount', name: 'num-sa', namespace: NS }, { kind: 'ServiceAccount', name: 'default', namespace: NS }]
    const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' }
    const crdVersion = (name: string, served: boolean, storage: boolean) => ({
      name, served, storage, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } },
    })
    const jsonPatch = (ops: Obj[]) => `--type=json -p=${arg(ops)}`
    const mergePatch = (patch: Obj) => `--type=merge -p=${arg(patch)}`
    // the kind as kubectl names it, its screen and list API, the object, the cells it should show, a change and the cells
    // that change leaves; another = a second object of the kind, which comes and goes on a screen short enough to hold it
    const kinds: { kind: string; path: string; list: string; object: Obj; cells: Record<string, string>; change: string; changed: Record<string, string>; another?: boolean }[] = [
      {
        kind: 'clusterrole', path: '/security/clusterroles', list: 'clusterroles',
        object: { apiVersion: RBAC, kind: 'ClusterRole', metadata: { name: 'num-live-cr' }, rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }, { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] }] },
        cells: { Rules: '2' }, change: jsonPatch([{ op: 'remove', path: '/rules/1' }]), changed: { Rules: '1' },
      },
      {
        kind: 'clusterrolebinding', path: '/security/clusterrolebindings', list: 'clusterrolebindings',
        object: { apiVersion: RBAC, kind: 'ClusterRoleBinding', metadata: { name: 'num-live-crb' }, roleRef, subjects },
        cells: { 'Role Ref': 'ClusterRole/view', Subjects: '2' }, change: jsonPatch([{ op: 'remove', path: '/subjects' }]), changed: { 'Role Ref': 'ClusterRole/view', Subjects: '0' },
      },
      {
        kind: 'rolebinding', path: '/security/rolebindings', list: `namespaces/${NS}/rolebindings`, another: true,
        object: { apiVersion: RBAC, kind: 'RoleBinding', metadata: namedInNs('num-live-rb'), roleRef, subjects },
        cells: { 'Role Ref': 'ClusterRole/view', Subjects: '2' }, change: jsonPatch([{ op: 'remove', path: '/subjects' }]), changed: { 'Role Ref': 'ClusterRole/view', Subjects: '0' },
      },
      {
        kind: 'priorityclass', path: '/cluster/priorityclasses', list: 'priorityclasses', another: true,
        object: { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'num-live-pc' }, value: 17, preemptionPolicy: 'Never', description: 'num-live' },
        cells: { Value: '17', 'Preemption Policy': 'Never' }, change: mergePatch({ description: 'num-live changed' }), changed: { Value: '17', 'Preemption Policy': 'Never' },
      },
      {
        kind: 'runtimeclass', path: '/cluster/runtimeclasses', list: 'runtimeclasses', another: true,
        object: { apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: { name: 'num-live-rc' }, handler: 'num-live' },
        cells: { Handler: 'num-live' }, change: mergePatch({ metadata: { labels: { 'num-live': 'yes' } } }), changed: { Handler: 'num-live' },
      },
      {
        kind: 'validatingwebhookconfiguration', path: '/cluster/validatingwebhookconfigurations', list: 'validatingwebhookconfigurations', another: true,
        object: { apiVersion: ADMISSION, kind: 'ValidatingWebhookConfiguration', metadata: { name: 'num-live-vwc' }, webhooks: [hook('one.num-live.invalid'), hook('two.num-live.invalid')] },
        cells: { Webhooks: '2' }, change: jsonPatch([{ op: 'remove', path: '/webhooks/1' }]), changed: { Webhooks: '1' },
      },
      {
        kind: 'mutatingwebhookconfiguration', path: '/cluster/mutatingwebhookconfigurations', list: 'mutatingwebhookconfigurations', another: true,
        object: { apiVersion: ADMISSION, kind: 'MutatingWebhookConfiguration', metadata: { name: 'num-live-mwc' }, webhooks: [hook('one.num-live.invalid'), hook('two.num-live.invalid')] },
        cells: { Webhooks: '2' }, change: jsonPatch([{ op: 'remove', path: '/webhooks/1' }]), changed: { Webhooks: '1' },
      },
      {
        kind: 'lease', path: '/cluster/leases', list: `namespaces/${NS}/leases`, another: true,
        object: { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: namedInNs('num-live-lease'), spec: { holderIdentity: 'num-live-holder', leaseDurationSeconds: 15 } },
        cells: { Holder: 'num-live-holder', 'Duration (s)': '15' },
        change: jsonPatch([{ op: 'remove', path: '/spec/holderIdentity' }, { op: 'remove', path: '/spec/leaseDurationSeconds' }]),
        changed: { Holder: '-', 'Duration (s)': '-' },
      },
      {
        kind: 'limitrange', path: '/cluster/limitranges', list: `namespaces/${NS}/limitranges`, another: true,
        object: { apiVersion: 'v1', kind: 'LimitRange', metadata: namedInNs('num-live-lr'), spec: { limits: [{ type: 'PersistentVolumeClaim', max: { storage: '100Gi' } }] } },
        cells: { Types: 'PersistentVolumeClaim' }, change: mergePatch({ spec: { limits: [] } }), changed: { Types: '-' },
      },
      {
        kind: 'resourcequota', path: '/cluster/resourcequotas', list: `namespaces/${NS}/resourcequotas`, another: true,
        object: { apiVersion: 'v1', kind: 'ResourceQuota', metadata: namedInNs('num-live-rq'), spec: { hard: { configmaps: '500', secrets: '500' } } },
        cells: { Resources: '2' }, change: mergePatch({ spec: { hard: { secrets: null } } }), changed: { Resources: '1' },
      },
      {
        kind: 'poddisruptionbudget', path: '/workloads/pdbs', list: `namespaces/${NS}/pdbs`, another: true,
        object: { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: namedInNs('num-live-pdb'), spec: { minAvailable: 1, selector: { matchLabels: { app: 'num-live-nothing' } } } },
        cells: { 'Min Available': '1', 'Max Unavailable': '-' },
        change: jsonPatch([{ op: 'remove', path: '/spec/minAvailable' }, { op: 'add', path: '/spec/maxUnavailable', value: '50%' }]),
        changed: { 'Min Available': '-', 'Max Unavailable': '50%' },
      },
      {
        kind: 'customresourcedefinition', path: '/custom-resources/groups', list: 'crds',
        object: {
          apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'numlives.numbers.kubeast.io' },
          spec: { group: 'numbers.kubeast.io', scope: 'Namespaced', names: { kind: 'NumLive', plural: 'numlives', singular: 'numlive', listKind: 'NumLiveList' }, versions: [crdVersion('v1', true, true), crdVersion('v1beta1', true, false)] },
        },
        cells: { Versions: 'v1 (storage), v1beta1' },
        change: mergePatch({ spec: { versions: [crdVersion('v1', true, true), crdVersion('v1beta1', false, false)] } }),
        changed: { Versions: 'v1 (storage)' },
      },
    ]
    const screenOf = (path: string) => [...SCREENS, ...SCREENS_CLUSTER].find((s) => s.path === path) as Screen
    const inNamespace = (o: Obj) => (o.metadata.namespace ? `-n ${o.metadata.namespace}` : '')

    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    const held = await page.context().newPage()
    await held.routeWebSocket(/wsMultiplexer/, () => {})
    for (const p of [held, page]) await p.setViewportSize({ width: 2560, height: 1200 })

    // one object's row by column (no Age, which moves), undefined while there is none, and the cards
    const shown = async (p: Page, name: string) => {
      const { heads, rows, cards } = await readScreen(p)
      const row = rows.find((cells) => cells[heads.findIndex((h) => /^name$/i.test(h))] === name)
      return { row: row && Object.fromEntries(heads.map((h, i) => [h, row[i]] as const).filter(([h]) => h !== 'Age')), cards }
    }
    const cellsOf = async (name: string, want: Record<string, string>) => {
      const { row } = await shown(page, name)
      return row && Object.fromEntries(Object.keys(want).map((k) => [k, row[k]]))
    }

    try {
      for (const k of kinds) {
        await test.step(`${k.kind}: from the list API, then live as it changes, comes and goes`, async () => {
          const s = screenOf(k.path)
          const name: string = k.object.metadata.name
          const listed = async () => {
            const answer = await page.request.get(`/api/v1/cluster/${k.list}?cluster=self&force_refresh=true`)
            return ((await answer.json()) as Obj[]).find((r) => r.name === name)
          }
          kubectl('apply -f -', JSON.stringify(k.object))

          const frames: string[] = []
          const collect = (ws: WebSocket) => {
            if (/wsMultiplexer/.test(ws.url())) ws.on('framereceived', (f) => { if (String(f.payload).includes(`"${name}"`)) frames.push(String(f.payload)) })
          }
          page.on('websocket', collect)
          try {
            await page.goto(screenUrl(s))
            await expect.poll(() => frames.length, { timeout: 20_000, message: `${k.kind}: the watch's first frame` }).toBeGreaterThan(0)
            await expect.poll(() => cellsOf(name, k.cells), { timeout: 20_000, message: `${k.kind}: the row as made` }).toEqual(k.cells)

            const before = frames.length
            kubectl(`patch ${k.kind} ${name} ${inNamespace(k.object)} ${k.change}`)
            await expect.poll(() => frames.length, { timeout: 20_000, message: `${k.kind}: the frame of the change` }).toBeGreaterThan(before)
            await expect.poll(() => cellsOf(name, k.changed), { timeout: 20_000, message: `${k.kind}: the row after a live update` }).toEqual(k.changed)
            await expect(async () => {
              expect(JSON.parse(frames[frames.length - 1]).data.object, `${k.kind}: the live frame is the list row`).toEqual(await listed())
            }).toPass({ timeout: 20_000 })

            // a fresh read of the list API reads what the update left
            const live = await shown(page, name)
            await expect.poll(async () => {
              await held.goto(screenUrl(s))
              await expect(held.locator('main tbody tr').filter({ has: held.getByRole('cell', { name, exact: true }) })).toHaveCount(1, { timeout: 20_000 })
              return shown(held, name)
            }, { timeout: 40_000, message: `${k.kind}: a fresh read of the list API` }).toEqual(live)

            if (k.another) {
              const other = `${name}-2`
              const made = { ...k.object, metadata: { ...k.object.metadata, name: other } }
              kubectl('apply -f -', JSON.stringify(made))
              await expect.poll(() => cellsOf(other, k.cells), { timeout: 20_000, message: `${k.kind}: a new object's row` }).toEqual(k.cells)
              kubectl(`delete ${k.kind} ${other} ${inNamespace(k.object)} --wait=false`)
              await expect.poll(async () => (await shown(page, other)).row, { timeout: 20_000, message: `${k.kind}: a deleted object's row` }).toBeUndefined()
            }

            kubectl(`delete ${k.kind} ${name} ${inNamespace(k.object)} --wait=false`)
            await expect.poll(async () => (await shown(page, name)).row, { timeout: 20_000, message: `${k.kind}: the row after its object went` }).toBeUndefined()
          } finally {
            page.off('websocket', collect)
          }
        })
      }
    } finally {
      await held.close()
      for (const k of kinds) {
        kubectl(`delete ${k.kind} ${k.object.metadata.name} ${inNamespace(k.object)} --ignore-not-found --wait=false`)
        if (k.another) kubectl(`delete ${k.kind} ${k.object.metadata.name}-2 ${inNamespace(k.object)} --ignore-not-found --wait=false`)
      }
    }
  })

  // The same drawers as a workload's: what they read is asked again when the object changes, whichever page opened them.
  test('an open drawer of a binding, class, webhook, limit, quota, budget or definition follows its object, and a role\'s and a ServiceAccount\'s its bindings', async ({ page }) => {
    test.setTimeout(420_000)
    const base = { 'num-follow-base': 'yes' }
    const subjects = [{ kind: 'ServiceAccount', name: 'num-sa', namespace: NS }]
    const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' }
    const hook = { name: 'one.num-follow.invalid', admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Ignore', clientConfig: { url: 'https://num-follow.invalid/' }, rules: [{ apiGroups: ['num-follow.invalid'], apiVersions: ['v1'], operations: ['CREATE'], resources: ['things'] }] }
    const objects: { kind: string; list: string; name: string; namespaced?: boolean; body: Obj }[] = [
      { kind: 'ClusterRole', list: '/security/clusterroles', name: 'num-follow-cr', body: { apiVersion: 'rbac.authorization.k8s.io/v1', rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }] } },
      { kind: 'ClusterRoleBinding', list: '/security/clusterrolebindings', name: 'num-follow-crb', body: { apiVersion: 'rbac.authorization.k8s.io/v1', roleRef, subjects } },
      { kind: 'RoleBinding', list: '/security/rolebindings', name: 'num-follow-rb', namespaced: true, body: { apiVersion: 'rbac.authorization.k8s.io/v1', roleRef, subjects } },
      { kind: 'PriorityClass', list: '/cluster/priorityclasses', name: 'num-follow-pc', body: { apiVersion: 'scheduling.k8s.io/v1', value: 18 } },
      { kind: 'RuntimeClass', list: '/cluster/runtimeclasses', name: 'num-follow-rc', body: { apiVersion: 'node.k8s.io/v1', handler: 'num-follow' } },
      { kind: 'ValidatingWebhookConfiguration', list: '/cluster/validatingwebhookconfigurations', name: 'num-follow-vwc', body: { apiVersion: 'admissionregistration.k8s.io/v1', webhooks: [hook] } },
      { kind: 'MutatingWebhookConfiguration', list: '/cluster/mutatingwebhookconfigurations', name: 'num-follow-mwc', body: { apiVersion: 'admissionregistration.k8s.io/v1', webhooks: [hook] } },
      { kind: 'LimitRange', list: '/cluster/limitranges', name: 'num-follow-lr', namespaced: true, body: { apiVersion: 'v1', spec: { limits: [{ type: 'PersistentVolumeClaim', max: { storage: '100Gi' } }] } } },
      { kind: 'ResourceQuota', list: '/cluster/resourcequotas', name: 'num-follow-rq', namespaced: true, body: { apiVersion: 'v1', spec: { hard: { configmaps: '500' } } } },
      { kind: 'PodDisruptionBudget', list: '/workloads/pdbs', name: 'num-follow-pdb', namespaced: true, body: { apiVersion: 'policy/v1', spec: { minAvailable: 1, selector: { matchLabels: { app: 'num-follow-nothing' } } } } },
      {
        kind: 'CustomResourceDefinition', list: '/custom-resources/groups', name: 'numfollows.numbers.kubeast.io',
        body: {
          apiVersion: 'apiextensions.k8s.io/v1',
          spec: { group: 'numbers.kubeast.io', scope: 'Namespaced', names: { kind: 'NumFollow', plural: 'numfollows' }, versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }] },
        },
      },
    ]
    const inNamespace = (o: { namespaced?: boolean }) => (o.namespaced ? `-n ${NS}` : '')
    const label = (o: (typeof objects)[number], value: string) => kubectl(`label ${o.kind.toLowerCase()} ${o.name} ${inNamespace(o)} num-follow=${value} --overwrite`)
    const drawer = page.locator(DRAWER).last()
    const binding = (kind: string, name: string, role: Obj, namespace?: string) =>
      JSON.stringify({ apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name, ...(namespace ? { namespace } : {}) }, roleRef: role, subjects })
    try {
      for (const o of objects) {
        const { body, ...named } = o
        kubectl('apply -f -', JSON.stringify({ ...body, kind: named.kind, metadata: { name: named.name, labels: base, ...(named.namespaced ? { namespace: NS } : {}) } }))
      }
      for (const o of objects) {
        await test.step(`${o.kind}: from its list, then by a link from another page`, async () => {
          const target = o.namespaced ? `${o.kind}/${NS}/${o.name}` : `${o.kind}/${o.name}`
          const detail = `cluster=self${o.namespaced ? `&namespace=${NS}` : ''}&detail=${target}`

          await page.goto(`${o.list}?${detail}`)
          await expect(drawer).toContainText('num-follow-base:yes', { timeout: 20_000 })
          const section = drawer.getByText('Labels', { exact: true }).first()
          // the same element after the update: the section was not drawn again from a loading state
          await section.evaluate((el) => el.setAttribute('data-e2e-kept', 'yes'))
          label(o, 'one')
          await expect(drawer, `${o.kind} drawer opened from its list`).toContainText('num-follow:one', { timeout: 20_000 })
          await expect(section).toHaveAttribute('data-e2e-kept', 'yes')

          await page.goto(`/workloads/pods?${detail}`)
          await expect(drawer).toContainText('num-follow:one', { timeout: 20_000 })
          label(o, 'two')
          await expect(drawer, `${o.kind} drawer opened by a link`).toContainText('num-follow:two', { timeout: 20_000 })
          await expect(drawer).not.toContainText('num-follow:one')
          kubectl(`label ${o.kind.toLowerCase()} ${o.name} ${inNamespace(o)} num-follow-`)
          await expect(drawer, `${o.kind} drawer after its label went`).not.toContainText('num-follow:', { timeout: 20_000 })
        })
      }

      await test.step('a CRD drawer reads its instances again when the CRD changes', async () => {
        const crd = objects.at(-1)!
        kubectl(`wait --for=condition=Established crd/${crd.name} --timeout=60s`)
        let reads = 0
        await page.route('**/api/v1/cluster/custom-resources/numbers.kubeast.io/v1/numfollows*', (route) => {
          reads += 1
          return route.fallback()
        })
        await page.goto(`/custom-resources/groups?cluster=self&detail=CustomResourceDefinition/${crd.name}`)
        await expect.poll(() => reads, { timeout: 20_000 }).toBeGreaterThan(0)
        await expect(drawer).not.toContainText('num-follow-inst')
        const before = reads
        kubectl('apply -f -', JSON.stringify({ apiVersion: 'numbers.kubeast.io/v1', kind: 'NumFollow', metadata: { name: 'num-follow-inst', namespace: NS } }))
        label(crd, 'three')
        await expect(drawer, 'the CRD itself').toContainText('num-follow:three', { timeout: 20_000 })
        await expect(drawer, 'the instance the new read found').toContainText('num-follow-inst', { timeout: 20_000 })
        expect(reads).toBeGreaterThan(before)
        await page.unroute('**/api/v1/cluster/custom-resources/numbers.kubeast.io/v1/numfollows*')
      })

      await test.step('a ClusterRole drawer lists its bindings as they come and go', async () => {
        const role = { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'num-follow-cr' }
        await page.goto(`/security/clusterroles?cluster=self&detail=ClusterRole/num-follow-cr`)
        await expect(drawer).toContainText('Referenced By ClusterRoleBindings (0)', { timeout: 20_000 })
        await expect(drawer).toContainText('Referenced By RoleBindings (0)', { timeout: 20_000 })
        kubectl('apply -f -', binding('ClusterRoleBinding', 'num-follow-ref-crb', role))
        kubectl('apply -f -', binding('RoleBinding', 'num-follow-ref-rb', role, NS))
        await expect(drawer, 'the ClusterRoleBinding that came').toContainText('Referenced By ClusterRoleBindings (1)', { timeout: 20_000 })
        await expect(drawer, 'the RoleBinding that came').toContainText('Referenced By RoleBindings (1)', { timeout: 20_000 })
        await expect(drawer).toContainText('num-follow-ref-crb')
        await expect(drawer).toContainText('num-follow-ref-rb')
        kubectl('delete clusterrolebinding num-follow-ref-crb --wait=false')
        kubectl(`delete rolebinding num-follow-ref-rb -n ${NS} --wait=false`)
        await expect(drawer, 'the ClusterRoleBinding that went').toContainText('Referenced By ClusterRoleBindings (0)', { timeout: 20_000 })
        await expect(drawer, 'the RoleBinding that went').toContainText('Referenced By RoleBindings (0)', { timeout: 20_000 })
      })

      await test.step("a ServiceAccount drawer's permissions follow the bindings that name it", async () => {
        await page.goto(`/security/serviceaccounts?cluster=self&namespace=${NS}&detail=ServiceAccount/${NS}/num-sa`)
        await expect(drawer).toContainText('num-sa', { timeout: 20_000 })
        await expect(drawer).not.toContainText('num-follow-sa-rb')
        kubectl('apply -f -', binding('RoleBinding', 'num-follow-sa-rb', roleRef, NS))
        await expect(drawer, 'the RoleBinding that came').toContainText('num-follow-sa-rb', { timeout: 20_000 })
        kubectl(`delete rolebinding num-follow-sa-rb -n ${NS} --wait=false`)
        await expect(drawer, 'the RoleBinding that went').not.toContainText('num-follow-sa-rb', { timeout: 20_000 })
      })
    } finally {
      kubectl('delete clusterrolebinding num-follow-ref-crb --ignore-not-found --wait=false')
      kubectl(`delete rolebinding num-follow-ref-rb num-follow-sa-rb -n ${NS} --ignore-not-found --wait=false`)
      for (const o of objects) kubectl(`delete ${o.kind.toLowerCase()} ${o.name} ${inNamespace(o)} --ignore-not-found --wait=false`)
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
      // the drawer's header comes before its fields: read it until every field is there, not once
      await expect.poll(async () => missing(await drawerText(), o), { timeout: 20_000, message: 'drawer opened by link' }).toEqual([])
    })
  })

  // the API server's Table for one Job, what kubectl prints, against the row a screen holds for it
  const JOBS = `/workloads/jobs?cluster=self&namespace=${NS}`
  const jobPrints = async (name: string) => {
    const table = await on().apiTable(`/apis/batch/v1/namespaces/${NS}/jobs/${name}`)
    const at = (column: string) => String(table.rows[0].cells[table.columnDefinitions.findIndex((c) => c.name === column)])
    return { Status: at('Status'), Completions: at('Completions') }
  }
  const jobRow = async (page: Page, name: string) => {
    const { heads, rows } = await readScreen(page)
    const row = rows.find((r) => r[heads.findIndex((h) => /^name$/i.test(h))] === name)
    return row ? { Status: row[heads.indexOf('Status')], Completions: row[heads.indexOf('Completions')] } : null
  }
  const jobBadge = (page: Page, name: string) => page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) }).locator('.badge').first()

  test('a suspended work queue reads Suspended and 0/1 of 3, drawn as a warning', async ({ page }) => {
    const name = 'num-held'
    await expect.poll(async () => (await jobPrints(name)).Status, { timeout: 20_000, message: 'kubectl prints' }).toBe('Suspended')
    expect((await jobPrints(name)).Completions, 'kubectl prints').toBe('0/1 of 3')
    await page.goto(JOBS)
    await expect.poll(() => jobRow(page, name), { timeout: 20_000 }).toEqual({ Status: 'Suspended', Completions: '0/1 of 3' })
    await expect(jobBadge(page, name)).toHaveClass(/badge-warning/)
  })

  // The finalizer keeps the Job while it is deleted; suspended, so no pod runs.
  test('a Job being deleted reads Terminating in its list and drawer, as kubectl prints it', async ({ page }) => {
    const name = 'num-leaving-job'
    try {
      kubectl('apply -f -', JSON.stringify({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, namespace: NS, finalizers: ['numbers.kubeast.io/hold'] },
        spec: { suspend: true, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['true'] }] } } },
      }))
      kubectl(`delete job ${name} -n ${NS} --wait=false`)
      const prints = await jobPrints(name)
      expect(prints.Status, 'kubectl prints').toBe('Terminating')
      await page.goto(JOBS)
      await expect.poll(() => jobRow(page, name), { timeout: 20_000 }).toEqual(prints)
      await expect(jobBadge(page, name)).toHaveClass(/badge-warning/)
      await page.goto(`${JOBS}&detail=${encodeURIComponent(`Job/${NS}/${name}`)}`)
      await expect(page.locator(DRAWER).last()).toContainText(/Status\s*Terminating/, { timeout: 20_000 })
    } finally {
      if (kubectl(`get job ${name} -n ${NS} --ignore-not-found -o name`)) kubectl(`patch job ${name} -n ${NS} --type=merge -p=${arg({ metadata: { finalizers: null } })}`)
    }
  })

  // The two conditions last until the Job's last pod has gone, which is told to stop once the other pod has ended. It
  // ignores SIGTERM, so it stays for its grace period and the condition with it.
  test('a Job on its way to Failed or Complete reads as kubectl prints it', async ({ page }) => {
    test.setTimeout(240_000)
    const cases = [
      { name: 'num-to-fail', condition: 'FailureTarget', badge: /badge-error/, exit: 1, spec: { backoffLimit: 0 } },
      { name: 'num-to-end', condition: 'SuccessCriteriaMet', badge: /badge-success/, exit: 0, spec: { successPolicy: { rules: [{ succeededIndexes: '0' }] } } },
    ]
    try {
      for (const c of cases) {
        kubectl('apply -f -', JSON.stringify({
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name: c.name, namespace: NS },
          spec: {
            completionMode: 'Indexed',
            completions: 2,
            parallelism: 2,
            ...c.spec,
            template: {
              spec: {
                restartPolicy: 'Never',
                terminationGracePeriodSeconds: 90,
                containers: [{
                  name: 'app',
                  image: 'busybox:1.37',
                  imagePullPolicy: 'IfNotPresent',
                  command: ['sh', '-c', `if [ "$JOB_COMPLETION_INDEX" = 0 ]; then sleep 5; exit ${c.exit}; fi; trap '' TERM; while true; do sleep 1; done`],
                }],
              },
            },
          },
        }))
      }
      for (const c of cases) {
        await test.step(c.condition, async () => {
          await expect.poll(async () => (await jobPrints(c.name)).Status, { timeout: 60_000, message: `${c.name}: kubectl prints` }).toBe(c.condition)
          await page.goto(JOBS)
          await expect.poll(async () => (await jobRow(page, c.name))?.Status, { timeout: 20_000 }).toBe(c.condition)
          expect(await jobRow(page, c.name)).toEqual(await jobPrints(c.name))
          await expect(jobBadge(page, c.name)).toHaveClass(c.badge)
          if (c.condition === 'FailureTarget') {
            // decided, not retrying, while the last pod is still there
            const issue = async () => ((await (await page.request.get('/api/v1/cluster/issues?cluster=self')).json()).issues as { id: string; reason: string }[])
              .find((i) => i.id === `Job/${NS}/${c.name}`)?.reason
            await expect.poll(issue, { timeout: 20_000, message: 'its issue while its pods leave' }).toBe('FailureTarget')
            expect((await jobPrints(c.name)).Status, 'kubectl still prints').toBe('FailureTarget')
          }
        })
      }
    } finally {
      for (const c of cases) {
        kubectl(`delete job ${c.name} -n ${NS} --ignore-not-found --wait=false`)
        kubectl(`delete pod -n ${NS} -l batch.kubernetes.io/job-name=${c.name} --ignore-not-found --wait=false --grace-period=0 --force`)
      }
    }
  })

  test('a work queue\'s drawer says Completions <unset>, as kubectl describe does', async ({ page }) => {
    const name = 'num-held'
    expect(/^Completions:\s+(\S+)$/m.exec(kubectl(`describe job ${name} -n ${NS}`))?.[1], 'kubectl describe prints').toBe('<unset>')
    await page.goto(`${JOBS}&detail=${encodeURIComponent(`Job/${NS}/${name}`)}`)
    await expect(page.locator(DRAWER).last()).toContainText(/Completions\s*<unset>/, { timeout: 20_000 })
    await expect(page.locator(DRAWER).last()).toContainText(/Parallelism\s*3/)
  })

  // One Job, one colour: a running Job is green in its list and in its CronJob's Jobs table, as its Resource Graph box is
  // (number-check-graph.spec.ts), and its card with them.
  test('a running Job is drawn green in the Jobs list and its CronJob\'s table', async ({ page }) => {
    const name = 'num-going'
    try {
      kubectl('apply -f -', JSON.stringify({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name,
          namespace: NS,
          ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: 'num-cron', uid: kubectl(`get cronjob num-cron -n ${NS} -o jsonpath='{.metadata.uid}'`), controller: true }],
        },
        spec: { template: { spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '300'] }] } } },
      }))
      await expect.poll(async () => (await jobPrints(name)).Status, { timeout: 20_000, message: 'kubectl prints' }).toBe('Running')
      await page.goto(JOBS)
      await expect.poll(async () => (await jobRow(page, name))?.Status, { timeout: 20_000 }).toBe('Running')
      await expect(jobBadge(page, name)).toHaveClass(/badge-success/)
      await expect(page.locator('main div.rounded-lg.border').filter({ hasText: /^(Running|실행 중)/ }).first()).toHaveClass(/emerald/)
      await page.goto(`${JOBS}&detail=${encodeURIComponent(`CronJob/${NS}/num-cron`)}`)
      const row = page.locator(DRAWER).last().locator('tbody tr').filter({ hasText: name })
      await expect(row.locator('.badge').first()).toHaveText('Running', { timeout: 20_000 })
      await expect(row.locator('.badge').first()).toHaveClass(/badge-success/)
    } finally {
      kubectl(`delete job ${name} -n ${NS} --ignore-not-found --wait=false`)
    }
  })

  test('the floating chat is told the Jobs cards\' numbers, each Job by its Status', async ({ page }) => {
    const sent: { base?: { data?: { stats?: Record<string, number>; interpretations?: string[] } } | null }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-num-jobs-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-num-jobs-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-num-jobs-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-num-jobs-\d+\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    const ask = async () => {
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()
      const before = sent.length
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length).toBe(before + 1)
      await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
      return sent[sent.length - 1].base?.data
    }
    const table = await on().apiTable(`/apis/batch/v1/namespaces/${NS}/jobs`)
    const status = table.columnDefinitions.findIndex((c) => c.name === 'Status')
    const statuses = table.rows.map((r) => String(r.cells[status]))
    const want = {
      total: statuses.length,
      completed: statuses.filter((s) => s === 'Complete').length,
      failed: statuses.filter((s) => s === 'Failed').length,
      suspended: statuses.filter((s) => s === 'Suspended').length,
      running: statuses.filter((s) => s !== 'Complete' && s !== 'Failed' && s !== 'Suspended').length,
    }
    expect(statuses, 'a suspended Job, which runs no pods, is among them').toContain('Suspended')
    await page.goto(JOBS)
    await expect.poll(async () => (await readScreen(page)).cards, { timeout: 20_000 }).toMatchObject({ Total: want.total, Completed: want.completed, Running: want.running, Suspended: want.suspended, Failed: want.failed })
    // the Suspended card in the colour of a suspended row's badge
    await expect(jobBadge(page, 'num-held')).toHaveClass(/badge-warning/)
    await expect(page.locator('main div.rounded-lg.border').filter({ hasText: /^(Suspended|중지됨)/ }).first()).toHaveClass(/yellow/)
    await expect.poll(async () => (await ask())?.stats, { timeout: 20_000 }).toEqual(want)
  })

  // The External IP cell is what kubectl prints; the drawer's rows are the spec's external IPs and the load balancer's addresses.
  test('a Service drawer opened from its row reads the object, not the External IP cell', async ({ page }) => {
    const services: [string, string, RegExp][] = [
      ['num-lb-pending', '<pending>', /External IPs\s*-\s*LoadBalancer\s*-\s*Session Affinity/],
      ['num-extname', 'db.numbers.example', /External IPs\s*-\s*LoadBalancer\s*-\s*Session Affinity/],
      ['num-lb-both', '192.0.2.31,192.0.2.40,lb.numbers.example,192.0.2.30', /External IPs\s*192\.0\.2\.30\s*LoadBalancer\s*192\.0\.2\.40, lb\.numbers\.example, 192\.0\.2\.31\s*Session Affinity/],
    ]
    for (const [name, cell, rows] of services) {
      await test.step(name, async () => {
        await page.goto(`/network/services?cluster=self&namespace=${NS}`)
        const row = page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) })
        await expect(row).toContainText(cell, { timeout: 20_000 })
        await row.click()
        await expect(page.locator(DRAWER).last()).toContainText(rows, { timeout: 20_000 })
      })
    }
  })

  test('a load balancer entry with an IP and a hostname shows both in the Service drawer', async ({ page }) => {
    const name = 'num-lb-one-entry'
    kubectl('apply -f -', JSON.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: NS }, spec: { type: 'LoadBalancer', ports: [{ port: 5434 }] } }))
    try {
      kubectl(`patch service ${name} -n ${NS} --subresource=status --type=merge -p=${arg({ status: { loadBalancer: { ingress: [{ ip: '192.0.2.50', hostname: 'one.numbers.example' }] } } })}`)
      await page.goto(`/network/services?cluster=self&namespace=${NS}`)
      const row = page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) })
      await expect(row).toContainText('192.0.2.50', { timeout: 20_000 })
      await row.click()
      await expect(page.locator(DRAWER).last()).toContainText(/LoadBalancer\s*192\.0\.2\.50 \(one\.numbers\.example\)\s*Session Affinity/, { timeout: 20_000 })
    } finally {
      kubectl(`delete service ${name} -n ${NS} --ignore-not-found`)
    }
  })

  test('Cluster View draws a pod whose sidecar is up and whose container runs as fine', async ({ page }) => {
    const table = await on().apiTable(`/api/v1/namespaces/${NS}/pods/num-sidecar`)
    const at = (column: string) => String(table.rows[0].cells[table.columnDefinitions.findIndex((c) => c.name === column)])
    expect({ Ready: at('Ready'), Status: at('Status') }, 'kubectl prints').toEqual({ Ready: '2/2', Status: 'Running' })
    await page.goto('/cluster-view?cluster=self')
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('num-sidecar')
    const card = page.locator('[data-testid="cluster-view-node"] button', { hasText: 'num-sidecar' })
    await expect(card).toHaveCount(1, { timeout: 20_000 })
    await expect(card).toContainText('Running')
    await expect(card).not.toContainText('PodInitializing')
    await expect(card.locator('svg.lucide-circle-check, svg.lucide-check-circle, svg.lucide-circle-check-big, svg.lucide-check-circle-2')).toHaveCount(1)
  })
})
