import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

import { sessionToken } from './session-token'

// The alert window's list of the same alert's earlier investigations (features.alertInvestigation.pastReports.window,
// off by default):
// - the window draws what the server lists, in its order, and the button of one opens that one's report (asked by its ID);
// - it says so when the server could not read them, and shows no section when the server sends no list;
// - with the switch off, as the dev install has it, the server answers the window's request as one that did not ask.
// The window's answers are stood in (no model, no row in the database); the last test reads the real inbox and changes
// nothing.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const run = Date.now().toString(36)
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

const at = new Date(Date.now() - 10 * 60_000).toISOString()
const ALERT = {
  id: `past-${run}`, cluster: 'self', fingerprint: `fp-${run}`, alertname: `PastAlert${run}`, severity: 'info', namespace: 'default',
  labels: { alertname: `PastAlert${run}`, severity: 'info' }, summary: '', status: 'firing', starts_at: at, resolved_at: null,
  first_received_at: at, last_received_at: at, received_count: 1, acknowledged: false, acked_by: '', acked_at: null, assignee: '',
  done: false, done_by: '', done_at: null, investigation: null, annotations: {}, generator_url: '', alertmanager_url: '',
  receiver: 'kubeast', note: '', note_by: '', note_at: null,
}
const PAST = [
  { id: `inv-b-${run}`, received_at: '2026-11-23T02:00:00Z', outcome: 'cause_found', causes_total: 1,
    causes: [{ resource: `CronJob/default/job-${run}`, kind: 'dependency_slow', verified: true }] },
  { id: `inv-a-${run}`, received_at: '2026-11-20T02:00:00Z', outcome: 'cannot_tell', causes_total: 1,
    causes: [{ resource: 'Pod/default/<EMAIL_1>', kind: 'crash', verified: false }] },
]

async function openWindow(page: Page, past: unknown): Promise<{ asked: URL[] }> {
  const asked: URL[] = []
  await page.route((u) => u.pathname === '/api/v1/alerts/inbox', (route) =>
    route.fulfill({ json: { items: [ALERT], total: 1, counts: { firing: 1, stale: 0, resolved: 0 }, stale_hours: 8, severities: ['info'] } }))
  await page.route((u) => u.pathname.startsWith(`/api/v1/alerts/inbox/${ALERT.id}`), async (route) => {
    const u = new URL(route.request().url())
    asked.push(u)
    if (!u.pathname.endsWith('/investigation')) return route.fulfill({ json: past === undefined ? ALERT : { ...ALERT, past_investigations: past } })
    return route.fulfill({
      json: {
        id: u.searchParams.get('past'), cluster: 'self', alertname: `Report of ${u.searchParams.get('past')}`, severity: 'info', namespace: 'default',
        status: 'done', skip_reason: '', received_at: at, started_at: at, finished_at: at, repeat_count: 1, last_seen_at: at, model: 'm',
        total_tokens: 1, iterations: 1, tool_call_count: 0, duration_ms: 1, fingerprint: ALERT.fingerprint, labels: {}, annotations: {}, starts_at: at,
        generator_url: '', alertmanager_url: '', provider: 'p', prompt_tokens: 1, completion_tokens: 1, tool_calls: [], report: '## Summary\nearlier', error: '',
      },
    })
  })
  await page.goto(`/alerts?cluster=self&alert=${ALERT.id}`)
  await expect(page.getByTestId('alert-detail')).toContainText(ALERT.alertname, { timeout: 20_000 })
  return { asked }
}

test.describe("the alert window's past investigations", () => {
  test('lists what the server sends, in its order, and opens the report of the one pressed', async ({ page }) => {
    const { asked } = await openWindow(page, PAST)
    expect(asked[0].searchParams.get('past')).toBe('true')
    const rows = page.getByTestId('alert-past-list').locator('> li')
    await expect(rows).toHaveCount(2)
    expect(await rows.evaluateAll((lis) => lis.map((li) => li.getAttribute('data-testid')))).toEqual(PAST.map((p) => `alert-past-${p.id}`))
    // part by part: margins, not spaces, keep them apart
    const parts = async (i: number) => [
      norm(await rows.nth(i).locator('[data-outcome]').textContent()),
      ...(await rows.nth(i).getByTestId('alert-past-cause').locator('> span').allTextContents()).map(norm),
    ]
    expect(await parts(0)).toEqual(
      [EN.investigations.result.outcome.cause_found, `CronJob/default/job-${run}`, 'dependency_slow', EN.alertInbox.past.checked])
    expect(await parts(1)).toEqual(
      [EN.investigations.result.outcome.cannot_tell, 'Pod/default/<EMAIL_1>', 'crash', EN.investigations.result.notVerifiedBare])
    expect(asked.some((u) => u.pathname.endsWith('/investigation')), 'no report is read before one is opened').toBe(false)
    await rows.nth(1).getByTestId('alert-past-report').click()
    await expect(page.getByTestId('investigation-modal')).toContainText(`Report of ${PAST[1].id}`)
    expect(asked.filter((u) => u.pathname.endsWith('/investigation')).map((u) => u.searchParams.get('past'))).toEqual([PAST[1].id])
  })

  test('says they could not be read, says None, and has no section without a list', async ({ page }) => {
    await openWindow(page, null)
    await expect(page.getByTestId('alert-past-section')).toContainText(EN.alertInbox.past.failed)
    await page.unrouteAll()
    await openWindow(page, [])
    await expect(page.getByTestId('alert-past-none')).toHaveText(EN.common.none)
    await page.unrouteAll()
    await openWindow(page, undefined)
    await expect(page.getByTestId('alert-past-section')).toHaveCount(0)
  })

  test('with the switch off the server answers the window as one that did not ask', async ({ request }) => {
    const signIn = async (r: APIRequestContext) => {
      const res = await r.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
      expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
      return { Authorization: `Bearer ${sessionToken(res)}`, 'X-Requested-With': 'XMLHttpRequest' }
    }
    const headers = await signIn(request)
    const list = await request.get('/api/v1/alerts/inbox', { headers, params: { cluster: 'self', status: 'resolved', limit: 1 }, failOnStatusCode: false })
    test.skip([404, 503].includes(list.status()), 'alert investigation (the inbox) or the AI is off')
    expect(list.status(), await list.text()).toBe(200)
    const [item] = (await list.json()).items
    test.skip(!item, 'the inbox holds no resolved alert to read')
    const read = async (params: Record<string, string>) => {
      const res = await request.get(`/api/v1/alerts/inbox/${item.id}`, { headers, params })
      expect(res.status(), await res.text()).toBe(200)
      return res.text()
    }
    const plain = await read({})
    expect(JSON.parse(plain)).not.toHaveProperty('past_investigations')
    expect(await read({ past: 'true' })).toBe(plain)
  })
})
