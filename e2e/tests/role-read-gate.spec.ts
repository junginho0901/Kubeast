import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// k8s-service's read gate (internal/handler/read_gate.go). The role screen's read permissions decide before the cluster
// does: a custom role reads a list only with resource.objects.read or resource.*.read, whatever its group is bound to. The
// key alone opens no Pod logs, Helm or Cost. Each role here is bound to the view ClusterRole, so a refusal is the app's.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const PW = 'E2e-readgate-pass1!'
const CLUSTER = 'self'
const KEY = 'resource.objects.read'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const MIGRATION = path.resolve(__dirname, '../../services/pkg/dbmigrate/migrations/00022_custom_roles_keep_lists.sql')

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-readgate-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const tryKubectl = (args: string[]) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type RoleRow = { id: number; name: string; permissions: string[] | null }
async function rolesOf(request: APIRequestContext, admin: string): Promise<RoleRow[]> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  return Array.isArray(raw) ? raw : raw.roles || raw.items || []
}

// Custom roles and accounts of one test, its namespace, and what the chart renders for a role's group, done by hand.
function people(request: APIRequestContext, admin: string) {
  const users: string[] = []
  const roles: number[] = []
  const bound: string[] = []
  return {
    async role(name: string, permissions: string[]) {
      const res = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions } })
      expect(res.status(), await res.text()).toBe(201)
      roles.push((await res.json()).id)
      bound.push(name)
      kubectl(['create', 'clusterrole', `${name}-imp`, '--verb=impersonate', '--resource=groups', `--resource-name=kubeast:role:${name}`])
      kubectl(['create', 'clusterrolebinding', `${name}-imp`, `--clusterrole=${name}-imp`, '--serviceaccount=kubeast:k8s-service', '--serviceaccount=kubeast:tool-server'])
      kubectl(['create', 'clusterrolebinding', `${name}-view`, '--clusterrole=view', `--group=kubeast:role:${name}`])
    },
    async person(tag: string, grant: string, namespaces?: string[]) {
      const email = `e2e-readgate-${tag}-${stamp()}@kubeast.local`
      const member = (await rolesOf(request, admin)).find((r) => r.name.toLowerCase() === 'member')
      const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E read gate', email, password: PW, role_id: member?.id } })
      expect(res.status(), `create ${email}`).toBe(201)
      const id = (await res.json()).id as string
      users.push(id)
      const put = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: grant, ...(namespaces ? { namespaces } : {}) } })
      expect(put.ok(), `grant ${grant}: ${await put.text()}`).toBeTruthy()
      return { email, token: await login(request, email, PW) }
    },
    async cleanup() {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const name of bound) {
        tryKubectl(['delete', 'clusterrolebinding', `${name}-imp`, `${name}-view`, '--ignore-not-found'])
        tryKubectl(['delete', 'clusterrole', `${name}-imp`, '--ignore-not-found'])
      }
    },
  }
}

function fixture(ns: string) {
  kubectl(['create', 'namespace', ns])
  kubectl(['-n', ns, 'create', 'configmap', 'gate-cm', '--from-literal=a=1'])
  kubectl(['-n', ns, 'run', 'gate-pod', '--image=docker.io/library/busybox:1.38.0', '--command', '--', 'sh', '-c', 'echo gate-log-line; sleep 3600'])
  kubectl(['-n', ns, 'wait', '--for=condition=Ready', 'pod/gate-pod', '--timeout=120s'])
}

const lists = (ns: string) => [
  `/api/v1/cluster/namespaces/${ns}/configmaps`,
  `/api/v1/cluster/namespaces/${ns}/configmaps/gate-cm/describe`,
  `/api/v1/cluster/namespaces/${ns}/configmaps/gate-cm/yaml`,
  `/api/v1/cluster/namespaces/${ns}/pods`,
  `/api/v1/cluster/resources?resource_type=configmaps&namespace=${ns}`,
]

