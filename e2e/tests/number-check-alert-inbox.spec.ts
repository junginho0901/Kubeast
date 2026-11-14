import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Number check of the Alerts screen against the webhook, the inbox API and the database:
// - one webhook message of 101 alerts (severity info, kept and not investigated) is 101 inbox rows: the webhook's
//   answer, the API, the database and the tabs; paging the API and the screen to the end holds every row once (the
//   rows of one message share their received time); the table never empties while the page or Refresh changes it or
//   an alert window opens; another tab shows the loading line and none of the rows before it while its answer is
//   held, then its own rows; resolving the 101 in one message closes all 101.
// - an investigation the per-message limit skipped (a row the spec writes into the dev database as the webhook writes
//   it — 101 critical alerts would start 100 real investigations on the dev model) says why in the catalog's words in
//   the row, the alert window, its report and Admin → Investigations.
// - a severity outside critical, warning and info is offered by the filter and finds its alert.
// - the Silences tab lists the second cluster's Alertmanager silences that mute the cluster's alerts without being its
//   own (no cluster condition, a cluster pattern), with their scope and no End button.
// Inbox rows stay in the dev database (retention deletes them), resolved; the investigation row and the silences go.

const INBOX = { path: '/alerts', cluster: 'self' }

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
// one more than the investigations one webhook message may start (ai-service webhook.MAX_INVESTIGATIONS_PER_MESSAGE)
const N = 101
// the reason ai-service's skip_reasons.investigation_cap(100) writes
const CAP_REASON = 'investigation cap (100 new per webhook message)'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Item = { id: string; alertname: string; status: string; investigation: Obj }
type InboxAnswer = { items: Item[]; total: number; counts: Record<string, number>; severities?: string[] }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const repeats = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i)
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-alert-inbox-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8' }).trim()
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

