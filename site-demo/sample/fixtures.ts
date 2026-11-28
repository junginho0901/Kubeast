// The demo's account, features, cost, Helm and audit records, over the sample cluster (./cluster): invented names on
// example domains, no real cluster, account or key. Everything here lives in page memory; a reload starts again.
import { costWorkloads, created, find, helmCharts, objectJson, releaseApplied, storefrontUpgraded, toYaml } from './cluster'
import { incident } from './logs'
import { fromYaml } from './yaml'

export { created, deletePod, describe, logs, nodes, optimization, overview, podMetrics, pods } from './cluster'
type Row = Record<string, any>

// The built-in Write role's permissions in v0.8.0 (auth-service repository.SeedSystemRoles) less resource.secret.reveal,
// plus admin.audit.read for the Audit screen: a custom role, as an operator might have. No exec, rollback of workloads,
// Helm uninstall or Secret values, so every Secret reads masked.
const writePermissions = [
  'menu.*', 'resource.*.read', 'resource.*.create', 'resource.*.edit', 'resource.*.delete',
  'resource.cronjob.suspend', 'resource.cronjob.trigger', 'resource.alert.silence', 'resource.pod.logfile',
  'resource.helm.read', 'resource.helm.rollback', 'resource.helm.upgrade', 'resource.helm.test', 'ai.tool.*', 'ai.mcp.use', 'admin.audit.read',
]
export const me = {
  id: 'sample-operator', name: 'Sample operator', email: 'operator@northstar.example', team: null,
  role: { id: 'sample-operations', name: 'Operations', permissions: writePermissions, is_system: false },
  created_at: created, updated_at: created, permissions_matrix: { default: writePermissions },
  cluster_roles: { default: 'Operations' }, cluster_namespaces: {}, token_ttl_minutes: 0,
}
export const features = { prometheus: { enabled: false }, ai: { enabled: true }, cost: { enabled: true }, policyReports: { enabled: false }, alertInvestigation: { enabled: false }, alertStore: { enabled: false, clusters: [] }, networkFlows: { enabled: false, clusters: [] }, logSearch: { enabled: false, clusters: [] }, logFiles: { enabled: false, maxLines: 100, namespaces: [] }, tracing: { enabled: false }, writeGuardedNamespaces: [] }

// ---- Cost: OpenCost's allocation of the workloads' requests (list prices of a default on-prem install)

const PRICE = { core: 0.031611, gib: 0.004237, pvGib: 0.000054795, lb: 0.025 }
const WINDOW_HOURS: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }
export function cost(params: URLSearchParams) {
  const aggregate = params.get('aggregate') || 'namespace', window = params.get('window') || '24h'
  const hours = WINDOW_HOURS[window] || 24
  const fields = ['cpu_cost', 'ram_cost', 'gpu_cost', 'pv_cost', 'network_cost', 'load_balancer_cost', 'cpu_core_hours', 'ram_byte_hours']
  const workloads = costWorkloads().map((w, i) => {
    const spread = 0.85 + ((i * 37) % 30) / 100
    const r: Row = {
      name: w.name, namespace: w.namespace, kind: w.kind, cpu_cost: w.cores * PRICE.core * hours, ram_cost: w.gib * PRICE.gib * hours, gpu_cost: 0, pv_cost: w.pvGib * PRICE.pvGib * hours,
      network_cost: (w.kind === 'DaemonSet' ? 0.002 : 0.004 * spread) * hours, load_balancer_cost: w.lb ? PRICE.lb * hours : 0, cpu_core_hours: w.cores * hours, ram_byte_hours: w.gib * 1073741824 * hours,
      cpu_efficiency: Math.min(0.95, 0.18 + ((i * 53) % 57) / 100), ram_efficiency: Math.min(0.95, 0.38 + ((i * 29) % 49) / 100), minutes: hours * 60,
    }
    r.total_efficiency = (r.cpu_efficiency * r.cpu_cost + r.ram_efficiency * r.ram_cost) / Math.max(1e-9, r.cpu_cost + r.ram_cost)
    r.total_cost = fields.filter((k) => k.endsWith('_cost')).reduce((v, k) => v + r[k], 0)
    return r
  }).filter((r) => r.total_cost > 0)
  const keys = [...fields, 'total_cost']
  const namespaces = [...new Set(workloads.map((r) => r.namespace))]
  const rows = aggregate === 'controller' ? workloads : namespaces.map((name) => {
    const items = workloads.filter((r) => r.namespace === name)
    const sums: Row = Object.fromEntries(keys.map((k) => [k, items.reduce((v, r) => v + r[k], 0)]))
    const weighted = (k: string) => items.reduce((v, r) => v + r[k] * r.total_cost, 0) / Math.max(1e-9, sums.total_cost)
    return { name, namespace: name, ...sums, cpu_efficiency: weighted('cpu_efficiency'), ram_efficiency: weighted('ram_efficiency'), total_efficiency: weighted('total_efficiency'), minutes: hours * 60 }
  })
  const end = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString()
  return { window, aggregate, currency: 'USD', start: new Date(Date.parse(end) - hours * 3600000).toISOString(), end, source: { namespace: 'observability', service: 'opencost', port: 9003 }, scoped: false, generated_at: end, rows, totals: Object.fromEntries(keys.map((k) => [k, workloads.reduce((v, r) => v + r[k], 0)])) }
}

