import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A role holding ai.tool.* does no more through the AI than on its screens, however much the cluster binds its group:
// each call asks what the route behind the same screen asks. What is held is the route's own answer next to the tool's,
// and what the cluster shows afterwards (kubectl). The built-in roles keep what they had.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-aiparity-pass1!'
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-aiparity-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kubeconfig} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const tryKubectl = (args: string) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }

async function rpc(request: APIRequestContext, token: string, method: string, params?: object) {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).result
}
const callTool = (request: APIRequestContext, token: string, name: string, args: object): Promise<ToolResult> =>
  rpc(request, token, 'tools/call', { name, arguments: { cluster: CLUSTER, ...args } })
async function toolsInSelf(request: APIRequestContext, token: string): Promise<string[]> {
  const listed = await callTool(request, token, 'list_clusters', {})
  const clusters = JSON.parse(listed.content[0].text).clusters as { id: string; tools: string[] }[]
  return clusters.find((c) => c.id === CLUSTER)?.tools ?? []
}

function refusedFor(result: ToolResult, ...permissions: string[]) {
  expect(result.isError, result.content[0].text).toBe(true)
  for (const permission of permissions) expect(result.content[0].text).toContain(permission)
}

function ran(result: ToolResult) {
  expect(result.isError, result.content[0].text).toBeFalsy()
  expect(result.content[0].text).not.toContain('needs the permission')
}

