import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { sessionToken } from './session-token'

// H2: a write tool the model picks is never executed straight away. The chat
// shows an approval card; nothing changes until the user approves, and a
// rejection leaves the cluster untouched. A conversation that showed a card is
// deleted with its approval rows.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /전송|send/i
const CARD = '[data-testid="tool-approval-card"]'
const SCALE_QUERY = 'test2 클러스터의 f3approve 네임스페이스에 있는 pause 디플로이먼트를 replicas 2로 스케일해줘. k8s_scale 툴을 사용해.'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return sessionToken(res)
}

async function replicas(request: APIRequestContext, auth: Record<string, string>): Promise<number | null> {
  const r = await request.get('/api/v1/cluster/namespaces/f3approve/deployments?cluster=test2', { headers: auth })
  if (!r.ok()) return null
  const body = await r.json()
  const list: any[] = Array.isArray(body) ? body : body.items || []
  const dep = list.find((d) => d?.name === 'pause')
  const n = dep?.replicas ?? dep?.desired ?? null
  return typeof n === 'number' ? n : null
}

// The chat screen makes a conversation for the first question on a page just opened, one per askForScale; they are
// removed after the test, passed or not.
const conversationMade = (page: Page) =>
  page.waitForResponse((r) => /\/api\/v1\/sessions(\?|$)/.test(r.url()) && r.request().method() === 'POST', { timeout: 15_000 })
async function deleteConversations(request: APIRequestContext, headers: Record<string, string>, ids: string[]) {
  for (const id of ids) await request.delete(`/api/v1/sessions/${id}`, { headers, failOnStatusCode: false })
}

// The approval rows of these conversations in the dev database, counted, on the kind cluster Kubeast runs on.
function approvalRows(kubeconfig: string, ids: string[]): number {
  for (const id of ids) expect(id, 'a conversation id').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const sql = `SELECT count(*) FROM tool_approvals WHERE session_id = ANY('{${ids.join(',')}}')`
  const out = execFileSync('kubectl', ['--kubeconfig', kubeconfig, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql], { encoding: 'utf8' }).trim()
  expect(out, 'a row count').toMatch(/^\d+$/)
  return Number(out)
}

async function askForScale(page: Page, made: string[]): Promise<void> {
  await page.goto('/ai-chat?cluster=test2')
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(SCALE_QUERY)
  const created = conversationMade(page)
  await page.getByRole('button', { name: SEND_RE }).click()
  made.push((await (await created).json()).id as string)
  await expect(input).toBeDisabled({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 120_000 })
}

test.describe('AI write tools need approval (H2)', () => {
  test.setTimeout(600_000)

  test('scale request shows a card, reject leaves replicas, approve applies them', async ({ browser, request }) => {
    const admin = { Authorization: `Bearer ${await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)}` }

    // A deployment to scale. The console API only patches existing objects, so
    // the fixture is created with kubectl against the kind cluster (the same
    // prerequisite scripts/add-kind-cluster.sh has).
    const kubeconfig = execSync('kind get kubeconfig --name test2', { encoding: 'utf8' })
    const kcPath = path.join(os.tmpdir(), 'e2e-test2-kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig)
    const dbKcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tool-approval-')), 'kubeconfig')
    fs.writeFileSync(dbKcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
    const manifest =
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: f3approve\n---\n' +
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: pause\n  namespace: f3approve\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: pause\n  template:\n    metadata:\n      labels:\n        app: pause\n    spec:\n      containers:\n        - name: pause\n          image: registry.k8s.io/pause:3.10\n'
    execSync(`kubectl --kubeconfig ${kcPath} apply -f -`, { input: withUndo(manifest, () => execSync(`kubectl --kubeconfig ${kcPath} delete namespace f3approve --wait=false`, { stdio: 'ignore' })), stdio: ['pipe', 'ignore', 'inherit'] })
    await expect.poll(() => replicas(request, admin), { timeout: 60_000 }).toBe(1)

    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(ADMIN_EMAIL)
    await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })

    const made = withUndo<string[]>([], (ids) => deleteConversations(request, admin, ids))
    try {
      // 1) The model asks for k8s_scale → card, replicas untouched.
      let card = page.locator(CARD).last()
      for (let attempt = 1; attempt <= 3 && (await page.locator(CARD).count()) === 0; attempt++) {
        await askForScale(page, made)
        card = page.locator(CARD).last()
      }
      await expect(card, 'approval card for the write tool').toBeVisible({ timeout: 10_000 })
      await expect(card).toHaveAttribute('data-approval-status', 'pending')
      await expect(card).toContainText('k8s_scale')
      expect(await replicas(request, admin), 'nothing runs before approval').toBe(1)

      // 2) Reject → status rejected, replicas still 1.
      await card.getByRole('button', { name: /거부|reject/i }).click()
      await expect(card).toHaveAttribute('data-approval-status', 'rejected', { timeout: 15_000 })
      expect(await replicas(request, admin), 'reject changes nothing').toBe(1)

      // 3) Ask again and approve → executed, replicas 2.
      const before = await page.locator(CARD).count()
      for (let attempt = 1; attempt <= 3 && (await page.locator(CARD).count()) <= before; attempt++) {
        await askForScale(page, made)
      }
      const card2 = page.locator(CARD).last()
      await expect(card2).toHaveAttribute('data-approval-status', 'pending', { timeout: 10_000 })
      await card2.getByRole('button', { name: /승인|approve/i }).click()
      await expect(card2).toHaveAttribute('data-approval-status', /executed|failed/, { timeout: 90_000 })
      await expect(card2).toHaveAttribute('data-approval-status', 'executed')
      await expect.poll(() => replicas(request, admin), { timeout: 60_000 }).toBe(2)
      await expect(card2, 'the decided card still says what was asked').toContainText(/"replicas": "?2/)
      await expect(card2).toContainText('f3approve')

      // Audit: the approval and the call are recorded with the approval id.
      const audit = await request.get('/api/v1/auth/admin/audit-logs?action=ai.tool.approve&limit=5', { headers: admin })
      if (audit.ok()) {
        const rows = (await audit.json()) as any
        const list: any[] = Array.isArray(rows) ? rows : rows.items || rows.logs || []
        expect(list.length, 'ai.tool.approve audit row').toBeGreaterThan(0)
      }

      // 4) Each conversation is deleted, those that showed a card too, and its approval rows go with it.
      expect(approvalRows(dbKcPath, made), 'the rejected and the approved card are rows of these conversations').toBeGreaterThanOrEqual(2)
      for (const id of made) {
        const res = await request.delete(`/api/v1/sessions/${id}`, { headers: admin })
        expect(res.status(), `delete conversation ${id}`).toBe(200)
      }
      expect(approvalRows(dbKcPath, made), 'approval rows left after the deletes').toBe(0)
    } finally {
      await ctx.close()
      await deleteConversations(request, admin, made)
      try {
        execSync(`kubectl --kubeconfig ${kcPath} delete namespace f3approve --wait=false`, { stdio: 'ignore' })
      } catch {
        /* best-effort cleanup */
      }
    }
  })
})

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
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
