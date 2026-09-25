import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// H2: a write tool the model picks is never executed straight away. The chat
// shows an approval card; nothing changes until the user approves, and a
// rejection leaves the cluster untouched.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /전송|send/i
const CARD = '[data-testid="tool-approval-card"]'
const SCALE_QUERY = 'test2 클러스터의 f3approve 네임스페이스에 있는 pause 디플로이먼트를 replicas 2로 스케일해줘. k8s_scale 툴을 사용해.'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return (await res.json()).access_token as string
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

async function askForScale(page: Page): Promise<void> {
  await page.goto('/ai-chat?cluster=test2')
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(SCALE_QUERY)
  await page.getByRole('button', { name: SEND_RE }).click()
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
    const manifest =
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: f3approve\n---\n' +
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: pause\n  namespace: f3approve\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: pause\n  template:\n    metadata:\n      labels:\n        app: pause\n    spec:\n      containers:\n        - name: pause\n          image: registry.k8s.io/pause:3.10\n'
    execSync(`kubectl --kubeconfig ${kcPath} apply -f -`, { input: manifest, stdio: ['pipe', 'ignore', 'inherit'] })
    await expect.poll(() => replicas(request, admin), { timeout: 60_000 }).toBe(1)

    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(ADMIN_EMAIL)
    await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })

    try {
      // 1) The model asks for k8s_scale → card, replicas untouched.
      let card = page.locator(CARD).last()
      for (let attempt = 1; attempt <= 3 && (await page.locator(CARD).count()) === 0; attempt++) {
        await askForScale(page)
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
        await askForScale(page)
      }
      const card2 = page.locator(CARD).last()
      await expect(card2).toHaveAttribute('data-approval-status', 'pending', { timeout: 10_000 })
      await card2.getByRole('button', { name: /승인|approve/i }).click()
      await expect(card2).toHaveAttribute('data-approval-status', /executed|failed/, { timeout: 90_000 })
      await expect(card2).toHaveAttribute('data-approval-status', 'executed')
      await expect.poll(() => replicas(request, admin), { timeout: 60_000 }).toBe(2)

      // Audit: the approval and the call are recorded with the approval id.
      const audit = await request.get('/api/v1/auth/admin/audit-logs?action=ai.tool.approve&limit=5', { headers: admin })
      if (audit.ok()) {
        const rows = (await audit.json()) as any
        const list: any[] = Array.isArray(rows) ? rows : rows.items || rows.logs || []
        expect(list.length, 'ai.tool.approve audit row').toBeGreaterThan(0)
      }
    } finally {
      await ctx.close()
      try {
        execSync(`kubectl --kubeconfig ${kcPath} delete namespace f3approve --wait=false`, { stdio: 'ignore' })
      } catch {
        /* best-effort cleanup */
      }
    }
  })
})
