import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The screens' Cordon, Suspend and Run now through the AI: each tool presses the button's route as the user, so what it
// does is held to kubectl and its rows to the audit API, and the role that holds only a button is offered only that.
// tools/list names what a call could do. It skips while mcp.enabled or mcp.writeTools is off.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-buttons-throwaway-1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const STAMP = Date.now().toString(36)
const NS = `e2e-buttons-${STAMP}`
const CRONJOB = 'nightly'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-buttons-')), 'kubeconfig')
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
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E buttons', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function rpc(request: APIRequestContext, token: string, method: string, params?: object) {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).result
}
const listed = async (request: APIRequestContext, token: string): Promise<string[]> =>
  ((await rpc(request, token, 'tools/list')).tools as { name: string }[]).map((t) => t.name).sort()
const call = (request: APIRequestContext, token: string, name: string, args: object) =>
  rpc(request, token, 'tools/call', { name, arguments: { cluster: 'self', ...args } })

const suspendedNow = () => kubectl(`-n ${NS} get cronjob ${CRONJOB} -o jsonpath={.spec.suspend}`)

async function routeRows(request: APIRequestContext, admin: string, action: string, actor: string) {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=100`, { headers: bearer(admin) })
  expect(res.ok()).toBeTruthy()
  return (((await res.json()).items ?? []) as Record<string, unknown>[]).filter((row) => (row.ActorEmail ?? row.actor_email) === actor)
}

test.describe('the screens\' buttons through the AI', () => {
  let admin = ''
  let writer = ''
  let writerId = ''
  const writerEmail = `e2e-buttons-w-${STAMP}@kubeast.local`
  const ids: string[] = []
  const roles: number[] = []

  async function userWithRole(request: APIRequestContext, name: string, permissions: string[]): Promise<string> {
    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions } })
    expect(role.status(), await role.text()).toBe(201)
    roles.push((await role.json()).id)
    const email = `${name}@kubeast.local`
    const id = await createUser(request, admin, email)
    ids.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: name } })).ok()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    const cfg = config.ok() ? await config.json() : {}
    test.skip(!cfg.enabled || !cfg.write_tools, 'MCP write tools are off (mcp.enabled + mcp.writeTools)')
    kubectl(`create namespace ${NS}`)
    kubectl(`-n ${NS} create cronjob ${CRONJOB} --image=registry.k8s.io/pause:3.10 --schedule="0 0 1 1 *"`)
    writerId = await createUser(request, admin, writerEmail)
    ids.push(writerId)
    expect((await request.put(`/api/v1/auth/admin/users/${writerId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Write' } })).ok()).toBeTruthy()
    writer = await login(request, writerEmail, PW)
  })

  test.afterAll(async ({ request }) => {
    for (const id of ids) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    try {
      kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
    } catch { /* the run skipped before making it */ }
  })

  test('Write suspends and resumes a CronJob as the button does, with the button\'s row', async ({ request }) => {
    expect(await listed(request, writer)).toEqual(expect.arrayContaining(['k8s_cronjob_suspend', 'k8s_cronjob_trigger']))
    expect(await listed(request, writer)).not.toContain('k8s_cordon_node')

    const suspended = await call(request, writer, 'k8s_cronjob_suspend', { resource_name: CRONJOB, namespace: NS, suspend: true })
    expect(suspended.isError, JSON.stringify(suspended)).toBeFalsy()
    expect(suspendedNow()).toBe('true')
    const resumed = await call(request, writer, 'k8s_cronjob_suspend', { resource_name: CRONJOB, namespace: NS, suspend: false })
    expect(resumed.isError, JSON.stringify(resumed)).toBeFalsy()
    expect(suspendedNow()).toBe('false')

    const row = (await routeRows(request, admin, 'k8s.cronjob.suspend', writerEmail))[0]
    expect(row?.UserAgent ?? row?.user_agent).toBe('kubeast-tool-server')
  })

  test('Write runs a CronJob now: the Job the answer names is on the cluster', async ({ request }) => {
    const ran = await call(request, writer, 'k8s_cronjob_trigger', { resource_name: CRONJOB, namespace: NS })
    expect(ran.isError, JSON.stringify(ran)).toBeFalsy()
    const job = JSON.parse(ran.content[0].text).job_name as string
    expect(kubectl(`-n ${NS} get job ${job} -o jsonpath={.metadata.ownerReferences[0].name}`)).toBe(CRONJOB)
  })

  test('Write is refused a cordon, naming the permission, and the node stays as it was', async ({ request }) => {
    const node = kubectl(`get nodes -o jsonpath={.items[0].metadata.name}`)
    const refused = await call(request, writer, 'k8s_cordon_node', { resource_name: node })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('resource.node.cordon')
    expect(kubectl(`get node ${node} -o jsonpath={.spec.unschedulable}`)).toBe('')
  })

  test('an admin cordons and uncordons a node of the second cluster as the button does', async ({ request }) => {
    const second = kubectlFor('kubeast-b')
    const node = second(`get nodes -o jsonpath={.items[0].metadata.name}`)
    try {
      const cordoned = await rpc(request, admin, 'tools/call', { name: 'k8s_cordon_node', arguments: { cluster: 'default', resource_name: node } })
      expect(cordoned.isError, JSON.stringify(cordoned)).toBeFalsy()
      expect(second(`get node ${node} -o jsonpath={.spec.unschedulable}`)).toBe('true')
      const back = await rpc(request, admin, 'tools/call', { name: 'k8s_cordon_node', arguments: { cluster: 'default', resource_name: node, uncordon: true } })
      expect(back.isError, JSON.stringify(back)).toBeFalsy()
      expect(second(`get node ${node} -o jsonpath={.spec.unschedulable}`)).toBe('')
    } finally {
      second(`uncordon ${node}`)
    }
  })

  test('tools/list names what the role holds, not every read tool', async ({ request }) => {
    // a read tool behind a list asks the role's read key, as the list does (read_gate.go)
    const oneRead = await userWithRole(request, `e2e-btn-read-${STAMP}`, ['ai.mcp.use', 'ai.tool.k8s_get_resources', 'resource.objects.read'])
    expect(await listed(request, oneRead)).toEqual(['k8s_get_resources', 'list_clusters', 'request_access'])

    const oneButton = await userWithRole(request, `e2e-btn-run-${STAMP}`, ['ai.mcp.use', 'ai.tool.k8s_cronjob_trigger', 'resource.cronjob.trigger'])
    expect(await listed(request, oneButton)).toEqual(['k8s_cronjob_trigger', 'list_clusters', 'request_access'])
  })

  test('a tool asking two permissions is listed only with both', async ({ request }) => {
    const one = await userWithRole(request, `e2e-btn-one-${STAMP}`, ['ai.mcp.use', 'ai.tool.alert_investigate', 'resource.alert.investigate'])
    expect(await listed(request, one)).not.toContain('alert_investigate')
    const both = await userWithRole(request, `e2e-btn-two-${STAMP}`, ['ai.mcp.use', 'ai.tool.alert_investigate', 'resource.alert.investigate', 'resource.*.read'])
    expect(await listed(request, both)).toContain('alert_investigate')
  })
})
