import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// gitops_status (a read tool: Argo CD Applications as the user) and the Admin-only audit_search,
// nodes_stats_summary and nodes_log. Driven through the MCP endpoint as the admin and a temporary
// Read user, checked against kubectl, the kubelet's own configuration and the audit API.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-tools5-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tools5-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return {
    run: (args: string, input?: string) =>
      execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input }).trim(),
    ok: (args: string) => {
      try {
        execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        return true
      } catch {
        return false
      }
    },
    // kubectl auth can-i exits 1 for "no"; the answer is still on stdout.
    answer: (args: string) => {
      try {
        return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      } catch (e) {
        return String((e as { stdout?: string }).stdout ?? '').trim()
      }
    },
  }
}
const kubectl = kubectlFor('kubeast')

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createReadUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E tools5', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id as string
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
  expect(grant.ok(), 'grant Read on self').toBeTruthy()
  return id
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function mcpOn(request: APIRequestContext, token: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && (await config.json()).enabled
}

const json = (text: string) => JSON.parse(text)

// A stand-in for Argo CD's CRD: the real schema is not needed to read status fields back.
const APP_CRD = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: applications.argoproj.io
  labels:
    kubeast.io/e2e: "true"
spec:
  group: argoproj.io
  names:
    kind: Application
    listKind: ApplicationList
    plural: applications
    singular: application
    shortNames: [app, apps]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              x-kubernetes-preserve-unknown-fields: true
`

function application(name: string, project: string, destNamespace: string) {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${name}
  namespace: default
spec:
  project: ${project}
  source:
    repoURL: https://git.example/${name}.git
    path: deploy
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: ${destNamespace}
  syncPolicy:
    automated:
      prune: true
`
}

