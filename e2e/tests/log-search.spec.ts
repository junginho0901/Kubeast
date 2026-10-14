import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Log search (features.logSearch) against the kind setup of scripts/kind-logsearch.sh: one Loki in the
// second cluster, a collector per cluster. A Job prints a unique line; the search finds it by text and by
// the Job's pods, not on the other cluster, and still after the Job and its pods are gone. A grant limited
// to namespaces searches its namespace only. Skipped while log search is off for cluster self.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-logsearch-pass1!'
const CLUSTER = 'self'
const OTHER = 'default'
const NS = 'default'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type Line = { ts: string; namespace: string; pod: string; container: string; line: string }

function kubectl(args: string): string {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-logsearch-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const tryKubectl = (args: string) => { try { return kubectl(args) } catch { return null } }

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function search(request: APIRequestContext, token: string, cluster: string, query: string): Promise<Line[]> {
  const res = await request.get(`/api/v1/namespaces/${NS}/logsearch?cluster=${cluster}&${query}`, { headers: bearer(token) })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).lines
}

test.describe('log search', () => {
  let admin = ''

  test.beforeEach(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.logSearch?.clusters?.includes(CLUSTER), 'log search is off for cluster self — run scripts/kind-logsearch.sh up')
  })

  test('finds a Job by text and by its pods, not on another cluster, and after the Job is gone', async ({ request }) => {
    test.setTimeout(180_000)
    const job = `e2e-logsearch-${Date.now().toString(36)}`
    const marker = `${job}-marker`
    const yaml = [
      'apiVersion: batch/v1',
      'kind: Job',
      `metadata: {name: ${job}, namespace: ${NS}}`,
      'spec:',
      '  backoffLimit: 0',
      '  template:',
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: say',
      '          image: docker.io/library/busybox:1.38.0',
      `          command: [sh, -c, "echo ${marker} one; echo ${marker} TWO"]`,
    ].join('\n')
    const headers = bearer(admin)
    try {
      const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers, data: { yaml, namespace: NS } })
      expect(create.ok(), await create.text()).toBeTruthy()

      // The collector ships within seconds; Loki answers once the lines are flushed to it.
      await expect.poll(async () => (await search(request, admin, CLUSTER, `q=${marker}`)).length, { timeout: 120_000, intervals: [3000] }).toBe(2)

      const byJob = await search(request, admin, CLUSTER, `workload_kind=Job&workload_name=${job}`)
      expect(byJob.map((l) => l.line).sort()).toEqual([`${marker} TWO`, `${marker} one`])
      expect(byJob[0].container).toBe('say')
      expect(byJob[0].namespace).toBe(NS)
      expect(byJob[0].pod).toMatch(new RegExp(`^${job}-[a-z0-9]{5}$`))
      expect(Date.parse(byJob[0].ts)).toBeGreaterThanOrEqual(Date.parse(byJob[1].ts))

      expect((await search(request, admin, CLUSTER, `q=${marker}%20two&ignore_case=true`)).map((l) => l.line)).toEqual([`${marker} TWO`])
      expect(await search(request, admin, OTHER, `q=${marker}`)).toEqual([])

      const del = await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers })
      expect(del.ok(), await del.text()).toBeTruthy()
      await expect.poll(async () => {
        const pods = await (await request.get(`/api/v1/namespaces/${NS}/pods?cluster=${CLUSTER}`, { headers })).json()
        return (pods as { name: string }[]).filter((p) => p.name.startsWith(`${job}-`)).length
      }, { timeout: 60_000 }).toBe(0)
      expect((await search(request, admin, CLUSTER, `q=${marker}`)).length).toBe(2)

      // One audit row per search, with the filters and the count, not the lines.
      const rows = (await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.pod.logs.search&limit=20', { headers })).json()).items as any[]
      const mine = rows.find((r) => JSON.stringify(r.After ?? r.after ?? {}).includes(`"workload":"Job/${job}"`))
      expect(mine?.Result ?? mine?.result).toBe('success')
      expect((mine?.After ?? mine?.after)?.lines).toBe(2)
      expect(JSON.stringify(mine)).not.toContain(`${marker} TWO`)
    } finally {
      await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers, failOnStatusCode: false })
    }
  })

  // The cluster decides (get pods/log as the user): the scoped Read group is bound by hand here, the way the
  // chart's per-namespace bindings would do it, and removed at the end.
  test('a grant limited to namespaces searches where the cluster lets it, not every namespace', async ({ request }) => {
    const id = Date.now().toString(36)
    const email = `e2e-logsearch-${id}@kubeast.local`
    const ns = `e2e-logsearch-${id}`
    const rbac = `e2e-logsearch-${id}`
    let userId = ''
    try {
      kubectl(`create namespace ${ns}`)
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E log search', email, password: PW, role_id: member.id } })
      expect(created.status()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [ns] } })
      expect(grant.ok(), await grant.text()).toBeTruthy()
      const user = await login(request, email, PW)
      const own = () => request.get(`/api/v1/namespaces/${ns}/logsearch?cluster=${CLUSTER}&since=5m`, { headers: bearer(user) })

      const unbound = await own()
      expect(unbound.status()).toBe(403)
      expect(await unbound.text()).toMatch(/impersonate|does not let you read pod logs/)

      kubectl(`create clusterrole ${rbac}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:read`)
      kubectl(`create clusterrolebinding ${rbac}-imp --clusterrole=${rbac}-imp --serviceaccount=kubeast:k8s-service`)
      kubectl(`-n ${ns} create rolebinding ${rbac}-view --clusterrole=view --group=kubeast:role:read`)
      await expect.poll(async () => (await own()).status(), { timeout: 20_000 }).toBe(200)

      const every = await request.get(`/api/v1/cluster/logsearch?cluster=${CLUSTER}&since=5m`, { headers: bearer(user) })
      expect(every.status()).toBe(403)
      expect(await every.text()).toContain('limited to namespaces')
      expect((await request.get(`/api/v1/namespaces/kube-system/logsearch?cluster=${CLUSTER}&since=5m`, { headers: bearer(user) })).status()).toBe(403)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete clusterrolebinding ${rbac}-imp`)
      tryKubectl(`delete clusterrole ${rbac}-imp`)
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })
})
