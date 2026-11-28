import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'
import { sessionToken } from './session-token'
import { getRoutes } from './get-routes'

// A reader's answer to every GET route holds no field the admin's answer lacks and no value under a secret's name; a refusal passes.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-byrole-pass1!'
const NS = `e2e-byrole-${Date.now().toString(36)}`
const SECRET_VALUE = `e2e-byrole-value-${Date.now().toString(36)}`

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-byrole-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const SECRET_NAMES = new Set([
  'password', 'passwd', 'password_hash', 'hash', 'token', 'access_token', 'refresh_token', 'id_token', 'bearer_token', 'session_token', 'secret',
  'client_secret', 'kubeconfig', 'api_key', 'apikey', 'secret_key', 'private_key', 'access_key', 'key_hash', 'token_hash', 'secret_value', 'tls_key',
])
const MASKED = /^(\*+|<REDACTED[^>]*>|\[REDACTED\])$/i
// Cells a reader's answer has about the reader alone (its grants, what it was refused), which the admin's answer has empty.
const OWN: { route: RegExp; cell: RegExp; why: string }[] = [
  { route: /^\/api\/v1\/auth\/me\?/, cell: /^\$\.(cluster_namespaces|cluster_roles|permissions_matrix)\./, why: "the reader's own grants on each cluster" },
  { route: /^\/api\/v1\/cluster\/features\?/, cell: /^\$\.writeGuardedNamespaces\[\]$/, why: 'the namespaces the reader may not write' },
  { route: /\/logsearch\?/, cell: /^\$\.hiddenNamespace$/, why: "the namespace the reader's search leaves out" },
  { route: /\/resource-graph\?/, cell: /^\$\.forbidden_kinds\[\]$/, why: 'the kinds the reader was refused' },
  { route: /\/timeline\/changes\?/, cell: /^\$\.summary\.not_read\./, why: 'the sources the reader was refused' },
  { route: /^\/api\/v1\/cluster\/overview\?/, cell: /^\$\.(refused\[\]|scoped)$/, why: "the counts the reader was refused and the reader's grant limited to namespaces" },
]
// Cells under a secret's name that hold the name of an object, not a value.
const NAMES: { cell: RegExp; why: string }[] = [
  { cell: /\.env_from\[\]\.secret$/, why: 'the Secret a container reads its environment from, as kubectl get pod shows' },
]

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase()

function cells(value: unknown, at = '$', out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) cells(v, `${at}[]`, out)
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) cells((value as Record<string, unknown>)[k], `${at}.${k}`, out)
  } else {
    out.add(at)
  }
  return out
}

function secretCells(value: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => secretCells(v, `${at}[]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const shown = typeof v === 'string' ? v !== '' && !MASKED.test(v) : !!v && typeof v === 'object' && Object.keys(v).length > 0
      if (SECRET_NAMES.has(snake(k)) && shown && !NAMES.some((n) => n.cell.test(`${at}.${k}`))) out.push(`${at}.${k}`)
      secretCells(v, `${at}.${k}`, out)
    }
  }
  return out
}

type Answer = { status: number; json: unknown; text: string }
async function answer(request: APIRequestContext, route: string, token: string): Promise<Answer> {
  try {
    const res = await request.get(route, { headers: bearer(token), failOnStatusCode: false, maxRedirects: 0, timeout: 30_000 })
    const text = await res.text()
    let json: unknown = undefined
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status(), json, text }
  } catch (e) {
    return { status: 0, json: undefined, text: String(e).split('\n')[0] }
  }
}
const ok = (a: Answer) => a.status >= 200 && a.status < 300

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return sessionToken(res)
}

async function reader(request: APIRequestContext, admin: string, tag: string, globalRole: string, namespaces: string[]): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const role = ((Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { id: number; name: string }[]).find((r) => r.name === globalRole)
  expect(role, `the role ${globalRole}`).toBeTruthy()
  const email = `e2e-byrole-${tag}-${Date.now().toString(36)}@kubeast.local`
  const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E by role ${tag}`, email, password: PW, role_id: role!.id } })
  expect(made.status(), await made.text()).toBe(201)
  const id = madeUser(String((await made.json()).id), bearer(admin))
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read', namespaces } })
  expect(grant.ok(), `grant Read on self: ${await grant.text()}`).toBeTruthy()
  return login(request, email, PW)
}

