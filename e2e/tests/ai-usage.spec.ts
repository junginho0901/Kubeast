import { test, expect, type APIRequestContext } from '@playwright/test'

// Every chat turn leaves an ai.chat.complete audit record (tokens, tool calls,
// duration) and the admin AI-usage view aggregates them per user. Depends on
// the dev LLM answering (as the other ai-* specs do).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

test.describe('AI usage accounting', () => {
  test('a chat turn is recorded as ai.chat.complete and shows up in the admin usage view', async ({ page, request }) => {
    const token = await adminToken(request)
    const since = new Date(Date.now() - 60_000).toISOString()

    await page.goto('/ai-chat?cluster=self')
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await expect(input).toBeVisible()
    await input.fill('안녕, 한 문장으로만 인사해줘')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeDisabled({ timeout: 10_000 })
    await expect(input).toBeEnabled({ timeout: 120_000 })

    // The audit record for the turn.
    const audit = await request.get('/api/v1/auth/admin/audit-logs', {
      headers: { Authorization: `Bearer ${token}` },
      params: { action: 'ai.chat.complete', since, limit: 20 },
    })
    expect(audit.ok()).toBeTruthy()
    const { items } = (await audit.json()) as { items: Array<Record<string, any>> }
    expect(items.length, 'one ai.chat.complete row per turn').toBeGreaterThanOrEqual(1)
    const after = items[0].After ?? items[0].after ?? {}
    expect(typeof after.duration_ms).toBe('number')
    expect(after.duration_ms).toBeGreaterThan(0)
    expect(typeof after.tool_calls).toBe('number')
    expect(typeof after.iterations).toBe('number')
    expect(after.model, 'model recorded').toBeTruthy()
    // tokens are either numbers (provider sent usage) or null (it did not) — never missing
    expect(['number', 'object']).toContain(typeof after.total_tokens)

    // The aggregated view groups it under the admin user.
    const usage = await request.get('/api/v1/auth/admin/ai-usage', {
      headers: { Authorization: `Bearer ${token}` },
      params: { since, group: 'user' },
    })
    expect(usage.ok()).toBeTruthy()
    const body = (await usage.json()) as { group: string; rows: Array<Record<string, any>> }
    expect(body.group).toBe('user')
    const mine = body.rows.find((r) => r.key === EMAIL)
    expect(mine, JSON.stringify(body.rows)).toBeTruthy()
    expect(mine!.requests).toBeGreaterThanOrEqual(1)
    expect(mine!.tool_calls).toBeGreaterThanOrEqual(0)

    // Unknown group is rejected, not silently defaulted.
    const bad = await request.get('/api/v1/auth/admin/ai-usage', {
      headers: { Authorization: `Bearer ${token}` },
      params: { group: 'namespace' },
    })
    expect(bad.status()).toBe(400)

    // The admin page renders the row.
    await page.goto('/admin/ai-usage')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: /AI 사용량|AI Usage/i })).toBeVisible()
    await expect(page.getByTestId('ai-usage-table').getByText(EMAIL, { exact: true })).toBeVisible({ timeout: 15_000 })
  })
})
