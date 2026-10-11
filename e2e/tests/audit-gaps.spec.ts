import { test, expect, type APIRequestContext } from '@playwright/test'

// Audit rows that used to be missing or mislabelled, checked against the audit
// log itself: a live log stream is a recorded sensitive read, a refused sign-in
// is a failure, and a refused write (not a refused read) is recorded.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'

type Headers = Record<string, string>
type Row = { Action: string; Result: string; Error: string; TargetID: string; ActorEmail: string; Cluster: string; After: Record<string, any> | null }

async function login(request: APIRequestContext, email: string, password: string): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

async function rows(request: APIRequestContext, admin: Headers, params: Record<string, string>): Promise<Row[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: admin, params: { cluster: '', limit: '100', ...params } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

test.describe('audit gaps', () => {
  test('a live log stream is recorded once as a sensitive read', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pods = await (await request.get(`/api/v1/cluster/namespaces/kubeast/pods?cluster=${CLUSTER}`, { headers: admin })).json()
    const pod = ((Array.isArray(pods) ? pods : pods.items || []) as Array<{ name: string }>).map((p) => p.name).find((n) => n.startsWith('gateway-'))
    expect(pod, 'a gateway pod').toBeTruthy()
    const since = new Date(Date.now() - 2000).toISOString()

    await page.goto('/')
    const lines = await page.evaluate(
      (url) =>
        new Promise<number>((resolve) => {
          let n = 0
          const es = new EventSource(url, { withCredentials: true })
          es.onmessage = () => { n++; if (n >= 1) { es.close(); resolve(n) } }
          es.onerror = () => { es.close(); resolve(n) }
          setTimeout(() => { es.close(); resolve(n) }, 15_000)
        }),
      `/api/v1/cluster/namespaces/kubeast/pods/${pod}/logs/stream?container=gateway&tail_lines=5&cluster=${CLUSTER}`,
    )
    expect(lines, 'the stream sent a line').toBeGreaterThan(0)

    await expect
      .poll(async () => (await rows(request, admin, { action: 'k8s.pod.logs.read', since })).filter((r) => r.TargetID === pod && r.After?.follow === true).length, { timeout: 15_000 })
      .toBe(1)
  })

  test('a refused sign-in is a failure row', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const since = new Date(Date.now() - 2000).toISOString()
    const email = `e2e-no-such-user-${Date.now()}@kubeast.local`
    const res = await request.post('/api/v1/auth/login', { data: { email, password: 'wrong' }, failOnStatusCode: false })
    expect(res.status()).toBe(401)
    const failed = (await rows(request, admin, { action: 'user.login.failed', result: 'failure', since })).filter((r) => r.After?.reason === 'user_not_found')
    expect(failed.length, 'found by the failure filter').toBeGreaterThanOrEqual(1)
    expect(failed[0].Error).toBe('user_not_found')
    expect(failed[0].Cluster, 'a sign-in names no cluster').toBe('')
  })

  test('a refused write is recorded, a refused read is not', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
    const roleId = (name: string) => ((Array.isArray(roles) ? roles : roles.items) as Array<{ id: number; name: string }>).find((r) => r.name === name)!.id
    const ts = Date.now()
    const users: string[] = []
    const make = async (email: string, clusterRole?: string) => {
      const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E audit gaps', email, password: 'e2e-audit-gaps-throwaway', role_id: roleId('Member') } })
      expect(created.status(), await created.text()).toBe(201)
      const id = (await created.json()).id as string
      users.push(id)
      if (clusterRole) await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${CLUSTER}`, { headers: admin, data: { role: clusterRole } })
      return login(request, email, 'e2e-audit-gaps-throwaway')
    }
    try {
      const since = new Date(Date.now() - 2000).toISOString()
      const readerEmail = `e2e-audit-reader-${ts}@kubeast.local`
      const memberEmail = `e2e-audit-member-${ts}@kubeast.local`
      const reader = await make(readerEmail, 'Read')
      const member = await make(memberEmail)

      // Read: an app-level refusal of a delete.
      const del = await request.delete(`/api/v1/cluster/namespaces/default/configmaps/e2e-no-such-${ts}?cluster=${CLUSTER}`, { headers: reader, failOnStatusCode: false })
      expect(del.status()).toBe(403)
      // Member without a grant: a read and a write refused at the cluster gate.
      expect((await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: member, failOnStatusCode: false })).status()).toBe(403)
      const post = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: member, data: { yaml: 'kind: ConfigMap\n' }, failOnStatusCode: false })
      expect(post.status()).toBe(403)

      const denied = await rows(request, admin, { action: 'k8s.access.denied', since })
      const byReader = denied.filter((r) => r.ActorEmail === readerEmail)
      const byMember = denied.filter((r) => r.ActorEmail === memberEmail)
      expect(byReader.map((r) => r.TargetID), 'the reader\'s delete').toEqual(['resource.configmap.delete'])
      expect(byReader[0].Result).toBe('failure')
      expect(byMember.map((r) => r.After?.method), 'only the member\'s write').toEqual(['POST'])
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  // The auth-service side of #61 B: a refused admin API call, an admin's own
  // role change, an access request on a cluster without a grant and a wrong
  // current password are failure rows (they left no row).
  test('auth-service refusals are failure rows', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
    const memberRole = ((Array.isArray(roles) ? roles : roles.items) as Array<{ id: number; name: string }>).find((r) => r.name === 'Member')!.id
    const ts = Date.now()
    const email = `e2e-audit-auth-${ts}@kubeast.local`
    const password = 'e2e-audit-auth-throwaway'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E audit auth', email, password, role_id: memberRole } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id as string
    try {
      const since = new Date(Date.now() - 2000).toISOString()
      const member = await login(request, email, password)

      // a member asks an admin endpoint
      expect((await request.get('/api/v1/auth/admin/users', { headers: member, failOnStatusCode: false })).status()).toBe(403)
      // the admin tries to change their own role (refused before any change)
      const me = await (await request.get('/api/v1/auth/me', { headers: admin })).json()
      const self = await request.patch(`/api/v1/auth/admin/users/${me.id}`, { headers: admin, data: { role_id: memberRole }, failOnStatusCode: false })
      expect(self.status()).toBe(403)
      // a wrong current password
      const pw = await request.post('/api/v1/auth/change-password', { headers: member, data: { current_password: 'not-the-password', new_password: 'e2e-audit-auth-new-1' }, failOnStatusCode: false })
      expect(pw.status()).toBe(401)
      // an access request on a cluster the member holds nothing on (when the feature is on)
      const arCfg = await (await request.get('/api/v1/auth/access-requests/config', { headers: member })).json()
      if (arCfg.enabled) {
        const ar = await request.post('/api/v1/auth/access-requests', {
          headers: member, data: { cluster_id: CLUSTER, role: arCfg.roles[0], duration_minutes: 30, reason: 'e2e: no grant' }, failOnStatusCode: false,
        })
        expect(ar.status()).toBe(403)
      }

      await expect
        .poll(async () => (await rows(request, admin, { action: 'admin.access.denied', since })).filter((r) => r.ActorEmail === email).map((r) => `${r.Result} ${r.TargetID} ${r.After?.method} ${r.After?.path}`), { timeout: 10_000 })
        .toEqual(['failure admin.users.read GET /api/v1/auth/admin/users'])
      const own = (await rows(request, admin, { action: 'user.role.update', result: 'failure', since })).filter((r) => r.TargetID === me.id)
      expect(own.map((r) => r.Error), 'the own role change').toEqual(['cannot change your own role'])
      const pwRows = (await rows(request, admin, { action: 'user.password.change', since })).filter((r) => r.TargetID === userId)
      expect(pwRows.map((r) => `${r.Result} ${r.Error}`), 'the wrong current password').toEqual(['failure password_mismatch'])
      if (arCfg.enabled) {
        const arRows = (await rows(request, admin, { action: 'access.request.create', since })).filter((r) => r.TargetID === userId)
        expect(arRows.map((r) => `${r.Result} ${r.Error} ${r.Cluster}`), 'the request without a grant').toEqual([`failure no grant on the cluster ${CLUSTER}`])
      }
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