async function get(request: APIRequestContext, token: string, url: string) {
  const res = await request.get(`${url}${url.includes('?') ? '&' : '?'}cluster=${CLUSTER}`, { headers: bearer(token), failOnStatusCode: false })
  return { status: res.status(), body: await res.text() }
}

async function expectRefusedForTheKey(request: APIRequestContext, token: string, ns: string) {
  for (const url of lists(ns)) {
    const answer = await get(request, token, url)
    expect(answer.status, `${url}: ${answer.body}`).toBe(403)
    expect(answer.body, url).toContain(`requires ${KEY} permission`)
    expect(answer.body, url).not.toContain('gate-cm')
  }
}

async function expectListsRead(request: APIRequestContext, token: string, ns: string) {
  for (const url of lists(ns)) {
    const answer = await get(request, token, url)
    expect(answer.status, `${url}: ${answer.body}`).toBe(200)
  }
  expect((await get(request, token, lists(ns)[0])).body).toContain('gate-cm')
}

// What asks more than the key: its own permission named, and nothing of what it guards.
async function expectOwnReadsRefused(request: APIRequestContext, token: string, ns: string) {
  for (const [url, permission] of [
    [`/api/v1/cluster/namespaces/${ns}/pods/gate-pod/logs`, 'resource.pod.read'],
    ['/api/v1/helm/releases', 'resource.helm.read'],
    ['/api/v1/cluster/cost/status', 'resource.cost.read'],
    ['/api/v1/cluster/policyreports/status', 'resource.policyreport.read'],
  ]) {
    const answer = await get(request, token, url)
    expect(answer.status, `${url}: ${answer.body}`).toBe(403)
    expect(answer.body, url).toContain(permission)
    expect(answer.body, url).not.toContain('gate-log-line')
  }
}

