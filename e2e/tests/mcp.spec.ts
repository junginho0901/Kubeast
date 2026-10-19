import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// The MCP server (/api/v1/ai/mcp, chart mcp.enabled — on in the dev values): an external AI agent connects with a
// Kubeast API key and gets the chat's read tools, run as that user on the cluster it names, masked, and audited as
// ai.mcp.call. Driven as JSON-RPC over the real transport, plus one connection through the official client SDK.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-mcp-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E MCP', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function grant(request: APIRequestContext, admin: string, userId: string, cluster: string, role: string) {
  const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role } })
  expect(res.ok(), `grant ${role} on ${cluster}`).toBeTruthy()
}

async function rpc(request: APIRequestContext, token: string, method: string, params?: object, id = 1) {
  return request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, failOnStatusCode: false })
}

async function auditRows(request: APIRequestContext, admin: string, actorEmail: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs?action=ai.mcp.call&limit=50', { headers: bearer(admin) })
  const items = ((await res.json()).items ?? []) as any[]
  return items.filter((i) => (i.ActorEmail ?? i.actor_email) === actorEmail)
}

test.describe('MCP server', () => {
  test('a Write user with an API key lists, calls and is audited; others are refused', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, EMAIL, PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    const cfg = config.ok() ? await config.json() : {}
    test.skip(!cfg.enabled, 'the MCP server is off (mcp.enabled)')

    const s = stamp()
    const writer = `e2e-mcp-w-${s}@kubeast.local`
    const reader = `e2e-mcp-r-${s}@kubeast.local`
    let writerId = ''
    let readerId = ''
    try {
      writerId = await createUser(request, admin, writer)
      await grant(request, admin, writerId, 'self', 'Write')
      readerId = await createUser(request, admin, reader)
      await grant(request, admin, readerId, 'self', 'Read')
      const writerToken = await login(request, writer, PW)
      const readerToken = await login(request, reader, PW)
      const keyRes = await request.post('/api/v1/auth/api-keys', { headers: bearer(writerToken), data: { name: 'e2e mcp', expires_in_days: 1, cluster_ids: ['self'], role_ceiling: 'Write' } })
      expect(keyRes.status(), 'issue key').toBe(201)
      const key = await keyRes.json()
      expect(key.key).toMatch(/^kbk_/)

      // No token → 401 with a Bearer challenge; the key itself is the credential.
      const anon = await request.post(MCP, { headers: RPC, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, failOnStatusCode: false })
      expect(anon.status()).toBe(401)
      expect(anon.headers()['www-authenticate'] ?? '').toMatch(/^Bearer/)

      const list = await rpc(request, key.key, 'tools/list')
      expect(list.status(), await list.text()).toBe(200)
      const tools = (await list.json()).result.tools as { name: string; annotations: { readOnlyHint?: boolean }; inputSchema: { required?: string[] } }[]
      const names = tools.map((t) => t.name).sort()
      expect(names).toContain('list_clusters')
      expect(names).toContain('k8s_get_resources')
      // Write tools (and request_access) appear only when the operator turned them on (mcp.writeTools, mcp-write.spec.ts).
      const writes = names.filter((n) => /^k8s_(apply|create|delete|patch|scale|rollout|execute|label|annotat|remove)/.test(n))
      expect(writes.length).toBe(cfg.write_tools ? 11 : 0)
      expect(names.includes('request_access')).toBe(!!cfg.write_tools)
      expect(tools.filter((t) => !writes.includes(t.name) && t.name !== 'request_access').every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
      expect(tools.find((t) => t.name === 'k8s_get_resources')!.inputSchema.required).toContain('cluster')

      // list_clusters says where the key may act.
      const clusters = await rpc(request, key.key, 'tools/call', { name: 'list_clusters', arguments: {} })
      const clusterInfo = JSON.parse((await clusters.json()).result.content[0].text).clusters as { id: string; mcp: boolean; tools: string[] }[]
      const self = clusterInfo.find((c) => c.id === 'self')
      expect(self?.mcp, 'self is usable').toBe(true)
      expect(self?.tools).toContain('k8s_get_pod_logs')

      // The pods the agent sees are the pods kubectl sees.
      const pods = await rpc(request, key.key, 'tools/call', { name: 'k8s_get_resources', arguments: { cluster: 'self', resource_type: 'pods', namespace: 'kubeast' } })
      const result = (await pods.json()).result
      expect(result.isError, result.content?.[0]?.text).toBeFalsy()
      const text = result.content[0].text as string
      for (const name of kubectl(`-n kubeast get pods -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean)) expect(text).toContain(name)

      // A Secret's values never reach the agent.
      const secret = await rpc(request, key.key, 'tools/call', { name: 'k8s_get_resource_yaml', arguments: { cluster: 'self', resource_type: 'secret', resource_name: 'kubeast-secrets', namespace: 'kubeast' } })
      const secretText = (await secret.json()).result.content[0].text as string
      expect(secretText).toContain('kubeast-secrets')
      const pw = kubectl(`-n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}'`)
      expect(pw.length).toBeGreaterThan(0)
      expect(secretText).not.toContain(pw)

      // A cluster the key does not reach: refused, and the refusal is a failure row.
      const other = await rpc(request, key.key, 'tools/call', { name: 'k8s_get_resources', arguments: { cluster: 'default', resource_type: 'pods' } })
      const otherResult = (await other.json()).result
      expect(otherResult.isError).toBe(true)
      expect(otherResult.content[0].text).toMatch(/forbidden/)

      await expect.poll(async () => (await auditRows(request, admin, writer)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
      const rows = await auditRows(request, admin, writer)
      const success = rows.filter((r) => (r.Result ?? r.result) === 'success')
      const failure = rows.filter((r) => (r.Result ?? r.result) === 'failure')
      expect(success.length).toBeGreaterThanOrEqual(2)
      expect(failure.some((r) => (r.Cluster ?? r.cluster) === 'default' && /forbidden/.test(r.Error ?? r.error ?? ''))).toBe(true)
      const podsRow = success.find((r) => (r.After ?? r.after)?.tool === 'k8s_get_resources')
      const after = podsRow?.After ?? podsRow?.after
      expect(podsRow?.Cluster ?? podsRow?.cluster).toBe('self')
      expect(after?.credential).toEqual({ type: 'api_key', akid: key.id })

      // A Read user on self has ai.mcp.use and the thirty read tools (not the Admin-only hygiene, audit_search, nodes_stats_summary, nodes_log nor the write preview k8s_diff), never a write tool (with write tools on, also the way to ask for a role).
      const readList = await rpc(request, readerToken, 'tools/list')
      expect(readList.status()).toBe(200)
      const readNames = ((await readList.json()).result.tools as { name: string }[]).map((t) => t.name).sort()
      expect(readNames.filter((n) => /^k8s_(apply|create|delete|patch|scale|rollout|execute|label|annotat|remove)/.test(n))).toEqual([])
      expect(readNames).toContain('k8s_get_resources')
      expect(readNames.includes('request_access')).toBe(!!cfg.write_tools)
      expect(readNames.filter((n) => n !== 'request_access' && n !== 'list_clusters').length).toBe(30)
      expect(readNames).not.toContain('hygiene')
      expect(readNames).not.toContain('audit_search')
      expect(readNames).not.toContain('nodes_log')
      expect(readNames).not.toContain('k8s_diff')

      // The official client SDK connects the same way Claude Code does (a static Authorization header).
      const transport = new StreamableHTTPClientTransport(new URL(MCP, process.env.E2E_BASE_URL || 'http://localhost:30080'), {
        requestInit: { headers: { Authorization: `Bearer ${key.key}` } },
      })
      const client = new Client({ name: 'kubeast-e2e', version: '1.0.0' })
      try {
        await client.connect(transport)
        const listed = await client.listTools()
        expect(listed.tools.map((t) => t.name)).toContain('k8s_get_events')
        const events = await client.callTool({ name: 'k8s_get_events', arguments: { cluster: 'self', namespace: 'kubeast' } })
        expect(events.isError).toBeFalsy()
        expect((events.content as { type: string; text?: string }[])[0].type).toBe('text')
      } finally {
        await client.close().catch(() => {})
      }
    } finally {
      for (const id of [writerId, readerId]) if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