test.afterAll(() => {
  try {
    kubectl(['delete', 'namespace', NS, '--wait=false'])
  } catch {
    // already gone
  }
})

test('a reader\'s answers hold no more fields than the admin\'s and no secret value', async ({ request }, testInfo) => {
  test.setTimeout(1_200_000)
  kubectl(['create', 'namespace', NS])
  kubectl(['-n', NS, 'create', 'configmap', 'e2e-byrole', '--from-literal=a=1'])
  kubectl(['-n', NS, 'create', 'secret', 'generic', 'e2e-byrole', `--from-literal=password=${SECRET_VALUE}`])
  const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
  const readers: [string, string][] = [
    ['Read on the cluster', await reader(request, admin, 'cluster', 'Read', [])],
    ['Read in one namespace', await reader(request, admin, 'ns', 'Member', [NS])],
  ]
  const { called } = getRoutes(NS)
  expect(called.length, 'GET routes read from the services').toBeGreaterThan(150)

  const problems: string[] = []
  const seen: Record<string, Record<string, number>> = {}
  for (const route of called) {
    const before = await answer(request, route, admin)
    const theirs: (readonly [string, Answer])[] = []
    for (const [who, token] of readers) theirs.push([who, await answer(request, route, token)] as const)
    const after = await answer(request, route, admin)
    seen[route] = Object.fromEntries([['admin', before.status], ...theirs.map(([who, a]) => [who, a.status])])
    for (const [who, a] of theirs) {
      if (a.text.includes(SECRET_VALUE) || a.text.includes(Buffer.from(SECRET_VALUE).toString('base64'))) problems.push(`${route} ${who}: the Secret's value`)
      for (const c of secretCells(a.json)) problems.push(`${route} ${who}: ${c} holds a value`)
      if (!ok(a)) continue
      if (!ok(before) && !ok(after)) {
        problems.push(`${route} ${who}: ${a.status} where the admin had ${before.status} and ${after.status}`)
        continue
      }
      const admins = [...new Set([...cells(ok(before) ? before.json : undefined), ...cells(ok(after) ? after.json : undefined)])]
      // a cell the admin's answer holds more under (null or empty for the reader) holds less, not more
      const held = (c: string) => admins.some((x) => x === c || x.startsWith(`${c}.`) || x.startsWith(`${c}[]`))
      const extra = [...cells(a.json)].filter((c) => !held(c) && !OWN.some((o) => o.route.test(route) && o.cell.test(c)))
      if (extra.length) problems.push(`${route} ${who}: ${extra.length} field(s) the admin's answers lack: ${extra.slice(0, 10).join(' ')}`)
    }
  }
  await testInfo.attach('route-answers-by-role.json', { body: JSON.stringify({ namespace: NS, statuses: seen, problems }, null, 2), contentType: 'application/json' })

  const readerAnswered = Object.values(seen).filter((s) => s['Read on the cluster'] >= 200 && s['Read on the cluster'] < 300).length
  expect(seen['/api/v1/auth/me?cluster=self']['Read in one namespace'], 'the readers are signed in').toBe(200)
  expect(readerAnswered, 'routes the cluster reader was answered 2xx').toBeGreaterThan(20)
  expect(problems).toEqual([])
})

// Accounts made above are deleted after each test too: a test that times out has its request context ended before its own finally runs.
const madeUsers: { id: string; headers: Record<string, string> }[] = []
function madeUser(id: string, headers: Record<string, string>): string {
  madeUsers.push({ id, headers })
  return id
}
test.afterEach(async ({ request }) => {
  for (const { id, headers } of madeUsers.splice(0)) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers, failOnStatusCode: false })
})
