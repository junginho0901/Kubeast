import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The Alerts page with alert investigation off and the alert store on (cluster default in the dev values, silences on).
// The inbox is ai-service's and answers only with investigation on, so the page asks nothing of it, says why in one
// line, and shows the store's silences, which are listed and ended as with the inbox. Investigation off, and AI off,
// are stood in on the features' answer; the silences are made through the API on the second cluster's Alertmanager.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const RUN = Date.now().toString(36)
const FEATURES = /\/api\/v1\/cluster\/features(\?|$)/
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const KO = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/ko.json'), 'utf8'))
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const either = (key: string) => new RegExp(`^(${esc(EN.alertInbox[key])}|${esc(KO.alertInbox[key])})$`)

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// the features as the server answers them, with the change on top
async function standIn(page: Page, change: object) {
  await page.route(FEATURES, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), ...change } })
  })
}

// the requests the page sends to the inbox (ai-service's /api/v1/alerts/)
function inboxCalls(page: Page): string[] {
  const calls: string[] = []
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    if (p.startsWith('/api/v1/alerts/')) calls.push(p)
  })
  return calls
}

const shownSilences = (page: Page) => page.getByTestId('silence-list').locator('tbody tr[data-testid^="silence-row-"]')
  .evaluateAll((trs) => trs.map((tr) => (tr.getAttribute('data-testid') ?? '').slice('silence-row-'.length)))

test.describe('the Alerts page without alert investigation', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  const made: string[] = []

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    test.skip(!features.alertStore?.clusters?.includes(CLUSTER) || !features.alertStore?.silences, `no alert store with silences for cluster ${CLUSTER}`)
  })

  test.afterAll(async ({ request }) => {
    for (const id of made) {
      await request.delete(`/api/v1/alertstore/silences/${id}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  const makeSilence = async (request: APIRequestContext, comment: string): Promise<string> => {
    const res = await request.post(`/api/v1/alertstore/silences?cluster=${CLUSTER}`, {
      headers: bearer(admin),
      data: { matchers: [{ name: 'alertname', value: `E2ENoInvestigation${RUN}`, isRegex: false, isEqual: true }], durationMinutes: 60, comment },
    })
    expect(res.status(), await res.text()).toBe(201)
    const id = (await res.json()).silenceID as string
    made.push(id)
    return id
  }
  const listed = async (request: APIRequestContext): Promise<string[]> => {
    const res = await request.get('/api/v1/alertstore/silences', { headers: bearer(admin), params: { cluster: CLUSTER } })
    expect(res.status(), await res.text()).toBe(200)
    return ((await res.json()).silences as { id: string }[]).map((s) => s.id)
  }

  test('investigation off: Alerts stays in the menu, the inbox is not asked, one line says why, a silence lists and ends', async ({ page, request }) => {
    const comment = `e2e no investigation ${RUN}`
    const id = await makeSilence(request, comment)
    const calls = inboxCalls(page)
    await standIn(page, { alertInvestigation: { enabled: false } })
    await page.goto(`/alerts?cluster=${CLUSTER}`)

    await expect(page.getByTestId('alert-inbox-disabled')).toHaveText(either('disabled'), { timeout: 20_000 })
    await expect(page.getByTestId('nav-alerts')).toHaveAttribute('href', '/alerts')
    await expect(page.getByTestId('alert-tab-firing'), 'no inbox tabs without the inbox').toHaveCount(0)
    const row = page.getByTestId(`silence-row-${id}`)
    await expect(row).toContainText(comment)
    expect((await shownSilences(page)).sort(), 'the rows are the store\'s list for the cluster').toEqual((await listed(request)).sort())

    await row.getByTestId('silence-expire').click()
    await page.getByRole('button', { name: /^(End now|지금 끝내기)$/ }).last().click()
    await expect(row).toHaveCount(0)
    expect(await listed(request), 'ended in the store').not.toContain(id)
    expect(calls, 'nothing asked of the inbox').toEqual([])
  })

  test('AI off: the line names ai.enabled, the page is not the AI notice, the silences are there', async ({ page, request }) => {
    const comment = `e2e no ai ${RUN}`
    const id = await makeSilence(request, comment)
    const calls = inboxCalls(page)
    await standIn(page, { ai: { enabled: false }, alertInvestigation: { enabled: false } })
    await page.goto(`/alerts?cluster=${CLUSTER}`)

    await expect(page.getByTestId('alert-inbox-disabled')).toHaveText(either('disabledNoAI'), { timeout: 20_000 })
    await expect(page.getByTestId('ai-disabled-notice')).toHaveCount(0)
    await expect(page.getByTestId(`silence-row-${id}`)).toContainText(comment)
    expect(calls, 'nothing asked of the inbox').toEqual([])
  })
})