// ---- Helm: one release for each Helm-managed workload, its values and manifest made from the workload's objects. Each
// revision keeps its values and manifest as text, as Helm keeps them with the release, so a later change of the objects
// does not change them.

export interface Release { name: string; namespace: string; revision: number; status: string; chart: string; chartVersion: string; appVersion: string; updated: string; kind: string; history: Row[]; objects: Row[]; kept: Map<number, { values: string; manifest: string }> }

const tagOf = (image: string) => image.slice(image.lastIndexOf(':') + 1)
const olderTag = (tag: string, k: number) => tag.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => String(Math.max(0, Number(n) - k)) + rest)
export const releases: Release[] = helmCharts.map((c) => {
  const w = find(c.kind, c.namespace, c.name)!
  const appVersion = tagOf(w.spec.template.spec.containers[0].image)
  const status = c.name === 'loki' ? 'failed' : 'deployed'
  const history = Array.from({ length: c.revision }, (_, k) => ({
    revision: c.revision - k, status: k === 0 ? status : 'superseded', chartVersion: c.chartVersion,
    appVersion: k === 0 ? appVersion : c.name === 'storefront' ? '1.4.1' : olderTag(appVersion, k === 1 && status === 'failed' ? 0 : Math.ceil(k / 2)),
    updated: c.name === 'storefront' && k === 0 ? storefrontUpgraded : new Date(Date.parse('2026-11-20T09:30:00Z') - k * 3 * 86400000).toISOString().replace(/\.\d+Z$/, 'Z'),
    description: k === 0 ? (status === 'failed' ? 'Upgrade "loki" failed: timed out waiting for the condition' : 'Upgrade complete') : 'Superseded by revision ' + (c.revision - k + 1),
  }))
  const objects = [c.kind, 'Service', 'HorizontalPodAutoscaler', 'Ingress'].flatMap((kind) => { const o = find(kind, c.namespace, c.name); return o ? [objectJson(o)] : [] })
  return { name: c.name, namespace: c.namespace, revision: c.revision, status, chart: c.name, chartVersion: c.chartVersion, appVersion, updated: history[0].updated, kind: c.kind, history, objects, kept: new Map() }
})

// Helm keeps a release in its namespace's Secrets, so it goes with the namespace.
const homes = new Map(releases.map((r) => [r, find('Namespace', '', r.namespace)]))
const installed = () => releases.filter((r) => { const home = find('Namespace', '', r.namespace); return home && home === homes.get(r) && !home.metadata.deletionTimestamp })

