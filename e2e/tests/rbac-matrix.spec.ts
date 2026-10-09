import { test, expect, type APIRequestContext } from '@playwright/test'

// Role × action matrix behind README "역할과 권한": what each Kubeast role may do
// on a cluster, checked end to end through the gateway — the JWT permission
// matrix in k8s-service first, then the cluster's own RBAC via the
// impersonation groups (kubeast:viewer / operator / admin / role:<slug>).
// API only; the throwaway user and role are removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const PASSWORD = 'e2e-rbac-matrix-throwaway'

type Headers = Record<string, string>

async function login(request: APIRequestContext, email: string, password: string): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function roleId(request: APIRequestContext, headers: Headers, name: string) {
  const body = await (await request.get('/api/v1/auth/roles', { headers })).json()
  const items = (Array.isArray(body) ? body : body.items || []) as Array<{ id: number; name: string }>
  const role = items.find((r) => r.name === name)
  expect(role, `role ${name}`).toBeTruthy()
  return role!.id
}

test.describe('RBAC matrix (role × action)', () => {
  test('Member, Read, Write, Admin and a custom role get the documented 403s and 200s', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now()
    const email = `e2e-rbac-matrix-${ts}@kubeast.local`
    let userId = ''
    let customRoleId: number | undefined
    try {
      const created = await request.post('/api/v1/auth/admin/users', {
        headers: admin,
        data: { name: 'E2E RBAC matrix', email, password: PASSWORD, role_id: await roleId(request, admin, 'Member') },
      })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id as string

      // The matrix lives in the JWT: log in again after every change.
      const grant = async (role: string) => {
        const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: admin, data: { role } })
        expect(res.ok(), `grant ${role} on ${CLUSTER}: ${await res.text()}`).toBeTruthy()
        return login(request, email, PASSWORD)
      }
      const status = async (headers: Headers, method: 'get' | 'post' | 'delete', path: string, cluster = CLUSTER) =>
        (await request[method](`${path}?cluster=${cluster}`, { headers, failOnStatusCode: false })).status()

      const NAMESPACES = '/api/v1/cluster/namespaces'
      const PODS = '/api/v1/cluster/namespaces/kube-system/pods'
      const SECRETS = '/api/v1/cluster/namespaces/default/secrets'
      // Objects that do not exist: a permitted call reaches the cluster and gets 404, a refused one never does.
      const DELETE_CONFIGMAP = `/api/v1/cluster/namespaces/default/configmaps/e2e-no-such-configmap-${ts}`
      const CORDON = `/api/v1/cluster/nodes/e2e-no-such-node-${ts}/cordon`

      // Member with no grant: the cluster gate refuses everything.
      const member = await login(request, email, PASSWORD)
      expect(await status(member, 'get', NAMESPACES), 'Member without a grant').toBe(403)

      // Read: lists yes; Secrets no (the view ClusterRole excludes them); writes no.
      const read = await grant('Read')
      expect(await status(read, 'get', NAMESPACES), 'Read lists namespaces').toBe(200)
      expect(await status(read, 'get', PODS), 'Read lists pods').toBe(200)
      expect(await status(read, 'get', SECRETS), 'Read cannot list Secrets (cluster RBAC)').toBe(403)
      expect(await status(read, 'delete', DELETE_CONFIGMAP), 'Read cannot delete').toBe(403)
      expect(await status(read, 'post', CORDON), 'Read cannot cordon').toBe(403)

      // YAML create / edit: each document needs resource.<kind>.create, an edit the resource's resource.<kind>.edit.
      const cm = `e2e-rbac-write-${ts}`
      const cmYaml = (v: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${cm}\n  namespace: default\ndata:\n  k: ${v}\n`
      const post = async (headers: Headers, path: string, data: object) =>
        (await request.post(`${path}?cluster=${CLUSTER}`, { headers, data, failOnStatusCode: false })).status()
      const CREATE = '/api/v1/cluster/resources/yaml/create'
      const APPLY = '/api/v1/cluster/resources/yaml/apply'
      const applyBody = (v: string) => ({ resource_type: 'configmaps', namespace: 'default', name: cm, yaml: cmYaml(v) })
      expect(await post(read, CREATE, { yaml: cmYaml('one'), namespace: 'default' }), 'Read cannot create').toBe(403)
      expect(await post(read, APPLY, applyBody('two')), 'Read cannot edit').toBe(403)

      // Write: Secrets and deletes reach the cluster; node actions stay Admin-only.
      const write = await grant('Write')
      expect(await status(write, 'get', SECRETS), 'Write lists Secrets').toBe(200)
      expect(await status(write, 'delete', DELETE_CONFIGMAP), 'Write may delete (object missing)').toBe(404)
      expect(await status(write, 'post', CORDON), 'Write cannot cordon').toBe(403)

      // Write creates and edits through YAML; a cluster-scoped kind passes the app and is refused by the cluster's `edit` role.
      try {
        expect(await post(write, CREATE, { yaml: cmYaml('one'), namespace: 'default' }), 'Write creates a ConfigMap').toBe(200)
        expect(await post(write, APPLY, applyBody('two')), 'Write edits it').toBe(200)
        const yaml = await (await request.get(`/api/v1/cluster/resources/yaml?resource_type=configmaps&resource_name=${cm}&namespace=default&cluster=${CLUSTER}`, { headers: admin })).text()
        expect(yaml, 'the edit landed').toContain('k: two')
        const clusterRole = `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: ${cm}\nrules: []\n`
        expect(await post(write, CREATE, { yaml: clusterRole }), 'the cluster refuses a ClusterRole from Write').toBe(403)
      } finally {
        await request.delete(`/api/v1/cluster/namespaces/default/configmaps/${cm}?cluster=${CLUSTER}`, { headers: admin, failOnStatusCode: false })
      }

      // Admin on this cluster: node actions reach the cluster; a cluster the user holds nothing on stays closed.
      const adminHere = await grant('Admin')
      expect(await status(adminHere, 'post', CORDON), 'Admin may cordon (node missing)').toBe(404)
      expect(await status(adminHere, 'delete', DELETE_CONFIGMAP), 'Admin may delete (object missing)').toBe(404)
      expect(await status(adminHere, 'get', NAMESPACES, 'default'), 'no grant on the other cluster').toBe(403)

      // Custom role: the app lets the read through, the cluster refuses the unbound kubeast:role:<slug> group.
      const customName = `e2e-matrix-${ts}`
      const role = await request.post('/api/v1/auth/admin/roles', {
        headers: admin,
        data: { name: customName, description: 'e2e', permissions: ['menu.dashboard', 'resource.*.read'] },
      })
      expect(role.status(), await role.text()).toBe(201)
      customRoleId = (await role.json()).id as number
      const custom = await grant(customName)
      expect(await status(custom, 'get', NAMESPACES), 'custom role group is not bound on the cluster').toBe(403)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
      if (customRoleId) await request.delete(`/api/v1/auth/admin/roles/${customRoleId}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
