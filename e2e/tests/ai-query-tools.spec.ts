import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The query tools shrink a list before it reaches the model (k8s_jq_query, k8s_tabular_query, k8s_count) and
// k8s_diff previews a manifest with a server dry run — nothing applied, offered only to users who may write.
// Driven through the MCP endpoint as the admin and a temporary Read user, checked against kubectl.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-query-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-query-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, allowFail = false) => {
    try {
      return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    } catch (e) {
      if (allowFail) return ''
      throw e
    }
  }
}
const kubectl = kubectlFor('kubeast')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createReadUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E query', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id as string
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
  expect(grant.ok(), 'grant Read on self').toBeTruthy()
  return id
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cluster: 'self', ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function mcpOn(request: APIRequestContext, token: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && (await config.json()).enabled
}

const json = (text: string) => JSON.parse(text)

test.describe('AI query tools: jq, tabular, count, and the k8s_diff preview', () => {
  test.setTimeout(180_000)

  test('k8s_jq_query, k8s_tabular_query and k8s_count read what kubectl reads, shrunk', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const running = kubectl(`-n kubeast get pods --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean).sort()
    expect(running.length).toBeGreaterThan(0)
    const all = Number(kubectl(`-n kubeast get pods -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean).length)

    const jq = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[] | select(.status.phase == "Running") | .metadata.name' })).text)
    expect(jq.scope).toBe('kubeast')
    expect(jq.total_items_processed).toBe(all)
    expect(jq.matches_found).toBe(running.length)
    expect([...jq.results].sort()).toEqual(running)

    const shaped = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[] | {name: .metadata.name, node: .spec.nodeName}', limit: 2 })).text)
    expect(shaped.results.length).toBe(2)
    expect(shaped.truncated).toBe(all > 2)
    expect(shaped.results[0]).toEqual({ name: expect.any(String), node: expect.any(String) })

    const badJq = await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[ | ' })
    expect(badJq.isError).toBe(true)
    expect(badJq.text).toMatch(/jq:/)
    // No environment leaks into the program.
    const env = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: 'env | length' })).text)
    expect(env.results).toEqual([0])

    const table = (await call(request, token, 'k8s_tabular_query', { resource_type: 'pods', namespace: 'kubeast', columns: 'NAME:.metadata.name,PHASE:.status.phase', sort_by: '.metadata.name', limit: 3 })).text
    const lines = table.split('\n')
    expect(lines[0]).toMatch(new RegExp(`^# pods in kubeast: ${all} rows`))
    expect(lines[1]).toMatch(/^NAME\s+PHASE$/)
    expect(lines.length).toBe(2 + Math.min(3, all))
    const names = lines.slice(2).map((l) => l.split(/\s+/)[0])
    expect([...names]).toEqual([...names].sort())

    const count = json((await call(request, token, 'k8s_count', { resource_type: 'pods', namespace: 'kubeast', group_by: '.status.phase' })).text)
    expect(count.count).toBe(all)
    const runningGroup = count.groups.find((g: { key: string }) => g.key === 'Running')
    expect(runningGroup?.count).toBe(running.length)
    const nodes = json((await call(request, token, 'k8s_count', { resource_type: 'nodes' })).text)
    expect(nodes.count).toBe(Number(kubectl(`get nodes -o name`).split('\n').filter(Boolean).length))
  })

  test('k8s_diff previews created, changed and unchanged without applying; a Read user is not offered it', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const name = `e2e-diff-${stamp()}`
    const manifest = (a: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  a: "${a}"\n`
    let readerId = ''
    try {
      // Not there yet: the preview says created, and nothing is created.
      const created = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') })).text)
      expect(created).toMatchObject({ status: 'created', kind: 'ConfigMap', name, namespace: 'default', lines_removed: 0 })
      expect(created.lines_added).toBeGreaterThan(3)
      expect(created.diff).toContain(`+    "a": "1"`)
      expect(kubectl(`-n default get configmap ${name} -o name`, true)).toBe('')

      kubectl(`-n default create configmap ${name} --from-literal=a=1`)
      const changed = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('2') })).text)
      expect(changed).toMatchObject({ status: 'changed', lines_added: 1, lines_removed: 1 })
      expect(changed.diff).toContain(`-    "a": "1"`)
      expect(changed.diff).toContain(`+    "a": "2"`)
      expect(changed.note).toMatch(/nothing was applied/)
      expect(kubectl(`-n default get configmap ${name} -o jsonpath='{.data.a}'`).replace(/'/g, '')).toBe('1')

      const unchanged = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') })).text)
      expect(unchanged.status).toBe('unchanged')
      expect(unchanged.diff).toBe('')

      const multi = await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') + '---\n' + manifest('2') })
      expect(multi.isError).toBe(true)
      expect(multi.text).toMatch(/one object per call/)

      // The admin's cluster list offers the preview; a Read user's does not, and a direct call is refused.
      const adminClusters = json((await call(request, admin, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      expect(adminClusters.find((c) => c.id === 'self')!.tools).toContain('k8s_diff')
      const email = `e2e-query-r-${stamp()}@kubeast.local`
      readerId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const readClusters = json((await call(request, reader, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      const readSelf = readClusters.find((c) => c.id === 'self')!
      expect(readSelf.tools).not.toContain('k8s_diff')
      expect(readSelf.tools).toContain('k8s_jq_query')
      expect(readSelf.tools).toContain('k8s_count')
      const refused = await call(request, reader, 'k8s_diff', { yaml_content: manifest('3') })
      expect(refused.isError).toBe(true)
      // A Read user still gets the shrinking tools, as the cluster lets them read.
      const readCount = json((await call(request, reader, 'k8s_count', { resource_type: 'pods', namespace: 'kubeast' })).text)
      expect(readCount.count).toBeGreaterThan(0)
    } finally {
      kubectl(`-n default delete configmap ${name} --ignore-not-found`, true)
      if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin) })
    }
  })
})
