import { test, expect, type APIRequestContext } from '@playwright/test'

// Multi-cluster cluster CRUD API — step 07.
//
// Codifies the register → list → test → delete flow plus validate-rejection,
// deployment-mode, and the cluster-switch audit endpoint. The cluster
// management *UI* arrives in step 11; this spec is API-level so the later JWT /
// per-cluster-RBAC changes (steps 06/08) regress against the contract here.
//
// auth-service's middleware is Authorization-header only (no cookie fallback),
// so we log in via the API and pass an explicit Bearer token rather than
// relying on the shared storageState cookie.
//
// The spec registers and deletes a throwaway "self" cluster; it is self-
// cleaning (beforeAll + afterAll best-effort delete). Like the rest of the
// suite it runs serially (workers: 1) against the live kind gateway.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

const TEST_DISPLAY_NAME = 'E2E Self Probe'
const TEST_ID = 'e2e-self-probe' // Slugify(TEST_DISPLAY_NAME)

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  })
  expect(
    res.ok(),
    'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD',
  ).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('multi-cluster — cluster CRUD API (step 07)', () => {
  let token = ''
  let auth: Record<string, string>

  test.beforeAll(async ({ request }) => {
    token = await login(request)
    auth = { Authorization: `Bearer ${token}` }
    // Remove any leftover from a previously aborted run.
    await request.delete(`/api/v1/clusters/${TEST_ID}`, {
      headers: auth,
      failOnStatusCode: false,
    })
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v1/clusters/${TEST_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    })
  })

  test('GET /clusters — 401 without a token', async ({ request }) => {
    const res = await request.get('/api/v1/clusters', { failOnStatusCode: false })
    expect(res.status()).toBe(401)
  })

  test('GET /clusters — admin sees a non-empty registry', async ({ request }) => {
    const res = await request.get('/api/v1/clusters', { headers: auth })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.items)).toBeTruthy()
    // The verification cluster (registered via Setup) should be present once the
    // app is configured. Don't pin the id in case it was renamed — just expect
    // the registry to be non-empty.
    expect(body.items.length).toBeGreaterThan(0)
  })

  test('GET /system/deployment-mode — k8s | docker', async ({ request }) => {
    const res = await request.get('/api/v1/system/deployment-mode', { headers: auth })
    expect(res.status()).toBe(200)
    expect(['k8s', 'docker']).toContain((await res.json()).mode)
  })

  test('POST /clusters/validate — bad kubeconfig rejected (400)', async ({ request }) => {
    const res = await request.post('/api/v1/clusters/validate', {
      headers: auth,
      data: { mode: 'external', kubeconfig: 'not valid yaml ::: [' },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(400)
  })

  test('register → list → test → delete (self cluster, rollout-free)', async ({ request }) => {
    // register: a self cluster uses the in-cluster ServiceAccount (valid on kind)
    const reg = await request.post('/api/v1/clusters', {
      headers: auth,
      data: { mode: 'self', display_name: TEST_DISPLAY_NAME },
      failOnStatusCode: false,
    })
    expect(reg.status(), 'self registration should 201 on an in-cluster deploy').toBe(201)
    const created = await reg.json()
    expect(created.id).toBe(TEST_ID)
    expect(created.is_self_cluster).toBe(true)

    // duplicate id is rejected
    const dup = await request.post('/api/v1/clusters', {
      headers: auth,
      data: { mode: 'self', display_name: TEST_DISPLAY_NAME },
      failOnStatusCode: false,
    })
    expect(dup.status()).toBe(409)

    // list now includes it
    const list = await request.get('/api/v1/clusters', { headers: auth })
    const ids = (await list.json()).items.map((c: { id: string }) => c.id)
    expect(ids).toContain(TEST_ID)

    // test connection — self cluster reachable via the ServiceAccount
    const probe = await request.post(`/api/v1/clusters/${TEST_ID}/test`, { headers: auth })
    expect(probe.status()).toBe(200)
    expect((await probe.json()).healthy).toBe(true)

    // delete
    const del = await request.delete(`/api/v1/clusters/${TEST_ID}`, { headers: auth })
    expect(del.status()).toBe(204)

    // gone from the registry
    const after = await request.get('/api/v1/clusters', { headers: auth })
    const idsAfter = (await after.json()).items.map((c: { id: string }) => c.id)
    expect(idsAfter).not.toContain(TEST_ID)
  })

  test('POST /audit/cluster-switch — 204 for an authed user', async ({ request }) => {
    const res = await request.post('/api/v1/audit/cluster-switch', {
      headers: auth,
      data: { previous_cluster: 'default', new_cluster: 'default' },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(204)
  })
})

test.describe('helm per-cluster (step 04b)', () => {
  let auth: Record<string, string>

  test.beforeAll(async ({ request }) => {
    auth = { Authorization: `Bearer ${await login(request)}` }
  })

  // Before 04b the Helm SDK was pinned to the legacy /app/kubeconfig.yaml file
  // path; with the multi-cluster reset flow that secret is gone, so helm 500'd
  // ("cluster unreachable"). 04b routes the Helm getter through the per-cluster
  // bundle (RESTConfigFor(ctx) → cluster-kubeconfig-<id>), so it now targets the
  // registered cluster like every other resource. This is the regression guard.
  test('GET /helm/releases?cluster=default — 200 (not the legacy 500)', async ({ request }) => {
    const res = await request.get('/api/v1/helm/releases?cluster=default', {
      headers: auth,
      failOnStatusCode: false,
    })
    expect(res.status(), 'helm must reach the registered cluster, not a missing file').toBe(200)
    expect(Array.isArray((await res.json()).items)).toBeTruthy()
  })

  test('helm release set is the same with and without ?cluster= (default fallback)', async ({
    request,
  }) => {
    const withParam = await request.get('/api/v1/helm/releases?cluster=default', { headers: auth })
    const noParam = await request.get('/api/v1/helm/releases', { headers: auth })
    expect(withParam.status()).toBe(200)
    expect(noParam.status()).toBe(200)
    const names = (b: { items: { name: string }[] }) => b.items.map((r) => r.name).sort()
    // Absent ?cluster= falls back to the default cluster → identical releases.
    expect(names(await noParam.json())).toEqual(names(await withParam.json()))
  })
})

// Decodes a JWT payload segment without verifying the signature (test-only).
function decodeJwtPayload(token: string): Record<string, unknown> {
  const seg = token.split('.')[1]
  const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json)
}

test.describe('per-cluster JWT permission matrix (step 06)', () => {
  test('login token carries a permissions MAP (not the legacy array); admin holds "*"', async ({
    request,
  }) => {
    const res = await request.post('/api/v1/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    })
    expect(res.ok()).toBeTruthy()
    const token = (await res.json()).access_token as string

    const claims = decodeJwtPayload(token)
    const perms = claims.permissions
    // Per-cluster matrix form, never the old flat array.
    expect(Array.isArray(perms)).toBe(false)
    expect(typeof perms).toBe('object')
    expect(perms).not.toBeNull()
    // The e2e user is admin → global superuser → "*" entry grants everything.
    expect((perms as Record<string, string[]>)['*']).toContain('*')
  })
})

test.describe('per-cluster RBAC enforcement (step 08)', () => {
  // Full deny-by-default → grant → enforce loop on a throwaway non-admin user.
  // The user starts with the global "Read" role but NO per-cluster grant, so
  // their JWT matrix is empty and every gated resource is refused. Granting a
  // role on a cluster (admin.users.update) adds that cluster to the matrix on
  // the user's next login, which the k8s handlers (requirePermissionForCluster)
  // then honor. Self-cleaning.
  let auth: Record<string, string>
  let userId = ''
  const email = `e2e-rbac-${Date.now()}@kubeast.local`
  const password = 'rbac1234'

  async function userToken(request: APIRequestContext): Promise<string> {
    const res = await request.post('/api/v1/auth/login', { data: { email, password } })
    expect(res.ok(), 'throwaway user login should succeed').toBeTruthy()
    return (await res.json()).access_token
  }

  test.beforeAll(async ({ request }) => {
    auth = { Authorization: `Bearer ${await login(request)}` }
    const res = await request.post('/api/v1/auth/admin/users', {
      headers: auth,
      data: { name: 'E2E RBAC', email, password },
      failOnStatusCode: false,
    })
    expect(res.status(), 'create throwaway user (defaults to Read role)').toBe(201)
    userId = (await res.json()).id
    expect(userId).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (!userId) return
    await request.delete(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, {
      headers: auth,
      failOnStatusCode: false,
    })
    await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: auth, failOnStatusCode: false })
  })

  test('new non-admin token carries an empty matrix (no grants)', async ({ request }) => {
    const perms = decodeJwtPayload(await userToken(request)).permissions as Record<string, string[]>
    expect(perms['*']).toBeUndefined() // not a global admin
    expect(perms['default']).toBeUndefined() // no per-cluster grant yet
  })

  test('deny-by-default: no grant → gated resource 403', async ({ request }) => {
    const res = await request.get('/api/v1/helm/releases?cluster=default', {
      headers: { Authorization: `Bearer ${await userToken(request)}` },
      failOnStatusCode: false,
    })
    expect(res.status(), 'no cluster grant → forbidden').toBe(403)
  })

  test('grant → GET reflects it; re-login → enforcement allows; accessibleOnly lists it', async ({
    request,
  }) => {
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, {
      headers: auth,
      data: { role: 'Read' },
    })
    expect(put.status()).toBe(200)

    const get = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: auth })
    expect(await get.json()).toMatchObject({ default: 'Read' })

    // Grants apply on the NEXT token issuance.
    const perms = decodeJwtPayload(await userToken(request)).permissions as Record<string, string[]>
    expect(perms['default']).toContain('resource.helm.read')

    const userHdr = { Authorization: `Bearer ${await userToken(request)}` }
    const allowed = await request.get('/api/v1/helm/releases?cluster=default', {
      headers: userHdr,
      failOnStatusCode: false,
    })
    expect(allowed.status(), 'granted cluster → allowed').toBe(200)

    // accessibleOnly returns only the clusters the user can reach.
    const acc = await request.get('/api/v1/clusters?accessibleOnly=true', { headers: userHdr })
    const ids = (await acc.json()).items.map((c: { id: string }) => c.id)
    expect(ids).toContain('default')
  })

  test('revoke → GET empty + repeat delete 404', async ({ request }) => {
    const del = await request.delete(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, {
      headers: auth,
    })
    expect(del.status()).toBe(204)
    const get = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: auth })
    expect(await get.json()).toEqual({})
    const again = await request.delete(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, {
      headers: auth,
      failOnStatusCode: false,
    })
    expect(again.status()).toBe(404)
  })
})
