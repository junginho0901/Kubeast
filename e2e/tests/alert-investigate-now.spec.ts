import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Locator, type Page, type Route } from '@playwright/test'

// "Investigate now" in the alert window (ai-service POST /api/v1/alerts/inbox/{id}/investigate, permission
// resource.alert.investigate, chart features.alertInvestigation.manual — on, and the dev values give the manual kind a
// budget, which the chart leaves at none):
// - an alert with no investigation: the button queues one as the webhook does, the window goes Queued → Failed in place
//   (one height, never empty), the press (ai.investigation.request) and the run (ai.investigation.run, requested_by) are
//   audited, and a failed one can be asked for again.
// - a skipped investigation offers the button; a running one is shown and a press queues nothing; the day's budget of
//   asked-for runs, spent, locks the button with why and the next 00:00 UTC in the viewer's zone — in the window, the
//   API (429, Retry-After) and the window's AI layer.
// - a Write grant sees no button and is refused (403); a role holding resource.alert.investigate gets the button.
// No model is called: the alerts carry a namespace label that is not a Kubernetes name, so auth-service refuses the
// investigator's token (400) and a run fails before its first model call; the queue, the worker and the audit rows
// are the real ones. The skipped, running and spent-budget rows are written into the dev database as the service
// writes them (inv-e2e-n4a2-*), and every row and user the spec makes goes after; the inbox rows stay, resolved.

const INBOX = { path: '/alerts', cluster: 'self' }

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-n4a2-pass1!'
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const NOW_EN = EN.alertInbox.investigateNow

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const num = (n: number) => n.toLocaleString('en-US')
// a namespace label auth-service refuses for the investigator's token: a run ends before its first model call
const badNamespace = (run: string) => `E2E_N4A2_${run}`
// the next 00:00 UTC, as the server writes it
function nextUtcMidnight(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString().replace('.000Z', 'Z')
}

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-investigate-now-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8' }).trim()
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: 100 } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items ?? []).map((i: Obj) => ({
    target: i.TargetID ?? i.target_id, actor: i.ActorEmail ?? i.actor_email, result: i.Result ?? i.result, after: i.After ?? i.after ?? {},
  }))
}

// the texts of a locator's matches now, without waiting (an element the old screen lacks reads as "")
const textOf = async (loc: Locator) => (await loc.allTextContents()).map(norm).join(' | ')

// waits for a value that comes later (the worker, the audit store); a wrong one is kept as a soft failure, so one
// value does not hide the checks after it
async function settle(read: () => Promise<unknown>, want: unknown, message: string, timeout = 15_000) {
  try {
    await expect.poll(read, { timeout }).toEqual(want)
  } catch {
    expect.soft(await read(), message).toEqual(want)
  }
}

// a time as the screen writes it (utils/time formatTime: YYYY-MM-DD HH:mm:ss in the viewer's zone)
const viewerTime = (page: Page, iso: string) => page.evaluate((v) => {
  const d = new Date(v)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}, iso)

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
  return page
}