const releaseSummary = (r: Release) => ({ name: r.name, namespace: r.namespace, revision: r.revision, status: r.status, chart: r.chart, chartVersion: r.chartVersion, appVersion: r.appVersion, updated: r.updated })
function valuesOf(r: Release, appVersion: string): Row {
  const one = (kind: string) => r.objects.find((o) => o.kind === kind)
  const w = one(r.kind)!, svc = one('Service'), hpa = one('HorizontalPodAutoscaler'), route = one('Ingress')
  const c = w.spec.template.spec.containers[0]
  return {
    ...(r.kind === 'DaemonSet' ? {} : { replicaCount: w.spec.replicas }),
    image: { repository: c.image.slice(0, c.image.lastIndexOf(':')), tag: appVersion, pullPolicy: c.imagePullPolicy },
    ...(svc ? { service: { type: svc.spec.type, port: svc.spec.ports[0].port } } : {}),
    resources: c.resources,
    ...(hpa ? { autoscaling: { enabled: true, minReplicas: hpa.spec.minReplicas, maxReplicas: hpa.spec.maxReplicas, targetCPUUtilizationPercentage: hpa.spec.metrics[0].resource.target.averageUtilization } } : {}),
    ...(route ? { ingress: { enabled: true, className: route.spec.ingressClassName, hosts: route.spec.rules.map((rule: Row) => rule.host) } } : {}),
    ...(r.kind === 'StatefulSet' ? { persistence: { enabled: true, size: w.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage, storageClass: w.spec.volumeClaimTemplates[0]?.spec.storageClassName } } : {}),
  }
}
// The release's objects as its chart renders them with these values.
export function renderedObjects(r: Release, values: Row): Row[] {
  return r.objects.map((o) => JSON.parse(JSON.stringify(o)) as Row).filter((o) => {
    const c = o.spec.template?.spec.containers[0]
    if (c) {
      const tag = values.image?.tag, repository = values.image?.repository ?? c.image.slice(0, c.image.lastIndexOf(':'))
      if (tag !== undefined && tag !== null) c.image = repository + ':' + tag
      if (values.image?.pullPolicy) c.imagePullPolicy = values.image.pullPolicy
      if (values.resources) c.resources = values.resources
      if (r.kind !== 'DaemonSet' && Number.isInteger(values.replicaCount) && values.replicaCount >= 0) o.spec.replicas = values.replicaCount
    } else if (o.kind === 'Service') {
      if (values.service?.type) o.spec.type = values.service.type
      if (Number.isInteger(values.service?.port)) o.spec.ports[0].port = values.service.port
    } else if (o.kind === 'HorizontalPodAutoscaler') {
      const a = values.autoscaling ?? {}
      if (a.enabled === false) return false
      if (Number.isInteger(a.minReplicas)) o.spec.minReplicas = a.minReplicas
      if (Number.isInteger(a.maxReplicas)) o.spec.maxReplicas = a.maxReplicas
      if (Number.isInteger(a.targetCPUUtilizationPercentage)) o.spec.metrics[0].resource.target.averageUtilization = a.targetCPUUtilizationPercentage
    } else if (o.kind === 'Ingress') {
      const i = values.ingress ?? {}
      if (i.enabled === false) return false
      if (i.className) o.spec.ingressClassName = i.className
      if (Array.isArray(i.hosts)) o.spec.rules.forEach((rule: Row, n: number) => { if (typeof i.hosts[n] === 'string') rule.host = i.hosts[n] })
    }
    return true
  })
}
export const manifestOf = (r: Release, values: Row) => renderedObjects(r, values).map((o) => '---\n# Source: ' + r.chart + '/templates/' + o.kind.toLowerCase() + '.yaml\n'
  + toYaml({ apiVersion: o.apiVersion, kind: o.kind, metadata: { name: o.metadata.name, namespace: o.metadata.namespace, labels: o.metadata.labels }, spec: o.spec })).join('')
for (const r of releases) for (const h of r.history) { const values = valuesOf(r, h.appVersion); r.kept.set(h.revision, { values: toYaml(values), manifest: manifestOf(r, values) }) }
// The text of a values window as an object, as Helm reads it; what it is not answers as the server does.
export function readValues(text: string): Row {
  if (!text.trim()) return {}
  let v: unknown
  try { v = fromYaml(text) } catch (e) { throw new Error('values must be valid YAML: ' + (e as Error).message.replace('error converting YAML to JSON: ', '')) }
  if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw new Error('values must be valid YAML: yaml: the values are not a mapping')
  return (v ?? {}) as Row
}

