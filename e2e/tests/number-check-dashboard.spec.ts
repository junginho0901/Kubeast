import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Number check of the dashboard's count cards on self: each count is what the user's own identity in the cluster
// lists, as kubectl as that identity — a custom role whose group the cluster lets list namespaces and services only
// sees those two counted, and the others as not counted ("—", named in the API's "refused"), not the cache's numbers.

const DASHBOARD = { path: '/', cluster: 'self' }
const CLUSTER = DASHBOARD.cluster
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-dash-refused-pass1!'
const stamp = Date.now().toString(36)
const ROLE = `e2e-dash-${stamp}`
const GROUP = `kubeast:role:${ROLE}`
const EMAIL = `e2e-dash-${stamp}@example.com`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-dashboard-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const asUser = `--as=${EMAIL} --as-group=kubeast:authenticated --as-group=${GROUP}`

// the overview's counts, the card each is on ("" = none) and the list kubectl makes for it
const KINDS = [
  { card: 'pods', key: 'total_pods', resource: 'pods', namespaced: true },
  { card: 'services', key: 'total_services', resource: 'services', namespaced: true },
  { card: 'deployments', key: 'total_deployments', resource: 'deployments.apps', namespaced: true },
  { card: 'pvcs', key: 'total_pvcs', resource: 'persistentvolumeclaims', namespaced: true },
  { card: '', key: 'total_pvs', resource: 'persistentvolumes', namespaced: false },
  { card: 'nodes', key: 'node_count', resource: 'nodes', namespaced: false },
]

// what kubectl as the user's identity may list, and how many it lists
function asTheUser(resource: string, namespaced: boolean): number | null {
  const all = namespaced ? ' -A' : ''
  let can = ''
  try {
    can = kubectl(`auth can-i list ${resource}${all} ${asUser}`)
  } catch {
    can = 'no'
  }
  if (can !== 'yes') return null
  const out = kubectl(`get ${resource}${all} ${asUser} -o name`)
  return out ? out.split('\n').length : 0
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Number check — dashboard counts as the user may list them', () => {
  let admin = ''
  let roleId = 0
  let userId = 0

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: ROLE, description: 'e2e', permissions: ['menu.dashboard', 'resource.*.read'] } })
    expect(role.status(), await role.text()).toBe(201)
    roleId = (await role.json()).id
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = ((Array.isArray(roles) ? roles : roles.items || []) as Array<{ id: number; name: string }>).find((r) => r.name.toLowerCase() === 'member')!.id
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E dashboard', email: EMAIL, password: PW, role_id: member } })
    expect(created.status(), await created.text()).toBe(201)
    userId = (await created.json()).id
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: ROLE } })
    expect(grant.ok(), await grant.text()).toBeTruthy()
    // the cluster side: Kubeast may act as the role's group, and the group may list namespaces and services only
    kubectl(`create clusterrole ${ROLE}-imp --verb=impersonate --resource=groups --resource-name=${GROUP}`)
    kubectl(`create clusterrolebinding ${ROLE}-imp --clusterrole=${ROLE}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
    kubectl(`create clusterrole ${ROLE}-list --verb=list,get --resource=namespaces,services`)
    kubectl(`create clusterrolebinding ${ROLE}-list --clusterrole=${ROLE}-list --group=${GROUP}`)
  })

  test.afterAll(async ({ request }) => {
    for (const o of [`clusterrolebinding/${ROLE}-imp`, `clusterrole/${ROLE}-imp`, `clusterrolebinding/${ROLE}-list`, `clusterrole/${ROLE}-list`]) kubectl(`delete ${o} --ignore-not-found`)
    if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a count the identity may not list is not counted; the others are what it lists', async ({ page, request }) => {
    test.setTimeout(180_000)
    const user = await login(request, EMAIL, PW)
    const overview = async () => {
      const res = await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: bearer(user), failOnStatusCode: false })
      return { status: res.status(), body: res.ok() ? await res.json() : null }
    }
    // the bindings take a moment, and the identity's answers are kept 60 s
    await expect.poll(async () => (await overview()).status, { timeout: 90_000, intervals: [3_000] }).toBe(200)

    const want: Record<string, number | null> = { total_namespaces: asTheUser('namespaces', false) }
    for (const k of KINDS) want[k.key] = asTheUser(k.resource, k.namespaced)
    expect(want.total_namespaces, 'the identity lists namespaces').not.toBeNull()
    expect(want.total_services, 'the identity lists services').not.toBeNull()
    expect(want.total_pods, 'the identity may not list pods').toBeNull()

    await expect(async () => {
      const ov = (await overview()).body
      const got: Record<string, number | null> = {}
      for (const k of Object.keys(want)) got[k] = ov[k] ?? null
      expect.soft(got, 'the counts, as kubectl as the identity lists').toEqual(want)
      expect.soft([...(ov.refused ?? [])].sort(), 'refused').toEqual(KINDS.filter((k) => want[k.key] === null).map((k) => k.resource.replace('.apps', '')).sort())
      expect.soft(ov.pod_status ?? null, 'no pod phases without the pods').toBeNull()
    }).toPass({ timeout: 30_000, intervals: [3_000] })

    // the screen: the identity's counts, and "—" with the reason for the others
    await page.context().clearCookies()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(EMAIL)
    await page.locator('input[type="password"]').first().fill(PW)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
    await page.goto(`${DASHBOARD.path}?cluster=${CLUSTER}`)
    await expect(page.getByTestId('stat-value-namespaces')).toHaveText(String(want.total_namespaces), { timeout: 30_000 })
    for (const k of KINDS.filter((x) => x.card)) {
      const n = want[k.key]
      await expect.soft(page.getByTestId(`stat-value-${k.card}`), `${k.card} card`).toHaveText(n === null ? '—' : String(n))
      if (n === null) await expect.soft(page.getByTestId(`stat-${k.card}`), `${k.card} card says why`).toHaveAttribute('title', /may not list|목록을 볼 수 없어/)
    }
  })
})
