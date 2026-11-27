// The sample cluster as Kubernetes objects in page memory. Every list row, describe answer, YAML, event and log the
// demo shows is made from these objects, as k8s-service makes them from a cluster's, so a list and the window opened
// from it agree, and a change made in the demo (a delete, a YAML apply, a cordon) shows in every view until a reload.
// Invented names on *.northstar.example; nodes on 192.0.2.0/24 and clients on 198.51.100.0/24 (documentation ranges),
// Pods and Services on 10.0.0.0/8. No real cluster, account, key or address.
import { boot, crashEnded, crashRunAt, crashRunEnd, crashRuns, incident, logText, type LogSource, type LogStyle } from './logs'
import { fromYaml, toYaml } from './yaml'

type Obj = Record<string, any>
export interface Answer { status: number; data?: unknown; changed?: boolean }
export { boot }

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const ago = (minutes: number) => iso(boot - minutes * 60_000)
export const created = '2026-11-23T00:00:00Z'
const installed = '2026-09-14T03:12:00Z'
const rolledOut = '2026-11-20T09:30:00Z'
// When storefront went to revision 8 (its Helm history and the audit record say the same time).
export const storefrontUpgraded = iso(incident - 9 * 60_000)
const REG = 'registry.northstar.example/'
const CSI = 'block.csi.northstar.example'
const LOST = 9 // minutes before the page opened that prod-seoul-worker-h stopped reporting
const NOT_READY = 6 // ... that prod-seoul-worker-g went NotReady
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const ok = (data: unknown): Answer => ({ status: 200, data })
const notFound = (what: string): Answer => ({ status: 404, data: { detail: what + ' not found' } })

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
const SAFE = 'bcdfghjklmnpqrstvwxz2456789'
const suffix = (seed: string, n = 5) => Array.from({ length: n }, (_, i) => SAFE[hash(seed + ':' + i) % SAFE.length]).join('')
const hex = (seed: string, n: number) => Array.from({ length: Math.ceil(n / 8) }, (_, i) => hash(seed + '#' + i).toString(16).padStart(8, '0')).join('').slice(0, n)
const uidOf = (seed: string) => { const h = hex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}` }

// ---- The store

const store = new Map<string, Obj>()
const CLUSTER_SCOPED = new Set(['Node', 'Namespace', 'PersistentVolume', 'StorageClass', 'IngressClass'])
const keyOf = (kind: string, ns: string | undefined, name: string) => kind + '/' + (CLUSTER_SCOPED.has(kind) ? '' : ns || '') + '/' + name
let resourceVersion = 48210
// Moves on with every change, so a list read after it is not taken for the same answer.
export let revision = 1
const changed = () => { revision += 1 }

function put(o: Obj): Obj {
  o.metadata.resourceVersion = String(++resourceVersion)
  store.set(keyOf(o.kind, o.metadata.namespace, o.metadata.name), o)
  return o
}
const drop = (o: Obj) => store.delete(keyOf(o.kind, o.metadata.namespace, o.metadata.name))
const order = (a: Obj, b: Obj) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name)
export function all(kind: string, ns?: string): Obj[] {
  if (kind === 'Endpoints') return all('Service', ns).map(endpointsOf)
  if (kind === 'EndpointSlice') return all('Service', ns).map(sliceOf)
  return [...store.values()].filter((o) => o.kind === kind && (!ns || o.metadata.namespace === ns)).sort(order)
}
export function find(kind: string, ns: string | undefined, name: string): Obj | undefined {
  if (kind === 'Endpoints' || kind === 'EndpointSlice') return all(kind, ns).find((o) => o.metadata.name === name)
  return store.get(keyOf(kind, ns, name))
}
const owned = (o: Obj, kind = 'Pod') => all(kind, o.metadata.namespace).filter((c) => (c.metadata.ownerReferences || []).some((r: Obj) => r.uid === o.metadata.uid))
const ownerOf = (o: Obj) => (o.metadata.ownerReferences || [])[0] as Obj | undefined

const API: Record<string, string> = {
  Deployment: 'apps/v1', ReplicaSet: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1', ControllerRevision: 'apps/v1', Job: 'batch/v1', CronJob: 'batch/v1',
  HorizontalPodAutoscaler: 'autoscaling/v2', Ingress: 'networking.k8s.io/v1', IngressClass: 'networking.k8s.io/v1', EndpointSlice: 'discovery.k8s.io/v1', StorageClass: 'storage.k8s.io/v1',
}
function make(kind: string, ns: string, name: string, at: string, meta: Obj = {}, body: Obj = {}): Obj {
  return { apiVersion: API[kind] ?? 'v1', kind, metadata: { name, ...(ns ? { namespace: ns } : {}), uid: uidOf(kind + '/' + ns + '/' + name + '/' + at), resourceVersion: '', creationTimestamp: at, ...meta }, ...body }
}
const ref = (o: Obj) => ({ apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true, blockOwnerDeletion: true })

// ---- Events (kubectl's printEvent fields), newest first in every answer

interface Ev { uid: string; type: string; reason: string; message: string; count: number; first: string; last: string; source: string }
let events: Ev[] = []
const event = (o: Obj, type: string, reason: string, message: string, count: number, first: string, last: string, source: string) =>
  events.push({ uid: o.metadata.uid, type, reason, message, count, first, last, source })
function eventsOf(o: Obj): Obj[] {
  const list = events.filter((e) => e.uid === o.metadata.uid).map((e) => ({ ...e }))
  if (o.kind === 'Pod' && crashing(o)) {
    const at = Date.parse(o.metadata.creationTimestamp), runs = crashRuns(at), ended = crashEnded(at), last = iso(crashRunAt(at, runs))
    list.push({ uid: '', type: 'Normal', reason: 'Pulled', message: `Container image "${o.spec.containers[0].image}" already present on machine`, count: runs, first: o.metadata.creationTimestamp, last, source: 'kubelet' })
    list.push({ uid: '', type: 'Normal', reason: 'Created', message: 'Created container: app', count: runs, first: o.metadata.creationTimestamp, last, source: 'kubelet' })
    list.push({ uid: '', type: 'Normal', reason: 'Started', message: 'Started container app', count: runs, first: o.metadata.creationTimestamp, last, source: 'kubelet' })
    const backOff = ended === runs ? Math.max(crashRunEnd(at, ended), Date.now() - 4000) : crashRunAt(at, runs) - 2000
    if (ended) list.push({ uid: '', type: 'Warning', reason: 'BackOff', message: `Back-off restarting failed container app in pod ${o.metadata.name}_${o.metadata.namespace}(${o.metadata.uid})`, count: ended * 2 - 1, first: iso(crashRunEnd(at, 1)), last: iso(backOff), source: 'kubelet' })
  }
  return list.sort((a, b) => b.last.localeCompare(a.last)).map((e) => ({ type: e.type, reason: e.reason, message: e.message, count: e.count, first_timestamp: e.first, last_timestamp: e.last, source: e.source }))
}

// ---- Namespaces, nodes, storage

const NAMESPACES = ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'commerce', 'payments', 'platform', 'observability', 'data', 'edge', 'batch']
for (const name of NAMESPACES) put(make('Namespace', '', name, installed, { labels: { 'kubernetes.io/metadata.name': name } }, { spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } }))

const LETTERS = 'abcdefgh'.split('')
export const nodeName = (letter: string) => 'prod-seoul-worker-' + letter
const nodeIp = (letter: string) => '192.0.2.' + (10 + LETTERS.indexOf(letter))
const zoneOf = (letter: string) => 'seoul-1' + 'abc'[LETTERS.indexOf(letter) % 3]
LETTERS.forEach((l, i) => {
  const name = nodeName(l)
  const state = l === 'g' ? 'NotReady' : l === 'h' ? 'Unknown' : 'Ready'
  const beat = state === 'Unknown' ? ago(LOST + 0.7) : ago(0.2)
  const cond = (type: string, reason: string, message: string, status = 'False') => ({ type, status, lastHeartbeatTime: beat, lastTransitionTime: installed, reason, message })
  const unknown = (type: string) => ({ type, status: 'Unknown', lastHeartbeatTime: beat, lastTransitionTime: ago(LOST), reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.' })
  const conditions = state === 'Unknown' ? ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'Ready'].map(unknown) : [
    cond('MemoryPressure', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
    cond('DiskPressure', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
    cond('PIDPressure', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
    state === 'NotReady'
      ? { ...cond('Ready', 'KubeletNotReady', 'PLEG is not healthy: pleg was last seen active 3m12s ago; threshold is 3m0s'), lastTransitionTime: ago(NOT_READY) }
      : cond('Ready', 'KubeletReady', 'kubelet is posting ready status', 'True'),
  ]
  const taint = state === 'NotReady' ? 'node.kubernetes.io/not-ready' : 'node.kubernetes.io/unreachable'
  const since = ago(state === 'NotReady' ? NOT_READY : LOST)
  const node = put(make('Node', '', name, installed, {
    labels: { 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux', 'node-role.kubernetes.io/worker': '', 'node.kubernetes.io/instance-type': 'standard-4x8', 'topology.kubernetes.io/region': 'seoul', 'topology.kubernetes.io/zone': zoneOf(l) },
    annotations: { 'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true' },
  }, {
    spec: { podCIDR: `10.244.${i + 1}.0/24`, podCIDRs: [`10.244.${i + 1}.0/24`], providerID: 'northstar://seoul/' + name, ...(state === 'Ready' ? {} : { taints: [{ key: taint, effect: 'NoSchedule', timeAdded: since }, { key: taint, effect: 'NoExecute', timeAdded: since }] }) },
    status: {
      capacity: { cpu: '4', 'ephemeral-storage': '100Gi', memory: '8Gi', pods: '110' },
      allocatable: { cpu: '3920m', 'ephemeral-storage': '92Gi', memory: '7448Mi', pods: '110' },
      conditions, addresses: [{ type: 'InternalIP', address: nodeIp(l) }, { type: 'Hostname', address: name }],
      daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
      nodeInfo: { machineID: hex('m' + name, 32), systemUUID: uidOf('s' + name), bootID: uidOf('b' + name), kernelVersion: '6.12.8', osImage: 'Example Linux 2026.11', containerRuntimeVersion: 'containerd://2.2.0', kubeletVersion: 'v1.37.0', kubeProxyVersion: '', operatingSystem: 'linux', architecture: 'amd64' },
    },
  }))
  if (state === 'NotReady') {
    event(node, 'Normal', 'NodeNotReady', `Node ${name} status is now: NodeNotReady`, 1, ago(NOT_READY), ago(NOT_READY), 'kubelet')
    event(node, 'Normal', 'NodeNotReady', `Node ${name} status is now: NodeNotReady`, 1, ago(NOT_READY - 0.7), ago(NOT_READY - 0.7), 'node-controller')
  }
  if (state === 'Unknown') event(node, 'Normal', 'NodeNotReady', `Node ${name} status is now: NodeNotReady`, 1, ago(LOST - 0.7), ago(LOST - 0.7), 'node-controller')
})
const nodeReady = (name: string) => find('Node', '', name)?.status.conditions.find((c: Obj) => c.type === 'Ready')?.status === 'True'

put(make('StorageClass', '', 'fast-ssd', installed, { annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, { provisioner: CSI, parameters: { 'csi.storage.k8s.io/fstype': 'ext4', type: 'ssd' }, reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true }))
put(make('StorageClass', '', 'standard', installed, {}, { provisioner: CSI, parameters: { 'csi.storage.k8s.io/fstype': 'ext4', type: 'hdd' }, reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true }))
put(make('IngressClass', '', 'edge', installed, { annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' }, labels: { 'app.kubernetes.io/name': 'ingress-controller' } }, { spec: { controller: 'ingress.northstar.example/controller' } }))

// ---- Configuration: ConfigMaps, Secrets (values never leave the page unmasked), ServiceAccounts

const b64 = (s: string) => btoa(s)
for (const ns of NAMESPACES) {
  put(make('ConfigMap', ns, 'kube-root-ca.crt', installed, { annotations: { 'kubernetes.io/description': 'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters.' } }, { data: { 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIC/jCCAeagAwIBAgIBADANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwprdWJl\ncm5ldGVzIChzYW1wbGUgY2VydGlmaWNhdGUgZm9yIHRoZSBkZW1vKQ==\n-----END CERTIFICATE-----\n' } }))
  put(make('ServiceAccount', ns, 'default', installed))
}
const config: Array<[string, string, Obj]> = [
  ['commerce', 'checkout-config', { PAYMENT_GATEWAY_URL: 'https://pay.northstar.example/v2', PAYMENT_TIMEOUT_MS: '3000', CART_TTL_MINUTES: '30' }],
  ['commerce', 'storefront-config', { 'default.conf': 'server {\n  listen 8080;\n  location / {\n    root /usr/share/nginx/html;\n    try_files $uri /index.html;\n  }\n  location /healthz { return 200; }\n}\n' }],
  ['observability', 'prometheus-config', { 'prometheus.yml': 'global:\n  scrape_interval: 30s\n  evaluation_interval: 30s\nscrape_configs:\n  - job_name: kubernetes-pods\n    kubernetes_sd_configs:\n      - role: pod\n  - job_name: metrics-agent\n    kubernetes_sd_configs:\n      - role: node\n' }],
  ['observability', 'loki-config', { 'config.yaml': 'auth_enabled: false\nserver:\n  http_listen_port: 3100\nstorage_config:\n  filesystem:\n    directory: /var/loki/chunks\nlimits_config:\n  retention_period: 168h\n' }],
  ['kube-system', 'coredns', { Corefile: '.:53 {\n    errors\n    health\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf\n    cache 30\n    loop\n    reload\n}\n' }],
  ['edge', 'ingress-controller', { 'use-forwarded-headers': 'true', 'proxy-body-size': '8m', 'log-format-upstream': '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" $request_time [$proxy_upstream_name] $upstream_addr $upstream_status $req_id' }],
]
for (const [ns, name, data] of config) put(make('ConfigMap', ns, name, rolledOut, { labels: { app: name.replace(/-config$/, '') } }, { data }))
const secrets: Array<[string, string, string, Obj]> = [
  ['commerce', 'registry-pull', 'kubernetes.io/dockerconfigjson', { '.dockerconfigjson': '{"auths":{"registry.northstar.example":{"auth":"c2FtcGxlOnNhbXBsZQ=="}}}' }],
  ['payments', 'registry-pull', 'kubernetes.io/dockerconfigjson', { '.dockerconfigjson': '{"auths":{"registry.northstar.example":{"auth":"c2FtcGxlOnNhbXBsZQ=="}}}' }],
  ['commerce', 'session-store-auth', 'Opaque', { password: 'sample-not-a-real-password' }],
  ['commerce', 'storefront-tls', 'kubernetes.io/tls', { 'tls.crt': '-----BEGIN CERTIFICATE-----\n(sample)\n-----END CERTIFICATE-----\n', 'tls.key': '-----BEGIN PRIVATE KEY-----\n(sample)\n-----END PRIVATE KEY-----\n' }],
  ['payments', 'payment-api-credentials', 'Opaque', { GATEWAY_API_KEY: 'sample-not-a-real-key-0000', WEBHOOK_SIGNING_SECRET: 'sample-not-a-real-secret' }],
  ['payments', 'ledger-db-credentials', 'Opaque', { username: 'ledger', password: 'sample-not-a-real-password' }],
  ['observability', 'grafana-admin', 'Opaque', { GF_SECURITY_ADMIN_USER: 'admin', GF_SECURITY_ADMIN_PASSWORD: 'sample-not-a-real-password' }],
  ['platform', 'argocd-secret', 'Opaque', { 'server.secretkey': 'sample-not-a-real-key' }],
]
for (const [ns, name, type, data] of secrets) put(make('Secret', ns, name, rolledOut, {}, { type, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) }))
for (const [ns, name] of [['commerce', 'commerce-api'], ['platform', 'argocd'], ['observability', 'prometheus'], ['observability', 'opencost'], ['observability', 'metrics-agent'], ['edge', 'ingress-controller'], ['kube-system', 'coredns']]) {
  put(make('ServiceAccount', ns, name, rolledOut, { labels: { app: name } }, ns === 'commerce' ? { imagePullSecrets: [{ name: 'registry-pull' }] } : {}))
}

// ---- Workloads: each plan makes its controller, its ReplicaSets or claims, its Pods and its Service

type State = 'ok' | 'crash' | 'pending' | 'lost' | 'notready' | 'done' | 'failed'
interface PodPlan { node: string; ip: number; state?: State; name?: string; at?: string }
interface Plan {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'; ns: string; name: string; image: string; log: LogStyle; pods: PodPlan[]
  ports?: Array<[number, string, string?]>; res?: string; hash?: string; prev?: string; was?: Obj; rollout?: string; replicas?: number; container?: string
  sa?: string; env?: Obj[]; envFrom?: Obj[]; volumes?: Obj[]; mounts?: Obj[]; claims?: Array<[string, string, string, string]>
  app?: [string, string]; helm?: [string, number]; pull?: boolean; tolerations?: Obj[]; args?: string[]; service?: [string, string]
  sidecar?: { name: string; image: string; log: LogStyle; res: string; mounts?: Obj[] }
}
const cm = (name: string, volume = 'config') => ({ name: volume, configMap: { name, defaultMode: 420 } })
const mount = (name: string, mountPath: string, readOnly?: boolean) => ({ name, mountPath, ...(readOnly ? { readOnly } : {}) })
const HTTP: Array<[number, string]> = [[8080, 'http']]
const plans: Plan[] = [
  // the same image as before: what the last change took out is the container's envFrom
  { kind: 'Deployment', ns: 'commerce', name: 'checkout-api', image: 'commerce/checkout-api:2.4.1', prev: '2.4.1', was: { envFrom: [{ configMapRef: { name: 'checkout-config' } }] }, rollout: iso(incident), log: 'crash', ports: HTTP, hash: '7b9bc96fc8', sa: 'commerce-api', pull: true, helm: ['1.2.0', 5],
    env: [{ name: 'LOG_LEVEL', value: 'info' }, { name: 'SESSION_STORE_URL', value: 'redis://session-store:6379' }], pods: [{ node: 'a', ip: 20, state: 'crash', name: 'checkout-api-7b9bc96fc8-8vn4z', at: iso(incident) }] },
  { kind: 'Deployment', ns: 'commerce', name: 'storefront', image: 'commerce/storefront:1.4.2', prev: '1.4.1', rollout: storefrontUpgraded, log: 'web', ports: HTTP, hash: '659cc69bb7', helm: ['1.3.0', 8], volumes: [cm('storefront-config')], mounts: [mount('config', '/etc/nginx/conf.d', true)],
    pods: [{ node: 'a', ip: 21, name: 'storefront-659cc69bb7-srlrk', at: storefrontUpgraded }, { node: 'b', ip: 12, name: 'storefront-659cc69bb7-zhk8s', at: iso(Date.parse(storefrontUpgraded) + 14_000) }] },
  { kind: 'Deployment', ns: 'commerce', name: 'recommendations', image: 'commerce/recommendations:3.1.0', log: 'api', ports: HTTP, hash: '7d85d6f674', res: '500m/7Gi/2/8Gi',
    volumes: [{ name: 'model-cache', persistentVolumeClaim: { claimName: 'recommendations-model-cache' } }], mounts: [mount('model-cache', '/models')], pods: [{ node: '', ip: 0, state: 'pending', name: 'recommendations-7d85d6f674-7c9qk', at: ago(25) }] },
  { kind: 'Deployment', ns: 'commerce', name: 'catalog', image: 'commerce/catalog:2.8.3', prev: '2.8.2', log: 'api', ports: HTTP, helm: ['2.0.1', 4], pods: [{ node: 'c', ip: 22 }, { node: 'd', ip: 23 }] },
  { kind: 'Deployment', ns: 'commerce', name: 'search', image: 'commerce/search:1.9.0', log: 'api', ports: [[9200, 'http']], res: '250m/1Gi/1/2Gi', pods: [{ node: 'e', ip: 24 }] },
  { kind: 'StatefulSet', ns: 'commerce', name: 'session-store', image: 'mirror/valkey:8.1.3', container: 'valkey', log: 'valkey', ports: [[6379, 'redis']], res: '100m/256Mi/500m/512Mi', claims: [['data', '5Gi', 'fast-ssd', '/data']],
    env: [{ name: 'VALKEY_PASSWORD', valueFrom: { secretKeyRef: { name: 'session-store-auth', key: 'password' } } }], pods: [{ node: 'e', ip: 25 }] },
  { kind: 'Deployment', ns: 'payments', name: 'payment-api', image: 'payments/payment-api:3.2.0', prev: '3.1.4', log: 'api', ports: HTTP, pull: true, helm: ['1.6.0', 6], envFrom: [{ secretRef: { name: 'payment-api-credentials' } }], pods: [{ node: 'b', ip: 30 }] },
  { kind: 'StatefulSet', ns: 'payments', name: 'ledger', image: 'mirror/postgres:17.2', container: 'postgres', log: 'postgres', ports: [[5432, 'postgres']], res: '250m/1Gi/1/2Gi', helm: ['0.9.2', 3], claims: [['data', '20Gi', 'fast-ssd', '/var/lib/postgresql/data']],
    env: [{ name: 'POSTGRES_USER', valueFrom: { secretKeyRef: { name: 'ledger-db-credentials', key: 'username' } } }, { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'ledger-db-credentials', key: 'password' } } }], pods: [{ node: 'b', ip: 31 }] },
  { kind: 'Deployment', ns: 'platform', name: 'argocd', image: 'mirror/argocd:v3.1.2', log: 'argocd', ports: HTTP, sa: 'argocd', helm: ['8.3.0', 6], envFrom: [{ secretRef: { name: 'argocd-secret' } }], pods: [{ node: 'f', ip: 40 }] },
  { kind: 'Deployment', ns: 'platform', name: 'notifications', image: 'platform/notifications:1.6.0', log: 'api', ports: HTTP, pods: [{ node: 'c', ip: 41 }] },
  { kind: 'Deployment', ns: 'platform', name: 'policy-reporter', image: 'mirror/policy-reporter:3.0.4', log: 'api', ports: HTTP, pods: [{ node: 'd', ip: 42 }] },
  { kind: 'StatefulSet', ns: 'observability', name: 'prometheus', image: 'mirror/prometheus:v3.5.0', container: 'prometheus', log: 'prometheus', ports: [[9090, 'web']], res: '500m/2Gi/2/4Gi', sa: 'prometheus', helm: ['27.3.0', 9],
    claims: [['storage', '50Gi', 'fast-ssd', '/prometheus']], volumes: [cm('prometheus-config')], mounts: [mount('config', '/etc/prometheus', true)],
    sidecar: { name: 'config-reloader', image: 'mirror/config-reloader:v0.84.0', log: 'reloader', res: '10m/32Mi/50m/64Mi', mounts: [mount('config', '/etc/prometheus', true)] }, pods: [{ node: 'c', ip: 50 }] },
  { kind: 'StatefulSet', ns: 'observability', name: 'loki', image: 'mirror/loki:3.5.1', container: 'loki', log: 'loki', ports: [[3100, 'http']], res: '250m/1Gi/1/2Gi', helm: ['6.30.0', 4],
    claims: [['storage', '30Gi', 'standard', '/var/loki']], volumes: [cm('loki-config')], mounts: [mount('config', '/etc/loki', true)], pods: [{ node: 'd', ip: 51 }] },
  { kind: 'Deployment', ns: 'observability', name: 'tempo', image: 'mirror/tempo:2.8.1', container: 'tempo', log: 'tempo', ports: [[3200, 'http']], helm: ['1.21.0', 3], pods: [{ node: 'e', ip: 52 }] },
  { kind: 'Deployment', ns: 'observability', name: 'grafana', image: 'mirror/grafana:12.1.0', container: 'grafana', log: 'grafana', ports: [[3000, 'http']], helm: ['9.3.0', 7], envFrom: [{ secretRef: { name: 'grafana-admin' } }], pods: [{ node: 'f', ip: 53 }] },
  { kind: 'Deployment', ns: 'observability', name: 'opencost', image: 'mirror/opencost:1.115.0', container: 'opencost', log: 'opencost', ports: [[9003, 'http']], sa: 'opencost', helm: ['2.1.6', 2], pods: [{ node: 'a', ip: 54 }] },
  { kind: 'DaemonSet', ns: 'observability', name: 'metrics-agent', image: 'mirror/node-exporter:v1.9.1', container: 'node-exporter', log: 'agent', ports: [[9100, 'metrics']], res: '50m/64Mi/200m/128Mi', sa: 'metrics-agent',
    tolerations: [{ operator: 'Exists' }], pods: LETTERS.map((l) => ({ node: l, ip: 60, state: l === 'g' || l === 'h' ? 'notready' : 'ok' })) },
  { kind: 'Deployment', ns: 'data', name: 'analytics', image: 'data/analytics:4.0.2', log: 'api', ports: HTTP, pods: [{ node: 'h', ip: 70, state: 'lost' }, { node: 'e', ip: 72, at: ago(LOST - 5) }] },
  { kind: 'Deployment', ns: 'data', name: 'cache', image: 'mirror/valkey:8.1.3', container: 'valkey', log: 'valkey', ports: [[6379, 'redis']], res: '100m/256Mi/500m/512Mi', pods: [{ node: 'f', ip: 71 }] },
  { kind: 'Deployment', ns: 'edge', name: 'ingress-controller', image: 'mirror/ingress-controller:v1.13.0', container: 'controller', log: 'ingress', ports: [[80, 'http'], [443, 'https']], sa: 'ingress-controller', helm: ['4.13.0', 5], pods: [{ node: 'a', ip: 80 }, { node: 'b', ip: 81 }] },
  { kind: 'Deployment', ns: 'edge', name: 'event-router', image: 'edge/event-router:0.9.4', log: 'api', ports: HTTP, pods: [{ node: 'h', ip: 82, state: 'lost' }, { node: 'c', ip: 83, at: ago(LOST - 5) }] },
  { kind: 'Deployment', ns: 'batch', name: 'image-worker', image: 'batch/image-worker:2.2.0', log: 'worker', pods: [{ node: 'c', ip: 92 }] },
  { kind: 'Deployment', ns: 'batch', name: 'checkout-worker', image: 'batch/checkout-worker:2.4.1', log: 'worker', pods: [{ node: 'e', ip: 94 }] },
  { kind: 'Deployment', ns: 'kube-system', name: 'coredns', image: 'mirror/coredns:v1.12.1', container: 'coredns', log: 'coredns', ports: [[53, 'dns', 'UDP'], [53, 'dns-tcp'], [9153, 'metrics']], hash: '7d6b8f9d58',
    app: ['k8s-app', 'kube-dns'], sa: 'coredns', res: '100m/70Mi/500m/170Mi', volumes: [cm('coredns', 'config-volume')], mounts: [mount('config-volume', '/etc/coredns', true)], args: ['-conf', '/etc/coredns/Corefile'], service: ['kube-dns', '10.96.0.10'], pods: [{ node: 'a', ip: 3, name: 'coredns-7d6b8f9d58-k4f72' }] },
]

// The log each container writes, by its image's repository: another tag writes the same.
const LOG_STYLE = new Map<string, LogStyle>()
const repositoryOf = (image: string) => image.replace(/:[^:/]*$/, '')
// The Helm release of a workload (release name = workload name): its chart version and revision.
export const helmCharts: Array<{ name: string; namespace: string; chartVersion: string; revision: number; kind: string }> = []

function containerOf(name: string, image: string, res = '100m/128Mi/500m/256Mi', more: Obj = {}): Obj {
  const [rc, rm, lc, lm] = res.split('/')
  const ports: Array<[number, string, string?]> | undefined = more.ports
  return {
    name, image: REG + image, ...(more.args ? { args: more.args } : {}),
    ...(ports ? { ports: ports.map(([port, n, protocol]) => ({ name: n, containerPort: port, protocol: protocol || 'TCP' })) } : {}),
    ...(more.env ? { env: more.env } : {}), ...(more.envFrom ? { envFrom: more.envFrom } : {}),
    resources: { limits: { cpu: lc, memory: lm }, requests: { cpu: rc, memory: rm } },
    ...(ports ? { readinessProbe: { tcpSocket: { port: ports[0][0] }, periodSeconds: 10, timeoutSeconds: 1, successThreshold: 1, failureThreshold: 3 } } : {}),
    ...(more.mounts ? { volumeMounts: more.mounts } : {}),
    terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File', imagePullPolicy: 'IfNotPresent',
  }
}

function templateOf(p: Plan): Obj {
  const [key, value] = p.app ?? ['app', p.name]
  const containers = [containerOf(p.container ?? 'app', p.image, p.res, p)]
  LOG_STYLE.set(repositoryOf(REG + p.image), p.log)
  if (p.sidecar) { containers.push(containerOf(p.sidecar.name, p.sidecar.image, p.sidecar.res, { mounts: p.sidecar.mounts })); LOG_STYLE.set(repositoryOf(REG + p.sidecar.image), p.sidecar.log) }
  return {
    metadata: { labels: { [key]: value } },
    spec: {
      containers, ...(p.volumes ? { volumes: p.volumes } : {}), restartPolicy: 'Always', terminationGracePeriodSeconds: 30, dnsPolicy: 'ClusterFirst',
      serviceAccountName: p.sa ?? 'default', securityContext: {}, schedulerName: 'default-scheduler', ...(p.pull ? { imagePullSecrets: [{ name: 'registry-pull' }] } : {}),
      ...(p.tolerations ? { tolerations: p.tolerations } : {}),
    },
  }
}

const READY_TOLERATIONS = [
  { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
  { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
]
const DAEMON_TOLERATIONS = ['not-ready:NoExecute', 'unreachable:NoExecute', 'disk-pressure:NoSchedule', 'memory-pressure:NoSchedule', 'pid-pressure:NoSchedule', 'unschedulable:NoSchedule']
  .map((t) => ({ key: 'node.kubernetes.io/' + t.split(':')[0], operator: 'Exists', effect: t.split(':')[1] }))
const nextIp = new Map<string, number>()
const ipOn = (letter: string, host?: number) => {
  const n = host ?? (nextIp.get(letter) ?? 110)
  if (host === undefined) nextIp.set(letter, n + 1)
  return `10.244.${LETTERS.indexOf(letter) + 1}.${n}`
}
const sha = (seed: string) => 'sha256:' + hex(seed, 64)

const UNSCHEDULABLE = '0/8 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/not-ready: }, 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 6 Insufficient memory. preemption: 0/8 nodes are available: 2 Preemption is not helpful for scheduling, 6 No preemption victims found for incoming pod.'

// One Pod of a controller, its spec the controller's template and its status the state it is shown in.
function makePod(owner: Obj, template: Obj, name: string, letter: string, ip: string, state: State, at: string, extraLabels: Obj = {}, claims: Obj[] = []): Obj {
  const spec = clone(template.spec)
  const access = 'kube-api-access-' + suffix(name + 'kube')
  spec.volumes = [...(spec.volumes || []), ...claims, { name: access, projected: { defaultMode: 420, sources: [
    { serviceAccountToken: { expirationSeconds: 3607, path: 'token' } },
    { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
    { downwardAPI: { items: [{ path: 'namespace', fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' } }] } },
  ] } }]
  for (const c of spec.containers) c.volumeMounts = [...(c.volumeMounts || []), { name: access, readOnly: true, mountPath: '/var/run/secrets/kubernetes.io/serviceaccount' }]
  if (letter) spec.nodeName = nodeName(letter)
  spec.tolerations = owner.kind === 'DaemonSet' ? [...(spec.tolerations || []), ...DAEMON_TOLERATIONS] : [...(spec.tolerations || []), ...READY_TOLERATIONS]
  Object.assign(spec, { priority: 0, enableServiceLinks: true, preemptionPolicy: 'PreemptLowerPriority' })
  const pod = make('Pod', owner.metadata.namespace, name, at, { labels: { ...template.metadata.labels, ...extraLabels }, ownerReferences: [ref(owner)] }, { spec, status: {} })
  setPodState(pod, state, ip)
  return pod
}

const container = (pod: Obj, c: Obj, at: string, extra: Obj) => ({ name: c.name, image: c.image, imageID: c.image.split(':')[0] + '@' + sha(c.image), containerID: 'containerd://' + hex(pod.metadata.uid + c.name, 64), started: true, ready: true, restartCount: 0, state: { running: { startedAt: at } }, lastState: {}, ...extra })

function setPodState(pod: Obj, state: State, ip: string) {
  const at = pod.metadata.creationTimestamp
  const node = pod.spec.nodeName as string | undefined
  const letter = node ? node.slice(-1) : ''
  const cond = (type: string, status: string, extra: Obj = {}) => ({ type, status, lastProbeTime: null, lastTransitionTime: at, ...extra })
  const requests = pod.spec.containers.every((c: Obj) => c.resources?.limits?.cpu === c.resources?.requests?.cpu && c.resources?.limits?.memory === c.resources?.requests?.memory)
  const none = pod.spec.containers.every((c: Obj) => !Object.keys({ ...c.resources?.limits, ...c.resources?.requests }).length)
  const status: Obj = { qosClass: none ? 'BestEffort' : requests ? 'Guaranteed' : 'Burstable' }
  const placed = (phase: string, conditions: Obj[], containerStatuses: Obj[]) => Object.assign(status, {
    phase, conditions, hostIP: nodeIp(letter), hostIPs: [{ ip: nodeIp(letter) }], podIP: ip, podIPs: [{ ip }], startTime: at, containerStatuses,
  })
  const running = (ready: boolean) => pod.spec.containers.map((c: Obj) => container(pod, c, at, { ready }))
  const allTrue = ['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'].map((t) => cond(t, 'True'))
  if (state === 'pending') {
    Object.assign(status, { phase: 'Pending', conditions: [cond('PodScheduled', 'False', { reason: 'Unschedulable', message: UNSCHEDULABLE })] })
  } else if (state === 'crash') {
    const unready = { reason: 'ContainersNotReady', message: 'containers with unready status: [app]' }
    placed('Running', [cond('PodReadyToStartContainers', 'True'), cond('Initialized', 'True'), cond('Ready', 'False', unready), cond('ContainersReady', 'False', unready), cond('PodScheduled', 'True')],
      pod.spec.containers.map((c: Obj) => container(pod, c, at, { ready: false, started: false })))
  } else if (state === 'lost' || state === 'notready') {
    const conditions = allTrue.map((c) => (c.type === 'Ready' ? { ...c, status: 'False', lastTransitionTime: ago(state === 'lost' || letter === 'h' ? LOST - 0.6 : NOT_READY - 0.6) } : c))
    placed(state === 'lost' ? 'Unknown' : 'Running', conditions, running(false))
    if (state === 'lost') {
      Object.assign(status, { reason: 'NodeLost', message: `Node ${node} which was running pod ${pod.metadata.name} is unresponsive` })
      Object.assign(pod.metadata, { deletionTimestamp: ago(LOST - 5), deletionGracePeriodSeconds: 30 })
    }
  } else if (state === 'done' || state === 'failed') {
    const reason = state === 'done' ? 'PodCompleted' : 'PodFailed'
    placed(state === 'done' ? 'Succeeded' : 'Failed', [cond('PodReadyToStartContainers', 'False'), cond('Initialized', 'True'), cond('Ready', 'False', { reason }), cond('ContainersReady', 'False', { reason }), cond('PodScheduled', 'True')],
      pod.spec.containers.map((c: Obj) => container(pod, c, at, { ready: false, started: false, restartCount: state === 'failed' ? 2 : 0,
        state: { terminated: { exitCode: state === 'done' ? 0 : 1, reason: state === 'done' ? 'Completed' : 'Error', startedAt: at, finishedAt: iso(Date.parse(at) + (state === 'done' ? 44_000 : 27_000)), containerID: 'containerd://' + hex(pod.metadata.uid, 64) } } })))
  } else {
    placed('Running', allTrue, running(true))
  }
  pod.status = status
  if (state === 'crash') crashPods.add(pod.metadata.uid)
}
const crashPods = new Set<string>()
const crashing = (pod: Obj) => crashPods.has(pod.metadata.uid)

function service(p: Plan, owner: Obj) {
  const [name, clusterIP] = p.service ?? [p.name, '']
  const headless = p.kind === 'StatefulSet'
  const lb = p.name === 'ingress-controller'
  const svc = put(make('Service', p.ns, name, owner.metadata.creationTimestamp, { labels: { ...(owner.metadata.labels || {}) }, ...(owner.metadata.annotations?.['meta.helm.sh/release-name'] ? { annotations: { 'meta.helm.sh/release-name': p.name, 'meta.helm.sh/release-namespace': p.ns } } : {}) }, {
    spec: {
      type: lb ? 'LoadBalancer' : 'ClusterIP', clusterIP: headless ? 'None' : clusterIP || nextClusterIp(), clusterIPs: [], ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack',
      ports: (p.ports || []).map(([port, n, protocol]) => ({ name: n, port: port === 8080 || port === 3000 ? 80 : port, targetPort: port, protocol: protocol || 'TCP', ...(lb ? { nodePort: port === 80 ? 30080 : 30443 } : {}) })),
      selector: { ...owner.spec.selector.matchLabels }, sessionAffinity: 'None', internalTrafficPolicy: 'Cluster', ...(lb ? { externalTrafficPolicy: 'Local', healthCheckNodePort: 31544, allocateLoadBalancerNodePorts: true } : {}),
    },
    status: { loadBalancer: lb ? { ingress: [{ hostname: 'edge-lb.northstar.example' }] } : {} },
  }))
  svc.spec.clusterIPs = [svc.spec.clusterIP]
}
let clusterIpSeq = 20
const nextClusterIp = () => `10.96.${Math.floor(clusterIpSeq / 250)}.${(clusterIpSeq += 3) % 250 + 3}`

function buildWorkload(p: Plan) {
  const [key, value] = p.app ?? ['app', p.name]
  const template = templateOf(p)
  const helmMeta = p.helm ? {
    labels: { [key]: value, 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': p.name + '-' + p.helm[0] },
    annotations: { 'meta.helm.sh/release-name': p.name, 'meta.helm.sh/release-namespace': p.ns },
  } : { labels: { [key]: value } }
  if (p.helm) helmCharts.push({ name: p.name, namespace: p.ns, chartVersion: p.helm[0], revision: p.helm[1], kind: p.kind })
  const replicas = p.replicas ?? p.pods.filter((x) => x.state !== 'lost').length
  const at = p.ns === 'kube-system' ? installed : rolledOut
  const selector = { matchLabels: { [key]: value } }
  if (p.kind === 'Deployment') {
    const hashNow = p.hash ?? suffix(p.name + 'rs', 10)
    const dep = put(make('Deployment', p.ns, p.name, at, { ...helmMeta, annotations: { ...(helmMeta.annotations || {}), 'deployment.kubernetes.io/revision': p.prev ? '2' : '1' }, generation: p.prev ? 2 : 1 }, {
      spec: { replicas, selector, template, strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '25%', maxSurge: '25%' } }, revisionHistoryLimit: 10, progressDeadlineSeconds: 600 },
      status: {},
    }))
    if (p.prev) {
      const old = clone(template)
      Object.assign(old.spec.containers[0], { image: REG + p.image.replace(/:[^:]+$/, ':' + p.prev) }, p.was)
      old.metadata.labels['pod-template-hash'] = suffix(p.name + 'prev', 10)
      put(make('ReplicaSet', p.ns, p.name + '-' + old.metadata.labels['pod-template-hash'], '2026-11-06T02:15:00Z', { labels: { ...old.metadata.labels }, annotations: { 'deployment.kubernetes.io/desired-replicas': String(replicas), 'deployment.kubernetes.io/max-replicas': String(replicas + 1), 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [ref(dep)], generation: 2 }, {
        spec: { replicas: 0, selector: { matchLabels: { ...selector.matchLabels, 'pod-template-hash': old.metadata.labels['pod-template-hash'] } }, template: old }, status: {},
      }))
    }
    const rsTemplate = clone(template)
    rsTemplate.metadata.labels['pod-template-hash'] = hashNow
    const rs = put(make('ReplicaSet', p.ns, p.name + '-' + hashNow, p.rollout ?? at, { labels: { ...rsTemplate.metadata.labels }, annotations: { 'deployment.kubernetes.io/desired-replicas': String(replicas), 'deployment.kubernetes.io/max-replicas': String(replicas + 1), 'deployment.kubernetes.io/revision': p.prev ? '2' : '1' }, ownerReferences: [ref(dep)], generation: 1 }, {
      spec: { replicas, selector: { matchLabels: { ...selector.matchLabels, 'pod-template-hash': hashNow } }, template: rsTemplate }, status: {},
    }))
    p.pods.forEach((x, i) => put(makePod(rs, rsTemplate, x.name ?? rs.metadata.name + '-' + suffix(p.name + i), x.node, x.node ? ipOn(x.node, x.ip) : '', x.state ?? 'ok', x.at ?? created)))
    if (p.ports) service(p, dep)
    return
  }
  const crHash = suffix(p.name + 'cr', 10)
  const owner = put(make(p.kind, p.ns, p.name, at, { ...helmMeta, generation: 1 }, {
    spec: p.kind === 'StatefulSet' ? {
      replicas, selector, serviceName: p.name, template, podManagementPolicy: 'OrderedReady', updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } }, revisionHistoryLimit: 10,
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      volumeClaimTemplates: (p.claims || []).map(([claim, size, sc]) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } }, storageClassName: sc, volumeMode: 'Filesystem' } })),
    } : { selector, template, updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }, revisionHistoryLimit: 10 },
    status: {},
  }))
  put(make('ControllerRevision', p.ns, p.name + '-' + crHash, at, { labels: { ...selector.matchLabels, 'controller-revision-hash': crHash }, ownerReferences: [ref(owner)] }, { revision: 1, data: { spec: { template: { $patch: 'replace', ...template } } } }))
  p.pods.forEach((x, i) => {
    const name = p.kind === 'StatefulSet' ? p.name + '-' + i : p.name + '-' + suffix(p.name + x.node)
    const claims = (p.claims || []).map(([claim]) => ({ name: claim, persistentVolumeClaim: { claimName: claim + '-' + name } }))
    const extra = p.kind === 'StatefulSet'
      ? { 'apps.kubernetes.io/pod-index': String(i), 'controller-revision-hash': p.name + '-' + crHash, 'statefulset.kubernetes.io/pod-name': name }
      : { 'controller-revision-hash': crHash, 'pod-template-generation': '1' }
    const tpl = clone(template)
    if (p.kind === 'StatefulSet') tpl.spec.containers[0].volumeMounts = [...(tpl.spec.containers[0].volumeMounts || []), ...(p.claims || []).map(([claim, , , path]) => mount(claim, path))]
    if (p.kind === 'StatefulSet') tpl.spec.hostname = name
    if (p.kind === 'StatefulSet') tpl.spec.subdomain = p.name
    put(makePod(owner, tpl, name, x.node, ipOn(x.node, x.ip), x.state ?? 'ok', x.at ?? created, extra, claims))
    for (const [claim, size, sc] of p.claims || []) claimFor(p.ns, claim + '-' + name, size, sc, x.node, { [key]: value })
  })
  if (p.ports) service(p, owner)
}

// A claim, and the volume it gets when a node takes its first Pod, provisioned in that node's zone.
function claimFor(ns: string, name: string, size: string, sc: string, letter: string, labels: Obj, bound = true) {
  const pvc = make('PersistentVolumeClaim', ns, name, rolledOut, { labels, finalizers: ['kubernetes.io/pvc-protection'], annotations: {} },
    { spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } }, storageClassName: sc, volumeMode: 'Filesystem' }, status: { phase: 'Pending' } })
  return bound ? bind(pvc, letter, rolledOut) : put(pvc)
}
function bind(pvc: Obj, letter: string, at: string): Obj {
  const { name, namespace: ns } = pvc.metadata, size = pvc.spec.resources.requests.storage, sc = pvc.spec.storageClassName
  const pvName = 'pvc-' + pvc.metadata.uid
  pvc.metadata.annotations = { ...pvc.metadata.annotations, 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes', 'volume.beta.kubernetes.io/storage-provisioner': CSI, 'volume.kubernetes.io/selected-node': nodeName(letter), 'volume.kubernetes.io/storage-provisioner': CSI }
  pvc.spec.volumeName = pvName
  pvc.status = { phase: 'Bound', accessModes: pvc.spec.accessModes, capacity: { storage: size } }
  put(pvc)
  put(make('PersistentVolume', '', pvName, at, { annotations: { 'pv.kubernetes.io/provisioned-by': CSI, 'volume.kubernetes.io/provisioner-deletion-secret-name': '', 'volume.kubernetes.io/provisioner-deletion-secret-namespace': '' }, finalizers: ['external-provisioner.volume.kubernetes.io/finalizer', 'kubernetes.io/pv-protection', 'external-attacher/block-csi-northstar-example'] }, {
    spec: {
      accessModes: pvc.spec.accessModes, capacity: { storage: size }, persistentVolumeReclaimPolicy: 'Delete', storageClassName: sc, volumeMode: 'Filesystem',
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name, namespace: ns, uid: pvc.metadata.uid, resourceVersion: pvc.metadata.resourceVersion },
      csi: { driver: CSI, fsType: 'ext4', volumeHandle: 'vol-' + hex(pvName, 17), volumeAttributes: { 'storage.kubernetes.io/csiProvisionerIdentity': '1726283520000-8081-' + CSI } },
      nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: [zoneOf(letter)] }] }] } },
    },
    status: { phase: 'Bound', lastPhaseTransitionTime: at },
  }))
  return pvc
}

plans.forEach(buildWorkload)
const pending = claimFor('commerce', 'recommendations-model-cache', '10Gi', 'standard', 'a', { app: 'recommendations' }, false)
const pendingPod = find('Pod', 'commerce', 'recommendations-7d85d6f674-7c9qk')!
event(pending, 'Normal', 'WaitForPodScheduled', `waiting for pod ${pendingPod.metadata.name} to be scheduled`, 101, ago(25), ago(0.2), 'persistentvolume-controller')
event(pendingPod, 'Warning', 'FailedScheduling', UNSCHEDULABLE, 27, ago(25), ago(0.5), 'default-scheduler')
put(make('Service', 'default', 'kubernetes', installed, { labels: { component: 'apiserver', provider: 'kubernetes' } }, {
  spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', clusterIPs: ['10.96.0.1'], ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack', ports: [{ name: 'https', port: 443, targetPort: 6443, protocol: 'TCP' }], sessionAffinity: 'None', internalTrafficPolicy: 'Cluster' },
  status: { loadBalancer: {} },
}))
for (const p of all('Pod')) {
  if (p.status.phase === 'Unknown') {
    event(p, 'Warning', 'NodeNotReady', 'Node is not ready', 1, ago(LOST - 0.6), ago(LOST - 0.6), 'node-controller')
    event(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, 1, ago(LOST - 5), ago(LOST - 5), 'taint-eviction-controller')
  } else if (p.status.conditions?.some((c: Obj) => c.type === 'Ready' && c.status === 'False') && p.status.phase === 'Running' && !crashing(p)) {
    event(p, 'Warning', 'NodeNotReady', 'Node is not ready', 1, p.spec.nodeName.endsWith('-g') ? ago(NOT_READY - 0.6) : ago(LOST - 0.6), p.spec.nodeName.endsWith('-g') ? ago(NOT_READY - 0.6) : ago(LOST - 0.6), 'node-controller')
  } else if (p.metadata.creationTimestamp === ago(LOST - 5)) {
    const node = p.spec.nodeName
    event(p, 'Normal', 'Scheduled', `Successfully assigned ${p.metadata.namespace}/${p.metadata.name} to ${node}`, 1, ago(LOST - 5), ago(LOST - 5), 'default-scheduler')
    event(p, 'Normal', 'Pulled', `Container image "${p.spec.containers[0].image}" already present on machine`, 1, ago(LOST - 4.9), ago(LOST - 4.9), 'kubelet')
    event(p, 'Normal', 'Created', `Created container: ${p.spec.containers[0].name}`, 1, ago(LOST - 4.9), ago(LOST - 4.9), 'kubelet')
    event(p, 'Normal', 'Started', `Started container ${p.spec.containers[0].name}`, 1, ago(LOST - 4.9), ago(LOST - 4.9), 'kubelet')
    const rs = find('ReplicaSet', p.metadata.namespace, ownerOf(p)!.name)
    if (rs) event(rs, 'Normal', 'SuccessfulCreate', `Created pod: ${p.metadata.name}`, 1, ago(LOST - 5), ago(LOST - 5), 'replicaset-controller')
  }
}

// Ingresses and the storefront's autoscaler, which their releases made.
function helmMade(ns: string, name: string): Obj {
  const c = helmCharts.find((x) => x.namespace === ns && x.name === name)
  return c ? { labels: { app: name, 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': name + '-' + c.chartVersion }, annotations: { 'meta.helm.sh/release-name': name, 'meta.helm.sh/release-namespace': ns } } : { labels: { app: name } }
}
const ingress = (ns: string, name: string, host: string, paths: Array<[string, string, number]>, tls?: string) => put(make('Ingress', ns, name, rolledOut, helmMade(ns, name), {
  spec: { ingressClassName: 'edge', ...(tls ? { tls: [{ hosts: [host], secretName: tls }] } : {}), rules: [{ host, http: { paths: paths.map(([path, svc, port]) => ({ path, pathType: 'Prefix', backend: { service: { name: svc, port: { number: port } } } })) } }] },
  status: { loadBalancer: { ingress: [{ hostname: 'edge-lb.northstar.example' }] } },
}))
ingress('commerce', 'storefront', 'shop.northstar.example', [['/', 'storefront', 80], ['/api/checkout', 'checkout-api', 80]], 'storefront-tls')
ingress('observability', 'grafana', 'grafana.northstar.example', [['/', 'grafana', 80]])
put(make('HorizontalPodAutoscaler', 'commerce', 'storefront', rolledOut, helmMade('commerce', 'storefront'), {
  spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'storefront' }, minReplicas: 2, maxReplicas: 6, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] },
  status: {},
}))

// Jobs: the batch-worker CronJob's last half-hourly run, which finished, and a one-off sync that failed.
const lastRun = Math.floor((boot - 60_000) / 1_800_000) * 1_800_000
const cron = put(make('CronJob', 'batch', 'batch-worker', rolledOut, { labels: { app: 'batch-worker' } }, {
  spec: { schedule: '*/30 * * * *', concurrencyPolicy: 'Forbid', suspend: false, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1, startingDeadlineSeconds: 120,
    jobTemplate: { spec: { backoffLimit: 2, template: { metadata: { labels: { app: 'batch-worker' } }, spec: { containers: [containerOf('app', 'batch/batch-worker:1.7.0')], restartPolicy: 'Never', serviceAccountName: 'default', terminationGracePeriodSeconds: 30, dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', securityContext: {} } } } } },
  status: { lastScheduleTime: iso(lastRun), lastSuccessfulTime: iso(lastRun + 46_000) },
}))
LOG_STYLE.set(REG + 'batch/batch-worker', 'job')
function jobFor(owner: Obj | null, ns: string, name: string, template: Obj, at: number, state: 'done' | 'failed' | 'running', letter: string, ip: string) {
  const id = uidOf('job' + name + at)
  const labels = { 'batch.kubernetes.io/controller-uid': id, 'batch.kubernetes.io/job-name': name, 'controller-uid': id, 'job-name': name }
  const tpl = clone(template)
  tpl.metadata = { labels: { ...(tpl.metadata?.labels || {}), ...labels } }
  const finished = state === 'done' ? at + 46_000 : at + 30_000
  const job = put(make('Job', ns, name, iso(at), { labels: { ...labels }, ...(owner ? { ownerReferences: [ref(owner)] } : {}), generation: 1 }, {
    spec: { parallelism: 1, completions: 1, backoffLimit: 2, completionMode: 'NonIndexed', suspend: false, manualSelector: false, selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': id } }, template: tpl, podReplacementPolicy: 'TerminatingOrFailed' },
    status: state === 'running' ? { active: 1, startTime: iso(at), ready: 1, terminating: 0, uncountedTerminatedPods: {} } : {
      startTime: iso(at), ...(state === 'done' ? { completionTime: iso(finished), succeeded: 1 } : { failed: 1 }), ready: 0, terminating: 0, uncountedTerminatedPods: {},
      conditions: state === 'done'
        ? [{ type: 'SuccessCriteriaMet', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: iso(finished), lastTransitionTime: iso(finished) }, { type: 'Complete', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: iso(finished), lastTransitionTime: iso(finished) }]
        : [{ type: 'FailureTarget', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastProbeTime: iso(finished), lastTransitionTime: iso(finished) }, { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastProbeTime: iso(finished), lastTransitionTime: iso(finished) }],
    },
  }))
  const pod = put(makePod(job, tpl, name + '-' + suffix(name + at), letter, ip, state === 'running' ? 'ok' : state, iso(at)))
  if (state !== 'running') event(job, state === 'done' ? 'Normal' : 'Warning', state === 'done' ? 'Completed' : 'BackoffLimitExceeded', state === 'done' ? 'Job completed' : 'Job has reached the specified backoff limit', 1, iso(finished), iso(finished), 'job-controller')
  event(job, 'Normal', 'SuccessfulCreate', `Created pod: ${pod.metadata.name}`, 1, iso(at), iso(at), 'job-controller')
  return job
}
jobFor(cron, 'batch', 'batch-worker-' + Math.floor(lastRun / 60_000), cron.spec.jobTemplate.spec.template, lastRun, 'done', 'f', ipOn('f', 90))
event(cron, 'Normal', 'SuccessfulCreate', 'Created job batch-worker-' + Math.floor(lastRun / 60_000), 1, iso(lastRun), iso(lastRun), 'cronjob-controller')
event(cron, 'Normal', 'SawCompletedJob', `Saw completed job: batch-worker-${Math.floor(lastRun / 60_000)}, condition: Complete`, 1, iso(lastRun + 46_000), iso(lastRun + 46_000), 'cronjob-controller')
const syncTemplate = { metadata: { labels: { app: 'scheduler' } }, spec: { containers: [containerOf('app', 'batch/scheduler:0.4.2')], restartPolicy: 'OnFailure', serviceAccountName: 'default', terminationGracePeriodSeconds: 30, dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', securityContext: {} } }
LOG_STYLE.set(REG + 'batch/scheduler', 'jobfail')
jobFor(null, 'batch', 'scheduler', syncTemplate, Date.parse('2026-11-23T00:20:00Z'), 'failed', 'c', ipOn('c', 91))

// ---- Status that follows the Pods (recomputed after every change)

const podReady = (p: Obj) => p.status.conditions?.some((c: Obj) => c.type === 'Ready' && c.status === 'True') === true
const active = (p: Obj) => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed'
const condition = (type: string, status: string, reason: string, message: string, at: string) => ({ type, status, lastUpdateTime: at, lastTransitionTime: at, reason, message })
// A Deployment's revision, which the ReplicaSet of its template has too, and when it last rolled out in the demo.
const REVISION = 'deployment.kubernetes.io/revision'
const revisionOf = (o: Obj) => Number(o.metadata.annotations?.[REVISION]) || 0
const rolledAt = new Map<string, number>()
const newestRevision = (w: Obj): Obj | undefined => owned(w, 'ControllerRevision').sort((a, b) => b.revision - a.revision)[0]

function sync() {
  for (const rs of all('ReplicaSet')) {
    const pods = owned(rs).filter(active)
    const ready = pods.filter(podReady).length
    rs.status = { replicas: pods.length, fullyLabeledReplicas: pods.length, readyReplicas: ready, availableReplicas: ready, observedGeneration: rs.metadata.generation }
  }
  for (const d of all('Deployment')) {
    const sets = owned(d, 'ReplicaSet')
    const current = sets.find((s) => revisionOf(s) === revisionOf(d)) ?? sets[0]
    const pods = sets.flatMap((s) => owned(s)).filter(active), updated = current ? owned(current).filter(active) : []
    const ready = pods.filter(podReady).length
    const want = d.spec.replicas ?? 1
    const enough = ready >= want - Math.floor(want * 0.25)
    // a rollout whose Pods do not start is under way until its deadline, and then stuck
    const rolled = rolledAt.get(d.metadata.uid)
    const behind = (rolled ? updated.filter(podReady).length < want : !enough) && updated.some((p) => crashing(p) || p.status.phase === 'Pending')
    const late = behind && (!rolled || Date.now() - rolled > 600_000), since = rolled && iso(rolled + (late ? 600_000 : 0))
    const name = current?.metadata.name ?? d.metadata.name
    const [reason, message] = !behind ? ['NewReplicaSetAvailable', 'has successfully progressed.'] : late ? ['ProgressDeadlineExceeded', 'has timed out progressing.'] : ['ReplicaSetUpdated', 'is progressing.']
    d.status = {
      observedGeneration: d.metadata.generation, replicas: pods.length, updatedReplicas: updated.length, readyReplicas: ready, availableReplicas: ready,
      ...(pods.length > ready ? { unavailableReplicas: pods.length - ready } : {}),
      conditions: [
        condition('Available', enough ? 'True' : 'False', enough ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', enough ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.', enough ? d.metadata.creationTimestamp : ago(24)),
        condition('Progressing', late ? 'False' : 'True', reason, `ReplicaSet "${name}" ${message}`, since || (behind ? ago(15) : d.metadata.creationTimestamp)),
      ],
    }
  }
  for (const s of all('StatefulSet')) {
    const pods = owned(s).filter(active)
    const ready = pods.filter(podReady).length
    const rev = newestRevision(s)?.metadata.name
    s.status = { observedGeneration: s.metadata.generation, replicas: pods.length, readyReplicas: ready, currentReplicas: pods.length, updatedReplicas: pods.length, availableReplicas: ready, currentRevision: rev, updateRevision: rev, collisionCount: 0 }
  }
  for (const ds of all('DaemonSet')) {
    const pods = owned(ds).filter(active)
    const ready = pods.filter(podReady).length
    const want = all('Node').length
    ds.status = { currentNumberScheduled: pods.length, numberMisscheduled: 0, desiredNumberScheduled: want, numberReady: ready, observedGeneration: ds.metadata.generation, updatedNumberScheduled: pods.length, numberAvailable: ready, ...(want > ready ? { numberUnavailable: want - ready } : {}) }
  }
  for (const h of all('HorizontalPodAutoscaler')) {
    const target = find(h.spec.scaleTargetRef.kind, h.metadata.namespace, h.spec.scaleTargetRef.name)
    const n = target?.spec.replicas ?? 0
    h.status = { lastScaleTime: '2026-11-22T14:05:00Z', currentReplicas: n, desiredReplicas: Math.max(h.spec.minReplicas, n), currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 38, averageValue: '38m' } } }],
      conditions: [condition('AbleToScale', 'True', 'ReadyForNewScale', 'recommended size matches current size', rolledOut), condition('ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)', rolledOut), condition('ScalingLimited', n <= h.spec.minReplicas ? 'True' : 'False', n <= h.spec.minReplicas ? 'TooFewReplicas' : 'DesiredWithinRange', n <= h.spec.minReplicas ? 'the desired replica count is less than the minimum replica count' : 'the desired count is within the acceptable range', rolledOut)].map(({ lastUpdateTime, ...c }) => (void lastUpdateTime, c)) }
  }
  for (const c of all('CronJob')) c.status.active = owned(c, 'Job').filter((j) => !j.status.conditions?.length).map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: j.metadata.namespace, uid: j.metadata.uid }))
}

// What a Namespace being deleted waits for.
function contentRemaining(n: Obj, left: number) {
  const says = left ? { status: 'True', reason: 'SomeResourcesRemain', message: `Some resources are remaining: pods. has ${left} resource instances` } : { status: 'False', reason: 'ContentRemoved', message: 'All content successfully removed' }
  n.status.conditions = [{ type: 'NamespaceContentRemaining', lastTransitionTime: iso(Date.now()), ...says }]
}

// What time changes without a click: checkout-api's restarts, a run started from the CronJob finishing, a deleted Namespace's
// Pods ending.
const crashShown = new Map<string, string>()
export function advance() {
  let moved = false
  for (const p of all('Pod').filter(crashing)) {
    const at = Date.parse(p.metadata.creationTimestamp), runs = crashRuns(at), ended = crashEnded(at)
    if (crashShown.get(p.metadata.uid) === runs + '/' + ended) continue
    crashShown.set(p.metadata.uid, runs + '/' + ended)
    moved = true
    p.status.containerStatuses[0] = { ...p.status.containerStatuses[0], restartCount: runs - 1,
      ...(ended ? {
        state: { waiting: { reason: 'CrashLoopBackOff', message: `back-off 20s restarting failed container=app pod=${p.metadata.name}_${p.metadata.namespace}(${p.metadata.uid})` } },
        lastState: { terminated: { exitCode: 1, reason: 'Error', startedAt: iso(crashRunAt(at, ended)), finishedAt: iso(crashRunEnd(at, ended)), containerID: 'containerd://' + hex(p.metadata.uid + ended, 64) } },
      } : {}) }
  }
  if (moved) refresh()
  for (const j of all('Job').filter((x) => x.status.active && Date.now() - Date.parse(x.status.startTime) > 20_000)) {
    const done = iso(Date.parse(j.status.startTime) + 20_000)
    j.status = { startTime: j.status.startTime, completionTime: done, succeeded: 1, ready: 0, terminating: 0, uncountedTerminatedPods: {}, conditions: [{ type: 'SuccessCriteriaMet', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: done, lastTransitionTime: done }, { type: 'Complete', status: 'True', reason: 'CompletionsReached', message: 'Reached expected number of succeeded pods', lastProbeTime: done, lastTransitionTime: done }] }
    for (const p of owned(j)) setPodState(p, 'done', p.status.podIP)
    event(j, 'Normal', 'Completed', 'Job completed', 1, done, done, 'job-controller')
    refresh()
  }
  // a Pod on a node that is not Ready has no kubelet to end it, so its Namespace stays Terminating
  for (const n of all('Namespace').filter((x) => x.metadata.deletionTimestamp && Date.now() - Date.parse(x.metadata.deletionTimestamp) > 8_000)) {
    const held = all('Pod', n.metadata.name), ended = held.filter((p) => !p.spec.nodeName || nodeReady(p.spec.nodeName))
    if (held.length && !ended.length) continue
    for (const p of ended) drop(p)
    if (ended.length === held.length) drop(n)
    else contentRemaining(n, held.length - ended.length)
    refresh()
  }
}

// ---- Rows, as the list APIs send them (kubectl's columns), and the arrays the chat reads

const cpuMilli = (q: string | undefined) => (!q ? 0 : q.endsWith('m') ? Number(q.slice(0, -1)) : Number(q) * 1000)
const bytes = (q: string | undefined) => {
  if (!q) return 0
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G)?$/.exec(q)
  return m ? Number(m[1]) * ({ Ki: 1024, Mi: 1048576, Gi: 1073741824, Ti: 1099511627776, K: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[m[2] ?? ''] || Number(m?.[1] ?? 0) : 0
}
const restartsOf = (p: Obj) => (p.status.containerStatuses || []).reduce((n: number, c: Obj) => n + (c.restartCount || 0), 0)
const readyOf = (p: Obj) => `${(p.status.containerStatuses || []).filter((c: Obj) => c.ready).length}/${p.spec.containers.length}`
// kubectl's printPod STATUS.
export function podStatusText(p: Obj): string {
  if (p.metadata.deletionTimestamp) return p.status.reason === 'NodeLost' ? 'Unknown' : 'Terminating'
  let reason = p.status.reason || p.status.phase || 'Unknown'
  let running = false
  for (const c of [...(p.status.containerStatuses || [])].reverse()) {
    if (c.state?.waiting?.reason) reason = c.state.waiting.reason
    else if (c.state?.terminated?.reason) reason = c.state.terminated.reason
    else if (c.state?.terminated) reason = 'ExitCode:' + c.state.terminated.exitCode
    else if (c.ready && c.state?.running) running = true
  }
  return reason === 'Completed' && running ? 'Running' : reason
}
const stateOf = (s: Obj = {}) => s.running ? { running: { started_at: s.running.startedAt } }
  : s.waiting ? { waiting: { reason: s.waiting.reason || '', message: s.waiting.message || '' } }
    : s.terminated ? { terminated: { exit_code: s.terminated.exitCode, reason: s.terminated.reason || '', message: s.terminated.message || '', started_at: s.terminated.startedAt, finished_at: s.terminated.finishedAt } } : {}
const portRow = (x: Obj) => ({ container_port: x.containerPort, protocol: x.protocol, name: x.name || '' })
const mountRow = (m: Obj) => ({ name: m.name, mount_path: m.mountPath, read_only: !!m.readOnly })
const refs = (o: Obj) => (o.metadata.ownerReferences || []).map((r: Obj) => ({ kind: r.kind, name: r.name, uid: r.uid, controller: !!r.controller }))
const tolerationRow = (t: Obj) => ({ key: t.key || '', operator: t.operator || 'Equal', value: t.value || '', effect: t.effect || '', toleration_seconds: t.tolerationSeconds ?? null })
const conditionRows = (o: Obj) => (o.status?.conditions || []).map((c: Obj) => ({ type: c.type, status: c.status, reason: c.reason || '', message: c.message || '', last_transition_time: c.lastTransitionTime || '', ...(c.lastUpdateTime ? { last_update_time: c.lastUpdateTime } : {}) }))
const meta = (o: Obj) => ({ uid: o.metadata.uid, resource_version: o.metadata.resourceVersion, labels: o.metadata.labels ?? null, annotations: o.metadata.annotations ?? null })
const withEvents = (o: Obj, row: Obj) => ({ ...row, events: eventsOf(o) })
function refNames(spec: Obj) {
  const cms = new Set<string>(), secretNames = new Set<string>()
  for (const v of spec.volumes || []) { if (v.configMap) cms.add(v.configMap.name); if (v.secret) secretNames.add(v.secret.secretName) }
  for (const c of spec.containers || []) {
    for (const e of c.envFrom || []) { if (e.configMapRef) cms.add(e.configMapRef.name); if (e.secretRef) secretNames.add(e.secretRef.name) }
    for (const e of c.env || []) { if (e.valueFrom?.configMapKeyRef) cms.add(e.valueFrom.configMapKeyRef.name); if (e.valueFrom?.secretKeyRef) secretNames.add(e.valueFrom.secretKeyRef.name) }
  }
  for (const s of spec.imagePullSecrets || []) secretNames.add(s.name)
  return { cms: [...cms].sort(), secrets: [...secretNames].sort() }
}

// The Pods list's row (pods_page.go).
export function podRow(p: Obj): Obj {
  return { name: p.metadata.name, namespace: p.metadata.namespace, status: podStatusText(p), phase: p.status.phase, ready: readyOf(p), restart_count: restartsOf(p), node_name: p.spec.nodeName || '', pod_ip: p.status.podIP || '', created_at: p.metadata.creationTimestamp, ...(p.metadata.deletionTimestamp ? { deletion_timestamp: p.metadata.deletionTimestamp } : {}), service_account_name: p.spec.serviceAccountName }
}
// podrow.Info: the row of every pod list and of the live updates.
function podInfo(p: Obj): Obj {
  const statuses = new Map((p.status.containerStatuses || []).map((c: Obj) => [c.name, c]))
  const { cms, secrets: secretRefs } = refNames(p.spec)
  return {
    name: p.metadata.name, namespace: p.metadata.namespace, status: podStatusText(p), phase: p.status.phase, reason: p.status.reason || '', status_reason: p.status.reason || '', message: p.status.message || '', status_message: p.status.message || '',
    node_name: p.spec.nodeName || '', pod_ip: p.status.podIP || '', labels: p.metadata.labels ?? null, restart_count: restartsOf(p), ready: readyOf(p), created_at: p.metadata.creationTimestamp,
    containers: p.spec.containers.map((c: Obj) => {
      const s = statuses.get(c.name) as Obj | undefined
      return { name: c.name, image: c.image, ports: (c.ports || []).map(portRow), resources: { requests: c.resources?.requests ?? {}, limits: c.resources?.limits ?? {} }, volume_mounts: (c.volumeMounts || []).map(mountRow), env_count: (c.env || []).length,
        env_from: (c.envFrom || []).map((e: Obj) => (e.configMapRef ? { config_map: e.configMapRef.name } : { secret: e.secretRef?.name })), ...(c.args ? { args: c.args } : {}),
        ...(s ? { ready: !!s.ready, restart_count: s.restartCount || 0, state: stateOf(s.state), last_state: stateOf(s.lastState) } : {}) }
    }),
    init_containers: [], ...(p.metadata.deletionTimestamp ? { deletion_timestamp: p.metadata.deletionTimestamp } : {}),
    owner_references: refs(p), service_account_name: p.spec.serviceAccountName, config_map_refs: cms, secret_refs: secretRefs,
  }
}
function podDescribe(p: Obj): Obj {
  const vol = (v: Obj) => v.configMap ? { name: v.name, type: 'ConfigMap', config_map: v.configMap.name } : v.secret ? { name: v.name, type: 'Secret', secret: v.secret.secretName }
    : v.persistentVolumeClaim ? { name: v.name, type: 'PersistentVolumeClaim', pvc: v.persistentVolumeClaim.claimName } : v.emptyDir ? { name: v.name, type: 'EmptyDir' }
      : v.hostPath ? { name: v.name, type: 'HostPath', path: v.hostPath.path } : v.projected ? { name: v.name, type: 'Projected' } : { name: v.name, type: 'Other' }
  return withEvents(p, {
    ...podInfo(p), uid: p.metadata.uid, resource_version: p.metadata.resourceVersion, qos_class: p.status.qosClass, pod_ips: (p.status.podIPs || []).map((x: Obj) => x.ip), host_ip: p.status.hostIP || '',
    host_ips: (p.status.hostIPs || []).map((x: Obj) => x.ip), nominated_node_name: '', preemption_policy: p.spec.preemptionPolicy, priority: p.spec.priority, priority_class_name: '',
    service_account: p.spec.serviceAccountName, restart_policy: p.spec.restartPolicy, host_network: false, host_pid: false, host_ipc: false, image_pull_secrets: (p.spec.imagePullSecrets || []).map((s: Obj) => s.name),
    ...(p.status.startTime ? { start_time: p.status.startTime } : {}), owner_references: (p.metadata.ownerReferences || []).map((r: Obj) => ({ api_version: r.apiVersion, kind: r.kind, name: r.name, uid: r.uid, controller: !!r.controller })),
    finalizers: p.metadata.finalizers ?? [], annotations: p.metadata.annotations ?? {}, conditions: conditionRows(p), volumes: (p.spec.volumes || []).map(vol),
    tolerations: (p.spec.tolerations || []).map(tolerationRow), node_selector: p.spec.nodeSelector ?? {},
  })
}

export const pods: Obj[] = []
export const nodes: Obj[] = []
function refresh() {
  // an autoscaler keeps its workload between its bounds (one scaled to zero is left alone)
  for (const h of all('HorizontalPodAutoscaler')) {
    const w = find(h.spec.scaleTargetRef.kind, h.metadata.namespace, h.spec.scaleTargetRef.name)
    const n = w?.spec.replicas ? Math.min(h.spec.maxReplicas ?? w.spec.replicas, Math.max(h.spec.minReplicas, w.spec.replicas)) : 0
    if (w && n && n !== w.spec.replicas) { w.spec.replicas = n; reconcile(w) }
  }
  sync()
  pods.splice(0, pods.length, ...all('Pod').map(podRow))
  nodes.splice(0, nodes.length, ...all('Node').map(nodeRow))
  changed()
}

const age = (at: string) => { const d = Math.floor((Date.now() - Date.parse(at)) / 86_400_000); return d >= 1 ? d + 'd' : Math.max(1, Math.floor((Date.now() - Date.parse(at)) / 3_600_000)) + 'h' }
function nodeStatus(n: Obj): string {
  const ready = n.status.conditions.find((c: Obj) => c.type === 'Ready')?.status
  return (ready === 'True' ? 'Ready' : ready === 'False' ? 'NotReady' : 'Unknown') + (n.spec.unschedulable ? ',SchedulingDisabled' : '')
}
function nodeRow(n: Obj): Obj {
  const info = n.status.nodeInfo
  return {
    name: n.metadata.name, status: nodeStatus(n), unschedulable: !!n.spec.unschedulable, roles: Object.keys(n.metadata.labels || {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).sort(),
    internal_ip: n.status.addresses.find((a: Obj) => a.type === 'InternalIP')?.address ?? '', external_ip: '', version: info.kubeletVersion, os_image: info.osImage, kernel_version: info.kernelVersion,
    container_runtime: info.containerRuntimeVersion, kubelet_version: info.kubeletVersion, age: age(n.metadata.creationTimestamp), created_at: n.metadata.creationTimestamp, labels: n.metadata.labels,
    taints: (n.spec.taints || []).map((t: Obj) => ({ key: t.key, value: t.value || '', effect: t.effect })), conditions: n.status.conditions.map((c: Obj) => ({ type: c.type, status: c.status, reason: c.reason })),
    capacity: n.status.capacity, allocatable: n.status.allocatable,
  }
}
function nodeDescribe(n: Obj, withEventsToo: boolean): Obj {
  const info = n.status.nodeInfo
  const on = all('Pod').filter((p) => p.spec.nodeName === n.metadata.name)
  const held = on.filter((p) => p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed')
  const sum = (pick: (c: Obj) => number) => held.reduce((t, p) => t + p.spec.containers.reduce((s: number, c: Obj) => s + pick(c), 0), 0)
  const cpuA = cpuMilli(n.status.allocatable.cpu), memA = bytes(n.status.allocatable.memory)
  const pct = (v: number, of: number) => Math.floor((v / of) * 100) + '%'
  const cpu = (m: number) => `${m}m (${pct(m, cpuA)})`, mem = (b: number) => `${Math.round(b / 1048576)}Mi (${pct(b, memA)})`
  const volumes = all('PersistentVolume').filter((pv) => on.some((p) => (p.spec.volumes || []).some((v: Obj) => v.persistentVolumeClaim?.claimName === pv.spec.claimRef?.name && p.metadata.namespace === pv.spec.claimRef?.namespace)))
  const handles = volumes.map((pv) => `kubernetes.io/csi/${CSI}^${pv.spec.csi.volumeHandle}`)
  return {
    ...nodeRow(n), uid: n.metadata.uid, annotations: n.metadata.annotations, unschedulable: !!n.spec.unschedulable,
    conditions: n.status.conditions.map((c: Obj) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message, last_heartbeat_time: c.lastHeartbeatTime, last_transition_time: c.lastTransitionTime })),
    addresses: n.status.addresses.map((a: Obj) => ({ type: a.type, address: a.address })),
    system_info: { machine_id: info.machineID, system_uuid: info.systemUUID, boot_id: info.bootID, kernel_version: info.kernelVersion, os_image: info.osImage, container_runtime_version: info.containerRuntimeVersion, kubelet_version: info.kubeletVersion, operating_system: info.operatingSystem, architecture: info.architecture },
    pod_cidr: n.spec.podCIDR, pod_cidrs: n.spec.podCIDRs,
    images: [...new Set(on.flatMap((p) => p.spec.containers.map((c: Obj) => c.image)))].map((image) => ({ names: [image.split(':')[0] + '@' + sha(image), image], size: 18_000_000 + (hash(image) % 220_000_000) })),
    volumes_attached: handles.map((name) => ({ name, device_path: '' })), volumes_in_use: handles,
    allocated_resources: [
      { resource: 'cpu', requests: cpu(sum((c) => cpuMilli(c.resources?.requests?.cpu))), limits: cpu(sum((c) => cpuMilli(c.resources?.limits?.cpu))) },
      { resource: 'memory', requests: mem(sum((c) => bytes(c.resources?.requests?.memory))), limits: mem(sum((c) => bytes(c.resources?.limits?.memory))) },
      { resource: 'ephemeral-storage', requests: '0 (0%)', limits: '0 (0%)' },
    ],
    ...(withEventsToo ? { events: eventsOf(n) } : {}),
  }
}

function templateRow(t: Obj): Obj {
  return {
    labels: t.metadata?.labels ?? null, service_account_name: t.spec.serviceAccountName ?? '', node_selector: t.spec.nodeSelector ?? null, priority_class_name: t.spec.priorityClassName ?? '',
    containers: t.spec.containers.map((c: Obj) => ({ name: c.name, image: c.image, ...(c.command ? { command: c.command } : {}), ...(c.args ? { args: c.args } : {}), ports: (c.ports || []).map(portRow),
      ...(c.resources?.requests ? { requests: c.resources.requests } : {}), ...(c.resources?.limits ? { limits: c.resources.limits } : {}), env_count: (c.env || []).length, volume_mounts: (c.volumeMounts || []).map(mountRow) })),
    tolerations: (t.spec.tolerations || []).map(({ tolerationSeconds, ...x }: Obj) => ({ key: x.key || '', operator: x.operator || 'Equal', effect: x.effect || '', ...(x.value ? { value: x.value } : {}), ...(tolerationSeconds !== undefined ? { toleration_seconds: tolerationSeconds } : {}) })),
  }
}
const images = (t: Obj) => t.spec.containers.map((c: Obj) => c.image)
const replicaStatus = (want: number, available: number, ready: number) => (want === 0 ? 'Idle' : available === 0 ? 'Unavailable' : ready < want ? 'Degraded' : 'Healthy')
const ownedRows = (o: Obj) => owned(o).map((p) => ({ name: p.metadata.name, namespace: p.metadata.namespace, status: podStatusText(p), ready: readyOf(p), restart_count: restartsOf(p), node_name: p.spec.nodeName || '', pod_ip: p.status.podIP || '', created_at: p.metadata.creationTimestamp }))

function deploymentRow(d: Obj): Obj {
  const s = d.status, progressing = s.conditions?.find((c: Obj) => c.type === 'Progressing'), available = s.conditions?.find((c: Obj) => c.type === 'Available')
  const status = progressing?.status === 'False' ? 'Failed' : available?.status === 'True' ? 'Available' : 'Progressing'
  return { name: d.metadata.name, namespace: d.metadata.namespace, replicas: d.spec.replicas, current_replicas: s.replicas || 0, ready_replicas: s.readyReplicas || 0, available_replicas: s.availableReplicas || 0, updated_replicas: s.updatedReplicas || 0, unavailable_replicas: s.unavailableReplicas || 0,
    progressing_reason: progressing?.status === 'False' ? progressing.reason : '', image: images(d.spec.template)[0], images: images(d.spec.template), labels: d.metadata.labels, selector: d.spec.selector.matchLabels, status, created_at: d.metadata.creationTimestamp }
}
const workloadReplicas = (o: Obj, want: number) => ({ desired: want, current: o.status.replicas ?? o.status.currentReplicas ?? 0, ready: o.status.readyReplicas || 0, updated: o.status.updatedReplicas ?? 0, available: o.status.availableReplicas || 0 })
function statefulSetRow(s: Obj): Obj {
  return { name: s.metadata.name, namespace: s.metadata.namespace, replicas: s.spec.replicas, ready_replicas: s.status.readyReplicas || 0, current_replicas: s.status.currentReplicas || 0, updated_replicas: s.status.updatedReplicas || 0, available_replicas: s.status.availableReplicas || 0,
    image: images(s.spec.template)[0], images: images(s.spec.template), selector: s.spec.selector.matchLabels, service_name: s.spec.serviceName, status: replicaStatus(s.spec.replicas, s.status.availableReplicas || 0, s.status.readyReplicas || 0), created_at: s.metadata.creationTimestamp }
}
function daemonSetRow(d: Obj): Obj {
  const s = d.status
  return { name: d.metadata.name, namespace: d.metadata.namespace, desired: s.desiredNumberScheduled, current: s.currentNumberScheduled, ready: s.numberReady, updated: s.updatedNumberScheduled, available: s.numberAvailable, misscheduled: 0, unavailable: s.numberUnavailable || 0,
    node_selector: d.spec.template.spec.nodeSelector ?? null, image: images(d.spec.template)[0], images: images(d.spec.template), selector: d.spec.selector.matchLabels, status: replicaStatus(s.desiredNumberScheduled, s.numberAvailable, s.numberReady), created_at: d.metadata.creationTimestamp }
}
function replicaSetRow(r: Obj): Obj {
  const owner = ownerOf(r)
  return { name: r.metadata.name, namespace: r.metadata.namespace, replicas: r.spec.replicas, current_replicas: r.status.replicas || 0, ready_replicas: r.status.readyReplicas || 0, available_replicas: r.status.availableReplicas || 0, image: images(r.spec.template)[0], images: images(r.spec.template),
    containers: r.spec.template.spec.containers.map((c: Obj) => c.name), selector: r.spec.selector.matchLabels, owner_deployment: owner?.kind === 'Deployment' ? owner.name : '', owner_references: refs(r),
    status: replicaStatus(r.spec.replicas, r.status.availableReplicas || 0, r.status.readyReplicas || 0), created_at: r.metadata.creationTimestamp }
}
function jobStatus(j: Obj) {
  const has = (type: string) => j.status.conditions?.find((c: Obj) => c.type === type)?.status === 'True'
  return has('Complete') ? 'Complete' : has('Failed') ? 'Failed' : j.spec.suspend ? 'Suspended' : 'Running'
}
function jobRow(j: Obj): Obj {
  return { name: j.metadata.name, namespace: j.metadata.namespace, completions: j.spec.completions, completions_text: `${j.status.succeeded || 0}/${j.spec.completions}`, parallelism: j.spec.parallelism, succeeded: j.status.succeeded || 0, failed: j.status.failed || 0, active: j.status.active || 0,
    status: jobStatus(j), image: images(j.spec.template)[0], images: images(j.spec.template), containers: j.spec.template.spec.containers.map((c: Obj) => c.name), owner_references: refs(j), created_at: j.metadata.creationTimestamp }
}
function cronJobRow(c: Obj): Obj {
  const t = c.spec.jobTemplate.spec.template
  return { name: c.metadata.name, namespace: c.metadata.namespace, schedule: c.spec.schedule, suspend: !!c.spec.suspend, active: (c.status.active || []).length, image: images(t)[0], images: images(t), containers: t.spec.containers.map((x: Obj) => x.name), concurrency_policy: c.spec.concurrencyPolicy, created_at: c.metadata.creationTimestamp,
    last_schedule: c.status.lastScheduleTime, last_successful: c.status.lastSuccessfulTime }
}
const cronJobJobs = (c: Obj) => owned(c, 'Job').map((j) => ({ name: j.metadata.name, namespace: j.metadata.namespace, status: jobStatus(j), start_time: j.status.startTime, ...(j.status.completionTime ? { completion_time: j.status.completionTime, duration: Math.round((Date.parse(j.status.completionTime) - Date.parse(j.status.startTime)) / 1000) } : {}) }))

function hpaRow(h: Obj): Obj {
  const spec = { type: 'Resource', resource_name: 'cpu', target_type: 'Utilization', target_average_utilization: h.spec.metrics[0].resource.target.averageUtilization }
  const current = { type: 'Resource', resource_name: 'cpu', current_average_utilization: h.status.currentMetrics?.[0]?.resource.current.averageUtilization ?? 0 }
  return { name: h.metadata.name, namespace: h.metadata.namespace, target_ref: `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, target_ref_kind: h.spec.scaleTargetRef.kind, target_ref_name: h.spec.scaleTargetRef.name,
    min_replicas: h.spec.minReplicas, max_replicas: h.spec.maxReplicas, current_replicas: h.status.currentReplicas, desired_replicas: h.status.desiredReplicas, scaling_active: true, metrics: [{ ...spec, current }], metrics_spec: [spec], metrics_status: [current],
    last_scale_time: h.status.lastScaleTime, labels: h.metadata.labels, created_at: h.metadata.creationTimestamp }
}

