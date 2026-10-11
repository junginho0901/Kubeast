import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// MCP write tools (chart mcp.writeTools — on in the dev values): a key whose role ceiling is Write also gets the
// chat's write tools. No approval step — the user's own role on the cluster (permanent, or granted through an access
// request) decides, the Argo CD guard applies as it does in the console, and every call is audited with write: true.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-mcpw-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const WRITE_TOOLS = [
  'k8s_apply_manifest', 'k8s_create_resource', 'k8s_delete_resource', 'k8s_patch_resource', 'k8s_annotate_resource',
  'k8s_remove_annotation', 'k8s_label_resource', 'k8s_remove_label', 'k8s_scale', 'k8s_rollout', 'k8s_execute_command',
]
const stamp = () => Date.now().toString(36)

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mcpw-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const tryKubectl = (args: string) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E MCP write', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function grant(request: APIRequestContext, admin: string, userId: string, cluster: string, role: string) {
  const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role } })
  expect(res.ok(), `grant ${role} on ${cluster}`).toBeTruthy()
}

async function issueKey(request: APIRequestContext, userToken: string, ceiling: string): Promise<{ id: string; key: string }> {
  const res = await request.post('/api/v1/auth/api-keys', { headers: bearer(userToken), data: { name: `e2e mcp ${ceiling}`, expires_in_days: 1, cluster_ids: ['self'], role_ceiling: ceiling } })
  expect(res.status(), `issue ${ceiling} key: ${await res.text()}`).toBe(201)
  return res.json()
}

async function rpc(request: APIRequestContext, token: string, method: string, params?: object, id = 1) {
  return request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, failOnStatusCode: false })
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }
type ToolDef = { name: string; annotations?: Record<string, boolean>; inputSchema: { required?: string[] } }

async function listTools(request: APIRequestContext, token: string): Promise<ToolDef[]> {
  const res = await rpc(request, token, 'tools/list')
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).result.tools
}

async function callTool(request: APIRequestContext, token: string, name: string, args: object): Promise<ToolResult> {
  const res = await rpc(request, token, 'tools/call', { name, arguments: args })
  expect(res.status(), await res.text()).toBe(200)
  const body = await res.json()
  expect(body.result, JSON.stringify(body)).toBeTruthy()
  return body.result
}

async function auditRows(request: APIRequestContext, admin: string, actorEmail: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs?action=ai.mcp.call&limit=100', { headers: bearer(admin) })
  const items = ((await res.json()).items ?? []) as any[]
  return items.filter((i) => (i.ActorEmail ?? i.actor_email) === actorEmail).map((r) => ({ result: r.Result ?? r.result, error: r.Error ?? r.error ?? '', cluster: r.Cluster ?? r.cluster, after: r.After ?? r.after }))
}