async function people(request: APIRequestContext) {
  const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
  const cfg = config.ok() ? await config.json() : {}
  test.skip(!cfg.enabled || !cfg.write_tools, 'MCP write tools are off (mcp.enabled + mcp.writeTools)')
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const users: string[] = []
  const roles: number[] = []
  const imps: string[] = []
  return {
    admin,
    // A custom role, its group bound to the default edit ClusterRole in the namespace: the cluster lets it do everything here.
    async role(name: string, permissions: string[], ns: string) {
      const res = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions } })
      expect(res.status(), await res.text()).toBeLessThan(300)
      roles.push((await res.json()).id)
      // What auth.impersonation.customRoles renders, done by hand: the two service accounts may act as this group.
      imps.push(`${name}-imp`)
      kubectl(`create clusterrole ${name}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:${name}`)
      kubectl(`create clusterrolebinding ${name}-imp --clusterrole=${name}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
      kubectl(`-n ${ns} create rolebinding ${name} --clusterrole=edit --group=kubeast:role:${name}`)
    },
    async person(tag: string, grant: string) {
      const email = `e2e-aiparity-${tag}-${stamp()}@kubeast.local`
      const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E AI parity', email, password: PW, role_id: member.id } })
      expect(res.status(), `create ${email}`).toBe(201)
      const id = (await res.json()).id as string
      users.push(id)
      const put = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: grant } })
      expect(put.ok(), `grant ${grant}: ${await put.text()}`).toBeTruthy()
      return { token: await login(request, email, PW), email }
    },
    async cleanup() {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const imp of imps) {
        tryKubectl(`delete clusterrolebinding ${imp} --ignore-not-found`)
        tryKubectl(`delete clusterrole ${imp} --ignore-not-found`)
      }
    },
  }
}

const POD = 'parity-runner'

function fixture(ns: string) {
  kubectl(`create namespace ${ns}`)
  kubectl(`-n ${ns} create configmap parity-cm --from-literal=a=1`)
  kubectl(`-n ${ns} create secret generic parity-secret --from-literal=a=fake-e2e-value`)
  kubectl(`-n ${ns} create deployment parity-web --image=registry.k8s.io/pause:3.10`)
  kubectl(`-n ${ns} run ${POD} --image=docker.io/library/busybox:1.38.0 --command -- sh -c 'echo parity-log-line; sleep 3600'`)
  kubectl(`-n ${ns} wait --for=condition=Ready pod/${POD} --timeout=120s`)
}
const has = (ns: string, what: string) => tryKubectl(`-n ${ns} get ${what} -o name`) !== null

test.describe('the AI asks what the screens ask', () => {
  test('a role with AI tools only, bound in the cluster, reads the lists its screens read and changes nothing', async ({ request }) => {
    test.setTimeout(240_000)
    const ctx = await people(request)
    const s = stamp()
    const ns = `e2e-aiparity-a-${s}`
    try {
      fixture(ns)
      const roleName = `e2e-parity-tools-${s}`
      await ctx.role(roleName, ['ai.mcp.use', 'ai.tool.*'], ns)
      const { token, email } = await ctx.person('tools', roleName)

      // A list: the screen's route answers, so the tool does.
      const list = await request.get(`/api/v1/namespaces/${ns}/configmaps?cluster=${CLUSTER}`, { headers: bearer(token) })
      expect(list.status(), await list.text()).toBe(200)
      expect(await list.text()).toContain('parity-cm')
      const listed = await callTool(request, token, 'k8s_get_resources', { resource_type: 'configmaps', namespace: ns })
      ran(listed)
      expect(listed.content[0].text).toContain('parity-cm')

      // Pod logs: the screen's route refuses, so the tool does, though the cluster would serve them.
      const logs = await request.get(`/api/v1/namespaces/${ns}/pods/${POD}/logs?cluster=${CLUSTER}`, { headers: bearer(token) })
      expect(logs.status()).toBe(403)
      expect(await logs.text()).toContain('resource.pod.read')
      const logsTool = await callTool(request, token, 'k8s_get_pod_logs', { pod_name: POD, namespace: ns })
      refusedFor(logsTool, 'resource.pod.read', CLUSTER)
      expect(logsTool.content[0].text).not.toContain('parity-log-line')
      expect(kubectl(`-n ${ns} auth can-i get pods/log --as=e2e --as-group=kubeast:role:${roleName}`)).toBe('yes')

      // A delete: the same.
      const del = await request.delete(`/api/v1/namespaces/${ns}/configmaps/parity-cm?cluster=${CLUSTER}`, { headers: bearer(token) })
      expect(del.status()).toBe(403)
      expect(await del.text()).toContain('resource.configmap.delete')
      refusedFor(await callTool(request, token, 'k8s_delete_resource', { resource_type: 'configmap', resource_name: 'parity-cm', namespace: ns }), 'resource.configmap.delete')
      expect(has(ns, 'configmap/parity-cm')).toBe(true)

      refusedFor(await callTool(request, token, 'k8s_scale', { resource_type: 'deployment', resource_name: 'parity-web', namespace: ns, replicas: 3 }), 'resource.deployment.edit')
      expect(kubectl(`-n ${ns} get deployment parity-web -o jsonpath={.spec.replicas}`)).toBe('1')

      // What can never pass is not offered, and a rollout still reads.
      const tools = await toolsInSelf(request, token)
      expect(tools).toContain('k8s_get_resources')
      for (const name of ['k8s_get_pod_logs', 'k8s_delete_resource', 'k8s_scale', 'k8s_patch_resource', 'k8s_create_resource', 'k8s_apply_manifest', 'k8s_execute_command']) expect(tools).not.toContain(name)
      expect(tools).toContain('k8s_rollout')
      const history = await callTool(request, token, 'k8s_rollout', { action: 'history', resource_type: 'deployment', resource_name: 'parity-web', namespace: ns })
      ran(history)
      expect(history.content[0].text).toContain('REVISION')

      // The refused write has its failure row, with what it tried and what was missing.
      const audit = await request.get('/api/v1/auth/admin/audit-logs?action=ai.mcp.call&limit=100', { headers: bearer(ctx.admin) })
      const rows = ((await audit.json()).items ?? []).filter((r: Record<string, unknown>) => (r.ActorEmail ?? r.actor_email) === email && (r.Result ?? r.result) === 'failure')
      expect(JSON.stringify(rows)).toContain('resource.configmap.delete')
    } finally {
      await ctx.cleanup()
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  // The role screen offers an action for all resources, not for one kind, so that is the smallest role a test can make; one
  // kind's key is held to its tool in screen_permissions_test.go.
  test('a role with one action does that action and no other, however the call names the kind', async ({ request }) => {
    test.setTimeout(240_000)
    const ctx = await people(request)
    const s = stamp()
    const ns = `e2e-aiparity-b-${s}`
    try {
      fixture(ns)
      const creator = `e2e-parity-create-${s}`
      await ctx.role(creator, ['ai.mcp.use', 'ai.tool.*', 'resource.*.create'], ns)
      const { token } = await ctx.person('create', creator)
      const del = (resource_type: string, extra: object = {}) => callTool(request, token, 'k8s_delete_resource', { resource_type, namespace: ns, ...extra })

      for (const spelling of ['secret', 'Secret', 'SECRETS', 'secrets.v1']) refusedFor(await del(spelling, { resource_name: 'parity-secret' }), 'resource.secret.delete')
      refusedFor(await del('configmaps,secrets', { resource_name: 'parity-cm' }), 'resource.configmap.delete')
      refusedFor(await del('all', { all: true }), 'resource.*.delete')
      refusedFor(await del('deployment.apps', { resource_name: 'parity-web' }), 'resource.deployment.delete')
      expect(has(ns, 'secret/parity-secret')).toBe(true)
      expect(has(ns, 'configmap/parity-cm')).toBe(true)
      expect(has(ns, 'deployment/parity-web')).toBe(true)

      const secretDoc = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: parity-new-secret\n  namespace: ${ns}\n`
      const cmDoc = (name: string, value: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${ns}\ndata:\n  a: "${value}"\n`
      refusedFor(await callTool(request, token, 'k8s_apply_manifest', { yaml_content: cmDoc('parity-cm', '2') }), 'resource.configmap.edit')
      expect(kubectl(`-n ${ns} get configmap parity-cm -o jsonpath={.data.a}`)).toBe('1')

      // The action it holds goes through.
      ran(await callTool(request, token, 'k8s_create_resource', { yaml_content: cmDoc('parity-made', '1') }))
      expect(has(ns, 'configmap/parity-made')).toBe(true)

      // And the other way round: a role that may delete makes nothing, one document of several, or in a List.
      const deleter = `e2e-parity-delete-${s}`
      await ctx.role(deleter, ['ai.mcp.use', 'ai.tool.*', 'resource.*.delete'], ns)
      const { token: deleterToken } = await ctx.person('delete', deleter)
      refusedFor(await callTool(request, deleterToken, 'k8s_create_resource', { yaml_content: `${cmDoc('parity-other', '1')}---\n${secretDoc}` }), 'resource.configmap.create')
      expect(has(ns, 'configmap/parity-other')).toBe(false)
      refusedFor(await callTool(request, deleterToken, 'k8s_create_resource', { yaml_content: `apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: parity-new-secret\n    namespace: ${ns}\n` }), 'resource.secret.create')
      expect(has(ns, 'secret/parity-new-secret')).toBe(false)
      ran(await callTool(request, deleterToken, 'k8s_delete_resource', { resource_type: 'cm', resource_name: 'parity-made', namespace: ns }))
      await expect.poll(() => has(ns, 'configmap/parity-made'), { timeout: 30_000 }).toBe(false)
    } finally {
      await ctx.cleanup()
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('edit changes through apply what exists; creating what is not there needs create, as on the screens', async ({ request }) => {
    test.setTimeout(240_000)
    const ctx = await people(request)
    const s = stamp()
    const ns = `e2e-aiparity-c-${s}`
    try {
      fixture(ns)
      const roleName = `e2e-parity-edit-${s}`
      await ctx.role(roleName, ['ai.mcp.use', 'ai.tool.*', 'resource.*.edit'], ns)
      const { token } = await ctx.person('edit', roleName)
      const doc = (name: string, value: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${ns}\ndata:\n  a: "${value}"\n`

      ran(await callTool(request, token, 'k8s_apply_manifest', { yaml_content: doc('parity-cm', '2') }))
      expect(kubectl(`-n ${ns} get configmap parity-cm -o jsonpath={.data.a}`)).toBe('2')

      refusedFor(await callTool(request, token, 'k8s_apply_manifest', { yaml_content: doc('parity-not-there', '1') }), 'resource.configmap.create')
      expect(has(ns, 'configmap/parity-not-there')).toBe(false)

      // The screen's create route says the same for this role.
      const screen = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: bearer(token), data: { yaml: doc('parity-not-there', '1'), namespace: ns } })
      expect(screen.status()).toBe(403)
      expect(await screen.text()).toContain('resource.configmap.create')
    } finally {
      await ctx.cleanup()
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('the Write and Read roles keep what they had through the AI', async ({ request }) => {
    test.setTimeout(240_000)
    const ctx = await people(request)
    const ns = `e2e-aiparity-d-${stamp()}`
    try {
      fixture(ns)
      kubectl(`-n ${ns} create configmap parity-all --from-literal=a=1`)
      const write = await ctx.person('write', 'Write')
      const read = await ctx.person('read', 'Read')

      const writeTools = await toolsInSelf(request, write.token)
      for (const name of ['k8s_delete_resource', 'k8s_patch_resource', 'k8s_scale', 'k8s_rollout', 'k8s_create_resource', 'k8s_apply_manifest', 'k8s_get_pod_logs']) expect(writeTools).toContain(name)
      expect(writeTools).not.toContain('k8s_execute_command')
      const writeLogs = await callTool(request, write.token, 'k8s_get_pod_logs', { pod_name: POD, namespace: ns })
      ran(writeLogs)
      expect(writeLogs.content[0].text).toContain('parity-log-line')
      ran(await callTool(request, write.token, 'k8s_scale', { resource_type: 'deployment', resource_name: 'parity-web', namespace: ns, replicas: 2 }))
      expect(kubectl(`-n ${ns} get deployment parity-web -o jsonpath={.spec.replicas}`)).toBe('2')
      ran(await callTool(request, write.token, 'k8s_delete_resource', { resource_type: 'configmaps', resource_name: 'parity-all', namespace: ns }))
      await expect.poll(() => has(ns, 'configmap/parity-all'), { timeout: 30_000 }).toBe(false)
      ran(await callTool(request, write.token, 'k8s_apply_manifest', { yaml_content: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: parity-new\n  namespace: ${ns}\n` }))
      expect(has(ns, 'configmap/parity-new')).toBe(true)

      const readLogs = await callTool(request, read.token, 'k8s_get_pod_logs', { pod_name: POD, namespace: ns })
      ran(readLogs)
      expect(readLogs.content[0].text).toContain('parity-log-line')
      expect(await toolsInSelf(request, read.token)).toContain('k8s_get_pod_logs')
    } finally {
      await ctx.cleanup()
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })
})