const servicePorts = (s: Obj) => s.spec.ports.map((p: Obj) => ({ name: p.name, port: p.port, target_port: String(p.targetPort), protocol: p.protocol, ...(p.nodePort ? { node_port: p.nodePort } : {}) }))
function serviceRow(s: Obj): Obj {
  const lb = (s.status.loadBalancer?.ingress || []).map((x: Obj) => ({ ...(x.ip ? { ip: x.ip } : {}), ...(x.hostname ? { hostname: x.hostname } : {}) }))
  return { name: s.metadata.name, namespace: s.metadata.namespace, type: s.spec.type, cluster_ip: s.spec.clusterIP, external_ip: lb.map((x: Obj) => x.ip || x.hostname).join(',') || (s.spec.type === 'LoadBalancer' ? '<pending>' : '<none>'), external_ips: [], load_balancer_ingress: lb, ports: servicePorts(s), selector: s.spec.selector ?? null, created_at: s.metadata.creationTimestamp }
}
// The Pods a Service's selector picks, with an address: its endpoints, ready or not.
function backends(s: Obj) {
  if (!s.spec.selector) return []
  return all('Pod', s.metadata.namespace).filter((p) => p.status.podIP && !p.metadata.deletionTimestamp && active(p) && Object.entries(s.spec.selector).every(([k, v]) => p.metadata.labels?.[k] === v))
}
function endpointsOf(s: Obj): Obj {
  const pods = backends(s)
  const address = (p: Obj) => ({ ip: p.status.podIP, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: p.metadata.namespace, uid: p.metadata.uid } })
  const subsets = s.metadata.name === 'kubernetes' && s.metadata.namespace === 'default'
    ? [{ addresses: [{ ip: '192.0.2.5' }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] }]
    : pods.length ? [{ ...(pods.some(podReady) ? { addresses: pods.filter(podReady).map(address) } : {}), ...(pods.some((p) => !podReady(p)) ? { notReadyAddresses: pods.filter((p) => !podReady(p)).map(address) } : {}), ports: s.spec.ports.map((p: Obj) => ({ name: p.name, port: p.targetPort, protocol: p.protocol })) }] : []
  return { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: s.metadata.name, namespace: s.metadata.namespace, uid: uidOf('ep' + s.metadata.uid), resourceVersion: String(resourceVersion), creationTimestamp: s.metadata.creationTimestamp, labels: { ...(s.metadata.labels || {}), 'endpoints.kubernetes.io/managed-by': 'endpoint-controller' } }, ...(subsets.length ? { subsets } : {}) }
}
function sliceOf(s: Obj): Obj {
  const ep = endpointsOf(s)
  const one = ep.subsets?.[0]
  const entry = (a: Obj, ready: boolean) => ({ addresses: [a.ip], conditions: { ready, serving: ready, terminating: false }, ...(a.targetRef ? { targetRef: a.targetRef } : {}), ...(a.nodeName ? { nodeName: a.nodeName, zone: zoneOf(a.nodeName.slice(-1)) } : {}) })
  return { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: { name: s.metadata.name + '-' + suffix(s.metadata.uid), namespace: s.metadata.namespace, uid: uidOf('es' + s.metadata.uid), resourceVersion: String(resourceVersion), creationTimestamp: s.metadata.creationTimestamp, generation: 1,
    labels: { 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': s.metadata.name }, ownerReferences: [ref(s)] },
    addressType: 'IPv4', endpoints: [...(one?.addresses || []).map((a: Obj) => entry(a, true)), ...(one?.notReadyAddresses || []).map((a: Obj) => entry(a, false))], ports: one?.ports ?? [] }
}
function endpointsRow(e: Obj): Obj {
  const sub = e.subsets?.[0] ?? {}
  const target = (a: Obj) => ({ ip: a.ip, ...(a.nodeName ? { node_name: a.nodeName } : {}), ...(a.targetRef ? { target_ref: { kind: a.targetRef.kind, name: a.targetRef.name } } : {}) })
  return { name: e.metadata.name, namespace: e.metadata.namespace, ready_count: (sub.addresses || []).length, not_ready_count: (sub.notReadyAddresses || []).length, ready_addresses: (sub.addresses || []).map((a: Obj) => a.ip), not_ready_addresses: (sub.notReadyAddresses || []).map((a: Obj) => a.ip),
    ready_targets: (sub.addresses || []).map(target), not_ready_targets: (sub.notReadyAddresses || []).map(target), ports: (sub.ports || []).map((p: Obj) => ({ name: p.name, port: p.port, protocol: p.protocol })), created_at: e.metadata.creationTimestamp }
}
function sliceRow(e: Obj): Obj {
  return { name: e.metadata.name, namespace: e.metadata.namespace, service_name: e.metadata.labels['kubernetes.io/service-name'], managed_by: e.metadata.labels['endpointslice.kubernetes.io/managed-by'], address_type: e.addressType,
    endpoints_total: e.endpoints.length, endpoints_ready: e.endpoints.filter((x: Obj) => x.conditions.ready).length, endpoints_not_ready: e.endpoints.filter((x: Obj) => !x.conditions.ready).length,
    endpoints: e.endpoints.map((x: Obj) => ({ addresses: x.addresses, conditions: x.conditions, ...(x.targetRef ? { target_ref: { kind: x.targetRef.kind, name: x.targetRef.name, namespace: x.targetRef.namespace } } : {}), ...(x.nodeName ? { node_name: x.nodeName, zone: x.zone } : {}) })),
    ports: e.ports.map((p: Obj) => ({ name: p.name, port: p.port, protocol: p.protocol })), labels: e.metadata.labels, annotations: null, created_at: e.metadata.creationTimestamp }
}
function serviceDescribe(s: Obj): Obj {
  const slice = sliceOf(s)
  const ready = slice.endpoints.filter((x: Obj) => x.conditions.ready).map((x: Obj) => x.addresses[0]), notReady = slice.endpoints.filter((x: Obj) => !x.conditions.ready).map((x: Obj) => x.addresses[0])
  return withEvents(s, { ...serviceRow(s), ...meta(s), cluster_ips: s.spec.clusterIPs, session_affinity: s.spec.sessionAffinity, internal_traffic_policy: s.spec.internalTrafficPolicy, ...(s.spec.externalTrafficPolicy ? { external_traffic_policy: s.spec.externalTrafficPolicy, health_check_node_port: s.spec.healthCheckNodePort, allocate_load_balancer_node_ports: true } : {}),
    ip_family_policy: s.spec.ipFamilyPolicy, ip_families: s.spec.ipFamilies, publish_not_ready_addresses: false, finalizers: [], owner_references: [], conditions: [],
    endpoint_summary: { ready_count: ready.length, not_ready_count: notReady.length, ready_addresses: ready, not_ready_addresses: notReady },
    endpoints: slice.endpoints.map((x: Obj) => ({ ip: x.addresses[0], ready: x.conditions.ready, target_ref: x.targetRef ? { kind: x.targetRef.kind, name: x.targetRef.name, namespace: x.targetRef.namespace } : null })),
    endpoint_slices: slice.endpoints.length || s.spec.selector ? [sliceRow(slice)] : [] })
}

const sortedKeys = (o: Obj = {}) => Object.keys(o).sort()
const configMapRow = (c: Obj) => ({ name: c.metadata.name, namespace: c.metadata.namespace, data_count: Object.keys(c.data || {}).length, data_keys: sortedKeys(c.data), binary_keys: [], labels: c.metadata.labels ?? null, created_at: c.metadata.creationTimestamp })
const secretRow = (s: Obj) => ({ name: s.metadata.name, namespace: s.metadata.namespace, type: s.type, data_count: Object.keys(s.data || {}).length, data_keys: sortedKeys(s.data), labels: s.metadata.labels ?? null, created_at: s.metadata.creationTimestamp })
const accountRow = (a: Obj) => ({ name: a.metadata.name, namespace: a.metadata.namespace, secrets: 0, secrets_list: [], image_pull_secrets: (a.imagePullSecrets || []).map((x: Obj) => x.name), created_at: a.metadata.creationTimestamp, labels: a.metadata.labels ?? null, annotations: a.metadata.annotations ?? null })
const qty = (q: string | undefined) => q ?? ''
function pvcRow(c: Obj): Obj {
  return { name: c.metadata.name, namespace: c.metadata.namespace, status: c.status.phase, volume_name: c.spec.volumeName ?? '', capacity: qty(c.status.capacity?.storage), requested: c.spec.resources.requests.storage, access_modes: c.status.accessModes ?? [], requested_access_modes: c.spec.accessModes, storage_class: c.spec.storageClassName, created_at: c.metadata.creationTimestamp }
}
function pvRow(v: Obj): Obj {
  return { name: v.metadata.name, status: v.status.phase, capacity: v.spec.capacity.storage, access_modes: v.spec.accessModes, reclaim_policy: v.spec.persistentVolumeReclaimPolicy, storage_class: v.spec.storageClassName, claim_ref: v.spec.claimRef ? { namespace: v.spec.claimRef.namespace, name: v.spec.claimRef.name } : null,
    volume_mode: v.spec.volumeMode, source: 'CSI', driver: v.spec.csi.driver, volume_handle: v.spec.csi.volumeHandle, reason: '', message: '', created_at: v.metadata.creationTimestamp }
}
const classRow = (s: Obj) => ({ name: s.metadata.name, provisioner: s.provisioner, reclaim_policy: s.reclaimPolicy, volume_binding_mode: s.volumeBindingMode, allow_volume_expansion: !!s.allowVolumeExpansion, is_default: s.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true', parameters: s.parameters, mount_options: [], labels: s.metadata.labels ?? null, annotations: s.metadata.annotations ?? null, created_at: s.metadata.creationTimestamp })
function claimUsers(ns: string, claim: string) {
  return all('Pod', ns).filter((p) => (p.spec.volumes || []).some((v: Obj) => v.persistentVolumeClaim?.claimName === claim)).map((p) => ({ name: p.metadata.name, namespace: ns, status: podStatusText(p), phase: p.status.phase, node_name: p.spec.nodeName || '', ready: readyOf(p), restart_count: restartsOf(p),
    volume_names: p.spec.volumes.filter((v: Obj) => v.persistentVolumeClaim?.claimName === claim).map((v: Obj) => v.name), created_at: p.metadata.creationTimestamp }))
}
function ingressRow(i: Obj): Obj {
  const rules = i.spec.rules.map((r: Obj) => ({ host: r.host, paths: r.http.paths.map((x: Obj) => ({ path: x.path, path_type: x.pathType, backend: { service_name: x.backend.service.name, service_port: x.backend.service.port.number } })) }))
  return { name: i.metadata.name, namespace: i.metadata.namespace, class: i.spec.ingressClassName, class_source: 'spec', hosts: i.spec.rules.map((r: Obj) => r.host), addresses: (i.status.loadBalancer.ingress || []).map((x: Obj) => ({ hostname: x.hostname })),
    tls: (i.spec.tls || []).map((t: Obj) => ({ secret_name: t.secretName, hosts: t.hosts })), default_backend: null, rules, backends: [...new Set(rules.flatMap((r: Obj) => r.paths.map((x: Obj) => x.backend.service_name)))].sort(), labels: i.metadata.labels ?? null, annotations: i.metadata.annotations ?? null, created_at: i.metadata.creationTimestamp }
}
const ingressClassRow = (c: Obj) => ({ name: c.metadata.name, controller: c.spec.controller, is_default: c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true', labels: c.metadata.labels ?? null, annotations: c.metadata.annotations ?? null, finalizers: [], created_at: c.metadata.creationTimestamp })
const namespaceRow = (n: Obj) => ({ name: n.metadata.name, status: n.status.phase, created_at: n.metadata.creationTimestamp, labels: n.metadata.labels })

// One kind's list row, as the kind's list API answers it.
export const ROW: Record<string, (o: Obj) => Obj> = {
  Pod: podInfo, Deployment: deploymentRow, StatefulSet: statefulSetRow, DaemonSet: daemonSetRow, ReplicaSet: replicaSetRow, Job: jobRow, CronJob: cronJobRow, HorizontalPodAutoscaler: hpaRow,
  Service: serviceRow, Endpoints: (e) => endpointsRow(e), EndpointSlice: sliceRow, Ingress: ingressRow, IngressClass: ingressClassRow, ConfigMap: configMapRow, Secret: secretRow, ServiceAccount: accountRow,
  PersistentVolumeClaim: pvcRow, PersistentVolume: pvRow, StorageClass: classRow, Namespace: namespaceRow, Node: nodeRow,
}

// A kind's list rows (one namespace or all), as its list API answers them.
export const listRows = (kind: string, ns?: string) => all(kind, ns).map(ROW[kind])

const podSummary = (ns: string) => {
  const list = all('Pod', ns)
  const held = list.filter((p) => p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed')
  const sum = (pick: (c: Obj) => number) => held.reduce((t, p) => t + p.spec.containers.reduce((s: number, c: Obj) => s + pick(c), 0), 0)
  const phases: Record<string, number> = {}
  for (const p of list) phases[p.status.phase] = (phases[p.status.phase] || 0) + 1
  return { total: list.length, summed_pods: held.length, phases, cpu_requests_millicores: sum((c) => cpuMilli(c.resources?.requests?.cpu)), cpu_limits_millicores: sum((c) => cpuMilli(c.resources?.limits?.cpu)), memory_requests_bytes: sum((c) => bytes(c.resources?.requests?.memory)), memory_limits_bytes: sum((c) => bytes(c.resources?.limits?.memory)) }
}

// One kind's describe answer (the drawer's Info).
const DESCRIBE: Record<string, (o: Obj) => Obj> = {
  Pod: podDescribe,
  Deployment: (d) => withEvents(d, { ...deploymentRow(d), ...meta(d), generation: d.metadata.generation, observed_generation: d.status.observedGeneration, progress_deadline_seconds: d.spec.progressDeadlineSeconds, revision_history_limit: d.spec.revisionHistoryLimit,
    revision: d.metadata.annotations?.['deployment.kubernetes.io/revision'], replicas_status: { desired: d.spec.replicas, current: d.status.replicas, ready: d.status.readyReplicas, updated: d.status.updatedReplicas, available: d.status.availableReplicas },
    strategy: { type: d.spec.strategy.type, ...(d.spec.strategy.rollingUpdate ? { rolling_update: { max_unavailable: d.spec.strategy.rollingUpdate.maxUnavailable, max_surge: d.spec.strategy.rollingUpdate.maxSurge } } : {}) }, pod_template: templateRow(d.spec.template), conditions: conditionRows(d) }),
  StatefulSet: (s) => withEvents(s, { ...statefulSetRow(s), ...meta(s), generation: s.metadata.generation, observed_generation: s.status.observedGeneration, pod_management_policy: s.spec.podManagementPolicy, revision_history_limit: s.spec.revisionHistoryLimit,
    current_revision: s.status.currentRevision, update_revision: s.status.updateRevision, collision_count: 0, replicas_status: workloadReplicas(s, s.spec.replicas), update_strategy: { type: 'RollingUpdate', rolling_update: { partition: 0 } },
    pod_template: templateRow(s.spec.template), volume_claim_templates: s.spec.volumeClaimTemplates.map((v: Obj) => ({ name: v.metadata.name, storage_class_name: v.spec.storageClassName, access_modes: v.spec.accessModes, requests: v.spec.resources.requests })), conditions: [], owned_pods: ownedRows(s) }),
  DaemonSet: (d) => withEvents(d, { ...daemonSetRow(d), ...meta(d), generation: d.metadata.generation, observed_generation: d.status.observedGeneration, revision_history_limit: d.spec.revisionHistoryLimit, collision_count: 0,
    daemonset_status: { desired: d.status.desiredNumberScheduled, current: d.status.currentNumberScheduled, ready: d.status.numberReady, updated: d.status.updatedNumberScheduled, available: d.status.numberAvailable, misscheduled: 0, unavailable: d.status.numberUnavailable || 0 },
    update_strategy: { type: 'RollingUpdate', rolling_update: { max_unavailable: '1', max_surge: '0' } }, pod_template: templateRow(d.spec.template), conditions: [], owned_pods: ownedRows(d) }),
  ReplicaSet: (r) => withEvents(r, { ...replicaSetRow(r), ...meta(r), generation: r.metadata.generation, fully_labeled_replicas: r.status.fullyLabeledReplicas, replicas_status: { desired: r.spec.replicas, current: r.status.replicas, ready: r.status.readyReplicas, available: r.status.availableReplicas },
    revision: r.metadata.annotations?.['deployment.kubernetes.io/revision'], pod_template: templateRow(r.spec.template), conditions: [], owned_pods: ownedRows(r) }),
  Job: (j) => withEvents(j, { ...jobRow(j), uid: j.metadata.uid, labels: j.metadata.labels, annotations: j.metadata.annotations ?? null, backoff_limit: j.spec.backoffLimit, completion_mode: j.spec.completionMode, suspend: !!j.spec.suspend, manual_selector: false,
    selector: j.spec.selector.matchLabels, start_time: j.status.startTime, ...(j.status.completionTime ? { completion_time: j.status.completionTime, duration_seconds: Math.round((Date.parse(j.status.completionTime) - Date.parse(j.status.startTime)) / 1000) } : {}),
    pod_template: templateRow(j.spec.template), conditions: conditionRows(j) }),
  CronJob: (c) => withEvents(c, { ...cronJobRow(c), uid: c.metadata.uid, labels: c.metadata.labels, annotations: c.metadata.annotations ?? null, starting_deadline_seconds: c.spec.startingDeadlineSeconds, successful_jobs_history_limit: c.spec.successfulJobsHistoryLimit,
    failed_jobs_history_limit: c.spec.failedJobsHistoryLimit, last_schedule_time: c.status.lastScheduleTime, last_successful_time: c.status.lastSuccessfulTime, pod_template: templateRow(c.spec.jobTemplate.spec.template),
    active_jobs: (c.status.active || []).map((a: Obj) => ({ name: a.name, namespace: a.namespace })), owned_jobs: cronJobJobs(c) }),
  HorizontalPodAutoscaler: (h) => withEvents(h, { ...hpaRow(h), ...meta(h), generation: 1, scale_target_ref: { kind: h.spec.scaleTargetRef.kind, name: h.spec.scaleTargetRef.name, api_version: h.spec.scaleTargetRef.apiVersion }, conditions: conditionRows(h) }),
  Service: serviceDescribe,
  Endpoints: (e) => withEvents(e, { ...endpointsRow(e), uid: e.metadata.uid, labels: e.metadata.labels, annotations: null, generation: 1, resource_version: e.metadata.resourceVersion,
    subsets: (e.subsets || []).map((s: Obj) => ({ addresses: (s.addresses || []).map((a: Obj) => ({ ip: a.ip, ...(a.targetRef ? { target_ref: { kind: a.targetRef.kind, name: a.targetRef.name, namespace: a.targetRef.namespace } } : {}) })),
      not_ready_addresses: (s.notReadyAddresses || []).map((a: Obj) => ({ ip: a.ip, ...(a.targetRef ? { target_ref: { kind: a.targetRef.kind, name: a.targetRef.name, namespace: a.targetRef.namespace } } : {}) })), ports: s.ports })) }),
  EndpointSlice: (e) => withEvents(e, { ...sliceRow(e), uid: e.metadata.uid, resource_version: e.metadata.resourceVersion }),
  Ingress: (i) => withEvents(i, { ...ingressRow(i), uid: i.metadata.uid, resource_version: i.metadata.resourceVersion, class_controller: find('IngressClass', '', i.spec.ingressClassName)?.spec.controller ?? '', class_is_default: true }),
  IngressClass: (c) => withEvents(c, { ...ingressClassRow(c), uid: c.metadata.uid, resource_version: c.metadata.resourceVersion }),
  ConfigMap: (c) => withEvents(c, { ...configMapRow(c), binary_count: 0, data: { ...(c.data || {}) }, annotations: c.metadata.annotations ?? null, uid: c.metadata.uid, resource_version: c.metadata.resourceVersion }),
  Secret: (s) => withEvents(s, { ...secretRow(s), data_sizes: Object.fromEntries(Object.entries(s.data || {}).map(([k, v]) => [k, atob(String(v)).length])), can_reveal: false, annotations: s.metadata.annotations ?? null, uid: s.metadata.uid, resource_version: s.metadata.resourceVersion }),
  ServiceAccount: (a) => withEvents(a, { ...accountRow(a), uid: a.metadata.uid, resource_version: a.metadata.resourceVersion }),
  PersistentVolumeClaim: (c) => {
    const pv = c.spec.volumeName ? find('PersistentVolume', '', c.spec.volumeName) : undefined
    return withEvents(c, { ...pvcRow(c), ...meta(c), finalizers: c.metadata.finalizers, volume_mode: c.spec.volumeMode, ...(c.metadata.annotations?.['volume.kubernetes.io/selected-node'] ? { selected_node: c.metadata.annotations['volume.kubernetes.io/selected-node'] } : {}),
      ...(pv ? { bound_pv: { name: pv.metadata.name, status: pv.status.phase, capacity: pv.spec.capacity.storage, access_modes: pv.spec.accessModes, storage_class: pv.spec.storageClassName, reclaim_policy: pv.spec.persistentVolumeReclaimPolicy, volume_mode: pv.spec.volumeMode } } : {}),
      used_by_pods: claimUsers(c.metadata.namespace, c.metadata.name), conditions: [], resize_conditions: [], filesystem_resize_pending: false })
  },
  PersistentVolume: (v) => {
    const claim = v.spec.claimRef ? find('PersistentVolumeClaim', v.spec.claimRef.namespace, v.spec.claimRef.name) : undefined
    return withEvents(v, { ...pvRow(v), ...meta(v), finalizers: v.metadata.finalizers, volume_attributes: v.spec.csi.volumeAttributes, node_affinity: JSON.stringify(v.spec.nodeAffinity), last_phase_transition_time: v.status.lastPhaseTransitionTime,
      ...(claim ? { bound_claim: { namespace: claim.metadata.namespace, name: claim.metadata.name, status: claim.status.phase, requested: claim.spec.resources.requests.storage, capacity: qty(claim.status.capacity?.storage), storage_class: claim.spec.storageClassName, volume_mode: claim.spec.volumeMode, access_modes: claim.status.accessModes ?? [] } } : {}),
      used_by_pods: claim ? claimUsers(claim.metadata.namespace, claim.metadata.name) : [], conditions: [] })
  },
  StorageClass: (s) => {
    const pvs = all('PersistentVolume').filter((v) => v.spec.storageClassName === s.metadata.name), pvcs = all('PersistentVolumeClaim').filter((c) => c.spec.storageClassName === s.metadata.name)
    return withEvents(s, { ...classRow(s), uid: s.metadata.uid, resource_version: s.metadata.resourceVersion, finalizers: [],
      related_pvs: pvs.map((v) => ({ name: v.metadata.name, status: v.status.phase, capacity: v.spec.capacity.storage, created_at: v.metadata.creationTimestamp, claim_ref: { namespace: v.spec.claimRef.namespace, name: v.spec.claimRef.name } })),
      related_pvcs: pvcs.map((c) => ({ name: c.metadata.name, namespace: c.metadata.namespace, status: c.status.phase, requested: c.spec.resources.requests.storage, capacity: qty(c.status.capacity?.storage), volume_name: c.spec.volumeName ?? '', created_at: c.metadata.creationTimestamp })),
      usage: { pv_count: pvs.length, pv_bound_count: pvs.filter((v) => v.status.phase === 'Bound').length, pvc_count: pvcs.length, pvc_bound_count: pvcs.filter((c) => c.status.phase === 'Bound').length } })
  },
  Namespace: (n) => {
    const ns = n.metadata.name
    return withEvents(n, { ...namespaceRow(n), annotations: n.metadata.annotations ?? null, uid: n.metadata.uid, resource_version: n.metadata.resourceVersion, ...(n.metadata.deletionTimestamp ? { deletion_timestamp: n.metadata.deletionTimestamp } : {}), finalizers: n.spec.finalizers,
      resource_counts: { pods: all('Pod', ns).length, services: all('Service', ns).length, deployments: all('Deployment', ns).length, configmaps: all('ConfigMap', ns).length, secrets: all('Secret', ns).length },
      resource_quotas: [], limit_ranges: [], owner_references: [], conditions: conditionRows(n), pod_summary: podSummary(ns) })
  },
  Node: (n) => nodeDescribe(n, true),
}

// ---- What the object looks like in the YAML window and to the AI (a Secret's values masked, as without reveal)

export function objectJson(o: Obj): Obj {
  const out = clone(o)
  if (out.kind === 'Secret') out.data = Object.fromEntries(Object.keys(out.data || {}).map((k) => [k, '***']))
  return out
}

// ---- Names the API takes for a kind (resource_type, list paths)

const PLURAL: Record<string, string> = {
  pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', replicasets: 'ReplicaSet', jobs: 'Job', cronjobs: 'CronJob', hpas: 'HorizontalPodAutoscaler', horizontalpodautoscalers: 'HorizontalPodAutoscaler',
  services: 'Service', endpoints: 'Endpoints', endpointslices: 'EndpointSlice', ingresses: 'Ingress', ingressclasses: 'IngressClass', configmaps: 'ConfigMap', secrets: 'Secret', serviceaccounts: 'ServiceAccount',
  pvcs: 'PersistentVolumeClaim', persistentvolumeclaims: 'PersistentVolumeClaim', pvs: 'PersistentVolume', persistentvolumes: 'PersistentVolume', storageclasses: 'StorageClass', namespaces: 'Namespace', nodes: 'Node', controllerrevisions: 'ControllerRevision',
}
const SHORT: Record<string, string> = { po: 'pods', deploy: 'deployments', sts: 'statefulsets', ds: 'daemonsets', rs: 'replicasets', cj: 'cronjobs', svc: 'services', ep: 'endpoints', ing: 'ingresses', cm: 'configmaps', sa: 'serviceaccounts', pvc: 'pvcs', pv: 'pvs', sc: 'storageclasses', hpa: 'hpas', ns: 'namespaces', no: 'nodes' }
// Kinds of the API the sample has none of: their lists answer empty, as a cluster without them does.
const NONE = new Set(['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings', 'networkpolicies', 'leases', 'resourcequotas', 'limitranges', 'pdbs', 'poddisruptionbudgets', 'vpas', 'priorityclasses', 'runtimeclasses',
  'mutatingwebhookconfigurations', 'validatingwebhookconfigurations', 'validatingadmissionpolicies', 'mutatingadmissionpolicies', 'volumeattachments', 'crds', 'customresourcedefinitions', 'gateways', 'gatewayclasses', 'httproutes', 'grpcroutes',
  'referencegrants', 'backendtlspolicies', 'deviceclasses', 'resourceclaims', 'resourceclaimtemplates', 'resourceslices', 'componentstatuses', 'events'])
export function kindOf(type: string): string | undefined {
  const t = type.split('.')[0].toLowerCase()
  const plural = SHORT[t] ?? t
  return PLURAL[plural] ?? Object.values(PLURAL).find((k) => k.toLowerCase() === t)
}

// ---- Logs

const lostNode = (p: Obj) => !!p.spec.nodeName && find('Node', '', p.spec.nodeName)?.status.conditions.find((c: Obj) => c.type === 'Ready')?.status === 'Unknown'
export function logSource(p: Obj, containerName?: string): LogSource | null {
  const c = p.spec.containers.find((x: Obj) => x.name === containerName) ?? p.spec.containers[0]
  if (!c) return null
  const s = (p.status.containerStatuses || []).find((x: Obj) => x.name === c.name)
  const style = LOG_STYLE.get(repositoryOf(c.image)) ?? 'api'
  const app = p.metadata.labels?.app ?? p.metadata.labels?.['k8s-app'] ?? p.metadata.name
  return { key: p.metadata.namespace + '/' + p.metadata.name + '/' + c.name, style: crashing(p) ? 'crash' : style === 'crash' ? 'api' : style, app, image: c.image, ip: p.status.podIP || '', live: !!s?.state?.running && !lostNode(p) && !p.metadata.deletionTimestamp, at: Date.parse(p.metadata.creationTimestamp) }
}
// A Pod's log read: the text, or why there is none (as the API server answers a log read of such a Pod).
export function podLog(ns: string, name: string, containerName: string | undefined, tail: number): Answer {
  const p = find('Pod', ns, name)
  if (!p) return notFound(`pods "${name}"`)
  if (!p.spec.nodeName) return { status: 400, data: { detail: `pod ${name} does not have a host assigned` } }
  if (lostNode(p)) return { status: 502, data: { detail: `No logs are available: the kubelet on ${p.spec.nodeName} (${nodeIp(p.spec.nodeName.slice(-1))}) stopped posting status, so the container log cannot be read.` } }
  const src = logSource(p, containerName)
  if (!src) return { status: 400, data: { detail: `container ${containerName} is not valid for pod ${name}` } }
  return ok({ logs: logText(src, tail) })
}
// A followed log (the logs/stream route): what its lines are made from, or why it cannot be read.
export function logFollow(ns: string, name: string, containerName?: string): LogSource | string {
  const answer = podLog(ns, name, containerName, 1)
  if (answer.status !== 200) return (answer.data as Obj).detail
  return logSource(find('Pod', ns, name)!, containerName) ?? 'no container'
}
// The Pod window's log text for the demo's live view; null when the read would fail.
export function podLogText(ns: string, name: string, containerName: string | undefined, tail: number): string | null {
  const answer = podLog(ns, name, containerName, tail)
  return answer.status === 200 ? (answer.data as { logs: string }).logs : null
}
// The chat's previous-log read.
export const logs = (row: Obj) => { const a = podLog(row.namespace, row.name, undefined, 100); return a.status === 200 ? (a.data as Obj).logs : (a.data as Obj).detail + '\n' }
export function describe(row: Obj) { const p = find('Pod', row.namespace, row.name); return p ? podDescribe(p) : {} }

// ---- Metrics (metrics-server's answer: Ready nodes only, Pods with a running container), moving a little over time

const wave = (seed: string, period: number) => 0.5 + 0.5 * Math.sin(Date.now() / period + (hash(seed) % 628) / 100)
function usageOf(p: Obj) {
  return p.spec.containers.map((c: Obj) => {
    const cpu = Math.max(1, Math.round((cpuMilli(c.resources?.requests?.cpu) || 10) * (0.2 + 0.6 * wave(p.metadata.name + c.name, 41_000))))
    const mem = Math.round((bytes(c.resources?.requests?.memory) / 1048576 || 32) * (0.45 + 0.4 * wave(p.metadata.name + c.name + 'm', 173_000)))
    return { name: c.name, cpu, mem }
  })
}
const measured = () => all('Pod').filter((p) => p.status.phase === 'Running' && !p.metadata.deletionTimestamp && p.spec.nodeName && nodeReady(p.spec.nodeName) && (p.status.containerStatuses || []).some((c: Obj) => c.state?.running))
export function podMetrics(): Obj[] {
  const stamp = iso(Date.now() - 12_000)
  return measured().map((p) => {
    const use = usageOf(p)
    const limit = (pick: (c: Obj) => number) => p.spec.containers.every((c: Obj) => pick(c) > 0) ? p.spec.containers.reduce((t: number, c: Obj) => t + pick(c), 0) : null
    return { name: p.metadata.name, namespace: p.metadata.namespace, cpu: use.reduce((t: number, u: Obj) => t + u.cpu, 0) + 'm', memory: use.reduce((t: number, u: Obj) => t + u.mem, 0) + 'Mi', timestamp: stamp,
      cpu_limit_millicores: limit((c) => cpuMilli(c.resources?.limits?.cpu)), memory_limit_bytes: limit((c) => bytes(c.resources?.limits?.memory)), containers: use.map((u: Obj) => ({ name: u.name, cpu: u.cpu + 'm', memory: u.mem + 'Mi' })) }
  })
}
export function nodeMetrics(): Obj[] {
  const stamp = iso(Date.now() - 12_000)
  const pods = measured()
  return all('Node').filter((n) => nodeReady(n.metadata.name)).map((n) => {
    const use = pods.filter((p) => p.spec.nodeName === n.metadata.name).flatMap(usageOf)
    const cpu = 310 + Math.round(120 * wave(n.metadata.name, 29_000)) + use.reduce((t, u) => t + u.cpu, 0)
    const mem = 1180 + Math.round(90 * wave(n.metadata.name + 'm', 97_000)) + use.reduce((t, u) => t + u.mem, 0)
    return { name: n.metadata.name, cpu: cpu + 'm', memory: mem + 'Mi', cpu_percent: Math.floor((cpu / cpuMilli(n.status.allocatable.cpu)) * 100) + '%', memory_percent: Math.floor((mem / (bytes(n.status.allocatable.memory) / 1048576)) * 100) + '%', timestamp: stamp }
  })
}

export function overview() {
  const list = all('Pod')
  return {
    total_namespaces: all('Namespace').length, total_pods: list.length, total_services: all('Service').length, total_deployments: all('Deployment').length,
    total_pvcs: all('PersistentVolumeClaim').length, total_pvs: all('PersistentVolume').length,
    pod_status: Object.fromEntries(['Running', 'Pending', 'Succeeded', 'Failed', 'Unknown'].map((phase) => [phase, list.filter((p) => p.status.phase === phase).length])),
    node_count: all('Node').length, cluster_version: 'v1.37.0', refused: [],
  }
}

// ---- The Pods page (pods_page.go): filters, order, the summary cards over the namespace, the page

const errorStatus = (s: string) => /Err|BackOff|Error|Failed|OOMKilled|Evicted|Invalid/.test(s)
// A Pod's card colour and the reason under it (pod_index.go podHealth), as Cluster View draws them and the Pods page counts.
type Level = 'ok' | 'warn' | 'error'
const ERROR_REASONS = ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError', 'ContainerCannotRun', 'InvalidImageName', 'ImageInspectError', 'RegistryUnavailable', 'ErrImageNeverPull', 'OOMKilled', 'Error']
const WARN_REASONS = ['ContainerCreating', 'PodInitializing', 'Pending', 'NotReady']
const pickReason = (reasons: string[], priority: string[]) => priority.find((r) => reasons.includes(r)) ?? reasons[0] ?? ''
function cardHealth(p: Obj): { level: Level; reason: string } {
  const phase = p.status.phase || podStatusText(p)
  if (p.metadata.deletionTimestamp) return { level: 'warn', reason: 'Terminating' }
  const statuses: Obj[] = p.status.containerStatuses || []
  const ended = (r: string) => r !== 'Completed' && r !== 'Succeeded'
  const waiting: string[] = statuses.map((c) => c.state?.waiting?.reason).filter(Boolean)
  const reasons = [p.status.reason, ...waiting, ...statuses.map((c) => c.state?.terminated?.reason)].filter((r) => r && ended(r) && !WARN_REASONS.includes(r))
  const error = pickReason(reasons, ERROR_REASONS)
  if (error || phase === 'Failed') return { level: 'error', reason: error || 'Failed' }
  if (phase === 'Pending' || phase === 'Unknown') return { level: 'warn', reason: phase }
  if (phase === 'Succeeded') return { level: 'ok', reason: 'Succeeded' }
  const warn = pickReason(waiting, WARN_REASONS)
  if (statuses.filter((c) => c.ready).length < p.spec.containers.length) return { level: 'warn', reason: warn || 'NotReady' }
  return warn ? { level: 'warn', reason: warn } : { level: 'ok', reason: phase }
}
const health = (p: Obj): Level => cardHealth(p).level
function selects(selector: string, labels: Obj = {}): boolean {
  return selector.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean).every((term) => {
    const set = /^(\S+)\s+(in|notin)\s+\((.*)\)$/.exec(term)
    if (set) { const values = set[3].split(',').map((v) => v.trim()); return set[2] === 'in' ? values.includes(labels[set[1]]) : !values.includes(labels[set[1]]) }
    const eq = /^([^!=]+?)\s*(==|=|!=)\s*(.*)$/.exec(term)
    if (eq) return eq[2] === '!=' ? labels[eq[1]] !== eq[3] : labels[eq[1]] === eq[3]
    return term.startsWith('!') ? !(term.slice(1) in labels) : term in labels
  })
}
const ownedBy = (p: Obj, owner: string) => {
  const [kind, name] = owner.split('/')
  const r = ownerOf(p)
  if (!r) return false
  if (r.kind === kind && r.name === name) return true
  if (kind === 'Deployment' && r.kind === 'ReplicaSet') return ownerOf(find('ReplicaSet', p.metadata.namespace, r.name) ?? { metadata: {} })?.name === name
  if (kind === 'CronJob' && r.kind === 'Job') return ownerOf(find('Job', p.metadata.namespace, r.name) ?? { metadata: {} })?.name === name
  return false
}
export function podPage(params: URLSearchParams) {
  const ns = params.get('namespace') || ''
  const filters: Obj = {}
  let scoped = all('Pod', ns || undefined)
  if (ns) filters.namespace = ns
  const owner = params.get('owner'), sa = params.get('service_account'), cmName = params.get('config_map'), secret = params.get('secret'), selector = params.get('label_selector')
  if (owner) { filters.owner = owner; scoped = scoped.filter((p) => ownedBy(p, owner)) }
  if (sa) { filters.service_account = sa; const accounts = sa.split(','); scoped = scoped.filter((p) => accounts.includes(p.metadata.namespace + '/' + p.spec.serviceAccountName)) }
  if (cmName) { filters.config_map = cmName; scoped = scoped.filter((p) => refNames(p.spec).cms.includes(cmName)) }
  if (secret) { filters.secret = secret; scoped = scoped.filter((p) => refNames(p.spec).secrets.includes(secret)) }
  if (selector) { filters.label_selector = selector; scoped = scoped.filter((p) => selects(selector, p.metadata.labels)) }
  if (params.get('runtime_class') || params.get('priority_class')) scoped = []
  const q = (params.get('q') || '').toLowerCase()
  let rows = scoped.filter((p) => !q || q.split(/\s+/).every((word) => [p.metadata.name, p.metadata.namespace, p.spec.nodeName || '', p.status.podIP || '', podStatusText(p)].join(' ').toLowerCase().includes(word)))
  if (params.get('phase')) rows = rows.filter((p) => (params.get('phase') === 'Unknown' ? !p.status.phase || p.status.phase === 'Unknown' : p.status.phase === params.get('phase')))
  if (params.get('health')) rows = rows.filter((p) => health(p) === params.get('health'))
  const sort = params.get('sort') || '', dir = params.get('dir') === 'desc' ? -1 : 1
  const key: Record<string, (p: Obj) => string | number> = { name: (p) => p.metadata.name, namespace: (p) => p.metadata.namespace + '/' + p.metadata.name, status: podStatusText, ready: readyOf, restarts: restartsOf, node_name: (p) => p.spec.nodeName || '', pod_ip: (p) => p.status.podIP || '', age: (p) => p.metadata.creationTimestamp, health: (p) => ({ error: 0, warn: 1, ok: 2 })[health(p)] }
  if (key[sort]) rows = [...rows].sort((a, b) => { const x = key[sort](a), y = key[sort](b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * (sort === 'health' ? 1 : dir) })
  const offset = Math.max(0, Number(params.get('offset')) || 0), limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 50))
  const card = (p: Obj) => { const s = podStatusText(p); return p.status.phase === 'Failed' || errorStatus(s) ? 'error' : s === 'Terminating' ? 'terminating' : p.status.phase === 'Pending' ? 'pending' : p.status.phase === 'Succeeded' ? 'completed' : p.status.phase === 'Running' && podReady(p) ? 'ready' : 'not_ready' }
  const count = (c: string) => scoped.filter((p) => card(p) === c).length
  const reasons: Record<string, number> = {}
  for (const p of scoped) { const s = podStatusText(p); if (s !== 'Running' && s !== 'Completed') reasons[s] = (reasons[s] || 0) + 1 }
  const byNs: Record<string, number> = {}
  for (const p of rows) byNs[p.metadata.namespace] = (byNs[p.metadata.namespace] || 0) + 1
  const top = Number(params.get('group_top')) || 20
  const groups = Object.entries(byNs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, count: n }))
  return {
    items: rows.slice(offset, offset + limit).map(podRow), total: rows.length, not_running: rows.filter((p) => !['Running', 'Completed', 'Succeeded'].includes(podStatusText(p))).length,
    stats: { total: scoped.length, ready: count('ready'), not_ready: count('not_ready'), pending: count('pending'), terminating: count('terminating'), error: count('error'), restarted: scoped.filter((p) => restartsOf(p) > 0).length, completed: count('completed'),
      top_reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, count: n })), health: { ok: scoped.filter((p) => health(p) === 'ok').length, warn: scoped.filter((p) => health(p) === 'warn').length, error: scoped.filter((p) => health(p) === 'error').length } },
    revision: 'site-demo-' + revision, source: 'index', filters,
    ...(params.get('groups') ? { by_namespace: groups.length > top ? [...groups.slice(0, top), { name: '(other)', count: groups.slice(top).reduce((t, g) => t + g.count, 0) }] : groups } : {}),
  }
}