export function helmRead(route: string, params: URLSearchParams): { status: number; data: any } | null {
  const get = (data: any) => ({ status: 200, data })
  if (route === '/helm/releases') return get({ items: installed().filter((r) => !params.get('namespace') || r.namespace === params.get('namespace')).map(releaseSummary) })
  const one = route.match(/^\/helm\/releases\/([^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (!one) return null
  const r = findRelease(decodeURIComponent(one[1]), decodeURIComponent(one[2]))
  if (!r) return { status: 404, data: { detail: `release: not found` } }
  const section = one[3]
  const notes = `${r.chart} ${r.chartVersion} is ${r.status === 'failed' ? 'not ready' : 'running'} in ${r.namespace}.\n\nRead its Pods with:\n  kubectl -n ${r.namespace} get pods -l app=${r.name}\n`
  if (!section) return get({ ...releaseSummary(r), description: r.history[0].description, values: readValues(revisionText(r, r.revision, 'values')), notes })
  if (section === 'history') return get({ items: r.history })
  if (section === 'resources') return get({ items: [find(r.kind, r.namespace, r.name), find('Service', r.namespace, r.name), find('HorizontalPodAutoscaler', r.namespace, r.name), find('Ingress', r.namespace, r.name)].filter(Boolean).map((o) => ({ kind: o!.kind, apiVersion: o!.apiVersion, name: o!.metadata.name, namespace: o!.metadata.namespace })) })
  if (section === 'images') return get({ items: [...new Set((find(r.kind, r.namespace, r.name)?.spec.template.spec.containers ?? []).map((c: Row) => c.image as string))] })
  const revisionSection = section.match(/^revisions\/(\d+)\/(values|manifest|notes|hooks)$/)
  if (revisionSection) {
    const revision = Number(revisionSection[1]), what = revisionSection[2]
    return get({ revision, section: what, content: what === 'notes' ? notes : what === 'hooks' ? '' : revisionText(r, revision, what) })
  }
  if (section === 'values' || section === 'manifest') return get({ section, content: revisionText(r, r.revision, section) })
  if (section === 'notes') return get({ section, content: notes })
  if (section === 'hooks') return get({ section, content: '' })
  return null
}

// What a section of one revision says.
export function revisionText(r: Release, revision: number, section: string): string {
  return r.kept.get(revision)?.[section === 'manifest' ? 'manifest' : 'values'] ?? ''
}

export function findRelease(namespace: string, name: string) {
  return installed().find((r) => r.namespace === namespace && r.name === name)
}

// A new revision of a release made in the demo (rollback or values upgrade); its objects take what the values say, so the
// drawers and lists show what the release now deploys.
export function newRevision(r: Release, description: string, text: string) {
  const values = readValues(text), objects = renderedObjects(r, values)
  const image: string | undefined = objects.find((o) => o.kind === r.kind)?.spec.template.spec.containers[0].image
  r.history = r.history.map((h) => (h.status === 'deployed' || h.status === 'failed' ? { ...h, status: 'superseded' } : h))
  r.revision += 1
  r.status = 'deployed'
  r.appVersion = image ? tagOf(image) : r.appVersion
  r.updated = new Date().toISOString()
  r.history = [{ revision: r.revision, status: 'deployed', chartVersion: r.chartVersion, appVersion: r.appVersion, updated: r.updated, description }, ...r.history]
  r.kept.set(r.revision, { values: text, manifest: manifestOf(r, values) })
  releaseApplied(r.namespace, r.name, objects)
}

// ---- Audit (deterministic example records, never a real audit store): the checkout-api change and what followed it, then
// three earlier half hours of the same kinds of action on other targets

const storefront = findRelease('commerce', 'storefront')!
const auditActions: any[][] = [
  ['k8s', 'k8s.yaml.apply', 'Deployment', 'checkout-api', 'commerce', 'release-bot@northstar.example', 'success', null, { resource_type: 'deployments', yaml_len: 846 }],
  ['ai', 'ai.investigation.run', 'Alert', 'KubePodCrashLooping', 'commerce', 'oncall@northstar.example', 'success', null, { status: 'completed', evidence: ['Pod status', 'BackOff event', 'previous logs'], finding: 'PAYMENT_GATEWAY_URL is not set' }],
  ['k8s', 'k8s.pod.logs.read', 'Pod', 'checkout-api-7b9bc96fc8-8vn4z', 'commerce', 'oncall@northstar.example', 'success', null, { previous: true, tail: 100 }],
  ['helm', 'helm.release.upgrade', 'HelmRelease', 'storefront', 'commerce', 'release-bot@northstar.example', 'success', { fromRevision: storefront.revision - 1 }, { newRevision: storefront.revision, values_keys: Object.keys(readValues(revisionText(storefront, storefront.revision, 'values'))).sort(), values_len: revisionText(storefront, storefront.revision, 'values').length }],
  ['k8s', 'k8s.yaml.apply', 'StatefulSet', 'ledger', 'payments', 'operator@northstar.example', 'failure', null, { resource_type: 'statefulsets', yaml_len: 532 }],
  ['auth', 'auth.login', 'User', 'platform-operator', '', 'oncall@northstar.example', 'success', null, { method: 'oidc' }],
  ['ai', 'ai.chat.complete', 'Session', 'checkout-investigation', 'commerce', 'oncall@northstar.example', 'success', null, { tools: ['k8s_describe_resource', 'k8s_get_pod_logs'], finish_reason: 'stop' }],
  ['k8s', 'k8s.yaml.apply', 'Deployment', 'catalog', 'commerce', 'release-bot@northstar.example', 'success', null, { resource_type: 'deployments', yaml_len: 620 }],
]
// The targets of the three earlier half hours, per action above.
const earlierTargets: Array<Array<[string, string]>> = [
  [['notifications', 'platform'], ['search', 'commerce'], ['image-worker', 'batch']],
  [['KubeJobFailed', 'batch'], ['KubeJobFailed', 'batch'], ['KubeJobFailed', 'batch']],
  [['ledger-0', 'payments'], ['loki-0', 'observability'], ['prometheus-0', 'observability']],
  [['catalog', 'commerce'], ['grafana', 'observability'], ['payment-api', 'payments']],
  [['ledger', 'payments'], ['ledger', 'payments'], ['ledger', 'payments']],
  [['platform-operator', ''], ['platform-operator', ''], ['platform-operator', '']],
  [['job-failure', 'batch'], ['node-status', ''], ['cost-review', '']],
  [['policy-reporter', 'platform'], ['checkout-worker', 'batch'], ['cache', 'data']],
]
function auditAction(i: number): any[] {
  const kind = i % auditActions.length, turn = Math.floor(i / auditActions.length)
  if (!turn) return auditActions[kind]
  const [service, action, type, , , actor, result, before, after] = auditActions[kind]
  const [target, namespace] = earlierTargets[kind][turn - 1]
  if (action === 'helm.release.upgrade') return [service, 'helm.release.test', type, target, namespace, 'operator@northstar.example', 'success', null, { success: true, hookCount: 1 }]
  if (action === 'ai.investigation.run') return [service, action, type, target, namespace, actor, result, before, { status: 'completed', evidence: ['Job status', 'Pod logs'], finding: 'Could not acquire lock "schedule-sync"' }]
  return [service, action, type, target, namespace, actor, result, before, action === 'k8s.pod.logs.read' ? { previous: false, tail: 100 } : after]
}
export const auditRows: Row[] = Array.from({ length: 32 }, (_, i) => {
  const [Service, Action, TargetType, TargetID, Namespace, ActorEmail, Result, Before, After] = auditAction(i)
  return {
    ID: 480 - i, CreatedAt: i === 3 ? new Date(storefront.updated).toISOString() : new Date(incident + ([0, 10, 6, -9, -12, -15, 11, -21][i % 8] - Math.floor(i / 8) * 30) * 60000).toISOString(),
    Service, Action, ActorUserID: String(ActorEmail).split('@')[0], ActorEmail, TargetID, TargetType, TargetEmail: '', Cluster: 'default', Namespace, Result,
    Error: Result === 'failure' ? `The selected role cannot edit ${TargetType}s in ${Namespace}.` : '', RequestIP: '192.0.2.' + (20 + i % 4), UserAgent: 'Kubeast console',
    RequestID: 'req-' + (480 - i), Path: '/api/v1/cluster/' + Namespace + '/' + String(TargetType).toLowerCase() + '/' + TargetID, Before, After,
  }
}).sort((a, b) => Date.parse(b.CreatedAt) - Date.parse(a.CreatedAt)).map((row, i) => ({ ...row, ID: 480 - i, RequestID: 'req-' + (480 - i) }))

// One filter for the Audit table and its CSV, so the file holds the rows the table shows.
export function auditList(params: URLSearchParams) {
  let items = auditRows
  const fields: Record<string, string> = { service: 'Service', action: 'Action', actor_email: 'ActorEmail', target_id: 'TargetID', cluster: 'Cluster', namespace: 'Namespace', result: 'Result' }
  for (const [q, key] of Object.entries(fields)) {
    const value = params.get(q)
    if (value) items = items.filter((row) => String(row[key]).toLowerCase().includes(value.toLowerCase()))
  }
  const since = params.get('since'), until = params.get('until'), asOf = params.get('as_of')
  if (since) items = items.filter((r) => Date.parse(r.CreatedAt) >= Date.parse(since))
  if (until) items = items.filter((r) => Date.parse(r.CreatedAt) <= Date.parse(until))
  if (asOf) items = items.filter((r) => r.ID <= Number(asOf))
  const total = items.length, offset = Number(params.get('offset')) || 0, limit = Number(params.get('limit')) || 50
  return { items: items.slice(offset, offset + limit), total, as_of: Number(asOf) || 480, export_limit: 10000 }
}

export function auditCsv(params: URLSearchParams): string {
  const p = new URLSearchParams(params)
  p.set('limit', '10000')
  p.set('offset', '0')
  const rows = auditList(p).items
  const keys = ['CreatedAt', 'ActorEmail', 'Service', 'Action', 'TargetType', 'TargetID', 'Cluster', 'Namespace', 'Result']
  const cell = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"'
  return '﻿' + [keys, ...rows.map((r) => keys.map((k) => r[k]))].map((row) => row.map(cell).join(',')).join('\r\n')
}
