import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// D6: the Read group (kubeast:viewer) may GET the cluster's Prometheus and OpenCost through the API server proxy and
// nothing else. The dev second cluster lists monitoring/prometheus:9090 and opencost/opencost:9003 in
// auth.impersonation.viewerProxyServices (scripts/add-kind-cluster.sh --addons renders
// templates/impersonation-viewer-proxy.yaml). Checked twice: through Kubeast as a Read user, and against the cluster
// itself impersonating the groups. Throwaway user removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-vproxy-throwaway-1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-vproxy-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  // Runs as the given groups; resolves to 'allowed' or the API server's refusal reason.
  const as = (groups: string[], args: string, stdin?: string): string => {
    const asFlags = ['--as=e2e-vproxy@kubeast.local', ...groups.map((g) => `--as-group=${g}`), '--as-group=system:authenticated'].join(' ')
    try {
      execSync(`kubectl --kubeconfig ${kcPath} ${asFlags} ${args}`, { encoding: 'utf8', input: stdin, stdio: ['pipe', 'pipe', 'pipe'] })
      return 'allowed'
    } catch (e) {
      const err = String((e as { stderr?: string }).stderr || e)
      return /Forbidden/.test(err) ? 'forbidden' : `error: ${err.slice(0, 200)}`
    }
  }
  return { as }
}
const { as } = kubectlFor('kubeast-b')
const VIEWER = ['kubeast:viewer']
const proxy = (ns: string, svc: string, suffix: string) => `/api/v1/namespaces/${ns}/services/${svc}/proxy${suffix}`

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Read reaches the listed Prometheus and OpenCost through the proxy, read-only', () => {
  test('the cluster lets the Read group GET only the listed Services, not POST, and not the namespace-scoped group', () => {
    expect(as(VIEWER, `get --raw "${proxy('monitoring', 'prometheus:9090', '/-/healthy')}"`)).toBe('allowed')
    expect(as(VIEWER, `get --raw "${proxy('monitoring', 'prometheus:9090', '/api/v1/query?query=up')}"`)).toBe('allowed')
    expect(as(VIEWER, `get --raw "${proxy('opencost', 'opencost:9003', '/healthz')}"`)).toBe('allowed')
    // Not listed: another Service in kube-system, another in the same namespace, the same Prometheus named another way.
    expect(as(VIEWER, `get --raw "${proxy('kube-system', 'kube-dns:53', '/')}"`)).toBe('forbidden')
    expect(as(VIEWER, `get --raw "${proxy('monitoring', 'prometheus-auth:30091', '/')}"`)).toBe('forbidden')
    expect(as(VIEWER, `get --raw "${proxy('monitoring', 'https:prometheus:9090', '/-/healthy')}"`)).toBe('forbidden')
    // Prometheus's admin API is POST: get only, so refused.
    expect(as(VIEWER, `create --raw "${proxy('monitoring', 'prometheus:9090', '/api/v1/admin/tsdb/snapshot')}" -f -`, '{}')).toBe('forbidden')
    // A namespace-scoped Read acts as kubeast:role:read, which the Role does not bind (Prometheus holds every namespace).
    expect(as(['kubeast:role:read'], `get --raw "${proxy('monitoring', 'prometheus:9090', '/-/healthy')}"`)).toBe('forbidden')
  })

  test('through Kubeast a Read user gets the cost table, the optimization usage and a Prometheus query; a scoped Read does not', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-vproxy-${Date.now().toString(36)}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E viewer proxy', email, password: PW, role_id: member.id } })
    expect(created.status()).toBe(201)
    const userId = (await created.json()).id as string
    try {
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
      const reader = await login(request, email, PW)

      const cost = await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=namespace', { headers: bearer(reader) })
      expect(cost.status()).toBe(200)
      expect((await cost.json()).rows.map((r: { name: string }) => r.name)).toContain('kube-system')

      const opt = await request.get('/api/v1/cluster/optimization?cluster=default&namespace=kube-system', { headers: bearer(reader) })
      expect(opt.status()).toBe(200)
      const optBody = await opt.json()
      expect(optBody.source).toBe('prometheus')
      expect(optBody.rows.some((r: { cpu_usage_m?: number }) => typeof r.cpu_usage_m === 'number')).toBeTruthy()

      // A refused proxy call surfaces as an error status; an answer carries the series.
      const q = await request.get('/api/v1/cluster/prometheus/query?cluster=default&query=up', { headers: bearer(reader) })
      expect(q.status()).toBe(200)
      const qBody = await q.json()
      expect(qBody.available).toBe(true)
      expect(qBody.results.length).toBeGreaterThan(0)

      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['kube-system'] } })).ok()).toBeTruthy()
      const scoped = await login(request, email, PW)
      const scopedCost = await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=namespace', { headers: bearer(scoped), failOnStatusCode: false })
      expect(scopedCost.status()).toBe(403)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