// ---- Cluster View: the node map (pods_nodes.go), a node's box (pods_node_box.go), a Pod's RBAC (pods_rbac.go) and the
// lists it follows

// The Pods a node's map cell counts, by card colour; asked again with the revision it has, "unchanged" while nothing moved.
export function podNodes(params: URLSearchParams) {
  const now = 'site-demo-' + revision
  if (params.get('revision') === now) return { nodes: [], total: 0, all: 0, revision: now, unchanged: true, source: 'index' }
  const q = (params.get('q') || '').trim().toLowerCase()
  const scoped = all('Pod', params.get('namespace') || undefined)
  const found = scoped.filter((p) => !q || [p.metadata.name, p.metadata.namespace, p.spec.nodeName || '', p.status.podIP || ''].some((v) => v.toLowerCase().includes(q)))
  const byNode = new Map<string, Obj>()
  for (const p of found) {
    const node = p.spec.nodeName || ''
    const count = byNode.get(node) ?? { node, total: 0, ok: 0, warn: 0, error: 0 }
    count.total += 1
    count[health(p)] += 1
    byNode.set(node, count)
  }
  return { nodes: [...byNode.values()].sort((a, b) => (a.node < b.node ? -1 : 1)), total: found.length, all: scoped.length, revision: now, source: 'index' }
}
// A box's card: no containers, so the Pod's window reads the Pod until the box's watch has sent its full row.
function boxPod(p: Obj): Obj {
  const { level, reason } = cardHealth(p)
  return { name: p.metadata.name, namespace: p.metadata.namespace, node_name: p.spec.nodeName || '', pod_ip: p.status.podIP || '', status: podStatusText(p), phase: p.status.phase, restart_count: restartsOf(p), created_at: p.metadata.creationTimestamp, labels: p.metadata.labels ?? null, health: level, health_reason: reason }
}
const onNode = (node: string, ns?: string) => all('Pod', ns).filter((p) => (p.spec.nodeName || '') === node)
// What a Pod's ServiceAccount may do: the sample holds no binding, in this answer and in the lists of bindings alike.
function podRbac(p: Obj, includeAuthenticated: boolean): Obj {
  const namespace = p.metadata.namespace, name = p.spec.serviceAccountName || 'default'
  const account = find('ServiceAccount', namespace, name)
  return { pod_name: p.metadata.name, namespace, service_account_name: name, pod: { name: p.metadata.name, namespace }, service_account: { name, namespace }, include_authenticated: includeAuthenticated,
    secrets: [], service_account_labels: account?.metadata.labels ?? null, role_bindings: [], cluster_role_bindings: [], bindings: [], errors: [] }
}
// The rows a followed list is of (the watch socket): the nodes, and the Pods of one node. Any other list reads itself.
export function watchRows(path: string, query: string): (() => Obj[]) | null {
  const params = new URLSearchParams(query)
  const field = params.get('fieldSelector')
  if (params.get('notify')) return null
  if (path === '/api/v1/nodes' && !field) return () => all('Node').map(nodeRow)
  const pods = /^\/api\/v1(?:\/namespaces\/([^/]+))?\/pods$/.exec(path)
  if (!pods || !field?.startsWith('spec.nodeName=')) return null
  return () => onNode(field.slice('spec.nodeName='.length), pods[1]).map(podInfo)
}

