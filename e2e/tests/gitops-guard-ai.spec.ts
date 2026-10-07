import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The Argo CD guard also holds for the AI write tools: an approved k8s_scale
// on the managed fixture Deployment comes back refused, with the Application
// named, and nothing changes. Needs a default model, like the other AI specs.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /전송|send/i
const CARD = '[data-testid="tool-approval-card"]'
const QUERY = 'self 클러스터의 default 네임스페이스에 있는 e2e-argo-managed 디플로이먼트를 replicas 2로 스케일해줘. k8s_scale 툴을 사용해.'

async function login(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function desiredReplicas(request: APIRequestContext, admin: Record<string, string>): Promise<number | null> {
  const r = await request.get('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self', { headers: admin, failOnStatusCode: false })
  if (!r.ok()) return null
  const d = await r.json()
  const n = d?.replicas ?? d?.desired ?? d?.spec?.replicas ?? null
  return typeof n === 'number' ? n : null
}

async function askForScale(page: Page): Promise<void> {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(QUERY)
  await page.getByRole('button', { name: SEND_RE }).click()
  await expect(input).toBeDisabled({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 120_000 })
}

test.describe('Argo CD guard — AI write tools', () => {
  test.setTimeout(600_000)

  test('an approved scale of a managed object is refused and names the Application', async ({ browser, request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: admin })).json()
    test.skip(features.gitops?.argocd?.mode !== 'block', 'gitops.argocd is not in block mode on this install')
    const before = await desiredReplicas(request, admin)
    test.skip(before === null, 'fixture e2e-argo-managed is missing (deploy/kind/fixtures.yaml)')

    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(ADMIN_EMAIL)
    await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
    try {
      let card = page.locator(CARD).last()
      for (let attempt = 1; attempt <= 3 && (await page.locator(CARD).count()) === 0; attempt++) {
        await askForScale(page)
        card = page.locator(CARD).last()
      }
      await expect(card, 'approval card for k8s_scale').toBeVisible({ timeout: 10_000 })
      await expect(card).toContainText('k8s_scale')
      await card.getByRole('button', { name: /승인|approve/i }).click()
      await expect(card).toHaveAttribute('data-approval-status', /executed|failed/, { timeout: 90_000 })
      await expect(card, 'the guard refuses the run').toHaveAttribute('data-approval-status', 'failed')
      await expect(card, 'the card shows the reason').toContainText('managed by Argo CD application e2e-app', { timeout: 15_000 })
      expect(await desiredReplicas(request, admin), 'replicas unchanged').toBe(before)
    } finally {
      await ctx.close()
    }
  })
})