test.describe('Investigate now in the Alerts inbox', () => {
  // the spent-budget case holds the day's budget for a moment: the cases take turns
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let adminEmail = ''
  let webhookToken = ''

  test.beforeEach(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.alertInvestigation?.enabled, 'alert investigation (the webhook and the inbox) is off')
    adminEmail ||= (await (await request.get('/api/v1/auth/me', { headers: bearer(admin) })).json()).email
    webhookToken ||= Buffer.from(kubectl(['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']), 'base64').toString()
  })

  const post = (request: APIRequestContext, status: string, labels: Obj, fingerprint: string, extra: Obj = {}) =>
    request.post(`/api/v1/alerts/webhook?cluster=${INBOX.cluster}`, {
      headers: { Authorization: `Bearer ${webhookToken}` },
      data: {
        version: '4', groupKey: `{}:{alertname="${labels.alertname}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093',
        alerts: [{ status, labels, annotations: { summary: `n4a2 ${labels.alertname}` }, startsAt: new Date(Date.now() - 3 * 60_000).toISOString(), fingerprint, ...extra }],
      },
    })
  // one inbox row of a new info alert (kept, not investigated by the webhook)
  async function newAlert(request: APIRequestContext, run: string, label: string): Promise<{ id: string; labels: Obj; fingerprint: string }> {
    const labels = { alertname: `E2EN4a2${label}${run}`, severity: 'info', namespace: badNamespace(run) }
    const fingerprint = `n4a2-${label.toLowerCase()}-${run}`
    expect((await (await post(request, 'firing', labels, fingerprint)).json()).stored).toBe(1)
    const list = await (await request.get('/api/v1/alerts/inbox', { headers: bearer(admin), params: { cluster: INBOX.cluster, q: run, limit: 50 } })).json()
    const item = (list.items as Obj[]).find((i) => i.fingerprint === fingerprint)
    expect(item, 'its inbox row').toBeTruthy()
    return { id: item.id, labels, fingerprint }
  }
  const windowOf = async (request: APIRequestContext, token: string, id: string): Promise<Obj> => {
    const res = await request.get(`/api/v1/alerts/inbox/${id}`, { headers: bearer(token) })
    expect(res.status(), await res.text()).toBe(200)
    return res.json()
  }
  const press = (request: APIRequestContext, token: string, id: string) =>
    request.post(`/api/v1/alerts/inbox/${id}/investigate`, { headers: bearer(token), failOnStatusCode: false })
  // the alert window and its AI investigation section, once drawn
  async function openWindow(page: Page, id: string): Promise<Locator> {
    await page.goto(`${INBOX.path}?cluster=${INBOX.cluster}&alert=${id}`)
    const win = page.getByTestId('alert-detail')
    await expect(win.getByTestId('alert-detail-meta')).toBeVisible({ timeout: 15_000 })
    const section = win.locator('section', { has: page.locator('h3', { hasText: EN.alertInbox.col.investigation }) })
    await expect(section).toBeVisible()
    return section
  }

  test('an alert with no investigation: the button queues one, the window goes Queued → Failed in place, the press and the run are audited, and a failed one can be asked for again', async ({ page, request }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    const since = new Date(Date.now() - 5_000).toISOString()
    const alert = await newAlert(request, run, 'Now')
    try {
      const before = await windowOf(request, admin, alert.id)
      expect(before.investigation, 'info alerts are not investigated by the webhook').toBeNull()
      const state = before.investigate_now
      test.skip(['provider_paused', 'manual_off', 'manual_budget'].includes(state?.reason), `the dev install does not let anyone ask now (${state?.reason})`)
      expect.soft(state?.allowed, 'the server lets the global admin ask for one').toBe(true)

      const section = await openWindow(page, alert.id)
      const button = section.getByTestId('alert-investigate-now')
      expect.soft(await button.count(), 'the button in the window').toBe(1)
      const used = Number(state?.used ?? 0)
      const budget = Number(state?.budget ?? 0)
      expect.soft(await textOf(section.getByTestId('alert-investigate-note')), "the note: today's use, the server's numbers")
        .toBe(budget > 0 ? NOW_EN.used.replace('{{used}}', num(used)).replace('{{budget}}', num(budget)) : '')

      // what the window shows from now on: its heights, the status each time it changes, and any empty or loading moment
      await section.evaluate((el, loading) => {
        const w = window as unknown as { __n4a2: { section: number[]; dialog: number[]; statuses: string[]; blank: number } }
        w.__n4a2 = { section: [], dialog: [], statuses: [], blank: 0 }
        const dialog = el.closest('[data-testid="alert-detail"]') as HTMLElement
        const note = () => {
          const s = w.__n4a2
          const h = Math.round(el.getBoundingClientRect().height)
          const dh = Math.round(dialog.getBoundingClientRect().height)
          if (!s.section.includes(h)) s.section.push(h)
          if (!s.dialog.includes(dh)) s.dialog.push(dh)
          const status = (el.querySelector('[data-testid="alert-investigation-status"]')?.textContent ?? '').trim()
          if (s.statuses[s.statuses.length - 1] !== status) s.statuses.push(status)
          if (!el.isConnected || (dialog.textContent ?? '').includes(loading)) s.blank++
        }
        note()
        new MutationObserver(note).observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true })
      }, EN.common.loading)

      let first: Obj = null
      if ((await button.count()) === 1) {
        const answered = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/alerts/inbox/${alert.id}/investigate` && r.request().method() === 'POST')
        await button.click()
        const res = await answered
        expect.soft(res.status(), 'the press').toBe(200)
        if (res.status() === 200) first = await res.json()
      } else {
        expect.soft((await press(request, admin, alert.id)).status(), 'the press through the API (no button)').toBe(200)
      }
      expect.soft(first && { started: first.started, status: first.investigation?.status, requested_by: first.investigation?.requested_by },
        'the answer: a new queued investigation, asked for by the admin').toEqual({ started: true, status: 'queued', requested_by: adminEmail })

      if (first) {
        const invId = first.investigation.id
        // the worker takes it at once and the investigator's token is refused: Failed, read again every 5 s
        await settle(() => textOf(section.getByTestId('alert-investigation-status')), EN.investigations.status.failed, 'the window reaches Failed', 60_000)
        const seen = await page.evaluate(() => (window as unknown as { __n4a2: Obj }).__n4a2)
        expect.soft(seen.statuses[0], 'before the press: no investigation').toBe('')
        expect.soft(seen.statuses.slice(1, -1).every((s: string) => [EN.investigations.status.queued, EN.investigations.status.running].includes(s)),
          `between: Queued or Running only (${seen.statuses.join(' → ')})`).toBe(true)
        expect.soft(seen.statuses[1], 'the answer shows Queued at once').toBe(EN.investigations.status.queued)
        expect.soft(seen.section.length, `the section kept one height (${seen.section.join(', ')})`).toBe(1)
        expect.soft(seen.dialog.length, `the window kept one height (${seen.dialog.join(', ')})`).toBe(1)
        expect.soft(seen.blank, 'no empty or loading moment').toBe(0)
        expect.soft(await textOf(section.getByTestId('alert-investigation-requested')), 'who asked, shown')
          .toBe(NOW_EN.requestedBy.replace('{{who}}', adminEmail).replace('{{when}}', await viewerTime(page, first.investigation.received_at)))

        // the row: failed, asked for by the admin, no tokens (no model call)
        expect.soft(psql(`SELECT count(*) FROM alert_investigations WHERE id = '${invId}' AND status = 'failed' AND requested_by = '${adminEmail}' AND total_tokens IS NULL`),
          'the investigation row').toBe('1')
        await settle(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id)
          .map((r) => ({ actor: r.actor, result: r.result, started: r.after.started, investigation_id: r.after.investigation_id, status: r.after.status })),
        [{ actor: adminEmail, result: 'success', started: true, investigation_id: invId, status: 'queued' }], 'ai.investigation.request')
        await settle(async () => (await auditRows(request, admin, 'ai.investigation.run', since)).filter((r) => r.after.investigation_id === invId)
          .map((r) => ({ result: r.result, requested_by: r.after.requested_by, total_tokens: r.after.total_tokens })),
        [{ result: 'failure', requested_by: adminEmail, total_tokens: null }], 'ai.investigation.run')

        // a failed one: asked for again from the same window
        expect.soft(await button.count(), 'the button is back after the failure').toBe(1)
        if ((await button.count()) === 1) {
          const again = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/alerts/inbox/${alert.id}/investigate` && r.request().method() === 'POST')
          await button.click()
          const res = await again
          const body = res.status() === 200 ? await res.json() : null
          expect.soft(body && { started: body.started, fresh: body.investigation?.id !== invId, status: body.investigation?.status }, 'pressed again after the failure')
            .toEqual({ started: true, fresh: true, status: 'queued' })
        }
      }
    } finally {
      psql(`DELETE FROM alert_investigations WHERE cluster = '${INBOX.cluster}' AND fingerprint = '${alert.fingerprint}'`)
      await post(request, 'resolved', alert.labels, alert.fingerprint, { endsAt: new Date().toISOString() })
    }
  })

  test("a skipped investigation offers the button; a running one is shown and a press queues nothing; the day's spent budget locks it with why and until when", async ({ page, request }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    const since = new Date(Date.now() - 5_000).toISOString()
    const alert = await newAlert(request, run, 'Held')
    const ids = { skipped: `inv-e2e-n4a2-${run}-s`, running: `inv-e2e-n4a2-${run}-r`, spent: `inv-e2e-n4a2-${run}-b` }
    const sent: { base?: Obj; overlays?: Obj[] }[] = []
    const fulfil = async (route: Route, answer: Parameters<Route['fulfill']>[0]) => {
      try {
        await route.fulfill(answer)
      } catch { /* the page went on */ }
    }
    // the floating chat's session and answer stood in, so asking it shows what the window sends (page_context)
    const chatRoutes: [RegExp, (route: Route) => Promise<void>][] = [
      [/\/api\/v1\/sessions(\?|$)/, (route) => (route.request().method() === 'POST'
        ? fulfil(route, { json: { id: 'e2e-n4a2-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())],
      [/\/api\/v1\/sessions\/e2e-n4a2-ctx-\d+(\?|$)/, (route) => fulfil(route, { json: { id: 'e2e-n4a2-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } })],
      [/\/api\/v1\/ai\/sessions\/e2e-n4a2-ctx-\d+\/floating-chat/, (route) => {
        sent.push(route.request().postDataJSON().page_context)
        return fulfil(route, { contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
      }],
    ]
    let routed = false
    // a row as the service writes one, with these columns besides the alert's (values as SQL)
    const insert = (id: string, fingerprint: string, columns: Record<string, string>) => psql(
      `INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, received_at, last_seen_at, ${Object.keys(columns).join(', ')})
       VALUES ('${id}', '${INBOX.cluster}', '${fingerprint}', '${alert.labels.alertname}', 'info', '${alert.labels.namespace}',
               now() at time zone 'utc', now() at time zone 'utc', ${Object.values(columns).join(', ')})`)
    try {
      const reason = (await windowOf(request, admin, alert.id)).investigate_now?.reason
      test.skip(['provider_paused', 'manual_off', 'manual_budget'].includes(reason), `the dev install does not let anyone ask now (${reason})`)
      // as the webhook writes an alert skipped by its hourly cap
      insert(ids.skipped, alert.fingerprint, { status: `'skipped'`, skip_reason: `'hourly cap (6 per hour)'` })
      const skipped = await windowOf(request, admin, alert.id)
      expect.soft({ status: skipped.investigation?.status, allowed: skipped.investigate_now?.allowed }, 'a skipped one may be asked for again').toEqual({ status: 'skipped', allowed: true })
      let section = await openWindow(page, alert.id)
      expect.soft(await section.getByTestId('alert-investigate-now').count(), 'the button beside the skipped one').toBe(1)

      // as the worker holds one (it fails running rows only past timeoutSeconds + 60 s)
      insert(ids.running, alert.fingerprint, { status: `'running'`, started_at: `now() at time zone 'utc'` })
      const held = await windowOf(request, admin, alert.id)
      expect.soft({ id: held.investigation?.id, reason: held.investigate_now?.reason }, 'a running one is the window’s, with no button').toEqual({ id: ids.running, reason: 'investigating' })
      section = await openWindow(page, alert.id)
      await expect.poll(() => section.textContent().then(norm), { timeout: 15_000 }).toContain(EN.investigations.status.running)
      expect.soft(await section.getByTestId('alert-investigate-now').count(), 'no button while it runs').toBe(0)
      const pressed = await press(request, admin, alert.id)
      expect.soft(pressed.status(), 'a press while it runs answers the window').toBe(200)
      const body = pressed.status() === 200 ? await pressed.json() : null
      expect.soft(body && { started: body.started, id: body.investigation?.id }, 'nothing new is queued').toEqual({ started: false, id: ids.running })
      expect.soft(psql(`SELECT count(*) FROM alert_investigations WHERE fingerprint = '${alert.fingerprint}'`), 'still the two rows the spec wrote').toBe('2')
      await settle(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id)
        .map((r) => ({ result: r.result, started: r.after.started, status: r.after.status, investigation_id: r.after.investigation_id })),
      [{ result: 'success', started: false, status: 'running', investigation_id: ids.running }], 'the press is audited')
      psql(`DELETE FROM alert_investigations WHERE id = '${ids.running}'`)

      // the day's budget of asked-for runs spent (by another alert's run): locked until the next 00:00 UTC
      const budget = Number(held.investigate_now?.budget ?? 0)
      test.skip(budget === 0, 'the manual budget is 0 (none) on this install')
      const hasColumn = psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'alert_investigations' AND column_name = 'requested_by'`) === '1'
      expect.soft(hasColumn, 'the investigation rows say who asked (migration 00021)').toBe(true)
      if (!hasColumn) return
      insert(ids.spent, `n4a2-spent-${run}`, { status: `'done'`, requested_by: `'e2e-n4a2-${run}@kubeast.local'`, total_tokens: String(budget) })
      const until = nextUtcMidnight()
      const spent = await windowOf(request, admin, alert.id)
      const used = Number(psql(`SELECT coalesce(sum(total_tokens), 0) FROM alert_investigations WHERE requested_by <> '' AND received_at >= date_trunc('day', now() at time zone 'utc')`))
      expect.soft(spent.investigate_now, 'the API: locked by the budget, the database sum and the next 00:00 UTC')
        .toMatchObject({ allowed: false, reason: 'manual_budget', until, budget, used })
      section = await openWindow(page, alert.id)
      const button = section.getByTestId('alert-investigate-now')
      expect.soft(await button.count(), 'the button stays, locked').toBe(1)
      expect.soft((await button.count()) === 1 && (await button.isDisabled()), 'locked').toBe(true)
      const why = NOW_EN.why.manual_budget.replace('{{budget}}', num(budget)).replace('{{until}}', await viewerTime(page, until))
      expect.soft(await textOf(section.getByTestId('alert-investigate-note')), 'why and until when, in the viewer’s zone').toBe(why)
      const refused = await press(request, admin, alert.id)
      expect.soft(refused.status(), 'the API refuses it').toBe(429)
      const detail = refused.status() === 429 ? (await refused.json()).detail : null
      expect.soft(detail && { code: detail.code, until: detail.until }, 'with its code and time').toEqual({ code: 'manual_budget', until })
      const wait = Number(refused.headers()['retry-after'] ?? 0)
      expect.soft(wait > 0 && wait <= 86_400, `Retry-After ${wait} s`).toBe(true)
      await settle(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id && r.result === 'failure')
        .map((r) => ({ actor: r.actor, code: r.after.code, until: r.after.until })), [{ actor: adminEmail, code: 'manual_budget', until }], 'the refusal is audited')

      // the window's AI layer carries the button as the server decided it
      for (const [url, handler] of chatRoutes) await page.route(url, handler)
      routed = true
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()
      await input.fill('can I investigate this alert now?')
      await input.press('Enter')
      await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1)
      const layer = [sent[0].base, ...(sent[0].overlays ?? [])].find((l) => l?.source === 'AlertDetailModal')?.data
      expect.soft(layer?.investigate_now, "the window's AI layer").toEqual({ allowed: false, reason: 'manual_budget', until, automatic: true, budget, used, shown: true, note: why })
    } finally {
      if (routed) for (const [url, handler] of chatRoutes) await page.unroute(url, handler)
      psql(`DELETE FROM alert_investigations WHERE id LIKE 'inv-e2e-n4a2-${run}-%' OR (cluster = '${INBOX.cluster}' AND fingerprint = '${alert.fingerprint}')`)
      await post(request, 'resolved', alert.labels, alert.fingerprint, { endsAt: new Date().toISOString() })
    }
  })

  test("it is the Admin role's: a Write grant sees no button and is refused, a role holding resource.alert.investigate gets the button", async ({ browser, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const since = new Date(Date.now() - 5_000).toISOString()
    const alert = await newAlert(request, run, 'Role')
    const userIds: string[] = []
    let roleId = 0
    const pages: Page[] = []
    const roles = async () => {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      return (Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { id: number; name: string }[]
    }
    async function user(label: string, role: string): Promise<{ email: string; token: string }> {
      const member = (await roles()).find((r) => r.name.toLowerCase() === 'member')!
      const email = `e2e-n4a2-${label}-${run}@kubeast.local`
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E n4a2 ${label}`, email, password: PW, role_id: member.id } })
      expect(created.status(), await created.text()).toBe(201)
      const userId = (await created.json()).id
      userIds.push(userId)
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${INBOX.cluster}`, { headers: bearer(admin), data: { role } })
      expect(put.ok(), await put.text()).toBeTruthy()
      return { email, token: await login(request, email, PW) }
    }
    try {
      // the Write role on the cluster: reads the inbox, holds resource.*.create/edit/delete, not resource.alert.investigate
      const writer = await user('write', 'Write')
      const shown = await windowOf(request, writer.token, alert.id)
      expect.soft(shown.investigate_now?.reason, 'the server: no permission').toBe('forbidden')
      const refused = await press(request, writer.token, alert.id)
      expect.soft(refused.status(), 'the API refuses Write').toBe(403)
      expect.soft(refused.status() === 403 ? (await refused.json()).detail?.code : null, 'with its code').toBe('forbidden')
      await settle(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id)
        .map((r) => ({ actor: r.actor, result: r.result, code: r.after.code })), [{ actor: writer.email, result: 'failure', code: 'forbidden' }], 'the refusal is audited')
      const writerPage = await signIn(browser, writer.email)
      pages.push(writerPage)
      const writerSection = await openWindow(writerPage, alert.id)
      expect.soft(await writerSection.getByTestId('alert-investigate-now').count(), 'Write: no button').toBe(0)

      // a role that adds the permission (Role Management lists it under Alerts)
      const roleName = `e2e-n4a2-asker-${run}`
      const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: roleName, description: 'e2e', permissions: ['menu.*', 'resource.*.read', 'resource.alert.investigate'] } })
      expect.soft(role.status(), 'a role may carry resource.alert.investigate').toBe(201)
      if (role.status() === 201) {
        roleId = (await role.json()).id
        const asker = await user('asker', roleName)
        const state = (await windowOf(request, asker.token, alert.id)).investigate_now
        expect.soft({ allowed: state?.allowed, reason: state?.reason }, 'the server lets that role ask').toEqual({ allowed: true, reason: '' })
        const askerPage = await signIn(browser, asker.email)
        pages.push(askerPage)
        const askerSection = await openWindow(askerPage, alert.id)
        expect.soft(await askerSection.getByTestId('alert-investigate-now').count(), 'that role: the button').toBe(1)
      }
    } finally {
      for (const p of pages) await p.context().close()
      for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
      if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: bearer(admin), failOnStatusCode: false })
      psql(`DELETE FROM alert_investigations WHERE cluster = '${INBOX.cluster}' AND fingerprint = '${alert.fingerprint}'`)
      await post(request, 'resolved', alert.labels, alert.fingerprint, { endsAt: new Date().toISOString() })
    }
  })
})