// ---- Dashboard windows: issues, storage, optimization

export function issues() {
  const list: Obj[] = []
  const add = (o: Obj, severity: string, reason: string, message: string, last: string, extra: Obj = {}) => list.push({ id: `${o.kind}/${o.metadata.namespace || ''}/${o.metadata.name}/${reason}`, kind: o.kind, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), name: o.metadata.name, severity, reason, message, last_seen: last, ...extra })
  for (const n of all('Node')) {
    const ready = n.status.conditions.find((c: Obj) => c.type === 'Ready')
    if (ready.status !== 'True') add(n, 'critical', ready.reason, ready.message, ready.lastTransitionTime, { events: 1 })
  }
  for (const p of all('Pod')) {
    const s = podStatusText(p), ev = eventsOf(p).find((x) => x.type === 'Warning')
    if (crashing(p)) { if (ev) add(p, 'critical', s, ev.message, ev.last_timestamp, { restarts: restartsOf(p), events: ev.count }) }
    else if (p.status.phase === 'Failed') add(p, 'critical', s, 'Container app exited with code 1', p.status.containerStatuses?.[0]?.state?.terminated?.finishedAt ?? '', { restarts: restartsOf(p) })
    else if (p.status.phase === 'Pending') add(p, 'warning', 'FailedScheduling', ev?.message ?? '', ev?.last_timestamp ?? '', { events: ev?.count })
    else if (p.status.phase === 'Unknown') add(p, 'warning', 'NodeLost', p.status.message, p.metadata.deletionTimestamp)
    else if (p.status.phase === 'Running' && !podReady(p)) add(p, 'warning', 'NotReady', 'Node is not ready', ev?.last_timestamp ?? '', { events: ev?.count })
  }
  for (const j of all('Job').filter((x) => jobStatus(x) === 'Failed')) add(j, 'critical', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit', j.status.conditions[0].lastTransitionTime, { failed: j.status.failed })
  for (const c of all('PersistentVolumeClaim').filter((x) => x.status.phase === 'Pending')) { const ev = eventsOf(c)[0]; add(c, 'warning', 'Pending', ev?.message ?? 'waiting for first consumer to be created before binding', ev?.last_timestamp ?? '', { events: ev?.count }) }
  for (const d of all('Deployment').filter((x) => x.status.conditions[1].status === 'False')) add(d, 'warning', 'ProgressDeadlineExceeded', d.status.conditions[1].message, d.status.conditions[1].lastTransitionTime)
  return { window_minutes: 60, generated_at: iso(Date.now()), issues: list }
}
export function storageTopology() {
  const pvs = all('PersistentVolume'), pvcs = all('PersistentVolumeClaim')
  return {
    nodes: [...pvs.map((v) => ({ id: 'pv-' + v.metadata.name, type: 'pv', name: v.metadata.name, status: v.status.phase, metadata: { capacity: v.spec.capacity.storage, storage_class: v.spec.storageClassName, access_modes: v.spec.accessModes } })),
      ...pvcs.map((c) => ({ id: `pvc-${c.metadata.namespace}-${c.metadata.name}`, type: 'pvc', name: c.metadata.name, namespace: c.metadata.namespace, status: c.status.phase, metadata: { capacity: qty(c.status.capacity?.storage), storage_class: c.spec.storageClassName } }))],
    edges: pvcs.filter((c) => c.spec.volumeName).map((c, i) => ({ id: 'edge-' + (i + 1), source: `pvc-${c.metadata.namespace}-${c.metadata.name}`, target: 'pv-' + c.spec.volumeName, type: 'bound_to', label: 'bound to' })),
    metadata: { pv_count: pvs.length, pvc_count: pvcs.length },
  }
}
export function optimization(ns: string) {
  const usage = new Map(podMetrics().map((m) => [m.namespace + '/' + m.name, m]))
  const rows: Obj[] = []
  for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet']) {
    for (const w of all(kind, ns)) {
      const pods = (kind === 'Deployment' ? owned(w, 'ReplicaSet').flatMap((r) => owned(r)) : owned(w)).filter(active)
      for (const c of w.spec.template.spec.containers) {
        const used = pods.map((p) => usage.get(p.metadata.namespace + '/' + p.metadata.name)?.containers.find((x: Obj) => x.name === c.name)).filter(Boolean) as Obj[]
        const cpu = used.length ? Math.max(...used.map((u) => cpuMilli(u.cpu))) : undefined, mem = used.length ? Math.max(...used.map((u) => bytes(u.memory))) : undefined
        rows.push({ kind, api_version: w.apiVersion, namespace: w.metadata.namespace, name: w.metadata.name, container: c.name, pods: pods.length, cpu_request_m: cpuMilli(c.resources?.requests?.cpu), cpu_limit_m: cpuMilli(c.resources?.limits?.cpu),
          mem_request_bytes: bytes(c.resources?.requests?.memory), mem_limit_bytes: bytes(c.resources?.limits?.memory), flags: [],
          ...(cpu !== undefined ? { cpu_usage_m: cpu, cpu_recommend_m: Math.max(10, Math.ceil(cpu * 1.2 / 5) * 5), mem_usage_bytes: mem, mem_recommend_bytes: Math.ceil((mem! * 1.15) / 1048576) * 1048576 } : {}) })
      }
    }
  }
  const sum = (k: string, fallback?: string) => rows.reduce((t, r) => t + (r[k] ?? (fallback ? r[fallback] : 0)), 0)
  return { namespace: ns, window_hours: 24, source: 'metrics-server', generated_at: iso(Date.now()), rows, resize_kinds: ['Deployment', 'StatefulSet', 'DaemonSet'],
    totals: { pods: sum('pods'), cpu_request_m: sum('cpu_request_m'), cpu_recommend_m: sum('cpu_recommend_m', 'cpu_request_m'), mem_request_bytes: sum('mem_request_bytes'), mem_recommend_bytes: sum('mem_recommend_bytes', 'mem_request_bytes'), unmeasured_rows: rows.filter((r) => r.cpu_usage_m === undefined).length } }
}

