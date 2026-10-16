import { test, expect, type APIRequestContext } from '@playwright/test'

// Turn tokens under an answer: ai-service keeps the turn's sums on the assistant message (messages.usage, the same
// numbers as the turn's ai.chat.complete audit row) and the AI chat page shows them under the answer, also after
// a reload. The browser runs with locale en-US (playwright.config). The chat page lists the sessions of its
// cluster, so the session is created for `self` and the page opened with ?cluster=self.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

test.describe('AI chat turn tokens', () => {
  test.setTimeout(300_000)

  test('an answer shows its turn tokens — the session API and the audit row agree, also after a reload', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const title = `e2e-usage-${Date.now().toString(36)}`
    const created = await request.post('/api/v1/sessions?cluster=self', { headers: admin, data: { title } })
    expect(created.ok()).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      await page.goto('/ai-chat?cluster=self')
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click({ timeout: 15_000 })
      const input = page.getByPlaceholder(/메시지|message/i)
      await input.fill('ok라고만 답해.')
      await page.getByRole('button', { name: /^전송$|^send$/i }).click()
      await expect(input).toBeDisabled({ timeout: 10_000 })
      await expect(input).toBeEnabled({ timeout: 180_000 })

      // What the session API returns for the answer, and the turn's audit row.
      await expect.poll(async () => {
        const detail = await (await request.get(`/api/v1/sessions/${sessionId}`, { headers: admin })).json()
        return (detail.messages as Array<{ role: string }>).filter((m) => m.role === 'assistant').length
      }, { timeout: 30_000 }).toBe(1)
      const detail = await (await request.get(`/api/v1/sessions/${sessionId}`, { headers: admin })).json()
      const answer = (detail.messages as Array<{ role: string; usage?: Record<string, number> | null }>).find((m) => m.role === 'assistant')!
      const audit = await (await request.get('/api/v1/auth/admin/audit-logs', { headers: admin, params: { action: 'ai.chat.complete', limit: 30 } })).json()
      const row = (audit.items as Array<Record<string, any>>)
        .map((e) => e.After ?? e.after ?? {})
        .find((a) => a.session_id === sessionId)
      expect(row, 'the turn has its ai.chat.complete row').toBeTruthy()

      const line = page.getByTestId('turn-usage')
      if (row.prompt_tokens == null) {
        // The provider sent no usage: nothing is kept and nothing is shown.
        expect(answer.usage ?? null).toBeNull()
        await expect(line).toHaveCount(0)
        return
      }
      const usage = answer.usage!
      expect([usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens, usage.model_calls])
        .toEqual([row.prompt_tokens, row.completion_tokens, row.cached_tokens, row.model_calls])
      const fmt = (n: number) => n.toLocaleString('en-US')
      const expected = `In ${fmt(usage.prompt_tokens)} · out ${fmt(usage.completion_tokens)} tokens` +
        (usage.prompt_tokens > 0 ? ` · ${Math.round((usage.cached_tokens / usage.prompt_tokens) * 100)}% cached` : '')
      await expect(line).toHaveText(expected)
      await expect(line).toHaveAttribute('title', `Model calls: ${usage.model_calls} · ${row.model}`)

      // Kept with the message: the same line after a reload (the first message renamed the session, so look it
      // up by its current title).
      const renamed = (await (await request.get(`/api/v1/sessions/${sessionId}`, { headers: admin })).json()).title as string
      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.getByText(renamed, { exact: true }).first().click({ timeout: 15_000 })
      await expect(page.getByTestId('turn-usage')).toHaveText(expected, { timeout: 15_000 })
    } finally {
      await request.delete(`/api/v1/sessions/${sessionId}`, { headers: admin })
    }
  })
})
