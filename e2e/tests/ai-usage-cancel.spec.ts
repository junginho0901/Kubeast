import { test, expect, type APIRequestContext } from '@playwright/test'

// A turn the user stops half-way still costs tokens, so it is still accounted
// for: ai.chat.complete is written with finish_reason "cancelled". The ai.*
// audit rows also carry the cluster the turn ran against in the cluster column.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i
const STOP_RE = /^중단$|^stop$/i

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

type AuditItem = { Cluster?: string; cluster?: string; After?: any; after?: any; CreatedAt?: string }

async function auditRows(request: APIRequestContext, token: string, action: string, since: string): Promise<AuditItem[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', {
    headers: { Authorization: `Bearer ${token}` },
    params: { action, since, limit: 20 },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { items: AuditItem[] }).items
}

test.describe('AI usage accounting — cancelled turns and cluster column', () => {
  test('stopping a stream records ai.chat.complete with finish_reason cancelled', async ({ page, request }) => {
    const token = await adminToken(request)
    const since = new Date(Date.now() - 60_000).toISOString()

    await page.goto('/ai-chat?cluster=self')
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await expect(input).toBeVisible()
    await input.fill('Kubernetes 의 deployment / service / pod 의 차이를 아주 자세히, 예시를 들어 길게 설명해줘')
    await page.getByRole('button', { name: SEND_RE }).click()

    const stop = page.getByRole('button', { name: STOP_RE })
    await expect(stop).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    await stop.click()
    await expect(input).toBeEnabled({ timeout: 10_000 })

    // The cancelled turn shows up within a few seconds (written from the
    // cancellation path as a background task).
    await expect
      .poll(
        async () => {
          const rows = await auditRows(request, token, 'ai.chat.complete', since)
          return rows.map((r) => (r.After ?? r.after ?? {}).finish_reason)
        },
        { timeout: 20_000, message: 'ai.chat.complete with finish_reason=cancelled' },
      )
      .toContain('cancelled')

    const rows = await auditRows(request, token, 'ai.chat.complete', since)
    const cancelled = rows.find((r) => (r.After ?? r.after ?? {}).finish_reason === 'cancelled')!
    const after = cancelled.After ?? cancelled.after
    expect(typeof after.duration_ms).toBe('number')
    expect(after.duration_ms).toBeGreaterThan(0)
    expect(after.cluster).toBe('self')
    expect(cancelled.Cluster ?? cancelled.cluster, 'cluster column is the turn cluster, not the writer default').toBe('self')

    // ai.chat.send of the same turn carries the cluster column too.
    const sends = await auditRows(request, token, 'ai.chat.send', since)
    expect(sends.length).toBeGreaterThanOrEqual(1)
    expect(sends[0].Cluster ?? sends[0].cluster).toBe('self')
  })
})