// the second cluster's Alertmanager, asked from its node (the laptop does not reach the kind network)
function am(method: 'GET' | 'POST' | 'DELETE', urlPath: string, body?: unknown): string {
  const data = body === undefined ? '' : `-H 'Content-Type: application/json' --data-binary @-`
  return execSync(`docker exec -i kubeast-b-control-plane curl -sf -X ${method} ${data} 'http://127.0.0.1:31093${urlPath}'`, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login ${ADMIN_EMAIL}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// the rows the table shows now, by inbox id
const rowIds = (page: Page) => page.locator('[data-testid="alert-inbox-table"] tbody tr[data-testid^="alert-row-"]')
  .evaluateAll((trs) => trs.map((tr) => (tr.getAttribute('data-testid') ?? '').slice('alert-row-'.length)))

// "Showing 26-50 of 101" of the list footer, read with the catalog's words
const RANGE = new RegExp(EN.common.paginationRange.replace('{{start}}', '(\\d+)').replace('{{end}}', '(\\d+)').replace('{{total}}', '(\\d+)'))
async function rangeOf(page: Page): Promise<{ start: number; end: number; total: number } | null> {
  const m = RANGE.exec(await page.getByTestId('list-pager').innerText())
  return m ? { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) } : null
}

test.describe('number check: the Alerts screen', () => {
  let admin = ''
  let webhookToken = ''

  test.beforeEach(async ({ request }) => {
    admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.alertInvestigation?.enabled, 'alert investigation (the webhook) is off')
    webhookToken ||= Buffer.from(kubectl(['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']), 'base64').toString()
  })

  const post = (request: APIRequestContext, cluster: string, groupKey: string, alerts: object[]) =>
    request.post(`/api/v1/alerts/webhook?cluster=${cluster}`, {
      headers: { Authorization: `Bearer ${webhookToken}` },
      data: { version: '4', groupKey, status: 'firing', receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093', alerts },
    })
  const list = async (request: APIRequestContext, params: Record<string, string | number>): Promise<InboxAnswer> => {
    const res = await request.get('/api/v1/alerts/inbox', { headers: bearer(admin), params: { cluster: INBOX.cluster, ...params } })
    expect(res.status(), await res.text()).toBe(200)
    return res.json()
  }

  test('one webhook message of 101 alerts is 101 rows: the answer, the API, the database, the tabs and every page', async ({ page, request }) => {
    test.setTimeout(240_000)
    const run = Date.now().toString(36)
    const name = `E2EN4aInbox${run}`
    const startsAt = new Date(Date.now() - 2 * 60_000).toISOString()
    const alert = (i: number, status: string, extra: Obj = {}) => ({
      status, labels: { alertname: name, severity: 'info', namespace: 'default', e2e_i: String(i).padStart(3, '0') },
      annotations: { summary: `n4a inbox ${run}` }, startsAt, generatorURL: 'http://prometheus.e2e/graph', fingerprint: `n4a-${run}-${i}`, ...extra,
    })
    const dbCount = (extra = '') => Number(psql(`SELECT count(*) FROM alert_inbox WHERE cluster = '${INBOX.cluster}' AND alertname = '${name}'${extra}`))

    const answer = await (await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, Array.from({ length: N }, (_, i) => alert(i, 'firing')))).json()
    expect.soft(answer, 'the webhook answer: every alert stored, none investigated (info)').toMatchObject({ stored: N, filtered: N, accepted: 0 })
    const first = await list(request, { q: run, limit: 200 })
    expect.soft(first.total, 'API total').toBe(N)
    expect.soft(first.counts, 'API counts').toEqual({ firing: N, stale: 0, resolved: 0 })
    expect.soft(dbCount(), 'database rows').toBe(N)

    await test.step('the API paged seven at a time: every row once', async () => {
      const ids: string[] = []
      for (let offset = 0; offset < N + 7; offset += 7) ids.push(...(await list(request, { q: run, limit: 7, offset })).items.map((i) => i.id))
      expect.soft(repeats(ids), 'rows on two pages').toEqual([])
      expect.soft([...new Set(ids)].sort(), 'the pages hold the rows of one read').toEqual(first.items.map((i) => i.id).sort())
    })

    await page.goto(`${INBOX.path}?cluster=${INBOX.cluster}`)
    await page.getByTestId('alert-inbox-table').waitFor()
    const searched = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/alerts/inbox' && new URL(r.url()).searchParams.get('q') === run)
    await page.getByTestId('alert-inbox-search').fill(run)
    await searched
    try {
      await expect.poll(async () => (await rangeOf(page))?.total, { timeout: 15_000 }).toBe(N)
    } catch {
      // compared below
    }
    expect.soft((await rangeOf(page))?.total, 'the footer counts the search').toBe(N)

    await test.step('the tabs count what the API and the database count', async () => {
      const tabs = async () => Object.fromEntries(await Promise.all(['firing', 'stale', 'resolved', 'all'].map(async (t) =>
        [t, Number(((await page.getByTestId(`alert-tab-${t}`).innerText()).match(/(\d+)\s*$/) ?? [])[1])])))
      const want = { firing: dbCount(" AND state = 'firing'"), stale: 0, resolved: dbCount(" AND state <> 'firing'"), all: dbCount() }
      expect.soft(await tabs(), 'tab counts').toEqual(want)
      expect.soft(want, 'the database holds the 101 as firing').toEqual({ firing: N, stale: 0, resolved: 0, all: N })
    })

    // a moment the table holds no row or the loading line, while it pages, changes tab, refreshes or opens a window
    await page.evaluate((loading) => {
      const w = window as Obj
      w.__inboxFlash = []
      const body = document.querySelector('[data-testid="alert-inbox-table"] tbody')!
      const check = () => {
        const rows = body.querySelectorAll('tr[data-testid^="alert-row-"]').length
        if (rows === 0 || (body as HTMLElement).innerText.includes(loading)) w.__inboxFlash.push(rows === 0 ? '(no rows)' : loading)
      }
      new MutationObserver(check).observe(body, { subtree: true, childList: true, characterData: true })
    }, EN.common.loading)

    await test.step('the screen paged to the end: every row once, each page as long as its range', async () => {
      const pages: string[][] = []
      const next = page.getByTestId('list-pager').getByRole('button', { name: EN.common.next, exact: true })
      for (let i = 0; i < 60; i++) {
        const range = await rangeOf(page)
        const want = range ? range.end - range.start + 1 : 0
        await expect.poll(async () => (await rowIds(page)).length, { timeout: 15_000, message: `page ${i + 1} holds its range` }).toBe(want)
        pages.push(await rowIds(page))
        if (await next.isDisabled()) break
        const before = norm(await page.getByTestId('list-pager').innerText())
        await next.click()
        await expect.poll(async () => norm(await page.getByTestId('list-pager').innerText()), { timeout: 15_000 }).not.toBe(before)
      }
      const ids = pages.flat()
      expect.soft(repeats(ids), 'rows shown on two pages').toEqual([])
      expect.soft([...ids].sort(), 'the pages hold the API rows').toEqual(first.items.map((i) => i.id).sort())
      // and back one page
      const before = norm(await page.getByTestId('list-pager').innerText())
      await page.getByTestId('list-pager').getByRole('button', { name: EN.common.prev, exact: true }).click()
      await expect.poll(async () => norm(await page.getByTestId('list-pager').innerText()), { timeout: 15_000 }).not.toBe(before)
      expect.soft(await page.evaluate(() => (window as Obj).__inboxFlash), 'the table never emptied or showed loading while it paged').toEqual([])
    })

    await test.step('another tab shows the loading line and none of the rows before it while its answer is held, then its own first page', async () => {
      // Resolved holds none of the 101 and Firing all of them; neither was read with this search before
      for (const tab of ['resolved', 'firing']) {
        const before = await rowIds(page)
        let release = () => {}
        const gate = new Promise<void>((resolve) => { release = resolve })
        let held = 0
        const hold = async (route: Obj) => {
          if (new URL(route.request().url()).searchParams.get('status') === tab) {
            held++
            await gate
          }
          await route.continue().catch(() => {})
        }
        await page.route(/\/api\/v1\/alerts\/inbox(\?|$)/, hold)
        const asked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/alerts/inbox' && new URL(r.url()).searchParams.get('status') === tab)
        try {
          await page.getByTestId(`alert-tab-${tab}`).click()
          await expect.poll(() => held, { message: `the ${tab} answer is held` }).toBeGreaterThan(0)
          await expect(page.getByTestId('alert-inbox-table').locator('tbody').first()).toContainText(EN.common.loading)
          const shown = await rowIds(page)
          expect.soft(shown.filter((id) => before.includes(id)), `rows of the tab before under ${tab} while its answer is held`).toEqual([])
          expect.soft(shown, `rows under ${tab} while its answer is held`).toEqual([])
          expect.soft((await rangeOf(page))?.total ?? 0, `the footer under ${tab} while its answer is held`).toBe(0)
        } finally {
          release()
          await page.unroute(/\/api\/v1\/alerts\/inbox(\?|$)/, hold)
        }
        const answer: InboxAnswer = await (await asked).json()
        await expect.poll(async () => rowIds(page), { timeout: 15_000, message: `the ${tab} rows once its answer came` }).toEqual(answer.items.map((i) => i.id))
        expect.soft(answer.items.length, `${tab} holds its share of the 101`).toBe(tab === 'firing' ? Math.min(N, Number(new URL((await asked).url()).searchParams.get('limit'))) : 0)
        if (tab === 'firing') await expect.poll(async () => (await rangeOf(page))?.start, { timeout: 15_000 }).toBe(1)
        else await expect(page.getByTestId('alert-inbox-table').locator('tbody').first()).toContainText(EN.common.noSearchResults)
      }
    })

    await test.step('Refresh and an alert window keep the table filled', async () => {
      await page.evaluate(() => { (window as Obj).__inboxFlash = [] })
      const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/alerts/inbox')
      await page.locator('.page-head').getByRole('button', { name: new RegExp(`^\\s*${EN.alertInbox.refresh}\\s*$`) }).click()
      await refreshed
      const ids = await rowIds(page)
      await page.getByTestId(`alert-row-${ids[0]}`).click()
      await expect(page.getByTestId('alert-detail')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('alert-detail')).toHaveCount(0)
      expect.soft(await page.evaluate(() => (window as Obj).__inboxFlash), 'the table never emptied or showed loading').toEqual([])
    })

    await test.step('one message resolving the 101 closes every row', async () => {
      const endsAt = new Date().toISOString()
      const done = await (await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, Array.from({ length: N }, (_, i) => alert(i, 'resolved', { endsAt })))).json()
      expect.soft(done, 'the webhook answer').toMatchObject({ stored: N, resolved: N })
      expect.soft((await list(request, { q: run, limit: 1 })).counts, 'API counts').toEqual({ firing: 0, stale: 0, resolved: N })
      expect.soft(dbCount(" AND state = 'resolved'"), 'database rows resolved').toBe(N)
    })
  })

  test('an investigation the per-message limit skipped says why in the row, the window, the report and Admin → Investigations', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const name = `E2EN4aSkip${run}`
    const fingerprint = `n4a-skip-${run}`
    const invId = `inv-e2e-n4a-${run}`
    const labels = { alertname: name, severity: 'info', namespace: 'default' }
    const startsAt = new Date(Date.now() - 3 * 60_000).toISOString()
    const want = {
      label: EN.investigations.skip.investigation_cap,
      text: `${EN.investigations.skip.investigation_cap} — ${EN.investigations.skipWhy.investigation_cap.replace('{{limit}}', '100')}`,
    }
    expect((await (await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, [{ status: 'firing', labels, annotations: { summary: `n4a skip ${run}` }, startsAt, fingerprint }])).json()).stored).toBe(1)
    // as the webhook writes an alert past the limit (status skipped never runs a model)
    psql(`INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, status, skip_reason, received_at, last_seen_at)
          VALUES ('${invId}', '${INBOX.cluster}', '${fingerprint}', '${name}', 'info', 'default', 'skipped', '${CAP_REASON}', now() at time zone 'utc', now() at time zone 'utc')`)
    try {
      const row = (await list(request, { q: run })).items.find((i) => i.alertname === name)!
      expect(row, 'the inbox row').toBeTruthy()
      expect.soft(row.investigation, 'the API names the reason and its catalog key')
        .toMatchObject({ id: invId, status: 'skipped', skip_reason: CAP_REASON, skip_reason_key: 'investigation_cap', skip_reason_args: { limit: 100 } })

      await page.goto(`${INBOX.path}?cluster=${INBOX.cluster}`)
      await page.getByTestId('alert-inbox-search').fill(run)
      const line = page.getByTestId(`alert-row-${row.id}`)
      await expect(line).toHaveCount(1, { timeout: 15_000 })
      // the AI investigation cell (folded columns keep their text)
      const cell = await line.locator('td').nth(6).evaluate((td) => [...td.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim()))
      expect.soft(cell, 'the row: the status, then why').toEqual([EN.investigations.status.skipped, want.label])

      await page.goto(`${INBOX.path}?cluster=${INBOX.cluster}&alert=${row.id}`)
      const section = page.getByTestId('alert-detail').locator('section', { has: page.locator('h3', { hasText: EN.alertInbox.col.investigation }) })
      await expect(section.getByTestId('alert-report')).toBeEnabled({ timeout: 15_000 })
      expect.soft(norm(await section.textContent()), 'the alert window').toContain(want.text)
      await section.getByTestId('alert-report').click()
      const amber = () => page.getByTestId('investigation-modal').evaluate((m) => [...m.querySelectorAll('div')]
        .filter((d) => d.className.includes('border-amber-800/60')).map((d) => (d.textContent ?? '').replace(/\s+/g, ' ').trim()))
      await expect(page.getByTestId('investigation-modal').getByTestId('investigation-meta')).toBeVisible({ timeout: 15_000 })
      expect.soft(await amber(), 'the report opened from the alert').toEqual([want.text])

      await page.goto('/admin/investigations')
      const status = page.getByTestId(`investigation-row-${invId}`).locator('td').nth(4).locator('span').first()
      await expect(status).toHaveText(EN.investigations.status.skipped, { timeout: 15_000 })
      expect.soft(await status.getAttribute('title'), 'Admin → Investigations: the status says why').toBe(want.text)
    } finally {
      psql(`DELETE FROM alert_investigations WHERE id = '${invId}'`)
      await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, [{ status: 'resolved', labels, annotations: {}, startsAt, fingerprint, endsAt: new Date().toISOString() }])
    }
  })

  test('the severity filter offers every severity the alerts carry and finds the alert', async ({ page, request }) => {
    test.setTimeout(90_000)
    const run = Date.now().toString(36)
    const name = `E2EN4aNone${run}`
    const labels = { alertname: name, severity: 'none', namespace: 'default' }
    const startsAt = new Date(Date.now() - 60_000).toISOString()
    const fingerprint = `n4a-none-${run}`
    await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, [{ status: 'firing', labels, annotations: { summary: `n4a none ${run}` }, startsAt, fingerprint }])
    try {
      const carried = psql(`SELECT DISTINCT severity FROM alert_inbox WHERE cluster = '${INBOX.cluster}' AND severity <> '' ORDER BY severity`).split('\n').filter(Boolean)
      const want = [EN.alertInbox.status.all, ...new Set(['critical', 'warning', 'info', ...carried])]
      await page.goto(`${INBOX.path}?cluster=${INBOX.cluster}`)
      await page.getByTestId('alert-inbox-table').waitFor()
      // the dropdown: its label's parent holds the field button, then the open list's entries
      const field = page.locator('label', { hasText: new RegExp(`^${EN.alertInbox.filter.severity}$`) }).locator('..')
      const options = () => field.locator('button').evaluateAll((bs) => bs.slice(1).map((b) => (b.textContent ?? '').trim()))
      await field.locator('button').first().click()
      try {
        await expect.poll(options, { timeout: 10_000 }).toEqual(want)
      } catch {
        // compared below
      }
      expect.soft(await options(), 'the severities offered').toEqual(want)
      expect.soft(carried, 'the database holds the alert of severity none').toContain('none')
      const api = await list(request, { q: run, severity: 'none' })
      expect.soft(api.total, 'the API finds it').toBe(1)
      const none = field.locator('button').filter({ hasText: /^none$/ })
      if (await none.count()) {
        await none.click()
        await page.getByTestId('alert-inbox-search').fill(run)
        await expect.poll(() => rowIds(page), { timeout: 15_000 }).toEqual(api.items.map((i) => i.id))
      }
    } finally {
      await post(request, INBOX.cluster, `{}:{alertname="${name}"}`, [{ status: 'resolved', labels, annotations: {}, startsAt, fingerprint, endsAt: new Date().toISOString() }])
    }
  })

  test("the Silences tab lists the store's silences that mute the cluster's alerts, with their scope", async ({ page, request }) => {
    test.setTimeout(120_000)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!['default', 'self'].every((c) => features.alertStore?.clusters?.includes(c)), 'no alert store for clusters default and self')
    try {
      am('GET', '/-/ready')
    } catch {
      test.skip(true, 'no Alertmanager on NodePort 31093')
    }
    const run = Date.now().toString(36)
    const span = { startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdBy: 'e2e' }
    const made: string[] = []
    try {
      // no cluster condition: every cluster on the store; a cluster pattern that takes default (kubeast-b) and not self
      for (const [matchers, comment] of [
        [[{ name: 'alertname', value: `E2EN4aAll${run}`, isRegex: false, isEqual: true }], `n4a all ${run}`],
        [[{ name: 'alertname', value: `E2EN4aPat${run}`, isRegex: false, isEqual: true }, { name: 'cluster', value: `kubeast-b|nothing-${run}`, isRegex: true, isEqual: true }], `n4a pattern ${run}`],
      ] as const) {
        made.push(JSON.parse(am('POST', '/api/v2/silences', { matchers, comment, ...span })).silenceID as string)
      }
      const [all, pattern] = made
      const scopes = async (cluster: string) => {
        const res = await request.get('/api/v1/alertstore/silences', { headers: bearer(admin), params: { cluster } })
        expect(res.status(), await res.text()).toBe(200)
        return Object.fromEntries(((await res.json()).silences as Obj[]).filter((s) => made.includes(s.id)).map((s) => [s.id, s.scope]))
      }
      expect.soft(await scopes('default'), 'the API for default').toEqual({ [all]: 'all', [pattern]: 'pattern' })
      expect.soft(await scopes('self'), 'the API for self').toEqual({ [all]: 'all' })

      const shown = async (cluster: string) => {
        await page.goto(`${INBOX.path}?cluster=${cluster}`)
        await page.getByTestId('alert-tab-silences').click()
        const listed = page.getByTestId('silence-list')
        await expect(listed.locator('svg.animate-spin')).toHaveCount(0, { timeout: 15_000 })
        return listed.locator('tbody tr[data-testid^="silence-row-"]').evaluateAll((trs, ids) => trs
          .filter((tr) => ids.includes((tr.getAttribute('data-testid') ?? '').slice('silence-row-'.length)))
          .map((tr) => ({
            id: (tr.getAttribute('data-testid') ?? '').slice('silence-row-'.length),
            scope: (tr.querySelector('[data-testid="silence-scope"]')?.textContent ?? '').trim(),
            end: tr.querySelectorAll('[data-testid="silence-expire"]').length,
          })), made)
      }
      const sort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
      expect.soft(sort(await shown('default')), 'the Silences tab of default').toEqual(sort([
        { id: all, scope: EN.alertInbox.silence.scope.all, end: 0 },
        { id: pattern, scope: EN.alertInbox.silence.scope.pattern, end: 0 },
      ]))
      expect.soft(await shown('self'), 'the Silences tab of self').toEqual([{ id: all, scope: EN.alertInbox.silence.scope.all, end: 0 }])
    } finally {
      for (const id of made) {
        try {
          am('DELETE', `/api/v2/silence/${id}`)
        } catch { /* expired already */ }
      }
    }
  })
})
