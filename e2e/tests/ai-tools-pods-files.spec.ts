import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Six AI tools called through the MCP endpoint, so the checks are exact and no model runs. Each is held value for value
// to the route its screen calls, and to the cluster:
// - pod_rbac: GET /namespaces/{ns}/pods/{name}/rbac, the service account and the bindings kubectl made.
// - logfiles: the Log files tab's routes on the e2e-logfile-writer fixture, its audit row, its refusals, the masking.
// - storage_summary: the Storage window's /pvcs?usage=true, /pvs and /topology/storage.
// - network_policy_effective: a drawer's Network Policies section.
// - limit_range_violations: a LimitRange window's Violating Pods, on a pod made before the LimitRange.
// - alerts_inbox: the Alerts inbox and one alert's window, with marks set through the screen's route and left unchanged.
// A grant limited to namespaces then calls the tools that stay inside it without naming one, with objects in a
// namespace beside its own that must not show.

const CLUSTER = 'self'
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-sym4-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const PAUSE = 'registry.k8s.io/pause:3.10'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const runId = () => Date.now().toString(36)

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ai-sym4-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const tryKubectl = (args: string[]) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, name: string, args: Obj): Promise<{ isError: boolean; text: string }> {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: name === 'list_clusters' ? {} : { cluster: CLUSTER, ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function answerOf(request: APIRequestContext, token: string, name: string, args: Obj): Promise<Obj> {
  const { isError, text } = await call(request, token, name, args)
  expect(isError, `${name}: ${text}`).toBe(false)
  return JSON.parse(text)
}

async function toolNames(request: APIRequestContext, token: string): Promise<string[]> {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name)
}

async function routeOf(request: APIRequestContext, token: string, route: string, params: Obj = {}): Promise<Obj> {
  const res = await request.get(route, { headers: bearer(token), params: { cluster: CLUSTER, ...params } })
  expect(res.status(), `${route}: ${await res.text()}`).toBe(200)
  return res.json()
}

// Every value of the route's answer in the tool's.
function expectSameValues(answer: Obj, route: Obj) {
  for (const key of Object.keys(route)) expect(answer[key], key).toEqual(route[key])
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: 100 } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items ?? []).map((i: Obj) => {
    const after = i.After ?? i.after ?? {}
    return {
      target: i.TargetID ?? i.target_id, targetType: i.TargetType ?? i.target_type, actor: i.ActorEmail ?? i.actor_email, result: i.Result ?? i.result,
      cluster: i.Cluster ?? i.cluster, after: typeof after === 'string' ? JSON.parse(after) : after,
    }
  })
}

