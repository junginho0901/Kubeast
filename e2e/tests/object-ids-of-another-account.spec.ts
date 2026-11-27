import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { sessionToken } from './session-token'

// Account B, of the same roles as account A, sends the ids of A's objects: each read, change and delete is refused and A's object stays.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-objids-pass1!'
const stamp = () => Date.now().toString(36)

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-objids-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const psql = (sql: string) =>
  execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql], { encoding: 'utf8' }).trim()
const quote = (s: string) => `'${s.split("'").join("''")}'`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return sessionToken(res)
}

type Person = { id: string; email: string; token: string }

// A holds Admin on cluster self and B on cluster default, both of the global role Member.
async function twoPeople(request: APIRequestContext): Promise<{ admin: string; a: Person; b: Person }> {
  const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = ((Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { id: number; name: string }[]).find((r) => r.name === 'Member')
  expect(member, 'the role Member').toBeTruthy()
  const person = async (tag: string, cluster: string): Promise<Person> => {
    const email = `e2e-objids-${tag}-${stamp()}@kubeast.local`
    const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E object ids ${tag}`, email, password: PW, role_id: member!.id } })
    expect(made.status(), await made.text()).toBe(201)
    const id = madeUser(String((await made.json()).id), bearer(admin))
    const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role: 'Admin', namespaces: [] } })
    expect(grant.ok(), `grant Admin on ${cluster}: ${await grant.text()}`).toBeTruthy()
    return { id, email, token: await login(request, email, PW) }
  }
  return { admin, a: await person('a', 'self'), b: await person('b', 'default') }
}

async function chatOf(request: APIRequestContext, a: Person, title: string): Promise<string> {
  const made = await request.post('/api/v1/sessions', { headers: bearer(a.token), data: { title } })
  expect(made.status(), await made.text()).toBeLessThan(300)
  return withUndo(String((await made.json()).id), (id) => request.delete(`/api/v1/sessions/${id}`, { headers: bearer(a.token), failOnStatusCode: false }))
}

async function expectRefused(what: string, res: APIResponse, codes: number[], hidden: string[]) {
  const body = await res.text()
  expect(codes, `${what}: ${res.status()} ${body.slice(0, 200)}`).toContain(res.status())
  for (const h of hidden) expect(body, `${what} says nothing of A's object`).not.toContain(h)
}

test.describe('object ids of another account', () => {
  test('a chat of A: B reads, renames, writes to and deletes it by its id, each answered 404, and it stays as A left it', async ({ request }) => {
    const { a, b } = await twoPeople(request)
    const marker = `e2e-objids-chat-${stamp()}`
    const sid = await chatOf(request, a, `${marker} title`)
    const saved = await request.post(`/api/v1/sessions/${sid}/messages`, { headers: bearer(a.token), data: { messages: [{ role: 'user', content: `${marker} question` }, { role: 'assistant', content: `${marker} answer` }] } })
    expect(saved.status(), await saved.text()).toBe(200)
    const asA = async () => (await request.get(`/api/v1/sessions/${sid}`, { headers: bearer(a.token) })).json()
    const was = await asA()
    expect(was.messages.map((m: { content: string }) => m.content)).toEqual([`${marker} question`, `${marker} answer`])

    const asB = bearer(b.token)
    await expectRefused('GET the chat', await request.get(`/api/v1/sessions/${sid}`, { headers: asB }), [404], [marker])
    await expectRefused('GET its earlier messages', await request.get(`/api/v1/sessions/${sid}/messages?before_id=${was.messages[1].id}`, { headers: asB }), [404], [marker])
    await expectRefused('PATCH its title', await request.patch(`/api/v1/sessions/${sid}`, { headers: asB, data: { title: 'renamed by b' } }), [404], [marker])
    await expectRefused('POST a message to it', await request.post(`/api/v1/sessions/${sid}/messages`, { headers: asB, data: { messages: [{ role: 'user', content: 'written by b' }] } }), [404], [marker])
    await expectRefused('DELETE it', await request.delete(`/api/v1/sessions/${sid}`, { headers: asB }), [404], [marker])
    const listed = await (await request.get('/api/v1/sessions', { headers: asB })).json()
    expect(((Array.isArray(listed) ? listed : listed.sessions || listed.items || []) as { id: string }[]).map((s) => s.id), 'B lists its own chats only').not.toContain(sid)

    const now = await asA()
    expect(now.title, 'the title A gave').toBe(was.title)
    expect(now.messages.map((m: { content: string }) => m.content), 'the messages A saved').toEqual(was.messages.map((m: { content: string }) => m.content))
    expect((await request.delete(`/api/v1/sessions/${sid}`, { headers: bearer(a.token) })).status(), 'A deletes its own chat').toBeLessThan(300)
  })

  test('a tool approval of A: B reads, approves and rejects it by its id, each answered 404, and it stays pending', async ({ request }) => {
    const { a, b } = await twoPeople(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: bearer(a.token) })).json()
    test.skip(features.ai?.enabled === false, 'AI is off on this installation: it keeps no tool approvals')
    const sid = await chatOf(request, a, `e2e-objids-approval-${stamp()}`)
    const id = withUndo(`e2e-objids-${stamp()}`, (i) => psql(`DELETE FROM tool_approvals WHERE id = ${quote(i)}`))
    psql(`INSERT INTO tool_approvals (id, session_id, user_id, user_email, cluster, tool, args, status, created_at, expires_at)
      VALUES (${quote(id)}, ${quote(sid)}, ${quote(a.id)}, ${quote(a.email)}, 'self', 'k8s_scale', '{"namespace":"e2e-objids-none","name":"e2e-objids-none","replicas":1}', 'pending',
      now() AT TIME ZONE 'utc', (now() AT TIME ZONE 'utc') + interval '1 hour')`)
    try {
      const mine = await request.get(`/api/v1/ai/tool-approvals/${id}`, { headers: bearer(a.token) })
      expect(mine.status(), 'A reads its own approval').toBe(200)
      expect((await mine.json()).status).toBe('pending')

      const asB = bearer(b.token)
      await expectRefused('GET the approval', await request.get(`/api/v1/ai/tool-approvals/${id}`, { headers: asB }), [404], ['e2e-objids-none', sid])
      await expectRefused('approve it', await request.post(`/api/v1/ai/tool-approvals/${id}/approve`, { headers: asB }), [404], ['e2e-objids-none', sid])
      await expectRefused('reject it', await request.post(`/api/v1/ai/tool-approvals/${id}/reject`, { headers: asB }), [404], ['e2e-objids-none', sid])
      await expectRefused('list the approvals of its chat', await request.get(`/api/v1/ai/tool-approvals?session_id=${sid}`, { headers: asB }), [403, 404], ['e2e-objids-none', id])

      expect(psql(`SELECT status, decided_at IS NULL FROM tool_approvals WHERE id = ${quote(id)}`), 'still pending, never decided').toBe('pending|t')
    } finally {
      psql(`DELETE FROM tool_approvals WHERE id = ${quote(id)}`)
      await request.delete(`/api/v1/sessions/${sid}`, { headers: bearer(a.token), failOnStatusCode: false })
    }
  })

  test('a terminal recording of A: B lists and reads it, each answered 403, and it stays', async ({ request }) => {
    const { admin, a, b } = await twoPeople(request)
    const id = withUndo(`e2e-objids-rec-${stamp()}`, (i) => psql(`DELETE FROM session_recordings WHERE id = ${quote(i)}`))
    psql(`INSERT INTO session_recordings (id, kind, user_id, user_email, cluster, namespace, target, storage, status, bytes, uploaded_bytes, parts, started_at, ended_at)
      VALUES (${quote(id)}, 'exec', ${quote(a.id)}, ${quote(a.email)}, 'self', 'default', 'e2e-objids-pod', 's3', 'interrupted', 64, 0, 0, now(), now())`)
    try {
      const forAdmin = await request.get(`/api/v1/cluster/recordings/${id}`, { headers: bearer(admin) })
      expect(forAdmin.status(), 'an admin reads it').toBe(200)
      expect((await forAdmin.json()).user_email).toBe(a.email)

      const asB = bearer(b.token)
      await expectRefused('GET the recording', await request.get(`/api/v1/cluster/recordings/${id}`, { headers: asB }), [403, 404], [a.email, 'e2e-objids-pod'])
      await expectRefused('GET its cast', await request.get(`/api/v1/cluster/recordings/${id}/cast?format=text`, { headers: asB }), [403, 404], [a.email, 'e2e-objids-pod'])
      await expectRefused('list A\'s recordings', await request.get(`/api/v1/cluster/recordings?user=${encodeURIComponent(a.email)}`, { headers: asB }), [403], [a.email, id])

      expect(psql(`SELECT status FROM session_recordings WHERE id = ${quote(id)}`), 'the recording stays').toBe('interrupted')
    } finally {
      psql(`DELETE FROM session_recordings WHERE id = ${quote(id)}`)
    }
  })

  test('a node drain of A: B asks its status by its id, answered 403 on A\'s cluster and 404 on its own, and it stays', async ({ request }) => {
    const { a, b } = await twoPeople(request)
    const id = withUndo(`e2e-objids-drain-${stamp()}`, (i) => psql(`DELETE FROM node_drains WHERE id = ${quote(i)}`))
    psql(`INSERT INTO node_drains (id, cluster, node, user_id, user_email, status, message, pods_total, pods_done, owner, finished_at)
      VALUES (${quote(id)}, 'self', 'e2e-objids-node', ${quote(a.id)}, ${quote(a.email)}, 'success', 'e2e-objids-drained', 3, 3, 'e2e-objids', now())`)
    const status = (cluster: string, token: string) =>
      request.get(`/api/v1/cluster/nodes/e2e-objids-node/drain/status?cluster=${cluster}&drain_id=${encodeURIComponent(id)}`, { headers: bearer(token) })
    try {
      const mine = await status('self', a.token)
      expect(mine.status(), 'A reads its drain').toBe(200)
      expect((await mine.json()).status).toBe('success')

      await expectRefused('the status on cluster self, where B holds nothing', await status('self', b.token), [403], ['e2e-objids-drained'])
      await expectRefused('the status on cluster default, where B drains nodes', await status('default', b.token), [404], ['e2e-objids-drained'])

      expect(psql(`SELECT status || '|' || message FROM node_drains WHERE id = ${quote(id)}`), 'the drain stays').toBe('success|e2e-objids-drained')
    } finally {
      psql(`DELETE FROM node_drains WHERE id = ${quote(id)}`)
    }
  })
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

const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