// The workloads OpenCost allocates cost to, with what their running Pods request.
export function costWorkloads() {
  return ['Deployment', 'StatefulSet', 'DaemonSet'].flatMap((kind) => all(kind).map((w) => {
    const pods = (kind === 'Deployment' ? owned(w, 'ReplicaSet').flatMap((r) => owned(r)) : owned(w)).filter((p) => p.status.phase === 'Running')
    const sum = (pick: (c: Obj) => number) => pods.reduce((t, p) => t + p.spec.containers.reduce((s: number, c: Obj) => s + pick(c), 0), 0)
    const claims = all('PersistentVolumeClaim', w.metadata.namespace).filter((c) => pods.some((p) => (p.spec.volumes || []).some((v: Obj) => v.persistentVolumeClaim?.claimName === c.metadata.name)))
    return { kind, name: w.metadata.name, namespace: w.metadata.namespace, cores: sum((c) => cpuMilli(c.resources?.requests?.cpu)) / 1000, gib: sum((c) => bytes(c.resources?.requests?.memory)) / 1073741824, pvGib: claims.reduce((t, c) => t + bytes(c.spec.resources.requests.storage) / 1073741824, 0), lb: w.metadata.name === 'ingress-controller' }
  }))
}
export const workloadOf = (kind: string, ns: string, name: string) => find(kind, ns, name)
export { toYaml }

