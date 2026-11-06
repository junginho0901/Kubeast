import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Pod exec and a rollout undo ask for the screens' permissions through the AI too (resource.pod.exec,
// resource.workload.rollback, next to ai.tool.*): over MCP and in the chat, Write is not offered exec and is told what
// is missing, while Admin and a custom role holding them go on. Every write tool's audit row says what it was asked to
// do, credentials masked; a read tool's row stays metadata only; an AI exec is also a k8s.pod.exec row. What is held is
// what the cluster shows (kubectl) and what the audit API returns, never only that a call answered.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-aiwrite-pass1!'
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const BUSYBOX = 'docker.io/library/busybox:1.38.0'
const CARD = '[data-testid="tool-approval-card"]'
const MARKER = '/tmp/e2e-ai-write-marker'
const FAKE = { command: 'fake-e2e-pass-1', patch: 'fake-e2e-pass-2', manifest: 'fake-e2e-pass-3' }

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-aiwrite-')), 'kubeconfig')
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

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }

async function rpc(request: APIRequestContext, token: string, method: string, params?: object) {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, failOnStatusCode: false })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).result
}
const callTool = (request: APIRequestContext, token: string, name: string, args: object): Promise<ToolResult> =>
  rpc(request, token, 'tools/call', { name, arguments: { cluster: CLUSTER, ...args } })
const toolNames = async (request: APIRequestContext, token: string): Promise<string[]> =>
  ((await rpc(request, token, 'tools/list')).tools as { name: string }[]).map((t) => t.name)
async function toolsInSelf(request: APIRequestContext, token: string): Promise<string[]> {
  const listed = await callTool(request, token, 'list_clusters', {})
  const clusters = JSON.parse(listed.content[0].text).clusters as { id: string; tools: string[] }[]
  return clusters.find((c) => c.id === CLUSTER)?.tools ?? []
}