// A namespace with a Deployment to scale and a ConfigMap to delete; replicas changes need no running pods.
function fixture(s: string) {
  const ns = `e2e-mcpw-${s}`
  kubectl(`create namespace ${ns}`)
  kubectl(`-n ${ns} create deployment web --image=registry.k8s.io/pause:3.10 --replicas=1`)
  kubectl(`-n ${ns} create configmap scratch --from-literal=a=b`)
  return ns
}
const replicasOf = (ns: string, name: string) => kubectl(`-n ${ns} get deployment ${name} -o jsonpath='{.spec.replicas}'`).replace(/'/g, '')

async function mcpWriteConfig(request: APIRequestContext, admin: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
  const cfg = config.ok() ? await config.json() : {}
  test.skip(!cfg.enabled || !cfg.write_tools, 'MCP write tools are off (mcp.enabled + mcp.writeTools)')
}

test.describe('MCP write tools', () => {
  test('a Write user with a Write-ceiling key scales and deletes, audited write: true; a Read ceiling cannot; Argo CD objects are guarded', async ({ request }) => {
    test.setTimeout(150_000)
    const admin = await login(request, EMAIL, PASSWORD)
    await mcpWriteConfig(request, admin)

    const s = stamp()
    const writer = `e2e-mcpw-w-${s}@kubeast.local`
    let writerId = ''
    let ns = ''
    try {
      ns = fixture(s)
      writerId = await createUser(request, admin, writer)
      await grant(request, admin, writerId, 'self', 'Write')
      const writerToken = await login(request, writer, PW)
      const writeKey = await issueKey(request, writerToken, 'Write')
      const readKey = await issueKey(request, writerToken, 'Read')

      // Write ceiling: every write tool, honestly annotated, plus request_access.
      const tools = await listTools(request, writeKey.key)
      const names = tools.map((t) => t.name)
      for (const w of WRITE_TOOLS) expect(names, w).toContain(w)
      expect(names).toContain('request_access')
      const del = tools.find((t) => t.name === 'k8s_delete_resource')!
      expect(del.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false })
      expect(del.inputSchema.required).toContain('cluster')
      expect(tools.find((t) => t.name === 'k8s_label_resource')!.annotations?.destructiveHint).toBe(false)
      expect(tools.filter((t) => !WRITE_TOOLS.includes(t.name) && t.name !== 'request_access').every((t) => t.annotations?.readOnlyHint === true)).toBe(true)

      // Read ceiling, same user: the key carries no ai.mcp.use — nothing to run, only the way to ask; a write is refused.
      expect((await listTools(request, readKey.key)).map((t) => t.name)).toEqual(['request_access'])
      const refused = await callTool(request, readKey.key, 'k8s_scale', { cluster: 'self', resource_type: 'deployment', resource_name: 'web', namespace: ns, replicas: 2 })
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toMatch(/forbidden/)
      expect(replicasOf(ns, 'web')).toBe('1')

      // The write runs as the user and the cluster shows it.
      const scaled = await callTool(request, writeKey.key, 'k8s_scale', { cluster: 'self', resource_type: 'deployment', resource_name: 'web', namespace: ns, replicas: 2 })
      expect(scaled.isError, scaled.content?.[0]?.text).toBeFalsy()
      expect(scaled.content[0].text).toMatch(/scaled/)
      expect(replicasOf(ns, 'web')).toBe('2')

      const deleted = await callTool(request, writeKey.key, 'k8s_delete_resource', { cluster: 'self', resource_type: 'configmap', resource_name: 'scratch', namespace: ns })
      expect(deleted.isError, deleted.content?.[0]?.text).toBeFalsy()
      expect(tryKubectl(`-n ${ns} get configmap scratch`), 'the ConfigMap is gone').toBeNull()

      // An Argo CD-managed Deployment (deploy/kind/fixtures.yaml): block refuses, warn runs with a notice first.
      const argoBefore = tryKubectl(`-n default get deployment e2e-argo-managed -o jsonpath='{.spec.replicas}'`)?.replace(/'/g, '')
      if (argoBefore) {
        const want = String(Number(argoBefore) + 1)
        const argo = await callTool(request, writeKey.key, 'k8s_scale', { cluster: 'self', resource_type: 'deployment', resource_name: 'e2e-argo-managed', namespace: 'default', replicas: Number(want) })
        const text = argo.content[0].text
        expect(text, 'the Application is named').toMatch(/managed by Argo CD application e2e-app/)
        if (argo.isError) {
          expect(text).toMatch(/change it in Git/)
          expect(replicasOf('default', 'e2e-argo-managed'), 'block: unchanged').toBe(argoBefore)
        } else {
          expect(text.startsWith('⚠'), 'warn: the notice comes first').toBe(true)
          expect(replicasOf('default', 'e2e-argo-managed'), 'warn: applied').toBe(want)
          kubectl(`-n default scale deployment e2e-argo-managed --replicas=${argoBefore}`)
        }
      }

      // Audit: the writes carry write: true; the refusal is a failure row that says which tool.
      await expect.poll(async () => (await auditRows(request, admin, writer)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
      const rows = await auditRows(request, admin, writer)
      const ok = rows.filter((r) => r.result === 'success')
      expect(ok.map((r) => r.after?.tool).sort()).toEqual(expect.arrayContaining(['k8s_delete_resource', 'k8s_scale']))
      expect(ok.every((r) => r.after?.write === true && r.cluster === 'self')).toBe(true)
      expect(ok.find((r) => r.after?.tool === 'k8s_scale')?.after?.credential).toEqual({ type: 'api_key', akid: writeKey.id })
      const fail = rows.find((r) => r.result === 'failure' && r.after?.tool === 'k8s_scale' && /forbidden/.test(r.error))
      expect(fail?.after?.write, 'the refused write is a write').toBe(true)
      expect(fail?.after?.credential).toEqual({ type: 'api_key', akid: readKey.id })
    } finally {
      if (writerId) await request.delete(`/api/v1/auth/admin/users/${writerId}`, { headers: bearer(admin), failOnStatusCode: false })
      if (ns) tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('a Read user asks through request_access; the write works once approved and is refused again after expiry', async ({ request }) => {
    test.setTimeout(420_000)
    const admin = await login(request, EMAIL, PASSWORD)
    await mcpWriteConfig(request, admin)
    const ar = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
    test.skip(!ar.ok() || !(await ar.json()).enabled, 'access requests are off (auth.accessRequests.enabled)')

    const s = stamp()
    const reader = `e2e-mcpw-r-${s}@kubeast.local`
    let readerId = ''
    let ns = ''
    try {
      ns = fixture(s)
      readerId = await createUser(request, admin, reader)
      await grant(request, admin, readerId, 'self', 'Read')
      const readerToken = await login(request, reader, PW)
      const key = await issueKey(request, readerToken, 'Write')

      // Read on self: no ai.mcp.use, so the only tool is the request; a write is refused and audited.
      expect((await listTools(request, key.key)).map((t) => t.name)).toEqual(['request_access'])
      const before = await callTool(request, key.key, 'k8s_scale', { cluster: 'self', resource_type: 'deployment', resource_name: 'web', namespace: ns, replicas: 2 })
      expect(before.isError).toBe(true)
      expect(before.content[0].text).toMatch(/forbidden/)

      // The agent asks for two minutes of Write; auth-service holds the request as pending.
      const asked = await callTool(request, key.key, 'request_access', { cluster: 'self', role: 'Write', duration_minutes: 2, reason: 'e2e: scale the web deployment' })
      expect(asked.isError, asked.content?.[0]?.text).toBeFalsy()
      const body = JSON.parse(asked.content[0].text) as { status: string; request: { id: string; status: string; cluster_id: string } }
      expect(body.status).toBe('pending')
      expect(body.request.cluster_id).toBe('self')
      const mine = await (await request.get('/api/v1/auth/access-requests', { headers: bearer(readerToken) })).json()
      expect(mine.some((x: { id: string; status: string }) => x.id === body.request.id && x.status === 'pending')).toBe(true)

      // An admin approves; the granted role reaches the key on its next exchange (within a minute).
      const approved = await request.post(`/api/v1/auth/admin/access-requests/${body.request.id}/approve`, { headers: bearer(admin), data: { note: 'e2e mcp' } })
      expect(approved.status(), await approved.text()).toBe(200)
      const approvedAt = Date.now()
      // The approval revokes the user's tokens; the server exchanges the key again when its cached token is refused.
      await expect.poll(async () => {
        const res = await rpc(request, key.key, 'tools/list')
        return res.status() === 200 ? ((await res.json()).result.tools as ToolDef[]).map((t) => t.name) : [`http ${res.status()}`]
      }, { timeout: 110_000, intervals: [3_000] }).toContain('k8s_scale')
      const granted = await callTool(request, key.key, 'k8s_scale', { cluster: 'self', resource_type: 'deployment', resource_name: 'web', namespace: ns, replicas: 2 })
      expect(granted.isError, granted.content?.[0]?.text).toBeFalsy()
      expect(replicasOf(ns, 'web')).toBe('2')
      console.log(`[mcp-write] write possible ${Math.round((Date.now() - approvedAt) / 1000)} s after approval`)

      const rows = await auditRows(request, admin, reader)
      const req = rows.find((r) => r.after?.tool === 'request_access')
      expect(req?.result).toBe('success')
      expect(req?.after?.request_id).toBe(body.request.id)
      expect(req?.after?.role).toBe('Write')
      expect(rows.some((r) => r.result === 'success' && r.after?.tool === 'k8s_scale' && r.after?.write === true)).toBe(true)

      // The grant ends: the request is swept to expired and the next write is refused (stale token or forbidden).
      await expect.poll(async () => {
        const all = await (await request.get('/api/v1/auth/admin/access-requests?status=expired', { headers: bearer(admin) })).json()
        return (all as { id: string }[]).some((x) => x.id === body.request.id)
      }, { timeout: 180_000, intervals: [5_000] }).toBe(true)
      await expect.poll(async () => {
        const res = await rpc(request, key.key, 'tools/call', { name: 'k8s_scale', arguments: { cluster: 'self', resource_type: 'deployment', resource_name: 'web', namespace: ns, replicas: 3 } })
        if (res.status() !== 200) return `http ${res.status()}`
        const r = (await res.json()).result as ToolResult | undefined
        return r?.isError ? 'refused' : 'allowed'
      }, { timeout: 110_000, intervals: [3_000] }).not.toBe('allowed')
      expect(replicasOf(ns, 'web'), 'nothing changed after expiry').toBe('2')
    } finally {
      if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin), failOnStatusCode: false })
      if (ns) tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })
})