// ---- Writes: each changes only these objects, and every view reads the change

const randomSuffix = (n = 5) => Array.from({ length: n }, () => SAFE[Math.floor(Math.random() * SAFE.length)]).join('')
const schedulable = () => all('Node').filter((n) => nodeReady(n.metadata.name) && !n.spec.unschedulable).map((n) => n.metadata.name.slice(-1))
// Whether a node has what a Pod requests left, past the requests of the Pods it holds.
const requested = (spec: Obj, what: 'cpu' | 'memory'): number => spec.containers.reduce((t: number, c: Obj) => t + (what === 'cpu' ? cpuMilli : bytes)(c.resources?.requests?.[what]), 0)
function hasRoom(letter: string, spec: Obj, what: 'cpu' | 'memory') {
  const name = nodeName(letter)
  let left = (what === 'cpu' ? cpuMilli : bytes)(find('Node', '', name)!.status.allocatable[what]) - requested(spec, what)
  for (const p of store.values()) if (p.kind === 'Pod' && p.spec.nodeName === name && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed') left -= requested(p.spec, what)
  return left >= 0
}
// Why no node can take a Pod of this spec, "" when one can.
function unplaceable(spec: Obj): string {
  const free = schedulable()
  if (!free.length) return UNSCHEDULABLE.replace('6 Insufficient memory', '6 node(s) were unschedulable')
  if (!free.some((l) => hasRoom(l, spec, 'memory'))) return UNSCHEDULABLE
  return free.some((l) => hasRoom(l, spec, 'memory') && hasRoom(l, spec, 'cpu')) ? '' : UNSCHEDULABLE.replace('memory', 'cpu')
}
// The node of a new Pod: the one before it when that takes it, else one with the fewest Pods of its controller, `beside`.
function placeFor(spec: Obj = { containers: [] }, beside: Obj[] = [], previous?: string): string {
  const free = schedulable().filter((l) => hasRoom(l, spec, 'memory') && hasRoom(l, spec, 'cpu'))
  if (previous && free.includes(previous)) return previous
  const held = (l: string) => beside.filter((p) => p.spec.nodeName === nodeName(l)).length
  const fewest = Math.min(...free.map(held)), choice = free.filter((l) => held(l) === fewest)
  return choice[Math.floor(Math.random() * choice.length)] ?? ''
}
// A new Pod's events: why it waits, or those of the node that took it (a crash-looping container's own are made from its
// runs), which binds the claims that waited for it.
function podScheduled(pod: Obj, why: string) {
  if (!why) return podStarted(pod)
  const at = pod.metadata.creationTimestamp
  pod.status.conditions[0].message = why
  event(pod, 'Warning', 'FailedScheduling', why, 1, at, at, 'default-scheduler')
}
function podStarted(pod: Obj) {
  const at = pod.metadata.creationTimestamp
  event(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${pod.spec.nodeName}`, 1, at, at, 'default-scheduler')
  for (const v of pod.spec.volumes || []) {
    const pvc = v.persistentVolumeClaim && find('PersistentVolumeClaim', pod.metadata.namespace, v.persistentVolumeClaim.claimName)
    if (pvc?.status.phase !== 'Pending' || !find('StorageClass', '', pvc.spec.storageClassName)) continue
    bind(pvc, pod.spec.nodeName.slice(-1), at)
    event(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pvc.spec.volumeName}`, 1, at, at, CSI)
  }
  if (crashing(pod)) return
  for (const c of pod.spec.containers) {
    event(pod, 'Normal', 'Pulled', `Container image "${c.image}" already present on machine`, 1, at, at, 'kubelet')
    event(pod, 'Normal', 'Created', `Created container: ${c.name}`, 1, at, at, 'kubelet')
    event(pod, 'Normal', 'Started', `Started container ${c.name}`, 1, at, at, 'kubelet')
  }
}
// checkout-api ends at its first lines without this setting (logs.ts), in its environment or in a ConfigMap it reads.
const stops = (spec: Obj, ns: string): boolean => spec.containers.some((c: Obj) => LOG_STYLE.get(repositoryOf(c.image)) === 'crash' && !(c.env || []).some((e: Obj) => e.name === 'PAYMENT_GATEWAY_URL')
  && !(c.envFrom || []).some((e: Obj) => e.configMapRef && 'PAYMENT_GATEWAY_URL' in (find('ConfigMap', ns, e.configMapRef.name)?.data ?? {})))