type Row = { service: string; result: string; error: string; target: string; after: Record<string, any> }
async function auditRows(request: APIRequestContext, admin: string, action: string, actorEmail: string): Promise<Row[]> {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=100`, { headers: bearer(admin) })
  expect(res.ok(), await res.text()).toBeTruthy()
  const items = ((await res.json()).items ?? []) as any[]
  return items.filter((i) => (i.ActorEmail ?? i.actor_email) === actorEmail).map((r) => ({
    service: r.Service ?? r.service, result: r.Result ?? r.result, error: r.Error ?? r.error ?? '', after: r.After ?? r.after ?? {},
    target: [r.TargetType ?? r.target_type, r.Namespace ?? r.namespace, r.TargetID ?? r.target_id].join(' '),
  }))
}

async function mcpWriteOn(request: APIRequestContext, admin: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
  const cfg = config.ok() ? await config.json() : {}
  test.skip(!cfg.enabled || !cfg.write_tools, 'MCP write tools are off (mcp.enabled + mcp.writeTools)')
}

async function createUser(request: APIRequestContext, admin: string, email: string, role: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E AI write', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id as string
  const put = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role } })
  expect(put.ok(), `grant ${role}: ${await put.text()}`).toBeTruthy()
  return id
}

async function issueKey(request: APIRequestContext, token: string, ceiling: string): Promise<string> {
  const res = await request.post('/api/v1/auth/api-keys', { headers: bearer(token), data: { name: `e2e ai write ${ceiling}`, expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: ceiling } })
  expect(res.status(), `issue ${ceiling} key: ${await res.text()}`).toBe(201)
  return (await res.json()).key
}

// A Pod with a shell for exec, and a Deployment at its second revision for undo.
function fixture(ns: string) {
  kubectl(`create namespace ${ns}`)
  kubectl(`-n ${ns} run runner --image=${BUSYBOX} --command -- sleep 3600`)
  kubectl(`-n ${ns} wait --for=condition=Ready pod/runner --timeout=120s`)
  kubectl(`-n ${ns} create deployment web --image=registry.k8s.io/pause:3.10`)
  kubectl(`-n ${ns} rollout status deployment/web --timeout=120s`)
  kubectl(`-n ${ns} set env deployment/web E2E_REV=2`)
  kubectl(`-n ${ns} rollout status deployment/web --timeout=120s`)
}
const env = (ns: string) => kubectl(`-n ${ns} get deployment web -o jsonpath={.spec.template.spec.containers[0].env}`)
const restartedAt = (ns: string) => kubectl(`-n ${ns} get deployment web -o 'jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'`)
const markerExists = (ns: string) => tryKubectl(`-n ${ns} exec runner -- ls ${MARKER}`) !== null

const stamp = () => Date.now().toString(36)
const writeExec = (ns: string) => ({ pod_name: 'runner', namespace: ns, command: ['touch', MARKER] })
const undo = (ns: string) => ({ action: 'undo', resource_type: 'deployment', resource_name: 'web', namespace: ns })

test.describe('AI write tools ask for the screens permissions', () => {
  test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')

  test('Write is not offered Pod exec, is refused exec and undo with the permission named, and keeps its other rollouts', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    await mcpWriteOn(request, admin)
    const s = stamp()
    const ns = `e2e-aiw-w-${s}`
    const email = `e2e-aiw-w-${s}@kubeast.local`
    let userId = ''
    try {
      fixture(ns)
      userId = await createUser(request, admin, email, 'Write')
      const key = await issueKey(request, await login(request, email, PW), 'Write')

      const names = await toolNames(request, key)
      expect(names).not.toContain('k8s_execute_command')
      expect(names).toContain('k8s_rollout')
      expect(await toolsInSelf(request, key)).not.toContain('k8s_execute_command')

      const exec = await callTool(request, key, 'k8s_execute_command', writeExec(ns))
      expect(exec.isError).toBe(true)
      expect(exec.content[0].text).toContain('resource.pod.exec')
      expect(markerExists(ns), 'the command did not run').toBe(false)

      const refused = await callTool(request, key, 'k8s_rollout', undo(ns))
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toContain('resource.workload.rollback')
      expect(env(ns), 'the revision did not move').toContain('E2E_REV')

      const restart = await callTool(request, key, 'k8s_rollout', { action: 'restart', resource_type: 'deployment', resource_name: 'web', namespace: ns })
      expect(restart.isError, restart.content[0].text).toBeFalsy()
      await expect.poll(() => restartedAt(ns), { timeout: 30_000 }).not.toBe('')

      const rows = await auditRows(request, admin, 'ai.mcp.call', email)
      const execRow = rows.find((r) => r.after.tool === 'k8s_execute_command')
      expect(execRow?.result).toBe('failure')
      expect(execRow?.error).toContain('resource.pod.exec')
      expect(execRow?.after.command, 'what it tried stays').toEqual(['touch', MARKER])
      const undoRow = rows.find((r) => r.after.tool === 'k8s_rollout' && r.after.rollout_action === 'undo')
      expect(undoRow?.result).toBe('failure')
      expect(undoRow?.error).toContain('resource.workload.rollback')
      expect(rows.find((r) => r.after.rollout_action === 'restart')?.result).toBe('success')
      expect(await auditRows(request, admin, 'k8s.pod.exec', email), 'no exec ran').toEqual([])
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('Admin runs exec and undo, and each write row says what it was asked to do with its credentials masked', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    await mcpWriteOn(request, admin)
    const me = await (await request.get('/api/v1/auth/me', { headers: bearer(admin) })).json()
    const email = String(me.email ?? me.user?.email)
    const ns = `e2e-aiw-a-${stamp()}`
    try {
      fixture(ns)
      expect(await toolNames(request, admin)).toContain('k8s_execute_command')

      const script = `touch ${MARKER}; echo --password=${FAKE.command}`
      const exec = await callTool(request, admin, 'k8s_execute_command', { pod_name: 'runner', namespace: ns, command: ['sh', '-c', script] })
      expect(exec.isError, exec.content[0].text).toBeFalsy()
      expect(markerExists(ns), 'the command ran').toBe(true)

      const back = await callTool(request, admin, 'k8s_rollout', undo(ns))
      expect(back.isError, back.content[0].text).toBeFalsy()
      await expect.poll(() => env(ns), { timeout: 30_000 }).not.toContain('E2E_REV')

      kubectl(`-n ${ns} create configmap conf --from-literal=old=1`)
      const patch = { data: { token: FAKE.patch, plain: 'keep-me' } }
      const patched = await callTool(request, admin, 'k8s_patch_resource', { resource_type: 'configmap', resource_name: 'conf', namespace: ns, patch, patch_type: 'merge' })
      expect(patched.isError, patched.content[0].text).toBeFalsy()
      expect(kubectl(`-n ${ns} get configmap conf -o jsonpath={.data.token}`), 'the patch itself was not touched').toBe(FAKE.patch)

      const manifest = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: made\n  namespace: ${ns}\nstringData:\n  anything: ${FAKE.manifest}\n`
      const applied = await callTool(request, admin, 'k8s_apply_manifest', { yaml_content: manifest })
      expect(applied.isError, applied.content[0].text).toBeFalsy()
      expect(Buffer.from(kubectl(`-n ${ns} get secret made -o jsonpath={.data.anything}`), 'base64').toString(), 'the manifest itself was not touched').toBe(FAKE.manifest)

      const read = await callTool(request, admin, 'k8s_get_resources', { resource_type: 'configmaps', namespace: ns })
      expect(read.isError, read.content[0].text).toBeFalsy()

      const inNs = (await auditRows(request, admin, 'ai.mcp.call', email)).filter((r) => r.target.includes(ns))
      const execRow = inNs.find((r) => r.after.tool === 'k8s_execute_command')
      expect(execRow?.after.command?.slice(0, 2)).toEqual(['sh', '-c'])
      expect(execRow?.after.command?.[2]).toContain(`touch ${MARKER}`)
      expect(execRow?.after.command_len).toBe('sh'.length + '-c'.length + script.length)
      const undoRow = inNs.find((r) => r.after.rollout_action === 'undo')
      expect(undoRow?.result).toBe('success')
      const patchRow = inNs.find((r) => r.after.tool === 'k8s_patch_resource')
      expect(patchRow?.after.patch_type).toBe('merge')
      expect(patchRow?.after.patch_len).toBe(JSON.stringify(patch).replace(/":/g, '": ').replace(/,"/g, ', "').length)
      expect(patchRow?.after.patch_preview).toContain('plain: keep-me')
      const applyRow = inNs.find((r) => r.after.tool === 'k8s_apply_manifest')
      expect(applyRow?.after.manifest_len).toBe(manifest.length)
      expect(applyRow?.after.manifest_preview).toContain('kind: Secret')
      const readRow = inNs.find((r) => r.after.tool === 'k8s_get_resources')
      expect(readRow?.after.write).toBe(false)
      for (const field of ['command', 'patch_len', 'patch_preview', 'manifest_len', 'manifest_preview']) expect(readRow?.after, field).not.toHaveProperty(field)

      const execRows = (await auditRows(request, admin, 'k8s.pod.exec', email)).filter((r) => r.target === `pod ${ns} runner`)
      expect(execRows).toHaveLength(1)
      expect(execRows[0].service).toBe('ai')
      expect(execRows[0].result).toBe('success')
      expect(execRows[0].after.tool).toBe('k8s_execute_command')
      expect(execRows[0].after.command?.[2]).toContain(`touch ${MARKER}`)
      expect(execRows[0].after, 'one command, not a terminal: no recording').not.toHaveProperty('recording_id')

      // Sealed rows keep what they hold: none of the values, in any row of this run, and no digest of them to guess against
      // (a cluster request's Audit-ID and an approval's id are hex too, and random: they come from no value).
      const text = JSON.stringify([...inNs, ...execRows])
      for (const value of Object.values(FAKE)) expect(text).not.toContain(value)
      expect(text.replace(/"(audit_id|approval_id)":"[^"]*"/g, '')).not.toMatch(/\b[0-9a-f]{32,}\b/)
    } finally {
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('a cluster Admin and a custom role holding the permissions are offered exec; a custom role without them, or a Write ceiling, is not', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    await mcpWriteOn(request, admin)
    const s = stamp()
    const ns = `e2e-aiw-c-${s}`
    const users: string[] = []
    const roles: number[] = []
    async function role(name: string, permissions: string[]) {
      const res = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions } })
      expect(res.status(), await res.text()).toBeLessThan(300)
      roles.push((await res.json()).id)
    }
    async function person(tag: string, grant: string) {
      const email = `e2e-aiw-${tag}-${s}@kubeast.local`
      users.push(await createUser(request, admin, email, grant))
      return login(request, email, PW)
    }
    try {
      fixture(ns)

      // A cluster Admin runs both, in the cluster.
      const clusterAdmin = await person('admin', 'Admin')
      const exec = await callTool(request, clusterAdmin, 'k8s_execute_command', writeExec(ns))
      expect(exec.isError, exec.content[0].text).toBeFalsy()
      expect(markerExists(ns)).toBe(true)
      const back = await callTool(request, clusterAdmin, 'k8s_rollout', undo(ns))
      expect(back.isError, back.content[0].text).toBeFalsy()
      await expect.poll(() => env(ns), { timeout: 30_000 }).not.toContain('E2E_REV')

      // The ceiling applies: a Write key of that Admin holds neither, an Admin key both.
      const narrow = await issueKey(request, clusterAdmin, 'Write')
      expect(await toolsInSelf(request, narrow)).not.toContain('k8s_execute_command')
      const refused = await callTool(request, narrow, 'k8s_execute_command', writeExec(ns))
      expect(refused.isError).toBe(true)
      expect(refused.content[0].text).toContain('resource.pod.exec')
      const wide = await issueKey(request, clusterAdmin, 'Admin')
      expect(await toolsInSelf(request, wide)).toContain('k8s_execute_command')

      // A custom role's group is not bound on this cluster, so the cluster may still refuse: what this holds is that
      // the app no longer stands in the way of the one with the permissions and does for the one without.
      const holds = `e2e-aiw-holds-${s}`
      const lacks = `e2e-aiw-lacks-${s}`
      await role(holds, ['ai.mcp.use', 'ai.tool.*', 'resource.*.read', 'resource.pod.exec', 'resource.workload.rollback'])
      await role(lacks, ['ai.mcp.use', 'ai.tool.*', 'resource.*.read'])
      const withPerms = await person('holds', holds)
      const withoutPerms = await person('lacks', lacks)

      expect(await toolsInSelf(request, withPerms)).toContain('k8s_execute_command')
      expect((await callTool(request, withPerms, 'k8s_execute_command', writeExec(ns))).content[0].text).not.toContain('needs the permission')
      expect((await callTool(request, withPerms, 'k8s_rollout', undo(ns))).content[0].text).not.toContain('needs the permission')

      expect(await toolsInSelf(request, withoutPerms)).not.toContain('k8s_execute_command')
      expect((await callTool(request, withoutPerms, 'k8s_execute_command', writeExec(ns))).content[0].text).toContain('resource.pod.exec')
      expect((await callTool(request, withoutPerms, 'k8s_rollout', undo(ns))).content[0].text).toContain('resource.workload.rollback')
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })

  test('in the chat a Write user gets a card for a scale whatever words the sentence holds, and no card for exec', async ({ browser, request }) => {
    test.setTimeout(600_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const s = stamp()
    const ns = `e2e-aiw-chat-${s}`
    const email = `e2e-aiw-chat-${s}@kubeast.local`
    let userId = ''
    const ctx = await (browser as Browser).newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      fixture(ns)
      userId = await createUser(request, admin, email, 'Write')
      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await page.goto(`/ai-chat?cluster=${CLUSTER}`)
      await page.waitForLoadState('networkidle')
      const input = page.getByPlaceholder(/메시지|message/i)
      const ask = async (question: string) => {
        await input.fill(question)
        await page.getByRole('button', { name: /^전송$|^send$/i }).click()
        await expect(input).toBeDisabled({ timeout: 15_000 })
        await expect(input).toBeEnabled({ timeout: 180_000 })
      }

      // The sentence holds words the chat used to stop at (스케일, 실행); the role may do this, so the card comes.
      const scale = `${ns} 네임스페이스의 web 디플로이먼트를 replicas 2로 스케일 실행해줘. k8s_scale 툴을 사용해.`
      for (let attempt = 1; attempt <= 3 && (await page.locator(CARD).count()) === 0; attempt++) await ask(scale)
      const card = page.locator(CARD).last()
      await expect(card).toHaveAttribute('data-approval-status', 'pending', { timeout: 10_000 })
      await expect(card).toContainText('k8s_scale')
      await card.getByRole('button', { name: /거부|reject/i }).click()
      await expect(card).toHaveAttribute('data-approval-status', 'rejected', { timeout: 15_000 })
      expect(kubectl(`-n ${ns} get deployment web -o jsonpath={.spec.replicas}`), 'a rejected card changes nothing').toBe('1')

      // Exec is not this role's: whatever the model does, no card for it and nothing runs.
      const cards = await page.locator(CARD).count()
      await ask(`${ns} 네임스페이스의 runner 파드에서 touch ${MARKER} 명령을 실행해줘. k8s_execute_command 툴을 사용해.`)
      await expect(page.locator(CARD)).toHaveCount(cards)
      expect(markerExists(ns), 'the command did not run').toBe(false)
      const asked = await auditRows(request, admin, 'ai.tool.approval_requested', email)
      expect(asked.map((r) => r.after.tool)).toContain('k8s_scale')
      expect(asked.map((r) => r.after.tool)).not.toContain('k8s_execute_command')
    } finally {
      await ctx.close()
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete namespace ${ns} --wait=false`)
    }
  })
})
