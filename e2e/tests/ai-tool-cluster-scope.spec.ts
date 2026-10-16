import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// C1: AI tool permissions are decided per cluster. A user with the Write role
// (ai.tool.*) on `test2` and only Read on `self` gets tool calls on both — the
// Read role carries the twenty-six read tools — but every tool call recorded on
// self is a read tool, even though both grants live in the same token.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /전송|send/i
// Same selector as ai-chat.spec.ts: assistant rows are the non-reversed message rows.
const ASSISTANT_MSG = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const LIST_PODS_QUERY = 'kube-system 네임스페이스의 파드 목록을 보여줘'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return (await res.json()).access_token as string
}

async function chatReply(page: Page, cluster: string): Promise<string> {
  await page.goto(`/ai-chat?cluster=${cluster}`)
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(LIST_PODS_QUERY)
  await page.getByRole('button', { name: SEND_RE }).click()
  await expect(input).toBeDisabled({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 120_000 })
  return (await page.locator(ASSISTANT_MSG).last().innerText()).trim()
}

test.describe('AI tool permissions are per cluster (C1)', () => {
  test.setTimeout(10 * 60 * 1000)

  test('Write on test2 and Read on self both get tool calls; on self only read tools are ever called', async ({ browser, request }) => {
    const admin = { Authorization: `Bearer ${await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)}` }
    const email = `e2e-toolscope-${Date.now()}@kubeast.local`
    const password = 'toolscope1234'
    let userId = ''
    try {
      const created = await request.post('/api/v1/auth/admin/users', {
        headers: admin,
        data: { name: 'E2E tool scope', email, password },
      })
      expect(created.status()).toBe(201)
      userId = (await created.json()).id
      for (const [cluster, role] of [['test2', 'Write'], ['self', 'Read']]) {
        const r = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, {
          headers: admin,
          data: { role },
        })
        expect(r.status(), `grant ${role} on ${cluster}`).toBe(200)
      }

      const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })

      // test2 (Write → ai.tool.*): the model is offered tools and uses one.
      let toolOnTest2 = ''
      for (let attempt = 1; attempt <= 3 && !toolOnTest2.includes('🔧'); attempt++) {
        toolOnTest2 = await chatReply(page, 'test2')
      }
      expect(toolOnTest2, 'test2 reply should carry a tool call marker').toContain('🔧')

      // self (Read → the read tools only): the same list question is answered with a tool call too.
      let replyOnSelf = ''
      for (let attempt = 1; attempt <= 3 && !replyOnSelf.includes('🔧'); attempt++) {
        replyOnSelf = await chatReply(page, 'self')
      }
      expect(replyOnSelf, 'self reply should carry a tool call marker (read tools)').toContain('🔧')

      // Audit: every tool call recorded for this user on self is a read tool (after.tool), never a write tool.
      const audit = await request.get('/api/v1/auth/admin/audit-logs?action=ai.tool.call&limit=100', { headers: admin })
      expect(audit.ok(), 'audit log read').toBeTruthy()
      const rows = (await audit.json()) as any
      const list: any[] = Array.isArray(rows) ? rows : rows.items || rows.logs || []
      const mine = list.filter((r) => (r.actor_user_id ?? r.ActorUserID) === userId)
      expect(mine.length, 'tool calls recorded for this user').toBeGreaterThan(0)
      const onSelf = mine.filter((r) => (r.cluster ?? r.Cluster) === 'self')
      expect(onSelf.length, 'tool calls on self').toBeGreaterThan(0)
      for (const r of onSelf) {
        const tool = String((r.after ?? r.After)?.tool ?? '')
        expect(tool, `audit row ${r.id} on self`).not.toMatch(/apply|create|delete|patch|scale|rollout|execute|label|annotat/)
      }
      await ctx.close()
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
    }
  })
})