// A Pod in place of one a controller lost: a new name from a ReplicaSet or DaemonSet, the same name for a StatefulSet. One
// already being deleted has its replacement.
function replace(old: Obj) {
  const r = ownerOf(old)
  const owner = r && find(r.kind, old.metadata.namespace, r.name)
  drop(old)
  if (!owner || owner.kind === 'Job' || old.metadata.deletionTimestamp) return
  const tpl = clone(owner.spec.template), daemon = owner.kind === 'DaemonSet', at = iso(Date.now())
  const why = daemon ? '' : unplaceable(tpl.spec), letter = daemon ? old.spec.nodeName.slice(-1) : why ? '' : placeFor(tpl.spec, [], old.spec.nodeName?.slice(-1))
  const name = owner.kind === 'StatefulSet' ? old.metadata.name : owner.metadata.name + '-' + randomSuffix()
  if (owner.kind === 'StatefulSet') Object.assign(tpl.spec, { hostname: name, subdomain: owner.metadata.name })
  if (owner.kind === 'StatefulSet') tpl.spec.containers[0].volumeMounts = old.spec.containers[0].volumeMounts.filter((m: Obj) => !m.name.startsWith('kube-api-access-'))
  const claims = (old.spec.volumes || []).filter((v: Obj) => v.persistentVolumeClaim && !(tpl.spec.volumes || []).some((t: Obj) => t.name === v.name))
  const extra = Object.fromEntries(Object.entries(old.metadata.labels || {}).filter(([k]) => !(k in tpl.metadata.labels)))
  const made = 'controller-revision-hash' in extra ? newestRevision(owner) : undefined
  if (made) extra['controller-revision-hash'] = daemon ? made.metadata.labels['controller-revision-hash'] : made.metadata.name
  const state: State = !letter ? 'pending' : stops(tpl.spec, old.metadata.namespace) ? 'crash' : nodeReady(nodeName(letter)) ? 'ok' : 'notready'
  podScheduled(put(makePod(owner, tpl, name, letter, letter && ipOn(letter), state, at, extra, claims)), why)
  if (owner.kind === 'ReplicaSet') event(owner, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 1, at, at, 'replicaset-controller')
}
function deleteObject(o: Obj) {
  if (o.kind === 'Pod') return replace(o)
  if (o.kind === 'Namespace') {
    if (o.metadata.deletionTimestamp) return
    o.status.phase = 'Terminating'
    o.metadata.deletionTimestamp = iso(Date.now())
    // what it holds goes at once, but its Pods, which have their grace period to end (advance)
    for (const x of [...store.values()].filter((y) => y.metadata.namespace === o.metadata.name)) {
      if (x.kind === 'Pod' && active(x)) Object.assign(x.metadata, { deletionTimestamp: iso(Date.now() + 30_000), deletionGracePeriodSeconds: 30 })
      else if (x.kind === 'PersistentVolumeClaim') deleteObject(x)
      else if (x.kind !== 'Pod' || !x.metadata.deletionTimestamp) drop(x)
    }
    return contentRemaining(o, all('Pod', o.metadata.name).length)
  }
  drop(o)
  const children = (x: Obj) => [...store.values()].filter((c) => (c.metadata.ownerReferences || []).some((r: Obj) => r.uid === x.metadata.uid))
  const cascade = (x: Obj) => { for (const c of children(x)) { drop(c); cascade(c) } }
  cascade(o)
  // a Node's Pods go with it, and their controllers make others on the nodes left (a DaemonSet has one a node)
  if (o.kind === 'Node') for (const p of all('Pod').filter((x) => x.spec.nodeName === o.metadata.name)) { if (active(p) && ownerOf(p)?.kind !== 'DaemonSet') replace(p); else drop(p) }
  if (o.kind === 'PersistentVolumeClaim' && o.spec.volumeName) { const pv = find('PersistentVolume', '', o.spec.volumeName); if (pv) pv.status.phase = 'Released' }
  events = events.filter((e) => e.uid !== o.metadata.uid)
}

// A Pod template as text, keys in one order and without what its ReplicaSet or ControllerRevision adds, so that two compare.
const templateText = (t: Obj): string => JSON.stringify({ ...t, $patch: undefined, metadata: { ...t.metadata, labels: { ...t.metadata?.labels, 'pod-template-hash': undefined } } },
  (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))

// A Deployment's ReplicaSets after a change of its spec, as its controller leaves them: the one of its template has the
// replicas. A changed template takes the ReplicaSet that had it before, or a new one, as the next revision, with Pods of its
// own; when those do not start, the update goes as far as its 25% lets it and the Pods before them stay.
function rollOut(d: Obj) {
  const ns = d.metadata.namespace, spec = d.spec.template.spec, want: number = d.spec.replicas ?? 1, text = templateText(d.spec.template), at = iso(Date.now())
  const sets = owned(d, 'ReplicaSet').sort((a, b) => revisionOf(b) - revisionOf(a))
  const had = sets.find((s) => templateText(s.spec.template) === text), others = sets.filter((s) => s !== had)
  if (!had || had !== sets[0]) rolledAt.set(d.metadata.uid, Date.now())
  const hashed = suffix(d.metadata.name + text, 10), template = clone(d.spec.template)
  template.metadata = { ...template.metadata, labels: { ...template.metadata?.labels, 'pod-template-hash': hashed } }
  const set = had ?? put(make('ReplicaSet', ns, d.metadata.name + '-' + hashed, at, { labels: { ...template.metadata.labels }, annotations: {}, ownerReferences: [ref(d)], generation: 1 }, {
    spec: { replicas: 0, selector: { matchLabels: { ...d.spec.selector.matchLabels, 'pod-template-hash': hashed } }, template }, status: {},
  }))
  const surge = Math.ceil(want / 4), unavailable = Math.floor(want / 4)
  const scale = (s: Obj, n: number) => {
    const from: number = s.spec.replicas
    s.metadata.annotations = { ...s.metadata.annotations, 'deployment.kubernetes.io/desired-replicas': String(want), 'deployment.kubernetes.io/max-replicas': String(want + surge) }
    if (from !== n) {
      s.spec.replicas = n
      if (s === had || s !== set) s.metadata.generation += 1
      event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${n > from ? 'up' : 'down'} replica set ${s.metadata.name} from ${from} to ${n}`, 1, at, at, 'deployment-controller')
    }
    reconcile(s)
  }
  const held = others.some((s) => s.spec.replicas) && d.spec.strategy?.type !== 'Recreate' && (unplaceable(spec) !== '' || stops(spec, ns))
  scale(set, held ? Math.min(want, surge + unavailable) : want)
  let keep = held ? want - unavailable : 0
  const ready = (s: Obj) => owned(s).filter((p) => active(p) && podReady(p)).length
  for (const s of others.sort((a, b) => ready(b) - ready(a) || revisionOf(b) - revisionOf(a))) {
    const n = Math.min(s.spec.replicas, keep)
    keep -= n
    scale(s, n)
  }
  const revision = String(Math.max(revisionOf(set), 1 + Math.max(0, ...others.map(revisionOf))))
  for (const o of [set, d]) o.metadata.annotations = { ...o.metadata.annotations, [REVISION]: revision }
}

// The Pods a controller has after a change of its spec.
function reconcile(w: Obj) {
  if (w.kind === 'Deployment') return rollOut(w)
  if (!['ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(w.kind)) return
  const ns = w.metadata.namespace, at = iso(Date.now()), text = templateText(w.spec.template), last = newestRevision(w)
  // a changed template of a StatefulSet or DaemonSet is its next revision, and its Pods are made again from it
  if (last && templateText(last.data.spec.template) !== text) {
    const before = owned(w, 'ControllerRevision').find((r) => templateText(r.data.spec.template) === text), hashed = suffix(w.metadata.name + text, 10)
    if (before) before.revision = last.revision + 1
    else put(make('ControllerRevision', ns, w.metadata.name + '-' + hashed, at, { labels: { ...w.spec.selector.matchLabels, 'controller-revision-hash': hashed }, ownerReferences: [ref(w)] }, { revision: last.revision + 1, data: { spec: { template: { $patch: 'replace', ...clone(w.spec.template) } } } }))
    for (const p of owned(w).filter(active)) replace(p)
  }
  if (w.kind === 'DaemonSet') return
  const pods = owned(w).filter(active), want = w.spec.replicas ?? 0, set = w.kind === 'ReplicaSet'
  // the first to go: a StatefulSet's highest ordinal; a ReplicaSet's Pods with no node, then not Ready, then the newest
  const first = (a: Obj, b: Obj) => (set ? Number(!!a.spec.nodeName) - Number(!!b.spec.nodeName) || Number(podReady(a)) - Number(podReady(b)) || b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp) || b.metadata.resourceVersion - a.metadata.resourceVersion
    : b.metadata.name.localeCompare(a.metadata.name, undefined, { numeric: true }))
  for (const p of [...pods].sort(first).slice(0, Math.max(0, pods.length - want))) {
    drop(p)
    if (set) event(w, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, 1, at, at, 'replicaset-controller')
  }
  const spec = w.spec.template.spec
  for (let i = pods.length, why = ''; i < want; i++) {
    why = why || unplaceable(spec)
    const letter = why ? '' : placeFor(spec, pods)
    const name = set ? w.metadata.name + '-' + randomSuffix() : w.metadata.name + '-' + i
    const pod = put(makePod(w, w.spec.template, name, letter, letter && ipOn(letter), !letter ? 'pending' : stops(spec, ns) ? 'crash' : 'ok', at))
    pods.push(pod)
    podScheduled(pod, why)
    if (set) event(w, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 1, at, at, 'replicaset-controller')
  }
}

function applyYaml(o: Obj, text: string): Answer {
  let next: any
  try { next = fromYaml(text) } catch (e) { return { status: 400, data: { detail: (e as Error).message } } }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { status: 400, data: { detail: 'error: the YAML is not an object' } }
  if (next.kind !== o.kind || next.metadata?.name !== o.metadata.name) return { status: 400, data: { detail: `the object in the YAML is ${next.kind ?? '?'}/${next.metadata?.name ?? '?'}, not ${o.kind}/${o.metadata.name}` } }
  const before = JSON.stringify(o)
  o.metadata.labels = next.metadata.labels ?? undefined
  o.metadata.annotations = next.metadata.annotations ?? undefined
  if (o.kind === 'Secret') {
    const data = next.data ?? {}
    o.data = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === '***' && o.data?.[k] !== undefined ? o.data[k] : String(v)]))
    for (const [k, v] of Object.entries(next.stringData ?? {})) o.data[k] = b64(String(v))
  } else if (o.kind === 'ConfigMap') o.data = next.data ?? undefined
  else if (o.kind === 'Pod') {
    const images = new Map((next.spec?.containers || []).map((c: Obj) => [c.name, c.image]))
    for (const c of o.spec.containers) if (images.get(c.name)) c.image = images.get(c.name)
  } else if (next.spec && typeof next.spec === 'object' && !['Endpoints', 'EndpointSlice'].includes(o.kind)) {
    const specBefore = JSON.stringify(o.spec)
    o.spec = { ...o.spec, ...next.spec }
    if (JSON.stringify(o.spec) !== specBefore && o.metadata.generation !== undefined) o.metadata.generation += 1
  }
  if (JSON.stringify(o) === before) return ok({ name: o.metadata.name, namespace: o.metadata.namespace, kind: o.kind, api_version: o.apiVersion, message: `${o.kind.toLowerCase()}/${o.metadata.name} unchanged`, unchanged: true })
  o.metadata.resourceVersion = String(++resourceVersion)
  reconcile(o)
  refresh()
  return { status: 200, changed: true, data: { name: o.metadata.name, namespace: o.metadata.namespace, kind: o.kind, api_version: o.apiVersion, message: `${o.kind.toLowerCase()}/${o.metadata.name} configured`, unchanged: false } }
}

// ---- Create from YAML (resources_apply.go): each document in order, up to the first the cluster refuses, which is answered
// with those made before it

const groupOf = (kind: string) => { const v = API[kind] ?? 'v1'; return v.includes('/') ? v.split('/')[0] : '' }
const withGroup = (name: string, kind: string) => (groupOf(kind) ? name + '.' + groupOf(kind) : name)
const pluralOf = (kind: string) => Object.keys(PLURAL).find((k) => PLURAL[k] === kind && k.startsWith(kind.toLowerCase().slice(0, -1))) ?? kind.toLowerCase() + 's'
// Kinds the sample keeps no objects of, or makes itself: the cluster does not let the demo's account create them.
const NOT_GRANTED: Record<string, string> = {
  Node: '', PersistentVolume: '', Endpoints: '', EndpointSlice: 'discovery.k8s.io', StorageClass: 'storage.k8s.io', IngressClass: 'networking.k8s.io', ReplicaSet: 'apps', ControllerRevision: 'apps', ResourceQuota: '', LimitRange: '', NetworkPolicy: 'networking.k8s.io',
  Role: 'rbac.authorization.k8s.io', RoleBinding: 'rbac.authorization.k8s.io', ClusterRole: 'rbac.authorization.k8s.io', ClusterRoleBinding: 'rbac.authorization.k8s.io', PodDisruptionBudget: 'policy', PriorityClass: 'scheduling.k8s.io', Lease: 'coordination.k8s.io',
}
const CLUSTER_WIDE = new Set([...CLUSTER_SCOPED, 'ClusterRole', 'ClusterRoleBinding', 'PriorityClass'])
const refuse = (status: number, detail: string): never => { throw { status, detail } }

// A container and a Pod's spec with the API server's defaults.
function podSpecOf(spec: Obj | undefined, at: string, invalid: (why: string) => never): Obj {
  if (!Array.isArray(spec?.containers) || !spec.containers.length) return invalid(at + '.containers: Required value')
  spec.containers.forEach((c: Obj, i: number) => { for (const field of ['name', 'image']) if (!c?.[field]) invalid(`${at}.containers[${i}].${field}: Required value`) })
  return { restartPolicy: 'Always', terminationGracePeriodSeconds: 30, dnsPolicy: 'ClusterFirst', serviceAccountName: 'default', securityContext: {}, schedulerName: 'default-scheduler', ...spec,
    containers: spec.containers.map((c: Obj) => ({ ...c, image: String(c.image), ...(c.ports ? { ports: c.ports.map((p: Obj) => ({ protocol: 'TCP', ...p })) } : {}), resources: c.resources ?? {}, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
      imagePullPolicy: c.imagePullPolicy ?? (/:(?!latest$)[^:/]+$/.test(String(c.image)) ? 'IfNotPresent' : 'Always') })) }
}

// One object of a create, with what its kind's controller then makes.
function createObject(kind: string, ns: string, name: string, o: Obj, at: string): void {
  const invalid = (why: string) => refuse(400, `${withGroup(kind, kind)} "${name}" is invalid: ${why}`)
  const kept: Obj = { ...(o.metadata.labels ? { labels: o.metadata.labels } : {}), ...(o.metadata.annotations ? { annotations: o.metadata.annotations } : {}) }
  const spec: Obj = o.spec && typeof o.spec === 'object' ? o.spec : {}
  const add = (meta: Obj, body: Obj) => put(make(kind, ns, name, at, { ...kept, ...meta }, body))
  const template = (t: Obj | undefined): Obj => ({ metadata: { labels: t?.metadata?.labels ?? {} }, spec: podSpecOf(t?.spec, 'spec.template.spec', invalid) })
  // a workload's selector, which its template's labels must match
  const selected = (t: Obj): Obj => {
    const match = spec.selector?.matchLabels
    if (!match || !Object.keys(match).length) return invalid('spec.selector: Required value')
    if (!Object.entries(match).every(([k, v]) => t.metadata.labels[k] === v)) return invalid('spec.template.metadata.labels: Invalid value: ' + JSON.stringify(t.metadata.labels) + ': `selector` does not match template `labels`')
    return { matchLabels: match }
  }
  if (kind === 'Pod') {
    const body = podSpecOf(spec, 'spec', invalid)
    const why = unplaceable(body), letter = why ? '' : placeFor(body)
    const pod = makePod({ kind: 'Pod', metadata: { namespace: ns } }, { metadata: { labels: o.metadata.labels ?? {} }, spec: body }, name, letter, letter && ipOn(letter), letter ? 'ok' : 'pending', at)
    delete pod.metadata.ownerReferences
    if (!o.metadata.labels) delete pod.metadata.labels
    if (o.metadata.annotations) pod.metadata.annotations = o.metadata.annotations
    podScheduled(put(pod), why)
  } else if (kind === 'Deployment') {
    const t = template(spec.template), selector = selected(t)
    rollOut(add({ generation: 1 }, { spec: { replicas: 1, strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '25%', maxSurge: '25%' } }, revisionHistoryLimit: 10, progressDeadlineSeconds: 600, ...spec, selector, template: t }, status: {} }))
  } else if (kind === 'StatefulSet' || kind === 'DaemonSet') {
    const t = template(spec.template), selector = selected(t)
    const w = add({ generation: 1 }, { spec: kind === 'StatefulSet'
      ? { replicas: 1, serviceName: '', podManagementPolicy: 'OrderedReady', updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } }, revisionHistoryLimit: 10, volumeClaimTemplates: [], ...spec, selector, template: t }
      : { updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }, revisionHistoryLimit: 10, ...spec, selector, template: t }, status: {} })
    put(make('ControllerRevision', ns, name + '-' + suffix(name + at, 10), at, { labels: { ...selector.matchLabels }, ownerReferences: [ref(w)] }, { revision: 1, data: { spec: { template: { $patch: 'replace', ...t } } } }))
    if (kind === 'StatefulSet') reconcile(w)
    else for (const letter of schedulable()) podStarted(put(makePod(w, t, name + '-' + randomSuffix(), letter, ipOn(letter), 'ok', at)))
  } else if (kind === 'Job') {
    const t = template(spec.template)
    if (!['OnFailure', 'Never'].includes(spec.template?.spec?.restartPolicy)) invalid('spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"')
    const letter = placeFor()
    const job = jobFor(null, ns, name, t, Date.parse(at), 'running', letter, ipOn(letter))
    for (const field of ['backoffLimit', 'completions', 'parallelism', 'activeDeadlineSeconds', 'ttlSecondsAfterFinished']) if (spec[field] !== undefined) job.spec[field] = spec[field]
    job.metadata.labels = { ...(kept.labels || {}), ...job.metadata.labels }
  } else if (kind === 'CronJob') {
    if (!spec.schedule) invalid('spec.schedule: Required value')
    const t = template(spec.jobTemplate?.spec?.template)
    add({}, { spec: { concurrencyPolicy: 'Allow', suspend: false, successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1, ...spec, jobTemplate: { spec: { backoffLimit: 6, ...spec.jobTemplate.spec, template: t } } }, status: {} })
  } else if (kind === 'Service') {
    const type = spec.type ?? 'ClusterIP', clusterIP = spec.clusterIP ?? nextClusterIp()
    if (!Array.isArray(spec.ports) && clusterIP !== 'None') invalid('spec.ports: Required value')
    const port = (p: Obj) => ({ protocol: 'TCP', targetPort: p.port, ...p, ...(type === 'ClusterIP' || p.nodePort ? {} : { nodePort: 30100 + (hash(name + p.port) % 2600) }) })
    add({}, { spec: { ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack', sessionAffinity: 'None', internalTrafficPolicy: 'Cluster', ...(type === 'ClusterIP' ? {} : { externalTrafficPolicy: 'Cluster' }), ...spec, type, clusterIP, clusterIPs: [clusterIP], ports: (spec.ports ?? []).map(port) }, status: { loadBalancer: {} } })
  } else if (kind === 'Ingress') {
    add({}, { spec: { ingressClassName: 'edge', ...spec, rules: spec.rules ?? [] }, status: { loadBalancer: { ingress: [{ hostname: 'edge-lb.northstar.example' }] } } })
  } else if (kind === 'HorizontalPodAutoscaler') {
    add({}, { spec: { minReplicas: 1, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }], ...spec }, status: {} })
  } else if (kind === 'PersistentVolumeClaim') {
    const claim = add({ finalizers: ['kubernetes.io/pvc-protection'] }, { spec: { storageClassName: 'fast-ssd', volumeMode: 'Filesystem', ...spec }, status: { phase: 'Pending' } })
    event(claim, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding', 1, at, at, 'persistentvolume-controller')
  } else if (kind === 'Secret') {
    add({}, { type: o.type ?? 'Opaque', data: { ...(o.data ?? {}), ...Object.fromEntries(Object.entries(o.stringData ?? {}).map(([k, v]) => [k, b64(String(v))])) } })
  } else if (kind === 'Namespace') {
    add({ labels: { ...(kept.labels || {}), 'kubernetes.io/metadata.name': name } }, { spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } })
    put(make('ServiceAccount', name, 'default', at))
  } else if (kind === 'ConfigMap') add({}, { ...(o.data ? { data: o.data } : {}) })
  else if (kind === 'ServiceAccount') add({}, { ...(o.imagePullSecrets ? { imagePullSecrets: o.imagePullSecrets } : {}) })
  else invalid('kind: Invalid value')
}

function createYaml(text: string, defaultNamespace: string): Answer {
  if (!text.trim()) return { status: 400, data: { detail: 'yaml is required' } }
  const made: Obj[] = []
  const documents = text.replace(/\r\n?/g, '\n').split(/^---(?:[ \t].*)?$/m)
  if (documents.length > 1 && !documents[0].replace(/^\s*#.*$/gm, '').trim()) documents.shift()
  try {
    documents.forEach((document, i) => {
      const doc = i + 1
      let o: any
      try { o = fromYaml(document) } catch (e) { refuse(400, `document ${doc} is not YAML: ${(e as Error).message.replace('error converting YAML to JSON: yaml: ', '')}`) }
      if (o === null) return
      if (typeof o !== 'object' || Array.isArray(o)) refuse(400, `document ${doc} (line 1) is ${Array.isArray(o) ? 'a list' : 'text'}, not an object with apiVersion, kind and metadata`)
      const missing = [...(o.apiVersion ? [] : ['apiVersion not set']), ...(o.kind ? [] : ['kind not set'])]
      if (missing.length) refuse(400, `document ${doc}: ${missing.join(', ')}`)
      const kind = String(o.kind), version = String(o.apiVersion)
      const served = Object.values(PLURAL).includes(kind)
      if ((served && version !== (API[kind] ?? 'v1')) || (!served && NOT_GRANTED[kind] === undefined)) refuse(400, `document ${doc}: no matches for kind "${kind}" in version "${version}" on this cluster (ensure CRDs are installed first)`)
      const meta: Obj = o.metadata && typeof o.metadata === 'object' ? o.metadata : {}
      o.metadata = meta
      const ns = CLUSTER_WIDE.has(kind) ? '' : String(meta.namespace || defaultNamespace || 'default')
      const name = String(meta.name || (meta.generateName ? meta.generateName + randomSuffix() : ''))
      const fail = (status: number, why: string) => refuse(status, `create ${kind} ${name}: ${why}`)
      if (NOT_GRANTED[kind] !== undefined) {
        const group = NOT_GRANTED[kind], plural = kind.toLowerCase().replace(/y$/, 'ie') + (/s$/.test(kind) ? (kind === 'Endpoints' ? '' : 'es') : 's')
        fail(403, `${plural}${group ? '.' + group : ''} is forbidden: User "operator@northstar.example" cannot create resource "${plural}" in API group "${group}" ${ns ? `in the namespace "${ns}"` : 'at the cluster scope'}`)
      }
      const invalid = (why: string) => fail(400, `${withGroup(kind, kind)} "${name}" is invalid: ${why}`)
      if (!name) invalid('metadata.name: Required value: name or generateName is required')
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(name) || name.length > 253) invalid(`metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`)
      const home = ns ? find('Namespace', '', ns) : undefined
      if (ns && !home) fail(404, `namespaces "${ns}" not found`)
      if (home?.metadata.deletionTimestamp) fail(403, `${withGroup(pluralOf(kind), kind)} "${name}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`)
      if (find(kind, ns, name)) fail(409, `${withGroup(pluralOf(kind), kind)} "${name}" already exists`)
      if (kind === 'Secret') for (const [k, v] of Object.entries({ ...(o.data ?? {}), ...(o.stringData ?? {}) })) if (v === '***') refuse(400, `a new Secret has no value for *** to stand for (${name} ${k in (o.data ?? {}) ? 'data' : 'stringData'}.${k}): write the value or leave it out`)
      const before = new Set(store.keys())
      try {
        createObject(kind, ns, name, o, iso(Date.now()))
        sync()
        const now = find(kind, ns, name)!
        void [ROW[kind]?.(now), DESCRIBE[kind]?.(now)]
      } catch (e) {
        for (const key of store.keys()) if (!before.has(key)) store.delete(key)
        if (typeof (e as Answer & { detail?: string }).detail === 'string') fail((e as Answer).status, (e as { detail: string }).detail)
        invalid('spec: Invalid value')
      }
      made.push({ api_version: version, kind, name, namespace: ns, message: `${kind} ${name} created` })
    })
  } catch (e) {
    const { status, detail } = e as { status?: number; detail?: string }
    if (status === undefined) throw e
    if (made.length) refresh()
    return { status, changed: made.length > 0, data: { detail, ...(made.length ? { created: made } : {}) } }
  }
  if (!made.length) return { status: 400, data: { detail: 'no objects passed to create: the YAML holds only comments or empty documents' } }
  return done(made)
}

