import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A Service's backends come from its EndpointSlices, not the deprecated Endpoints API: the Service describe, the
// connectivity check, the namespace resource graph and the AI service check all agree with
// `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`, and none of them bumps the API server's
// apiserver_requested_deprecated_apis counter for v1/endpoints.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const stamp = Date.now().toString(36)
const NS = `e2e-eps-${stamp}`
const READER = `e2e-eps-reader-${stamp}@example.com`
const PW = 'E2e-eps-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-eps-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const run = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
  const apply = (manifest: object) => {
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify(manifest))
    return run(`apply -f ${file}`)
  }
  return { run, apply }
}
const { run: kubectl, apply: kubectlApply } = kubectlFor('kubeast')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// The API server counts every request to the deprecated Endpoints API (the metrics page is several MB; only the
// deprecated-API lines come back through grep).
function deprecatedEndpointsRequests(): number {
  const lines = kubectl(`get --raw /metrics | grep '^apiserver_requested_deprecated_apis' || true`).split('\n')
  const line = lines.find((l) => l.includes('resource="endpoints"'))
  return line ? Number(line.trim().split(/\s+/).pop()) : 0
}

// The slices' addresses as kubectl sees them, split by the ready condition (unset reads as ready).
function sliceAddresses(): { ready: string[]; notReady: string[] } {
  const list = JSON.parse(kubectl(`get endpointslices -n ${NS} -l kubernetes.io/service-name=web -o json`))
  const ready: string[] = []
  const notReady: string[] = []
  for (const slice of list.items ?? []) for (const e of slice.endpoints ?? []) (e.conditions?.ready === false ? notReady : ready).push(...(e.addresses ?? []))
  return { ready: ready.sort(), notReady: notReady.sort() }
}

test.describe('service backends from EndpointSlices', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let readerId = ''
  let before = 0

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    const fixture = JSON.parse(kubectl('get deploy e2e-argo-managed -n default -o json')).spec.template.spec.containers[0]
    kubectl(`create namespace ${NS}`)
    kubectlApply({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: NS },
      spec: {
        replicas: 2, selector: { matchLabels: { app: 'web' } },
        template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'app', image: fixture.image, imagePullPolicy: fixture.imagePullPolicy, command: fixture.command, args: fixture.args, ports: [{ containerPort: 8080 }] }] } },
      },
    })
    kubectlApply({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: NS }, spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }] } })
    kubectl(`wait --for=condition=Ready pod -l app=web -n ${NS} --timeout=120s`)
    await expect.poll(() => sliceAddresses().ready.length, { timeout: 30000 }).toBe(2)
    before = deprecatedEndpointsRequests()
  })

  test.afterAll(async ({ request }) => {
    try {
      kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    } catch {
      // never created
    }
    if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('the Service describe and the connectivity check count the ready addresses the slices hold', async ({ request }) => {
    const expected = sliceAddresses()
    const describe = await (await request.get(`/api/v1/cluster/namespaces/${NS}/services/web/describe?cluster=self`, { headers: bearer(admin) })).json()
    expect(describe.endpoint_summary.ready_count).toBe(expected.ready.length)
    expect(describe.endpoint_summary.not_ready_count).toBe(expected.notReady.length)
    expect([...describe.endpoint_summary.ready_addresses].sort()).toEqual(expected.ready)
    const listed = (describe.endpoints as { ip: string; ready: boolean; target_ref?: { kind: string }; ports: { port: number }[] }[])
    expect(listed.map((e) => e.ip).sort()).toEqual(expected.ready)
    expect(listed.every((e) => e.ready && e.target_ref?.kind === 'Pod' && e.ports[0]?.port === 8080)).toBe(true)
    expect(describe.endpoint_slices.length).toBeGreaterThanOrEqual(1)

    const conn = await (await request.get(`/api/v1/cluster/namespaces/${NS}/services/web/connectivity?cluster=self`, { headers: bearer(admin) })).json()
    expect(conn.has_endpoints).toBe(true)
    expect(conn.ready_endpoints).toBe(expected.ready.length)
    expect(['ok', 'tcp_failed']).toContain(conn.connectivity)
  })

  test('the namespace resource graph links the EndpointSlice to the Service and has no Endpoints node', async ({ request }) => {
    const body = await (await request.get(`/api/v1/cluster/namespaces/${NS}/resource-graph?cluster=self`, { headers: bearer(admin) })).json()
    const nodes = (body.nodes ?? body.graph?.nodes ?? []) as { id: string; kind: string; name: string }[]
    const edges = (body.edges ?? body.graph?.edges ?? []) as { source: string; target: string }[]
    const slice = nodes.find((n) => n.kind === 'EndpointSlice')
    const svc = nodes.find((n) => n.kind === 'Service' && n.name === 'web')
    expect(slice, 'an EndpointSlice node').toBeTruthy()
    expect(svc, 'the Service node').toBeTruthy()
    expect(edges.some((e) => e.source === slice!.id && e.target === svc!.id), 'EndpointSlice → Service edge').toBe(true)
    expect(nodes.filter((n) => n.kind === 'Endpoints')).toEqual([])
  })

  test('the AI service check reports the same ready count through MCP', async ({ request }) => {
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!config.ok() || !(await config.json()).enabled, 'the MCP server is off (mcp.enabled)')
    // The agent acts under a user's key, and the tools follow that user's cluster grant: the service check is a read
    // tool, so a Member with Read on self and a Read-ceiling key is enough.
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E eps', email: READER, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    readerId = (await created.json()).id
    expect((await request.put(`/api/v1/auth/admin/users/${readerId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
    const reader = await login(request, READER, PW)
    const keyRes = await request.post('/api/v1/auth/api-keys', { headers: bearer(reader), data: { name: 'e2e eps', expires_in_days: 1, cluster_ids: ['self'], role_ceiling: 'Read' } })
    expect(keyRes.status(), await keyRes.text()).toBe(201)
    const key = await keyRes.json()
    const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${key.key}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'k8s_check_service_connectivity', arguments: { cluster: 'self', namespace: NS, service_name: 'web' } } }, failOnStatusCode: false })
    const result = (await res.json()).result
    expect(result.isError, result.content?.[0]?.text).toBeFalsy()
    const report = JSON.parse(result.content[0].text)
    const expected = sliceAddresses()
    expect(report.endpoints).toEqual({ ready: expected.ready.length, not_ready: expected.notReady.length, total: expected.ready.length + expected.notReady.length })
    expect(report.status).toBe('Ready')
  })

  test('none of it touched the deprecated Endpoints API', async () => {
    expect(deprecatedEndpointsRequests()).toBe(before)
  })
})