test.describe('AI admin tools: gitops_status, audit_search, nodes_stats_summary, nodes_log', () => {
  test.setTimeout(240_000)

  test('gitops_status reads Argo CD Applications as the user: unavailable without the CRD, problems first with it', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const hadCRD = kubectl.ok('get crd applications.argoproj.io')
    if (!hadCRD) {
      const missing = json((await call(request, admin, 'gitops_status', { cluster: 'self' })).text)
      expect(missing).toMatchObject({ status: 'unavailable', feature: 'gitops_status' })
      expect(missing.reason).toMatch(/applications\.argoproj\.io/)
    }

    const s = stamp()
    // Name order would list the healthy app first; the tool lists problems first.
    const ok = `e2e-app-a-ok-${s}`
    const bad = `e2e-app-bad-${s}`
    const email = `e2e-tools5-r-${s}@kubeast.local`
    let userId = ''
    try {
      if (!hadCRD) {
        kubectl.run('apply -f -', APP_CRD)
        kubectl.run('wait --for=condition=Established crd/applications.argoproj.io --timeout=60s')
      }
      kubectl.run('apply -f -', application(ok, 'e2e-shop', 'shop'))
      kubectl.run('apply -f -', application(bad, 'e2e-shop', 'api'))
      kubectl.run(
        `-n default patch applications.argoproj.io ${ok} --subresource=status --type=merge -p '${JSON.stringify({
          status: {
            sync: { status: 'Synced', revision: '0123456789abcdef0123456789abcdef01234567' },
            health: { status: 'Healthy' },
            operationState: { phase: 'Succeeded', finishedAt: '2026-10-16T01:00:00Z' },
            resources: [{ kind: 'Deployment', namespace: 'shop', name: 'web', status: 'Synced', health: { status: 'Healthy' } }],
          },
        })}'`,
      )
      kubectl.run(
        `-n default patch applications.argoproj.io ${bad} --subresource=status --type=merge -p '${JSON.stringify({
          status: {
            sync: { status: 'OutOfSync', revision: 'fedcba9876543210fedcba9876543210fedcba98' },
            health: { status: 'Degraded', message: 'Deployment api has 0/2 replicas' },
            operationState: { phase: 'Failed', message: 'one or more objects failed to apply', retryCount: 2 },
            conditions: [{ type: 'SyncError', message: 'ConfigMap api-config: forbidden' }],
            resources: [
              { kind: 'Deployment', namespace: 'api', name: 'api', status: 'OutOfSync', health: { status: 'Degraded', message: '0/2' } },
              { kind: 'Service', namespace: 'api', name: 'api', status: 'Synced', health: { status: 'Healthy' } },
            ],
          },
        })}'`,
      )

      const all = json((await call(request, admin, 'gitops_status', { cluster: 'self', namespace: 'default', project: 'e2e-shop' })).text)
      expect(all.applications_total).toBeGreaterThanOrEqual(2)
      expect(all.matched).toBe(2)
      expect(all.counts.sync).toMatchObject({ Synced: 1, OutOfSync: 1 })
      expect(all.counts.health).toMatchObject({ Healthy: 1, Degraded: 1 })
      const names = (all.applications as { name: string }[]).map((a) => a.name)
      expect(names).toEqual([bad, ok])
      const badApp = all.applications[0]
      expect(badApp.sync).toEqual({ status: 'OutOfSync', revision: 'fedcba98' })
      expect(badApp.health).toEqual({ status: 'Degraded', message: 'Deployment api has 0/2 replicas' })
      expect(badApp.operation).toMatchObject({ phase: 'Failed', retry_count: 2 })
      expect(badApp.conditions).toEqual([{ type: 'SyncError', message: 'ConfigMap api-config: forbidden' }])
      expect(badApp.resources).toEqual({ total: 2, problems: 1 })
      expect(badApp.problem_resources).toEqual([{ kind: 'Deployment', namespace: 'api', name: 'api', sync: 'OutOfSync', health: 'Degraded', message: '0/2' }])
      expect(badApp.destination).toEqual({ server: 'https://kubernetes.default.svc', namespace: 'api' })
      expect(badApp.automated).toEqual({ prune: true, self_heal: false })
      const okApp = all.applications[1]
      expect(okApp.sync).toEqual({ status: 'Synced', revision: '01234567' })
      expect(okApp.problem_resources).toBeUndefined()
      expect(okApp.source).toEqual({ repo: `https://git.example/${ok}.git`, path: 'deploy', target_revision: 'main' })

      const problems = json((await call(request, admin, 'gitops_status', { cluster: 'self', namespace: 'default', project: 'e2e-shop', only_problems: true })).text)
      expect((problems.applications as { name: string }[]).map((a) => a.name)).toEqual([bad])
      expect(problems.matched).toBe(1)
      expect(problems.counts.sync).toMatchObject({ Synced: 1, OutOfSync: 1 })

      const one = json((await call(request, admin, 'gitops_status', { cluster: 'self', namespace: 'default', name: ok })).text)
      expect(one.applications_total).toBe(1)
      expect(one.applications[0].name).toBe(ok)

      const byDest = json((await call(request, admin, 'gitops_status', { cluster: 'self', namespace: 'default', destination_namespace: 'api' })).text)
      expect((byDest.applications as { name: string }[]).map((a) => a.name)).toContain(bad)
      expect((byDest.applications as { name: string }[]).map((a) => a.name)).not.toContain(ok)

      // A Read user is offered gitops_status (a read tool); the cluster's RBAC decides what it returns.
      userId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const clusters = json((await call(request, reader, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      expect(clusters.find((c) => c.id === 'self')!.tools).toContain('gitops_status')
      const canList = kubectl.answer('auth can-i list applications.argoproj.io -n default --as=check --as-group=kubeast:viewer --as-group=system:authenticated') === 'yes'
      const asReader = json((await call(request, reader, 'gitops_status', { cluster: 'self', namespace: 'default', project: 'e2e-shop' })).text)
      if (canList) {
        expect(asReader.matched).toBe(2)
      } else {
        expect(asReader.status).toBe('forbidden')
      }
    } finally {
      kubectl.ok(`-n default delete applications.argoproj.io ${ok} ${bad} --ignore-not-found`)
      if (!hadCRD) kubectl.ok('delete crd applications.argoproj.io --ignore-not-found')
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
    }
  })

  test('audit_search reads the audit log through auth-service for Admin only, with the same totals as the API', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    // Our own MCP calls are audited as ai.mcp.call; pin the window so the tool and the API count the same rows,
    // and let the window close before the tool call itself is audited.
    await call(request, admin, 'list_clusters', {})
    const until = new Date(Date.now() + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await new Promise((r) => setTimeout(r, 1500))
    // Other specs' temporary users call MCP too, so the actor is part of the filter.
    const found = json((await call(request, admin, 'audit_search', { cluster: 'self', audit_action: 'ai.mcp.call', actor_email: EMAIL, since_time: since, until_time: until, limit: 5 })).text)
    expect(found.cluster).toBe('self')
    expect(found.filter).toMatchObject({ action: 'ai.mcp.call', actor_email: EMAIL, since, until })
    expect(found.returned).toBeGreaterThanOrEqual(1)
    expect(found.returned).toBeLessThanOrEqual(5)
    for (const e of found.entries as Array<Record<string, unknown>>) {
      expect(e.action).toBe('ai.mcp.call')
      expect(e.cluster).toBe('self')
      expect(e.actor).toBe(EMAIL)
      expect(typeof e.at).toBe('string')
      expect(['success', 'failure']).toContain(e.result)
      expect(e).not.toHaveProperty('user_agent')
    }
    const api = await request.get(`/api/v1/auth/admin/audit-logs?action=ai.mcp.call&actor_email=${EMAIL}&cluster=self&since=${since}&until=${until}&limit=1`, { headers: bearer(admin) })
    expect(api.ok()).toBeTruthy()
    expect(found.total).toBe((await api.json()).total)

    const failures = json((await call(request, admin, 'audit_search', { cluster: 'self', result: 'failure', since_time: '7d', limit: 20 })).text)
    for (const e of failures.entries as Array<Record<string, unknown>>) expect(e.result).toBe('failure')
    const everywhere = json((await call(request, admin, 'audit_search', { cluster: 'self', all_clusters: true, since_time: '1h', limit: 3 })).text)
    expect(everywhere.cluster).toBe('all')
    expect(everywhere.total).toBeGreaterThanOrEqual(found.total)

    // Reading the audit log is itself audited; that entry is Kubeast-wide (no cluster), so a cluster-filtered
    // search finds nothing and says why, and all_clusters finds it.
    const scoped = json((await call(request, admin, 'audit_search', { cluster: 'self', audit_action: 'admin.audit.read', since_time: '10m', limit: 3 })).text)
    expect(scoped.returned).toBe(0)
    expect(scoped.hint).toMatch(/all_clusters=true/)
    const meta = json((await call(request, admin, 'audit_search', { cluster: 'self', audit_action: 'admin.audit.read', actor_email: EMAIL, since_time: '10m', limit: 3, all_clusters: true })).text)
    expect(meta.returned).toBeGreaterThanOrEqual(1)
    expect(meta.entries[0].action).toBe('admin.audit.read')

    const email = `e2e-tools5-a-${stamp()}@kubeast.local`
    let userId = ''
    try {
      userId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const clusters = json((await call(request, reader, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      const tools = clusters.find((c) => c.id === 'self')!.tools
      expect(tools).not.toContain('audit_search')
      expect(tools).not.toContain('nodes_stats_summary')
      expect(tools).not.toContain('nodes_log')
      expect(tools).toContain('gitops_status')
      const refused = await call(request, reader, 'audit_search', { cluster: 'self', since_time: '1h' })
      expect(refused.isError).toBe(true)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
    }
  })

  test('nodes_stats_summary and nodes_log read the kubelet through the API server proxy as the admin', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const nodes = kubectl.run("get nodes -o jsonpath='{.items[*].metadata.name}'").replace(/'/g, '').split(/\s+/).filter(Boolean)
    const node = nodes[0]
    const podsOnNode = kubectl.run(`get pods -A --field-selector spec.nodeName=${node},status.phase=Running -o name`).split('\n').filter(Boolean).length

    const one = json((await call(request, admin, 'nodes_stats_summary', { cluster: 'self', node, top: 3 })).text)
    expect(one.node).toBe(node)
    expect(one.cpu_cores).toBeGreaterThanOrEqual(0)
    expect(one.memory_mib.working_set).toBeGreaterThan(0)
    expect(one.memory_mib.available).toBeGreaterThan(0)
    expect(one.fs.capacity_gib).toBeGreaterThan(0)
    expect(one.system_containers.kubelet.memory_working_set_mib).toBeGreaterThan(0)
    expect(one.pods_total).toBeGreaterThanOrEqual(1)
    expect(one.pods_total).toBeLessThanOrEqual(podsOnNode)
    expect(one.ranked_by).toBe('memory')
    const top = one.pods_top as Array<{ namespace: string; name: string; memory_working_set_mib: number }>
    expect(top.length).toBe(3)
    expect(top[0].memory_working_set_mib).toBeGreaterThanOrEqual(top[1].memory_working_set_mib)
    expect(top[1].memory_working_set_mib).toBeGreaterThanOrEqual(top[2].memory_working_set_mib)
    for (const p of top) expect(kubectl.ok(`-n ${p.namespace} get pod ${p.name}`)).toBe(true)

    const byCpu = json((await call(request, admin, 'nodes_stats_summary', { cluster: 'self', node, top: 2, rank_by: 'cpu' })).text)
    const cpu = byCpu.pods_top as Array<{ cpu_cores: number }>
    expect(cpu.length).toBe(2)
    expect(cpu[0].cpu_cores).toBeGreaterThanOrEqual(cpu[1].cpu_cores)

    const all = json((await call(request, admin, 'nodes_stats_summary', { cluster: 'self' })).text)
    expect(all.nodes_total).toBe(nodes.length)
    expect((all.nodes as Array<{ node: string }>).map((n) => n.node).sort()).toEqual([...nodes].sort())
    expect(all.nodes[0].pods_top).toBeUndefined()

    const missing = json((await call(request, admin, 'nodes_stats_summary', { cluster: 'self', node: 'e2e-no-such-node' })).text)
    expect(missing.status).toBe('not_found')

    // The kubelet decides whether log queries are answered.
    const configz = JSON.parse(kubectl.run(`get --raw /api/v1/nodes/${node}/proxy/configz`)).kubeletconfig
    const log = json((await call(request, admin, 'nodes_log', { cluster: 'self', node, source: 'kubelet', tail_lines: 20 })).text)
    if (configz.enableSystemLogQuery) {
      expect(log.node).toBe(node)
      expect(log.lines_returned).toBeGreaterThanOrEqual(1)
      expect(log.lines_returned).toBeLessThanOrEqual(20)
    } else {
      expect(log).toMatchObject({ status: 'unavailable', feature: 'nodes_log' })
      expect(log.reason).toMatch(/enableSystemLogQuery/)
      expect(log.reason).toContain(node)
    }
    const noNode = await call(request, admin, 'nodes_log', { cluster: 'self' })
    expect(noNode.isError).toBe(true)
  })
})