// ---- "Check a connection" (netpol_check.go). The sample holds no NetworkPolicy, as the drawers' Network Policies section
// and the list say, so neither side is isolated and a port the destination has is allowed.

const NETPOL_KINDS: Record<string, string> = { pod: 'Pod', deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet', replicaset: 'ReplicaSet', job: 'Job', cronjob: 'CronJob', service: 'Service' }
interface NetGroup { pods: string[]; pod?: string; ns: string; ports: Obj[]; hostNetwork: boolean; external?: boolean }
interface NetEnd { kind: string; end: Obj; groups: NetGroup[]; service?: Obj }
const podPorts = (spec: Obj): Obj[] => spec.containers.flatMap((c: Obj) => c.ports || [])
const namedPort = (ports: Obj[], name: string, protocol: string) => ports.find((p) => p.name === name && (p.protocol || 'TCP') === protocol)?.containerPort as number | undefined

function netpolEnd(text: string, allowService: boolean): NetEnd {
  const value = text.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || (value.includes(':') && !value.includes('/'))) return { kind: 'ip', end: { ref: value, kind: 'IP', ips: [value], namespace_labels_known: false }, groups: [{ pods: [], ns: '', ports: [], hostNetwork: false, external: true }] }
  const [type, ns, name, more] = value.split('/')
  if (!ns || !name || more !== undefined) refuse(400, `"${value}" is not <kind>/<namespace>/<name> or an IP address`)
  const key = type.toLowerCase(), kind = NETPOL_KINDS[key]
  if (!kind || (kind === 'Service' && !allowService)) refuse(400, `kind "${type}": use pod, deployment, statefulset, daemonset, replicaset, job, cronjob${allowService ? ' or service' : ''}`)
  const o = find(kind, ns, name)
  if (!o) return refuse(404, `${withGroup(pluralOf(kind), kind)} "${name}" not found`)
  const end: Obj = { ref: key + '/' + ns + '/' + name, kind, namespace: ns, name, ips: [] as string[], namespace_labels_known: true }
  const ips = (p: Obj): string[] => (p.status.podIPs || []).map((x: Obj) => x.ip)
  if (kind === 'Pod') return { kind: key, end: { ...end, ips: ips(o) }, groups: [{ pods: [name], pod: name, ns, ports: podPorts(o.spec), hostNetwork: !!o.spec.hostNetwork }] }
  const labels = kind === 'Service' ? o.spec.selector : kind === 'CronJob' ? null : o.spec.selector?.matchLabels
  if (kind === 'Service' && !labels) refuse(400, `service ${ns}/${name} has no selector: check its pods or address instead`)
  const pods = labels ? all('Pod', ns).filter((p) => active(p) && Object.entries(labels).every(([k, v]) => p.metadata.labels?.[k] === v)) : []
  if (kind === 'Service' && !pods.length) refuse(400, `service ${ns}/${name} selects no running pods`)
  Object.assign(end, { ips: pods.flatMap(ips), ...(pods.length ? { pods: pods.map((p) => p.metadata.name) } : {}) })
  if (kind !== 'Service') { const spec = (kind === 'CronJob' ? o.spec.jobTemplate : o).spec.template.spec; return { kind: key, end, groups: [{ pods: end.pods ?? [], ns, ports: podPorts(spec), hostNetwork: !!spec.hostNetwork }] } }
  const groups = new Map<string, NetGroup>()
  for (const p of pods) {
    const alike = JSON.stringify([p.metadata.labels, podPorts(p.spec), !!p.spec.hostNetwork])
    const group = groups.get(alike) ?? { pods: [], ns, ports: podPorts(p.spec), hostNetwork: !!p.spec.hostNetwork }
    group.pods.push(p.metadata.name)
    groups.set(alike, group)
  }
  return { kind: key, end, groups: [...groups.values()], service: o }
}

interface NetTarget { port: number; protocol: string; service_port?: string; missing?: boolean }
function netpolTargets(to: NetEnd, group: NetGroup, port: string, protocol: string): NetTarget[] {
  if (to.service) {
    const out = to.service.spec.ports.filter((p: Obj) => (!protocol || p.protocol === protocol) && (!port || port === String(p.port) || port === p.name)).map((p: Obj) => {
      const number = typeof p.targetPort === 'string' ? namedPort(group.ports, p.targetPort, p.protocol) : p.targetPort || p.port
      return { port: number ?? 0, protocol: p.protocol, service_port: (p.name ? p.name + ' ' : '') + p.port + '/' + p.protocol, missing: number === undefined }
    })
    return out.length ? out : refuse(400, `service ${to.end.namespace}/${to.end.name} has no port "${port}"`)
  }
  if (!port) {
    if (to.kind === 'ip') refuse(400, 'give a port for an address')
    return group.ports.filter((p) => !protocol || (p.protocol || 'TCP') === protocol).map((p) => ({ port: p.containerPort, protocol: p.protocol || 'TCP' }))
  }
  const asked = protocol || 'TCP'
  if (/^-?\d+$/.test(port)) {
    if (Number(port) < 1 || Number(port) > 65535) refuse(400, `port ${Number(port)} is outside 1-65535`)
    return [{ port: Number(port), protocol: asked }]
  }
  if (to.kind === 'ip') refuse(400, 'an address has no named ports: give a number')
  const number = namedPort(group.ports, port, asked)
  return number === undefined ? refuse(400, `the destination declares no ${asked} port named "${port}"`) : [{ port: number, protocol: asked }]
}

function netpolCheck(params: URLSearchParams): Answer {
  try {
    const protocol = (params.get('protocol') || '').trim().toUpperCase(), port = (params.get('port') || '').trim()
    const from = netpolEnd(params.get('src') || '', false), to = netpolEnd(params.get('dst') || '', true)
    if (!['', 'TCP', 'UDP', 'SCTP'].includes(protocol)) refuse(400, 'protocol must be TCP, UDP or SCTP')
    if (from.kind === 'ip' && to.kind === 'ip') refuse(400, 'one end must be pods: NetworkPolicy does not apply between two addresses')
    const src = from.groups[0]
    const side = () => ({ isolated: false, policies: [], result: 'allowed', allowed_by: [], undecided: [], misses: [] })
    const checks: Obj[] = to.groups.flatMap((group) => netpolTargets(to, group, port, protocol).map((t) => {
      const row = { ...(to.kind === 'pod' || to.kind === 'ip' || !group.pods.length ? {} : { pods: group.pods }), port: t.port, protocol: t.protocol, ...(t.service_port ? { service_port: t.service_port } : {}) }
      if (t.missing) return { ...row, result: 'unknown', notes: ['target_port_not_on_pod'] }
      if (src.pod && src.pod === group.pod && src.ns === group.ns) return { ...row, result: 'allowed', notes: ['same_pod'] }
      const plugin = src.hostNetwork || group.hostNetwork
      return { ...row, result: plugin ? 'unknown' : 'allowed', ...(src.external ? {} : { egress: side() }), ...(group.external ? {} : { ingress: side() }), notes: plugin ? ['host_network'] : [] }
    }))
    if (!checks.length) refuse(400, 'nothing to check: the destination declares no port of that protocol — give a port')
    return ok({ source: from.end, destination: to.end, result: checks.every((c) => c.result === checks[0].result) ? checks[0].result : 'mixed', checks, unevaluated: [], notes: [] })
  } catch (e) {
    const { status, detail } = e as { status?: number; detail?: string }
    if (status === undefined) throw e
    return { status, data: { detail } }
  }
}

// ---- The routes (after /api/v1)

const done =(data: unknown): Answer => { refresh(); return { status: 200, data, changed: true } }

export function clusterRead(route: string, params: URLSearchParams): Answer | null {
  const parts = route.split('/').slice(1).map(decodeURIComponent)
  if (parts[0] === 'topology' && parts[1] === 'storage') return ok(storageTopology())
  if (parts[0] !== 'cluster') return null
  const [, a, b, c, d, e] = parts
  if (a === 'overview') return ok(overview())
  if (a === 'issues') return ok(issues())
  if (a === 'optimization') return ok(optimization(params.get('namespace') || 'default'))
  if (a === 'networkpolicies' && b === 'check') return netpolCheck(params)
  if (a === 'pods' && b === 'page') return ok(podPage(params))
  if (a === 'pods' && b === 'nodes') return ok(podNodes(params))
  if (a === 'pods' && b === 'on-node') return ok(onNode(params.get('node') || '', params.get('namespace') || undefined).map(boxPod))
  if (a === 'metrics' && b === 'nodes') return ok(nodeMetrics())
  if (a === 'metrics' && b === 'pods') return ok(podMetrics().filter((m) => !params.get('namespace') || m.namespace === params.get('namespace')).map((m) => (params.get('with_limits') ? m : { ...m, cpu_limit_millicores: undefined, memory_limit_bytes: undefined })))
  if (a === 'metrics' && b === 'top-resources') {
    const byCpu = (x: Obj, y: Obj) => parseInt(y.cpu) - parseInt(x.cpu)
    return ok({ top_pods: podMetrics().sort(byCpu).slice(0, Number(params.get('pod_limit')) || 5), top_nodes: nodeMetrics().sort(byCpu).slice(0, Number(params.get('node_limit')) || 3) })
  }
  if (a === 'resources' && (b === 'json' || b === 'yaml' || b === 'describe')) {
    const kind = kindOf(params.get('resource_type') || '')
    const o = kind && find(kind, params.get('namespace') || undefined, params.get('resource_name') || '')
    if (!o) return notFound(`${params.get('resource_type')} "${params.get('resource_name')}"`)
    if (b === 'json') return ok(objectJson(o))
    if (b === 'yaml') return ok({ yaml: toYaml(objectJson(o)) })
    return ok(DESCRIBE[o.kind]?.(o) ?? { events: eventsOf(o) })
  }
  if (a === 'nodes' && b) {
    const n = find('Node', '', b)
    if (!n) return notFound(`nodes "${b}"`)
    if (!c) return ok(nodeRow(n))
    if (c === 'describe') return ok(nodeDescribe(n, params.get('events') !== '0'))
    if (c === 'pods') return ok(all('Pod').filter((p) => p.spec.nodeName === b).map(podInfo))
    if (c === 'events') return ok(eventsOf(n))
    if (c === 'yaml') return ok({ yaml: toYaml(n) })
    if (c === 'drain' && d === 'status') return ok({ id: params.get('drain_id') || '', node: b, status: 'succeeded', message: 'Drained', pods_total: 0, pods_done: 0, cordoned_nodes: [b] })
  }
  if (a === 'namespaces' && b && !c) { const n = find('Namespace', '', b); return n ? ok(namespaceRow(n)) : notFound(`namespaces "${b}"`) }
  if (a === 'namespaces' && b && ['describe', 'yaml', 'resource-quotas', 'limit-ranges', 'owned-pods'].includes(c)) {
    const n = find('Namespace', '', b)
    if (!n) return notFound(`namespaces "${b}"`)
    if (c === 'describe') return ok(DESCRIBE.Namespace(n))
    if (c === 'yaml') return ok({ yaml: toYaml(n) })
    if (c === 'owned-pods') return ok(all('Pod', b).map((p) => ({ name: p.metadata.name, namespace: b, status: podStatusText(p), phase: p.status.phase, ready: readyOf(p), restart_count: restartsOf(p), restarts: restartsOf(p), node_name: p.spec.nodeName || '', node: p.spec.nodeName || '', created_at: p.metadata.creationTimestamp })))
    return ok([])
  }
  if (a === 'namespaces' && b && c) {
    if (c === 'networkpolicies' && d === 'effective') return ok({ kind: params.get('kind'), namespace: b, name: params.get('name'), host_network: false, ingress: { isolated: false, policies: [] }, egress: { isolated: false, policies: [] }, unevaluated: [] })
    const kind = PLURAL[c]
    if (!d) {
      if (NONE.has(c)) return ok([])
      if (!kind) return null
      let list = all(kind, b === 'all' ? undefined : b)
      if (kind === 'Pod' && params.get('label_selector')) list = list.filter((p) => selects(params.get('label_selector')!, p.metadata.labels))
      return ok(list.map(ROW[kind]))
    }
    if (NONE.has(c)) return notFound(`${c} "${d}"`)
    const o = kind && find(kind, b, d)
    if (!o) return notFound(`${c} "${d}"`)
    if (!e) return ok(ROW[kind]?.(o) ?? objectJson(o))
    if (e === 'describe') return ok(DESCRIBE[kind](o))
    if (e === 'yaml') return ok({ yaml: toYaml(objectJson(o)) })
    if (e === 'logs' && kind === 'Pod') return podLog(b, d, params.get('container') || undefined, Number(params.get('tail_lines')) || 100)
    if (e === 'rbac' && kind === 'Pod') return ok(podRbac(o, params.get('include_authenticated') === 'true'))
    if (e === 'jobs' && kind === 'CronJob') return ok(cronJobJobs(o))
    if (e === 'revisions') {
      if (kind === 'Deployment') {
        return ok(owned(o, 'ReplicaSet').map((r) => ({ revision: Number(r.metadata.annotations['deployment.kubernetes.io/revision']), images: images(r.spec.template), created_at: r.metadata.creationTimestamp, is_current: r.metadata.annotations['deployment.kubernetes.io/revision'] === o.metadata.annotations['deployment.kubernetes.io/revision'], name: r.metadata.name, replicas: r.status.replicas || 0 })).sort((x, y) => y.revision - x.revision))
      }
      return ok(owned(o, 'ControllerRevision').map((r) => ({ revision: r.revision, images: images(r.data.spec.template), created_at: r.metadata.creationTimestamp, is_current: r === newestRevision(o), name: r.metadata.name })).sort((x, y) => y.revision - x.revision))
    }
    if (e === 'backend-usage') return ok({ available: false, reason: 'prometheus_not_configured', pods: [], queries: 0 })
    return null
  }
  if (b === 'all' && PLURAL[a]) return ok(all(PLURAL[a]).map(ROW[PLURAL[a]]))
  if (b === 'all' && NONE.has(a)) return ok([])
  if (a === 'ingressclasses' && b && c === 'ingresses') return ok(all('Ingress').filter((i) => i.spec.ingressClassName === b).map((i) => ({ name: i.metadata.name, namespace: i.metadata.namespace, created_at: i.metadata.creationTimestamp })))
  if (PLURAL[a] && !b) {
    const list = all(PLURAL[a])
    return ok(PLURAL[a] === 'PersistentVolumeClaim' && params.get('usage') ? list.map((x) => ({ ...pvcRow(x), usage: null })) : list.map(ROW[PLURAL[a]]))
  }
  if (PLURAL[a] && b) {
    const o = find(PLURAL[a], '', b)
    if (!o) return notFound(`${a} "${b}"`)
    return ok(c === 'describe' ? DESCRIBE[o.kind](o) : ROW[o.kind](o))
  }
  if (NONE.has(a)) return b ? notFound(`${a} "${b}"`) : ok([])
  return null
}

export function clusterWrite(method: string, route: string, body: Obj): Answer | null {
  const parts = route.split('/').slice(1).map(decodeURIComponent)
  if (parts[0] !== 'cluster') return null
  const [, a, b, c, d, e] = parts
  if (method === 'POST' && a === 'resources' && b === 'yaml' && c === 'create') return createYaml(String(body.yaml ?? ''), String(body.namespace ?? ''))
  if (method === 'POST' && a === 'resources' && b === 'yaml' && c === 'apply') {
    const kind = kindOf(String(body.resource_type || ''))
    const o = kind && find(kind, body.namespace ? String(body.namespace) : undefined, String(body.resource_name || ''))
    return o ? applyYaml(o, String(body.yaml ?? '')) : notFound(`${body.resource_type} "${body.resource_name}"`)
  }
  if (a === 'nodes' && b) {
    const n = find('Node', '', b)
    if (!n) return notFound(`nodes "${b}"`)
    if (method === 'POST' && (c === 'cordon' || c === 'uncordon')) {
      n.spec.unschedulable = c === 'cordon' ? true : undefined
      return done({ status: c === 'cordon' ? 'cordoned' : 'uncordoned', unschedulable: c === 'cordon' })
    }
    if (method === 'POST' && c === 'drain') {
      n.spec.unschedulable = true
      for (const p of all('Pod').filter((x) => x.spec.nodeName === b && ownerOf(x)?.kind !== 'DaemonSet' && active(x))) replace(p)
      return done({ status: 'started', drain_id: 'drain-' + randomSuffix(8) })
    }
    if (method === 'POST' && c === 'yaml' && d === 'apply') return applyYaml(n, String(body.yaml ?? ''))
    if (method === 'DELETE' && !c) { deleteObject(n); return done({ message: 'deleted' }) }
  }
  if (a === 'namespaces' && b) {
    if (method === 'POST' && c === 'yaml' && d === 'apply') { const n = find('Namespace', '', b); return n ? applyYaml(n, String(body.yaml ?? '')) : notFound(`namespaces "${b}"`) }
    if (method === 'DELETE' && !c) {
      const n = find('Namespace', '', b)
      if (!n) return notFound(`namespaces "${b}"`)
      if (['default', 'kube-system', 'kube-public'].includes(b)) return { status: 403, data: { detail: `namespaces "${b}" is forbidden: this namespace may not be deleted` } }
      deleteObject(n)
      return done({ message: 'deleted' })
    }
    if (method === 'POST' && c === 'optimization' && d === 'resize') return resize(b, body)
    const kind = PLURAL[c]
    const o = kind && d ? find(kind, b, d) : undefined
    if (!o) return d ? notFound(`${c} "${d}"`) : null
    if (method === 'DELETE' && !e) { deleteObject(o); return done({ message: 'deleted' }) }
    if (kind === 'CronJob' && method === 'PATCH' && e === 'suspend') { o.spec.suspend = !!body.suspend; return done({ suspend: o.spec.suspend }) }
    if (kind === 'CronJob' && method === 'POST' && e === 'trigger') {
      const letter = placeFor()
      const job = jobFor(o, b, o.metadata.name + '-manual-' + randomSuffix(3).replace(/\D/g, '7'), o.spec.jobTemplate.spec.template, Date.now(), 'running', letter, ipOn(letter))
      return done({ job_name: job.metadata.name })
    }
    if (method === 'POST' && e === 'rollback' && kind === 'Deployment') {
      const target = owned(o, 'ReplicaSet').find((r) => Number(r.metadata.annotations['deployment.kubernetes.io/revision']) === Number(body.revision))
      if (!target) return { status: 400, data: { detail: `unable to find specified revision ${body.revision} in history` } }
      o.spec.template = clone(target.spec.template)
      delete o.spec.template.metadata.labels['pod-template-hash']
      rollOut(o)
      return done({ message: 'rolled back', revision: body.revision })
    }
  }
  if (method === 'DELETE' && PLURAL[a] && b && !c) {
    const o = find(PLURAL[a], '', b)
    if (!o) return notFound(`${a} "${b}"`)
    deleteObject(o)
    return done({ message: 'deleted' })
  }
  return null
}

// "Apply without restart": the containers' requests change on the workload's running Pods.
function resize(ns: string, body: Obj): Answer {
  const w = find(String(body.kind), ns, String(body.name))
  if (!w) return notFound(`${String(body.kind).toLowerCase()}s "${body.name}"`)
  const pods = (w.kind === 'Deployment' ? owned(w, 'ReplicaSet').flatMap((r) => owned(r)) : owned(w)).filter((p) => p.status.phase === 'Running' && !p.metadata.deletionTimestamp)
  const results = pods.map((p) => {
    const c = p.spec.containers.find((x: Obj) => x.name === body.container)
    if (!c) return { pod: p.metadata.name, result: 'skipped', reason: 'no such container' }
    c.resources = { ...c.resources, requests: { ...c.resources?.requests, ...(body.cpu_request_m ? { cpu: body.cpu_request_m + 'm' } : {}), ...(body.mem_request_bytes ? { memory: Math.round(body.mem_request_bytes / 1048576) + 'Mi' } : {}) } }
    return { pod: p.metadata.name, result: 'resized' }
  })
  return done({ kind: w.kind, namespace: ns, name: w.metadata.name, container: body.container, pods: results, resized: results.filter((r) => r.result === 'resized').length, pending: 0, skipped: results.filter((r) => r.result === 'skipped').length, failed: 0, api_version: w.apiVersion })
}

// A Helm revision made in the demo: the release's objects take the specs it renders, one it leaves out goes, and one it
// brings back is made again.
export function releaseApplied(ns: string, name: string, wanted: Obj[]) {
  for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet', 'Service', 'HorizontalPodAutoscaler', 'Ingress']) {
    const want = wanted.find((o) => o.kind === kind), live = find(kind, ns, name)
    if (want && live) {
      const before = JSON.stringify(live.spec)
      live.spec = clone(want.spec)
      if (JSON.stringify(live.spec) === before) continue
      if (live.metadata.generation !== undefined) live.metadata.generation += 1
      live.metadata.resourceVersion = String(++resourceVersion)
      reconcile(live)
    } else if (want) reconcile(put(make(kind, ns, name, iso(Date.now()), { labels: want.metadata.labels, annotations: want.metadata.annotations, ...(want.metadata.generation ? { generation: 1 } : {}) }, { spec: clone(want.spec), status: clone(want.status ?? {}) })))
    else if (live && live.metadata.annotations?.['meta.helm.sh/release-name'] === name) drop(live)
  }
  refresh()
}

// The chat's Pod delete (as the Pods page's): the Pod goes and its controller makes another.
export function deletePod(namespace: string, name: string): boolean {
  const p = find('Pod', namespace, name)
  if (!p) return false
  deleteObject(p)
  refresh()
  return true
}

advance()
refresh()
