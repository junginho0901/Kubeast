import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A-2 (records/ns-scope-20261012.md): a namespace-scoped grant is enforced — a namespaced path outside the grant is
// refused before any cluster call, the namespace list is the grant, all-namespaces lists fan out over it, the overview
// counts only it, and the MCP tools must name one of its namespaces. The chart's per-namespace RoleBindings come in
// A-3, so the spec binds the user's group itself with kubectl (an impersonation allow for the group and a RoleBinding
// in one namespace) and removes everything at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-nsapi-pass1!'
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nsapi-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const tryKubectl = (args: string) => { try { return kubectl(args) } catch { return null } }

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E ns api', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

const get = (request: APIRequestContext, token: string, p: string) => request.get(`${p}${p.includes('?') ? '&' : '?'}cluster=${CLUSTER}`, { headers: bearer(token), failOnStatusCode: false })

test.describe('namespace-scoped grant enforcement', () => {
  test('a Read grant limited to one namespace sees that namespace only: paths, lists, overview, MCP', async ({ request }) => {
    test.setTimeout(180_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const s = Date.now().toString(36)
    const nsA = `e2e-nsapi-a-${s}`
    const nsB = `e2e-nsapi-b-${s}`
    const email = `e2e-nsapi-${s}@kubeast.local`
    const rbac = `e2e-nsapi-${s}`
    let userId = ''
    try {
      // Two namespaces with a ConfigMap each; the grant covers A only.
      kubectl(`create namespace ${nsA}`)
      kubectl(`create namespace ${nsB}`)
      kubectl(`-n ${nsA} create configmap cm-a --from-literal=k=a`)
      kubectl(`-n ${nsB} create configmap cm-b --from-literal=k=b`)
      userId = await createUser(request, admin, email)
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [nsA] } })
      expect(grant.status(), await grant.text()).toBe(200)
      const user = await login(request, email, PW)

      // Outside the grant: refused by Kubeast itself, naming the grant — the cluster is never asked.
      const outside = await get(request, user, `/api/v1/cluster/namespaces/${nsB}/configmaps`)
      expect(outside.status()).toBe(403)
      expect(await outside.text()).toMatch(/outside your grant/)

      // Inside the grant, before the cluster binds the group: the cluster refuses (impersonation), 403 with its reason.
      const unbound = await get(request, user, `/api/v1/cluster/namespaces/${nsA}/configmaps`)
      expect(unbound.status()).toBe(403)
      expect(await unbound.text()).toMatch(/impersonate|forbidden/)

      // What A-3's chart will render, done by hand here: the scoped groups (Read now, Write for the MCP part below)
      // may be impersonated, and they read (view) in A only.
      kubectl(`create clusterrole ${rbac}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:read --resource-name=kubeast:role:write`)
      kubectl(`create clusterrolebinding ${rbac}-imp --clusterrole=${rbac}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
      kubectl(`-n ${nsA} create rolebinding ${rbac}-view --clusterrole=view --group=kubeast:role:read --group=kubeast:role:write`)

      // Namespaced path inside the grant → the cluster's answer.
      await expect.poll(async () => (await get(request, user, `/api/v1/cluster/namespaces/${nsA}/configmaps`)).status(), { timeout: 20_000 }).toBe(200)
      const inside = await (await get(request, user, `/api/v1/cluster/namespaces/${nsA}/configmaps`)).json()
      expect(JSON.stringify(inside)).toContain('cm-a')

      // The namespace list is the grant; the all-namespaces list fans out over it (B never appears).
      const namespaces = await get(request, user, '/api/v1/cluster/namespaces')
      expect(namespaces.status()).toBe(200)
      expect(((await namespaces.json()) as { name: string }[]).map((n) => n.name)).toEqual([nsA])
      const all = await get(request, user, '/api/v1/cluster/configmaps/all')
      expect(all.status(), await all.text()).toBe(200)
      const allText = JSON.stringify(await all.json())
      expect(allText).toContain('cm-a')
      expect(allText).not.toContain('cm-b')
      expect(allText).not.toContain('kube-root-ca.crt","namespace":"kube-system')

      // The overview counts the grant only and says so.
      const overview = await get(request, user, '/api/v1/cluster/overview')
      expect(overview.status(), await overview.text()).toBe(200)
      const ov = await overview.json()
      expect(ov.scoped).toBe(true)
      expect(ov.total_namespaces).toBe(1)
      expect(ov.node_count).toBe(0)
      const adminOv = await (await get(request, admin, '/api/v1/cluster/overview')).json()
      expect(adminOv.scoped).toBeUndefined()
      expect(ov.total_pods).toBeLessThan(adminOv.total_pods)

      // MCP: the tools must name one of the granted namespaces; cluster-wide tools are refused.
      const mcpCfg = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
      if (mcpCfg.ok() && (await mcpCfg.json()).enabled) {
        // Read carries no ai.mcp.use; a Write grant on A does (still namespace-scoped).
        expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Write', namespaces: [nsA] } })).ok()).toBeTruthy()
        const writer = await login(request, email, PW)
        const rpc = async (name: string, args: object) => {
          const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${writer}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, failOnStatusCode: false })
          expect(res.status(), await res.text()).toBe(200)
          return (await res.json()).result as { isError?: boolean; content: { text: string }[] }
        }
        const listed = await rpc('list_clusters', {})
        const self = (JSON.parse(listed.content[0].text).clusters as { id: string; namespaces?: string[] }[]).find((c) => c.id === CLUSTER)
        expect(self?.namespaces).toEqual([nsA])
        const none = await rpc('k8s_get_resources', { cluster: CLUSTER, resource_type: 'configmaps' })
        expect(none.isError).toBe(true)
        expect(none.content[0].text).toMatch(/namespace is required/)
        const other = await rpc('k8s_get_resources', { cluster: CLUSTER, resource_type: 'configmaps', namespace: nsB })
        expect(other.isError).toBe(true)
        expect(other.content[0].text).toMatch(/outside your grant/)
        const wide = await rpc('get_cluster_overview', { cluster: CLUSTER })
        expect(wide.isError).toBe(true)
        expect(wide.content[0].text).toMatch(/spans the cluster/)
        const ok = await rpc('k8s_get_resources', { cluster: CLUSTER, resource_type: 'configmaps', namespace: nsA })
        expect(ok.isError, ok.content?.[0]?.text).toBeFalsy()
        expect(ok.content[0].text).toContain('cm-a')
      }
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete clusterrolebinding ${rbac}-imp --ignore-not-found`)
      tryKubectl(`delete clusterrole ${rbac}-imp --ignore-not-found`)
      tryKubectl(`delete namespace ${nsA} ${nsB} --ignore-not-found --wait=false`)
    }
  })
})