test.describe('AI tools: what a screen computes', () => {
  let admin = ''
  const userIds: string[] = []
  const roleIds: number[] = []
  const namespaces: string[] = []

  test.beforeEach(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!config.ok() || !(await config.json()).enabled, 'the MCP server is off (mcp.enabled)')
  })

  test.afterEach(async ({ request }) => {
    for (const id of userIds.splice(0)) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const id of roleIds.splice(0)) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const ns of namespaces.splice(0)) tryKubectl(['delete', 'namespace', ns, '--ignore-not-found', '--wait=false'])
  })

  function namespace(name: string): string {
    kubectl(['create', 'namespace', name])
    namespaces.push(name)
    return name
  }

  async function user(request: APIRequestContext, label: string, role: string, grant?: string[]): Promise<{ email: string; token: string }> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = ((Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { id: number; name: string }[]).find((r) => r.name.toLowerCase() === 'member')!
    const email = `e2e-sym4-${label}-${runId()}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E sym4 ${label}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role, ...(grant ? { namespaces: grant } : {}) } })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  async function customRole(request: APIRequestContext, name: string, permissions: string[]): Promise<string> {
    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions } })
    expect(role.status(), await role.text()).toBe(201)
    roleIds.push((await role.json()).id)
    return name
  }

  test('pod_rbac answers the route value for value, with the bindings the cluster has', async ({ request }) => {
    const run = runId()
    const ns = namespace(`e2e-sym4-rbac-${run}`)
    const crb = `e2e-sym4-${run}`
    try {
      kubectl(['-n', ns, 'create', 'serviceaccount', 'web-sa'])
      kubectl(['-n', ns, 'create', 'role', 'web-reader', '--verb=get', '--resource=configmaps'])
      kubectl(['-n', ns, 'create', 'rolebinding', 'web-rb', '--role=web-reader', `--serviceaccount=${ns}:web-sa`])
      kubectl(['create', 'clusterrolebinding', crb, '--clusterrole=view', `--serviceaccount=${ns}:web-sa`])
      kubectl(['-n', ns, 'run', 'web', `--image=${PAUSE}`, '--restart=Never', `--overrides=${JSON.stringify({ spec: { serviceAccountName: 'web-sa' } })}`])

      const route = await routeOf(request, admin, `/api/v1/cluster/namespaces/${ns}/pods/web/rbac`)
      const answer = await answerOf(request, admin, 'pod_rbac', { namespace: ns, pod_name: 'web' })
      expectSameValues(answer, route)
      expect(answer.service_account_name).toBe('web-sa')
      expect(answer.bindings).toContainEqual({ binding_type: 'RoleBinding', binding_name: 'web-rb', role_kind: 'Role', role_name: 'web-reader' })
      expect(answer.bindings).toContainEqual({ binding_type: 'ClusterRoleBinding', binding_name: crb, role_kind: 'ClusterRole', role_name: 'view' })
      // the tab's rows: what the role allows, not only its name
      expect(answer.role_bindings.find((b: Obj) => b.name === 'web-rb').resolved_role.rules).toEqual([
        { verbs: ['get'], api_groups: [''], resources: ['configmaps'], resource_names: [], non_resource_urls: [] },
      ])
      expect(answer.cluster_role_bindings.find((b: Obj) => b.name === crb).matched_by.map((m: Obj) => m.reason)).toEqual(['serviceaccount'])

      const broadRoute = await routeOf(request, admin, `/api/v1/cluster/namespaces/${ns}/pods/web/rbac`, { include_authenticated: 'true' })
      const broadAnswer = await answerOf(request, admin, 'pod_rbac', { namespace: ns, pod_name: 'web', include_authenticated: true })
      expectSameValues(broadAnswer, broadRoute)
      expect(broadAnswer.cluster_role_bindings.some((b: Obj) => b.is_broad === true), 'the bindings of system:authenticated').toBe(true)

      const reader = await user(request, 'rbac', 'Read')
      expectSameValues(await answerOf(request, reader.token, 'pod_rbac', { namespace: ns, pod_name: 'web' }), route)

      const missing = JSON.parse((await call(request, admin, 'pod_rbac', { namespace: ns, pod_name: 'no-such-pod' })).text)
      expect(missing.status).toBe('not_found')
    } finally {
      tryKubectl(['delete', 'clusterrolebinding', crb, '--ignore-not-found'])
    }
  })

  test('network_policy_effective answers the Network Policies section, and asks its permission', async ({ request }) => {
    const run = runId()
    const ns = namespace(`e2e-sym4-netpol-${run}`)
    kubectl(['-n', ns, 'run', 'web', `--image=${PAUSE}`, '--restart=Never', '--labels=app=web'])
    kubectl(['-n', ns, 'create', 'deployment', 'web-deploy', `--image=${PAUSE}`])
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'allow-front', namespace: ns },
      spec: { podSelector: { matchLabels: { app: 'web' } }, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: { matchLabels: { app: 'front' } } }], ports: [{ protocol: 'TCP', port: 8080 }] }] },
    }))

    const pod = await answerOf(request, admin, 'network_policy_effective', { namespace: ns, pod: 'web' })
    expectSameValues(pod, await routeOf(request, admin, `/api/v1/cluster/namespaces/${ns}/networkpolicies/effective`, { kind: 'Pod', name: 'web' }))
    expect(pod.ingress.isolated).toBe(true)
    expect(pod.ingress.policies.map((p: Obj) => p.name)).toEqual(['allow-front'])
    expect(pod.egress.isolated).toBe(false)

    const workload = await answerOf(request, admin, 'network_policy_effective', { namespace: ns, workload_kind: 'Deployment', workload_name: 'web-deploy' })
    expectSameValues(workload, await routeOf(request, admin, `/api/v1/cluster/namespaces/${ns}/networkpolicies/effective`, { kind: 'Deployment', name: 'web-deploy' }))
    expect(workload.ingress.isolated).toBe(false)

    const role = await customRole(request, `e2e-sym4-noread-${run}`, ['menu.*', 'ai.tool.*', 'ai.mcp.use'])
    const lacking = await user(request, 'netpol', role)
    const refused = await call(request, lacking.token, 'network_policy_effective', { namespace: ns, pod: 'web' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('resource.networkpolicy.read')
    expect(refused.text).not.toContain('allow-front')
  })

  test('limit_range_violations answers the Violating Pods list of a pod made before the LimitRange', async ({ request }) => {
    const run = runId()
    const ns = namespace(`e2e-sym4-limits-${run}`)
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'big', namespace: ns },
      spec: { containers: [{ name: 'app', image: PAUSE, resources: { limits: { cpu: '2' }, requests: { cpu: '2' } } }] },
    }))
    kubectl(['create', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'LimitRange', metadata: { name: 'limits', namespace: ns }, spec: { limits: [{ type: 'Container', max: { cpu: '1' } }] },
    }))

    const route = await routeOf(request, admin, `/api/v1/cluster/namespaces/${ns}/limitranges/limits/violations`)
    const answer = await answerOf(request, admin, 'limit_range_violations', { namespace: ns, name: 'limits' })
    expect(route).toEqual([{ pod: 'big', namespace: ns, container: 'app', field: 'cpu max', actual: '2', limit: '1' }])
    expect(answer.violations).toEqual(route)
    expect(answer.violations_total).toBe(route.length)

    const missing = JSON.parse((await call(request, admin, 'limit_range_violations', { namespace: ns, name: 'no-such' })).text)
    expect(missing.status).toBe('not_found')
  })

  test('storage_summary answers the Storage window, counted as the window counts', async ({ request }) => {
    const run = runId()
    const ns = namespace(`e2e-sym4-storage-${run}`)
    const pv = `e2e-sym4-pv-${run}`
    const storageClass = `e2e-sym4-${run}`
    const claim = (name: string, extra: Obj = {}) => JSON.stringify({
      apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: ns },
      spec: { accessModes: ['ReadWriteOnce'], storageClassName: storageClass, resources: { requests: { storage: '1Gi' } }, ...extra },
    })
    try {
      kubectl(['create', '-f', '-'], JSON.stringify({
        apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pv },
        spec: { capacity: { storage: '1Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: storageClass, hostPath: { path: '/tmp/e2e-sym4' } },
      }))
      kubectl(['create', '-f', '-'], claim('pending-claim', { volumeName: `${pv}-no-such` }))
      kubectl(['create', '-f', '-'], claim('bound-claim', { volumeName: pv }))
      await expect.poll(() => kubectl(['-n', ns, 'get', 'pvc', 'bound-claim', '-o', 'jsonpath={.status.phase}']), { timeout: 30_000 }).toBe('Bound')

      const answer = await answerOf(request, admin, 'storage_summary', { namespace: ns })
      const claims = (await routeOf(request, admin, '/api/v1/cluster/pvcs', { usage: 'true' })) as Obj[]
      const volumes = (await routeOf(request, admin, '/api/v1/cluster/pvs')) as Obj[]
      const byName = (name: string, rows: Obj[]) => rows.find((r) => r.name === name)

      expect(answer.namespace).toBe(ns)
      expect(answer.pvcs_total).toBe(2)
      expect(answer.pvc_status_counts).toEqual({ Pending: 1, Bound: 1 })
      // What needs a person first.
      expect(answer.pvcs.map((r: Obj) => r.name)).toEqual(['pending-claim', 'bound-claim'])
      for (const row of answer.pvcs) expect(row).toEqual(claims.find((c) => c.namespace === ns && c.name === row.name))
      expect(answer.pvs.map((r: Obj) => r.name)).toEqual([pv])
      expect(answer.pv_status_counts).toEqual({ Bound: 1 })
      expect(byName(pv, answer.pvs)).toEqual(byName(pv, volumes))

      const whole = await answerOf(request, admin, 'storage_summary', {})
      const claimCounts: Record<string, number> = {}
      for (const c of claims) claimCounts[c.status] = (claimCounts[c.status] ?? 0) + 1
      expect(whole.pvc_status_counts).toEqual(claimCounts)
      expect(whole.pvcs_total).toBe(claims.length)
      expect(whole.pvs_total).toBe(volumes.length)
      expect(kubectl(['get', 'pvc', '-A', '-o', 'name']).split('\n').length).toBe(claims.length)

      const graph = await (await request.get('/api/v1/topology/storage', { headers: bearer(admin), params: { cluster: CLUSTER } })).json()
      expect(whole.topology.pv_count).toBe(graph.metadata.pv_count)
      expect(whole.topology.pvc_count).toBe(graph.metadata.pvc_count)
      expect(whole.topology.nodes_total).toBe(graph.nodes.length)
      expect(whole.topology.edges_total).toBe(graph.edges.length)
      expect(whole.topology.edges.map((e: Obj) => [e.source, e.target])).toContainEqual([`pvc-${ns}-bound-claim`, `pv-${pv}`])
    } finally {
      tryKubectl(['-n', ns, 'delete', 'pvc', '--all', '--ignore-not-found', '--wait=false'])
      tryKubectl(['delete', 'pv', pv, '--ignore-not-found', '--wait=false'])
    }
  })

  test('logfiles lists and reads what the tab does, with its audit row, its refusals and the masking', async ({ request }) => {
    test.setTimeout(120_000)
    const headers = bearer(admin)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers })).json()
    const pods = await (await request.get(`/api/v1/cluster/namespaces/default/pods?cluster=${CLUSTER}&label_selector=app%3De2e-logfile-writer`, { headers, failOnStatusCode: false })).json()
    const pod = Array.isArray(pods) ? ((pods.find((p: Obj) => (p.status ?? p.phase) === 'Running') ?? pods[0])?.name as string | undefined) : undefined
    test.skip(!features.logFiles?.enabled || !pod, 'features.logFiles is off or the e2e-logfile-writer fixture is missing')
    const target = { namespace: 'default', pod_name: pod, container: 'app' }
    const reader = await user(request, 'files', 'Read')
    const since = new Date(Date.now() - 1000).toISOString()

    const list = await answerOf(request, reader.token, 'logfiles', target)
    expect(list).toEqual(await routeOf(request, reader.token, `/api/v1/cluster/namespaces/default/pods/${pod}/logfiles`, { container: 'app' }))
    expect(list.files.map((f: Obj) => f.path)).toEqual(['/var/log/app/access.log', '/var/log/app/app.log'])

    const read = await answerOf(request, reader.token, 'logfiles', { ...target, path: '/var/log/app/app.log', lines: 3 })
    expect([read.path, read.container, read.lines, read.truncated]).toEqual(['/var/log/app/app.log', 'app', 3, false])
    const lines = (read.content as string).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    // The file only grows, a line every 2 seconds, so what was read stands in its end as one piece.
    expect(kubectl(['-n', 'default', 'exec', pod!, '-c', 'app', '--', 'tail', '-n', '200', '/var/log/app/app.log'])).toContain((read.content as string).trimEnd())

    const capped = await answerOf(request, reader.token, 'logfiles', { ...target, path: '/var/log/app/app.log', lines: 100000 })
    expect(capped.lines).toBe(Math.min(2000, features.logFiles.maxLines || 2000))

    await test.step('a read leaves the tab\'s row and a tool row, not a following one', async () => {
      await expect.poll(async () => (await auditRows(request, admin, 'k8s.pod.logfile.read', since))
        .filter((r) => r.actor === reader.email && r.result === 'success')
        .map((r) => ({ target: r.target, cluster: r.cluster, path: r.after.path, lines: r.after.lines, follow: r.after.follow, container: r.after.container })))
        .toContainEqual({ target: pod, cluster: CLUSTER, path: '/var/log/app/app.log', lines: 3, follow: false, container: 'app' })
      await expect.poll(async () => (await auditRows(request, admin, 'ai.mcp.call', since)).filter((r) => r.actor === reader.email && r.after.tool === 'logfiles').length).toBeGreaterThanOrEqual(3)
    })

    await test.step('a path the patterns do not cover is refused, with a failure row', async () => {
      for (const file of ['/var/log/app/notes.txt', '/etc/passwd', '/var/log/app/../../../etc/passwd']) {
        const refused = await answerOf(request, reader.token, 'logfiles', { ...target, path: file })
        expect([refused.status, refused.code], file).toEqual(['forbidden', 'path'])
        expect(JSON.stringify(refused)).not.toContain('root:')
      }
      await expect.poll(async () => (await auditRows(request, admin, 'k8s.pod.logfile.read', since)).filter((r) => r.actor === reader.email && r.result === 'failure').map((r) => r.after.path))
        .toContain('/var/log/app/notes.txt')
    })

    await test.step('a credential in the file is masked', async () => {
      const file = `/var/log/app/e2e-sym4-${runId()}.log`
      try {
        kubectl(['-n', 'default', 'exec', pod!, '-c', 'app', '--', 'sh', '-c', `printf 'first line\\npassword: fake-e2e-logfile-password\\nlast line\\n' > ${file}`])
        const masked = await answerOf(request, reader.token, 'logfiles', { ...target, path: file })
        expect(masked.content).not.toContain('fake-e2e-logfile-password')
        expect(masked.content).toContain('first line')
        expect(masked.content).toContain('last line')
      } finally {
        tryKubectl(['-n', 'default', 'exec', pod!, '-c', 'app', '--', 'rm', '-f', file])
      }
    })

    await test.step('without the tab\'s permission the tool is not listed and not run', async () => {
      const role = await customRole(request, `e2e-sym4-nofiles-${runId()}`, ['menu.*', 'resource.*.read', 'ai.tool.*', 'ai.mcp.use'])
      const lacking = await user(request, 'nofiles', role)
      expect(await toolNames(request, lacking.token)).not.toContain('logfiles')
      const refused = await call(request, lacking.token, 'logfiles', target)
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('resource.pod.logfile')
      expect(await toolNames(request, reader.token)).toContain('logfiles')
    })
  })

  test('alerts_inbox reads the inbox and one alert as the screen does, and changes nothing', async ({ request }) => {
    const headers = bearer(admin)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers })).json()
    test.skip(!features.alertInvestigation?.enabled, 'the Alerts inbox is off (features.alertInvestigation)')
    const run = runId()
    const webhookToken = Buffer.from(kubectl(['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']), 'base64').toString()
    const labels = { alertname: `E2ESym4Inbox${run}`, severity: 'info', namespace: `e2e-sym4-${run}` }
    const post = (status: string, extra: Obj = {}) => request.post(`/api/v1/alerts/webhook?cluster=${CLUSTER}`, {
      headers: { Authorization: `Bearer ${webhookToken}` },
      data: {
        version: '4', groupKey: `{}:{alertname="${labels.alertname}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093',
        alerts: [{ status, labels, annotations: { summary: `sym4 ${run}`, runbook: 'https://runbook.example/sym4' }, startsAt: new Date(Date.now() - 60_000).toISOString(), fingerprint: `sym4-${run}`, ...extra }],
      },
    })
    expect((await (await post('firing')).json()).stored).toBe(1)
    try {
      const routeList = await routeOf(request, admin, '/api/v1/alerts/inbox', { q: run, limit: 50 })
      const id = (routeList.items as Obj[]).find((i) => i.fingerprint === `sym4-${run}`).id as string
      const note = `looked at it ${run}`
      const marked = await request.patch(`/api/v1/alerts/inbox/${id}`, { headers, data: { acknowledged: true, assignee: 'me', note } })
      expect(marked.status(), await marked.text()).toBe(200)

      const list = await answerOf(request, admin, 'alerts_inbox', { search: run })
      expectSameValues(list, await routeOf(request, admin, '/api/v1/alerts/inbox', { q: run, limit: 50 }))
      expect(list.items.map((i: Obj) => i.id)).toEqual([id])
      const adminEmail = (await (await request.get('/api/v1/auth/me', { headers })).json()).email
      expect([list.items[0].acknowledged, list.items[0].assignee, list.items[0].acked_by]).toEqual([true, adminEmail, adminEmail])

      const window = await routeOf(request, admin, `/api/v1/alerts/inbox/${id}`)
      const one = await answerOf(request, admin, 'alerts_inbox', { alert_id: id })
      expectSameValues(one, window)
      expect([one.note, one.note_by]).toEqual([note, adminEmail])
      expect(one.alert_link).toContain(`alert=${id}`)

      // Each filter is the screen's.
      for (const [args, params] of [
        [{ status: 'firing' }, { status: 'firing' }],
        [{ status: 'resolved' }, { status: 'resolved' }],
        [{ alert_severity: 'info' }, { severity: 'info' }],
        [{ mine: true }, { mine: true }],
        [{ open_only: true }, { open: true }],
      ] as [Obj, Obj][]) {
        expect((await answerOf(request, admin, 'alerts_inbox', { search: run, ...args })).total, JSON.stringify(args))
          .toBe((await routeOf(request, admin, '/api/v1/alerts/inbox', { q: run, ...params })).total)
      }

      const reader = await user(request, 'inbox', 'Read')
      expectSameValues(await answerOf(request, reader.token, 'alerts_inbox', { search: run }), await routeOf(request, reader.token, '/api/v1/alerts/inbox', { q: run, limit: 50 }))
      expect((await answerOf(request, reader.token, 'alerts_inbox', { search: run, mine: true })).total).toBe(0)

      // Reading changed no mark.
      expect(await routeOf(request, admin, `/api/v1/alerts/inbox/${id}`)).toEqual(window)

      const missing = JSON.parse((await call(request, admin, 'alerts_inbox', { alert_id: 'no-such-alert' })).text)
      expect(missing.status).toBe('not_found')
    } finally {
      await post('resolved', { endsAt: new Date().toISOString() })
    }
  })

  test('a limited grant calls the tools that stay inside it without a namespace, and sees nothing outside it', async ({ request }) => {
    test.setTimeout(180_000)
    const run = runId()
    const own = namespace(`e2e-sym4-own-${run}`)
    const outside = namespace(`e2e-sym4-out-${run}`)
    const rbac = `e2e-sym4-${run}`
    const storageClass = `e2e-sym4-sc-${run}`
    const unschedulable = JSON.stringify({ spec: { nodeSelector: { 'kubeast.io/no-such-node': 'true' } } })
    const claim = (ns: string) => JSON.stringify({
      apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `web-claim-${ns}`, namespace: ns },
      spec: { accessModes: ['ReadWriteOnce'], storageClassName: storageClass, resources: { requests: { storage: '1Gi' } } },
    })
    try {
      for (const ns of [own, outside]) {
        kubectl(['-n', ns, 'run', `web-${ns}`, `--image=${PAUSE}`, '--restart=Never', `--overrides=${unschedulable}`])
        kubectl(['-n', ns, 'create', 'configmap', `web-config-${ns}`, '--from-literal=k=v'])
        kubectl(['create', '-f', '-'], claim(ns))
        kubectl(['create', '-f', '-'], JSON.stringify({
          apiVersion: 'v1', kind: 'Event', metadata: { name: `web-config-${ns}.e2e`, namespace: ns },
          involvedObject: { apiVersion: 'v1', kind: 'ConfigMap', namespace: ns, name: `web-config-${ns}` },
          type: 'Warning', reason: 'E2ESym4Warning', message: `e2e warning in ${ns}`, count: 1,
          firstTimestamp: new Date().toISOString(), lastTimestamp: new Date().toISOString(), source: { component: 'e2e' },
        }))
      }
      kubectl(['create', 'clusterrole', `${rbac}-imp`, '--verb=impersonate', '--resource=groups', '--resource-name=kubeast:role:read'])
      kubectl(['create', 'clusterrolebinding', `${rbac}-imp`, `--clusterrole=${rbac}-imp`, '--serviceaccount=kubeast:k8s-service', '--serviceaccount=kubeast:tool-server'])
      kubectl(['-n', own, 'create', 'rolebinding', `${rbac}-view`, '--clusterrole=view', '--group=kubeast:role:read'])

      const limited = await user(request, 'limited', 'Read', [own])
      await expect.poll(async () => (await request.get(`/api/v1/cluster/namespaces/${own}/configmaps?cluster=${CLUSTER}`, { headers: bearer(limited.token), failOnStatusCode: false })).status(), { timeout: 20_000 }).toBe(200)

      await test.step('k8s_find_resource finds what is in its namespaces only', async () => {
        const found = await answerOf(request, limited.token, 'k8s_find_resource', { query: 'web', kinds: ['pods', 'configmaps'] })
        const names = (found.matches as Obj[]).map((m) => `${m.kind}/${m.namespace}/${m.name}`).sort()
        expect(names).toEqual([`configmaps/${own}/web-config-${own}`, `pods/${own}/web-${own}`])
        expect(found.searched.namespaces).toEqual([own])
      })

      await test.step('k8s_find_resource does not list a namespace outside the grant', async () => {
        const found = await call(request, limited.token, 'k8s_find_resource', { query: 'e2e-sym4', kinds: ['namespaces'] })
        expect(found.isError, found.text).toBe(false)
        expect(found.text).not.toContain(outside)
      })

      await test.step('k8s_explain reads the schema', async () => {
        const schema = await call(request, limited.token, 'k8s_explain', { resource: 'pods.spec.nodeSelector' })
        expect(schema.isError, schema.text).toBe(false)
        expect(schema.text).toContain('nodeSelector')
      })

      await test.step('issues answers what its screen answers this user', async () => {
        const ids = (issues: Obj[]) => issues.map((i) => i.id as string).sort()
        const route = await routeOf(request, limited.token, '/api/v1/cluster/issues', { window: 60 })
        const answer = await answerOf(request, limited.token, 'issues', { window_minutes: 60 })
        expect(answer.namespace).toEqual([own])
        expect(ids(answer.issues)).toEqual(ids(route.issues))
        expect(ids(answer.issues)).toContain(`ConfigMap/${own}/web-config-${own}`)
        // The list the grant cannot read is said, as on the screen.
        expect(ids(answer.issues)).toContain('Collector/nodes')
        expect(JSON.stringify(answer.issues)).not.toContain(outside)
      })

      await test.step('cost is narrowed or says there is no OpenCost', async () => {
        const answer = await call(request, limited.token, 'cost', {})
        expect(answer.isError, answer.text).toBe(false)
        const parsed = JSON.parse(answer.text)
        if (parsed.status) expect(parsed.status).toBe('unavailable')
        else expect((parsed.rows as Obj[]).filter((r) => r.namespace !== own)).toEqual([])
        expect(answer.text).not.toContain(outside)
      })

      await test.step('gitops_status reads its namespaces or says there is no Argo CD here', async () => {
        const answer = JSON.parse((await call(request, limited.token, 'gitops_status', {})).text)
        if (answer.status) expect(answer.status).toBe('unavailable')
        else expect(answer.scope).toEqual([own])
      })

      await test.step('storage_summary counts its namespaces\' claims', async () => {
        const route = (await routeOf(request, limited.token, '/api/v1/cluster/pvcs', { usage: 'true' })) as Obj[]
        const answer = await call(request, limited.token, 'storage_summary', {})
        expect(answer.isError, answer.text).toBe(false)
        const parsed = JSON.parse(answer.text)
        expect(route.map((c) => c.name)).toEqual([`web-claim-${own}`])
        expect(parsed.pvcs).toEqual(route)
        expect(parsed.pvc_status_counts).toEqual({ Pending: 1 })
        expect(parsed.namespace).toEqual([own])
        expect(answer.text).not.toContain(outside)
      })

      await test.step('naming a namespace outside the grant is still refused, and the inbox is for the whole cluster', async () => {
        for (const tool of ['issues', 'cost', 'gitops_status', 'storage_summary']) {
          const refused = await call(request, limited.token, tool, { namespace: outside })
          expect(refused.isError, tool).toBe(true)
          expect(refused.text, tool).toContain('outside your grant')
        }
        const all = await call(request, limited.token, 'k8s_find_resource', { query: 'web', all_namespaces: true })
        expect(all.text).not.toContain(`web-${outside}`)
        const inbox = await call(request, limited.token, 'alerts_inbox', {})
        expect(inbox.isError).toBe(true)
        expect(inbox.text).toContain('spans the cluster')
      })
    } finally {
      tryKubectl(['delete', 'clusterrolebinding', `${rbac}-imp`, '--ignore-not-found'])
      tryKubectl(['delete', 'clusterrole', `${rbac}-imp`, '--ignore-not-found'])
    }
  })
})