async function userPage(browser: Browser, email: string) {
  const ctx = await browser.newContext({ baseURL: BASE, locale: 'en-US' })
  const res = await ctx.request.post('/api/v1/auth/login', { data: { email, password: PW } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { ctx, page: await ctx.newPage() }
}

type Frame = { type: string; error?: { message: string; reason: string }; data?: unknown }

// The first frame of a live list, from the app's origin so the session cookie goes along. A static file, so no screen opens its own.
async function firstFrame(page: Page, ns: string): Promise<Frame> {
  await page.goto('/color-mode.js')
  return page.evaluate(
    ({ ns, cluster }) =>
      new Promise<Frame>((resolve, reject) => {
        const base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
        const socket = new WebSocket(`${base}/api/v1/cluster/wsMultiplexer?cluster=${cluster}`)
        const timer = setTimeout(() => reject(new Error('no frame in 30 s')), 30_000)
        socket.onopen = () => socket.send(JSON.stringify({ type: 'REQUEST', clusterId: cluster, path: `/api/v1/namespaces/${ns}/configmaps`, query: 'watch=1' }))
        socket.onmessage = (e) => {
          clearTimeout(timer)
          socket.close()
          resolve(JSON.parse(e.data))
        }
      }),
    { ns, cluster: CLUSTER },
  )
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }
async function rpc(request: APIRequestContext, token: string, method: string, params?: object) {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).result
}
const callTool = (request: APIRequestContext, token: string, name: string, args: object): Promise<ToolResult> =>
  rpc(request, token, 'tools/call', { name, arguments: { cluster: CLUSTER, ...args } })
async function toolsOffered(request: APIRequestContext, token: string): Promise<string[]> {
  const listed = await callTool(request, token, 'list_clusters', {})
  const clusters = JSON.parse(listed.content[0].text).clusters as { id: string; tools: string[] }[]
  return clusters.find((c) => c.id === CLUSTER)?.tools ?? []
}

test.describe('the role screen decides who reads a list', () => {
  test.setTimeout(240_000)

  test('a custom role reads the lists only with the key or All resources: read, however the cluster binds its group', async ({ browser, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = people(request, admin)
    const s = stamp()
    const ns = `e2e-readgate-a-${s}`
    try {
      fixture(ns)
      const none = `e2e-gate-none-${s}`
      const key = `e2e-gate-key-${s}`
      const all = `e2e-gate-all-${s}`
      await ctx.role(none, ['menu.*'])
      await ctx.role(key, ['menu.*', KEY])
      await ctx.role(all, ['menu.*', 'resource.*.read'])
      const withNone = await ctx.person('none', none)
      const withKey = await ctx.person('key', key)
      const withAll = await ctx.person('all', all)

      // The cluster would serve all of it to each group: what refuses below is the app.
      for (const name of [none, key, all]) {
        expect(kubectl(['-n', ns, 'auth', 'can-i', 'list', 'configmaps', '--as=e2e', `--as-group=kubeast:role:${name}`]), name).toBe('yes')
        expect(kubectl(['-n', ns, 'auth', 'can-i', 'get', 'pods/log', '--as=e2e', `--as-group=kubeast:role:${name}`]), name).toBe('yes')
      }

      await expectRefusedForTheKey(request, withNone.token, ns)
      await expectOwnReadsRefused(request, withNone.token, ns)

      await expectListsRead(request, withKey.token, ns)
      await expectOwnReadsRefused(request, withKey.token, ns)

      await expectListsRead(request, withAll.token, ns)
      const logs = await get(request, withAll.token, `/api/v1/cluster/namespaces/${ns}/pods/gate-pod/logs`)
      expect(logs.status, logs.body).toBe(200)
      expect(logs.body).toContain('gate-log-line')

      // What has no object in it stays open: the screens read these to draw themselves.
      for (const url of ['/api/v1/cluster/features', '/api/v1/cluster/api-resources', '/api/v1/cluster/can-i?verb=list&resource=configmaps&namespace=default']) {
        const answer = await get(request, withNone.token, url)
        expect(answer.status, `${url}: ${answer.body}`).toBe(200)
      }

      // A live list asks when it opens.
      const noneUser = await userPage(browser, withNone.email)
      const refused = await firstFrame(noneUser.page, ns)
      expect(refused.type).toBe('ERROR')
      expect(refused.error?.reason).toBe('forbidden')
      expect(refused.error?.message).toContain(KEY)
      await noneUser.ctx.close()
      const keyUser = await userPage(browser, withKey.email)
      const opened = await firstFrame(keyUser.page, ns)
      expect(opened.type, JSON.stringify(opened)).toBe('DATA')
      expect(JSON.stringify(opened.data)).toContain('gate-cm')
      await keyUser.ctx.close()
    } finally {
      await ctx.cleanup()
      tryKubectl(['delete', 'namespace', ns, '--wait=false'])
    }
  })

  test('the screen says the role lacks the permission, and does not blame the cluster', async ({ browser, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = people(request, admin)
    const s = stamp()
    const ns = `e2e-readgate-b-${s}`
    try {
      fixture(ns)
      const none = `e2e-gate-scr-none-${s}`
      const key = `e2e-gate-scr-key-${s}`
      await ctx.role(none, ['menu.*'])
      await ctx.role(key, ['menu.*', KEY])
      const url = `/configuration/configmaps?cluster=${CLUSTER}&namespace=${ns}`

      const refused = await userPage(browser, (await ctx.person('scr-none', none)).email)
      await refused.page.goto(url)
      await expect(refused.page.getByTestId('forbidden-read-permission-hint')).toContainText(KEY, { timeout: 20_000 })
      await expect(refused.page.getByTestId('forbidden-custom-role-hint')).toHaveCount(0)
      await expect(refused.page.getByText('gate-cm', { exact: true })).toHaveCount(0)
      await refused.ctx.close()

      const reads = await userPage(browser, (await ctx.person('scr-key', key)).email)
      await reads.page.goto(url)
      await expect(reads.page.getByText('gate-cm', { exact: true })).toHaveText('gate-cm', { timeout: 20_000 })
      await expect(reads.page.getByTestId('forbidden-read-permission-hint')).toHaveCount(0)
      await reads.ctx.close()
    } finally {
      await ctx.cleanup()
      tryKubectl(['delete', 'namespace', ns, '--wait=false'])
    }
  })

  test('the AI asks what the lists ask', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!config.ok() || !(await config.json()).enabled, 'the MCP server is off (mcp.enabled)')
    const ctx = people(request, admin)
    const s = stamp()
    const ns = `e2e-readgate-c-${s}`
    try {
      fixture(ns)
      const none = `e2e-gate-ai-none-${s}`
      const key = `e2e-gate-ai-key-${s}`
      await ctx.role(none, ['ai.mcp.use', 'ai.tool.*'])
      await ctx.role(key, ['ai.mcp.use', 'ai.tool.*', KEY])
      const withNone = await ctx.person('ai-none', none)
      const withKey = await ctx.person('ai-key', key)
      const args = { resource_type: 'configmaps', namespace: ns }

      const refused = await callTool(request, withNone.token, 'k8s_get_resources', args)
      expect(refused.isError, refused.content[0].text).toBe(true)
      expect(refused.content[0].text).toContain(KEY)
      expect(refused.content[0].text).not.toContain('gate-cm')
      const offeredNone = await toolsOffered(request, withNone.token)
      expect(offeredNone).not.toContain('k8s_get_resources')
      expect(offeredNone).toContain('can_i')
      const asked = await callTool(request, withNone.token, 'can_i', { verb: 'list', resource: 'configmaps', namespace: ns })
      expect(asked.isError, asked.content[0].text).toBeFalsy()

      const read = await callTool(request, withKey.token, 'k8s_get_resources', args)
      expect(read.isError, read.content[0].text).toBeFalsy()
      expect(read.content[0].text).toContain('gate-cm')
      const offeredKey = await toolsOffered(request, withKey.token)
      expect(offeredKey).toContain('k8s_get_resources')
      expect(offeredKey).not.toContain('k8s_get_pod_logs')
      const logs = await callTool(request, withKey.token, 'k8s_get_pod_logs', { pod_name: 'gate-pod', namespace: ns })
      expect(logs.isError, logs.content[0].text).toBe(true)
      expect(logs.content[0].text).toContain('resource.pod.read')
      expect(logs.content[0].text).not.toContain('gate-log-line')
    } finally {
      await ctx.cleanup()
      tryKubectl(['delete', 'namespace', ns, '--wait=false'])
    }
  })

  test('the built-in roles, a grant limited to namespaces and an API key read as they did', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = people(request, admin)
    const s = stamp()
    const ns = `e2e-readgate-d-${s}`
    try {
      fixture(ns)
      const adminOnCluster = await ctx.person('admin', 'Admin')
      const write = await ctx.person('write', 'Write')
      const read = await ctx.person('read', 'Read')
      for (const [name, token] of [['global admin', admin], ['Admin', adminOnCluster.token], ['Write', write.token], ['Read', read.token]]) {
        const answer = await get(request, token, lists(ns)[0])
        expect(answer.status, `${name}: ${answer.body}`).toBe(200)
        expect(answer.body, name).toContain('gate-cm')
      }
      const logs = await get(request, read.token, `/api/v1/cluster/namespaces/${ns}/pods/gate-pod/logs`)
      expect(logs.status, logs.body).toBe(200)
      expect(logs.body).toContain('gate-log-line')

      // A grant limited to namespaces gets past the gate, and is held to its namespaces by the next check.
      const limited = await ctx.person('limited', 'Read', [ns])
      const inside = await get(request, limited.token, lists(ns)[0])
      expect(inside.body).not.toContain(KEY)
      const outside = await get(request, limited.token, '/api/v1/cluster/namespaces/kube-system/configmaps')
      expect(outside.status, outside.body).toBe(403)
      expect(outside.body).toContain('outside your grant')

      // A key under the Read ceiling on a custom role keeps the lists that role reads, and gains nothing.
      const custom = `e2e-gate-apikey-${s}`
      await ctx.role(custom, ['menu.*', KEY])
      const holder = await ctx.person('apikey', custom)
      const keysOn = await request.get('/api/v1/auth/api-keys/config', { headers: bearer(holder.token), failOnStatusCode: false })
      if (keysOn.ok() && (await keysOn.json()).enabled) {
        const issued = await request.post('/api/v1/auth/api-keys', { headers: bearer(holder.token), data: { name: 'e2e read gate', expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: 'Read' } })
        expect(issued.status(), await issued.text()).toBe(201)
        const exchanged = await request.post('/api/v1/auth/token', { headers: { Authorization: `Bearer ${(await issued.json()).key}` }, failOnStatusCode: false })
        expect(exchanged.status(), await exchanged.text()).toBe(200)
        const keyToken = (await exchanged.json()).access_token as string
        await expectListsRead(request, keyToken, ns)
        await expectOwnReadsRefused(request, keyToken, ns)
      }
    } finally {
      await ctx.cleanup()
      tryKubectl(['delete', 'namespace', ns, '--wait=false'])
    }
  })

  test("an investigation's token reads the lists it read, and not Helm or Cost", async () => {
    // Asked for as ai-service asks, from its pod; the answer printed holds statuses and bodies, not the token.
    const script = `
import json, os, urllib.error, urllib.request

K8S = 'http://k8s-service:8002/api/v1'
CLUSTER = '${CLUSTER}'

def call(method, url, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json', **headers})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return {'status': res.status, 'body': res.read().decode()}
    except urllib.error.HTTPError as err:
        return {'status': err.code, 'body': err.read().decode()}

if 'AUTH_INVESTIGATOR_TOKEN_URL' not in os.environ:
    print(json.dumps({'off': True}))
    raise SystemExit(0)
issued = call('POST', os.environ['AUTH_INVESTIGATOR_TOKEN_URL'], {'X-Internal-Token': os.environ['INTERNAL_API_TOKEN']}, {'cluster_id': CLUSTER})
if issued['status'] != 200:
    print(json.dumps({'off': True, 'status': issued['status']}))
    raise SystemExit(0)
token = {'Authorization': 'Bearer ' + json.loads(issued['body'])['access_token']}
print(json.dumps({
    'list': call('GET', K8S + '/namespaces/default/configmaps?cluster=' + CLUSTER, token),
    'issues': call('GET', K8S + '/issues?namespace=default&cluster=' + CLUSTER, token),
    'helm': call('GET', K8S + '/helm/releases?cluster=' + CLUSTER, token),
    'cost': call('GET', K8S + '/cost/status?cluster=' + CLUSTER, token),
    'tool': call('POST', os.environ.get('TOOL_SERVER_URL', 'http://tool-server:8086') + '/tools/call', token, {'name': 'k8s_get_resources', 'arguments': {'cluster': CLUSTER, 'resource_type': 'configmaps', 'namespace': 'default'}}),
}))
`
    const out = JSON.parse(execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', '-i', 'deploy/ai-service', '--', 'python', '-'], { input: script, encoding: 'utf8' }))
    test.skip(out.off === true, 'alert investigation (the investigator token) is off')
    expect(out.list.status, out.list.body).toBe(200)
    expect(out.list.body).toContain('kube-root-ca.crt')
    expect(out.issues.status, out.issues.body).toBe(200)
    expect(out.helm.status, out.helm.body).toBe(403)
    expect(out.helm.body).toContain('resource.helm.read')
    expect(out.cost.status, out.cost.body).toBe(403)
    expect(out.cost.body).toContain('resource.cost.read')
    expect(out.tool.status, out.tool.body).toBe(200)
    expect(JSON.parse(out.tool.body).content, 'the tool reads for it').toContain('kube-root-ca.crt')
  })

  // The statements of the migration itself, on the dev database. They touch every custom role there, which only adds
  // what each could read anyway, and end the tokens of those roles' holders: no other spec runs alongside.
  test('an upgrade leaves each role reading what it read', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ctx = people(request, admin)
    const s = stamp()
    const ns = `e2e-readgate-e-${s}`
    const up = fs.readFileSync(MIGRATION, 'utf8').split('-- +goose Down')[0]
    expect(up).toContain(KEY)
    try {
      fixture(ns)
      const old = `e2e-gate-old-${s}`
      const wide = `e2e-gate-wide-${s}`
      const empty = `e2e-gate-empty-${s}`
      const auditor = `e2e-gate-auditor-${s}`
      const oldPerms = ['ai.mcp.use', 'ai.tool.*', 'menu.*']
      const widePerms = ['menu.*', 'resource.*.read']
      await ctx.role(old, oldPerms)
      await ctx.role(wide, widePerms)
      await ctx.role(empty, [])
      await ctx.role(auditor, ['admin.audit.read'])
      const before = await ctx.person('old', old)
      const systemBefore = (await rolesOf(request, admin)).filter((r) => ['Read', 'Write', 'Admin', 'Member', 'Pending'].includes(r.name))
      await expectRefusedForTheKey(request, before.token, ns)

      psql(up)

      const after = await rolesOf(request, admin)
      const held = (name: string) => [...(after.find((r) => r.name === name)?.permissions ?? [])].sort()
      expect(held(old)).toEqual([...oldPerms, KEY].sort())
      expect(held(wide), 'a wildcard already holds it').toEqual([...widePerms].sort())
      expect(held(empty), 'a role with nothing reaches no cluster, and stays so').toEqual([])
      expect(held(auditor), 'admin keys granted on no cluster open pages, not lists').toEqual(['admin.audit.read'])
      const sorted = (r: RoleRow) => ({ name: r.name, permissions: [...(r.permissions ?? [])].sort() })
      expect(after.filter((r) => systemBefore.some((b) => b.id === r.id)).map(sorted), 'the built-in roles').toEqual(systemBefore.map(sorted))

      // The token from before holds no key: its owner signs in again.
      await expect.poll(async () => (await request.get('/api/v1/auth/me', { headers: bearer(before.token), failOnStatusCode: false })).status(), { timeout: 30_000 }).toBe(401)
      const token = await login(request, before.email, PW)
      await expectListsRead(request, token, ns)
      await expectOwnReadsRefused(request, token, ns)
    } finally {
      await ctx.cleanup()
      tryKubectl(['delete', 'namespace', ns, '--wait=false'])
    }
  })

  test('the role form starts with the key, and warns when a role would read no list', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const body = await (await request.get('/api/v1/auth/permissions', { headers: bearer(admin) })).json()
    const categories: { category: string; permissions: { key: string; description: string }[] }[] = Array.isArray(body) ? body : body.categories ?? body.items
    const resources = categories.find((c) => c.category === 'Resources')?.permissions.map((p) => p.key) ?? []
    expect(resources, 'offered next to All resources: read').toEqual(expect.arrayContaining([KEY, 'resource.*.read']))

    await page.goto('/admin/roles')
    await page.getByRole('button', { name: /^(Create Role|역할 생성)$/ }).click()
    const box = (key: RegExp) => page.locator('label', { hasText: key }).locator('input[type="checkbox"]')
    const keyBox = box(/^resource\.objects\.read/)
    const hint = page.getByTestId('role-no-list-hint')
    await expect(keyBox).toHaveCount(1)
    expect(await keyBox.isChecked(), 'a new role reads the lists it is bound to').toBe(true)
    await expect(hint).toHaveCount(0)

    await keyBox.uncheck()
    await expect(hint, 'nothing chosen: a role with nothing reaches no cluster').toHaveCount(0)
    await box(/^menu\.dashboard/).check()
    await expect(hint).toHaveCount(1)
    await box(/^resource\.\*\.read/).check()
    await expect(hint).toHaveCount(0)
  })
})
