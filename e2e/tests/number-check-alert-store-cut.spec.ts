import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test'

// What a silence would mute, and the alert store's limit, said: the second cluster's Alertmanager (NodePort 31093,
// features.alertStore for cluster default, dev maxAlerts 100) gets 105 alerts of one name, so the silence window
// opened from one of them counts all 105, lists the 100 the store sends ten to a page and says the store cut the rest;
// the Alerts page and the floating chat say the store's list for the cluster was cut, and the alert window of an alert
// the list left out says "Alertmanager now" is unknown with the store's numbers (also in its AI layer). The screen is
// compared with the store API's answer, the preview's count also with Alertmanager itself. The alerts carry
// kubeast_e2e="store" (the dev route sends them to no receiver) and are resolved at the start and the end; the two
// inbox rows stay, resolved (retention deletes them).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const CLUSTER = 'default'
const STORE_CLUSTER = 'kubeast-b'
const CASE = 'store-cut'
// past the dev store limit (100) and past ten to a page
const N = 105

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type AmAlert = { fingerprint: string; labels: Record<string, string>; startsAt: string; status: { state: string } }
type Walked = { count: string | null; notes: string[]; pages: { items: string[][]; pager: string | null }[] }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const q = (s: string) => encodeURIComponent(s)

// the second cluster's Alertmanager, asked from its node (the laptop does not reach the kind network)
function am(method: 'GET' | 'POST', urlPath: string, body?: unknown): string {
  const data = body === undefined ? '' : `-H 'Content-Type: application/json' --data-binary @-`
  return execSync(`docker exec -i kubeast-b-control-plane curl -sf -X ${method} ${data} 'http://127.0.0.1:31093${urlPath}'`, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
}
const amAlerts = (filters: string[]) => JSON.parse(am('GET', `/api/v2/alerts?${filters.map((f) => `filter=${q(f)}`).join('&')}`)) as AmAlert[]

// every alert of this case still held, earlier runs too, resolved (an alert whose endsAt is past is no longer listed)
async function resolveCase() {
  const held = amAlerts([`e2e_case="${CASE}"`])
  if (held.length) am('POST', '/api/v2/alerts', held.map((a) => ({ labels: a.labels, startsAt: a.startsAt, endsAt: new Date(Date.now() - 1000).toISOString() })))
  await expect.poll(() => amAlerts([`e2e_case="${CASE}"`]).length, { timeout: 30_000 }).toBe(0)
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login ${ADMIN_EMAIL}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// the silence window's preview: the count line, its own notes, and per page the alerts' cells and the pager's range
async function readPreview(page: Page) {
  return page.getByTestId('silence-preview').evaluate((sec) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const count = sec.querySelector('[data-testid="silence-preview-count"]')
    const pager = [...sec.querySelectorAll('span')].find((s) => /^\d+-\d+ \/ \d+$/.test(txt(s)))
    const next = pager ? [...(pager.parentElement?.querySelectorAll('button') ?? [])].find((b) => txt(b) === 'Next') as HTMLButtonElement | undefined : undefined
    return {
      count: count ? txt(count) : null,
      notes: [...sec.querySelectorAll('p')].filter((p) => p !== count).map(txt),
      items: [...sec.querySelectorAll('li')].map((li) => [...li.querySelectorAll('span')].map(txt)),
      pager: pager ? txt(pager) : null,
      next: !!next && !next.disabled,
    }
  })
}

async function walkPreview(page: Page): Promise<Walked> {
  const first = await readPreview(page)
  const pages = [{ items: first.items, pager: first.pager }]
  let cur = first
  for (let i = 0; i < 30 && cur.next; i++) {
    const before = cur.pager
    await page.getByTestId('silence-preview').getByRole('button', { name: 'Next' }).click()
    await expect.poll(async () => (await readPreview(page)).pager, { timeout: 10_000 }).not.toBe(before)
    cur = await readPreview(page)
    pages.push({ items: cur.items, pager: cur.pager })
  }
  return { count: first.count, notes: first.notes, pages }
}

function pagesOf(rows: string[][], size: number) {
  const pages: Walked['pages'] = []
  for (let i = 0; i < rows.length; i += size) {
    pages.push({ items: rows.slice(i, i + size), pager: rows.length > size ? `${i + 1}-${Math.min(i + size, rows.length)} / ${rows.length}` : null })
  }
  return pages.length ? pages : [{ items: [], pager: null }]
}

const cutNote = (key: string, listed: number, total: number) => (key === 'silence' ? EN.alertInbox.silence.storeCut : EN.alertInbox.storeCut)
  .replace('{{listed}}', String(listed)).replace('{{total}}', String(total))

test.describe('number check — the alert store limit', () => {
  test('the silence preview counts and lists every matching alert, and a list the store cut says so', async ({ page, request }) => {
    test.setTimeout(300_000)
    const token = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(token) })).json()
    test.skip(!features.alertInvestigation?.enabled, 'alert investigation (the webhook) is off')
    test.skip(!features.alertStore?.clusters?.includes(CLUSTER) || !features.alertStore?.silences, `no alert store with silences for cluster ${CLUSTER}`)
    try {
      am('GET', '/-/ready')
    } catch {
      test.skip(true, 'no Alertmanager on NodePort 31093')
    }
    const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-store-cut-')), 'kubeconfig')
    fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
    const webhookToken = Buffer.from(execSync(`kubectl --kubeconfig ${kc} -n kubeast get secret kubeast-secrets -o jsonpath={.data.ALERT_WEBHOOK_TOKEN}`, { encoding: 'utf8' }).trim(), 'base64').toString()

    const run = Date.now().toString(36)
    const name = `E2EStoreCut${run}`
    const labels = (i: number) => ({ alertname: name, cluster: STORE_CLUSTER, severity: 'info', namespace: 'default', kubeast_e2e: 'store', e2e_case: CASE, e2e_i: String(i).padStart(3, '0') })
    const startsAt = new Date().toISOString()
    const post = (status: string, alert: Obj, extra: Obj = {}) => request.post(`/api/v1/alerts/webhook?cluster=${CLUSTER}`, {
      headers: { Authorization: `Bearer ${webhookToken}` },
      data: { version: '4', groupKey: `{}:{alertname="${name}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093', alerts: [{ status, annotations: {}, startsAt, ...alert, ...extra }] },
    })
    await resolveCase()
    let fingerprint = ''
    let firstLabels: Record<string, string> = {}
    // the alert the alert window step opens (one the store's list left out), and the floating chat stand-ins to undo
    let leftOut: AmAlert | undefined
    let routed = async () => {}
    try {
      // ten minutes at most, should the run stop before it resolves them
      am('POST', '/api/v2/alerts', Array.from({ length: N }, (_, i) => ({ labels: labels(i), annotations: { summary: `store cut ${run}` }, startsAt, endsAt: new Date(Date.now() + 10 * 60_000).toISOString() })))
      const ours = [`alertname="${name}"`, 'namespace="default"', `cluster="${STORE_CLUSTER}"`]
      // all held and past Alertmanager's own processing, so the state the store reports does not move under the test
      await expect.poll(() => amAlerts(ours).filter((a) => a.status.state === 'active').length, { timeout: 60_000 }).toBe(N)
      const one = amAlerts(ours).find((a) => a.labels.e2e_i === '000')!
      fingerprint = one.fingerprint
      firstLabels = one.labels
      expect((await (await post('firing', { labels: one.labels, fingerprint })).json()).stored).toBe(1)
      const inbox = await (await request.get('/api/v1/alerts/inbox', { headers: bearer(token), params: { cluster: CLUSTER, q: run, limit: 200 } })).json()
      const row = (inbox.items as Obj[]).find((i) => i.alertname === name)
      expect(row, 'the inbox row of the alert the window opens from').toBeTruthy()

      // the conditions the window starts from (alertname and namespace; the server adds the cluster)
      const matchers = [{ name: 'alertname', value: name, isRegex: false, isEqual: true }, { name: 'namespace', value: 'default', isRegex: false, isEqual: true }]
      const preview = async () => (await request.get('/api/v1/alertstore/silences/preview', { headers: bearer(token), params: { cluster: CLUSTER, matchers: JSON.stringify(matchers) } })).json()
      const api = await preview()
      expect(api.total, 'the store counts every alert Alertmanager holds for the conditions').toBe(amAlerts(ours).length)
      expect(api.truncated, 'the store cut the list at its limit').toBe(true)
      expect(api.alerts.length, 'the store sent fewer than it counts').toBeLessThan(api.total)

      await test.step('the silence window: the count of all, every alert sent page by page, the cut said', async () => {
        await page.goto(`/alerts?cluster=${CLUSTER}&alert=${row.id}`)
        await page.getByTestId('alert-detail').getByTestId('alert-silence').click()
        const want: Walked = {
          count: EN.alertInbox.silence.affectedCount.replace('{{count}}', String(api.total)),
          notes: [cutNote('silence', api.alerts.length, api.total)],
          pages: pagesOf((api.alerts as Obj[]).map((a) => [a.alertname, a.labels.namespace ?? '', a.state]), 10),
        }
        try {
          await expect.poll(async () => (await readPreview(page)).count, { timeout: 20_000 }).toBe(want.count)
        } catch {
          // compared below with what it shows
        }
        expect.soft(await walkPreview(page), 'silence preview').toEqual(want)
      })

      // the store's list for the whole cluster, as the Alerts page reads it
      // store reads are limited per user and minute (alertStore.perUserPerMinute): a refused read waits the minute out
      const listOf = async () => {
        for (let i = 0; ; i++) {
          const res = await request.get('/api/v1/alertstore/alerts', { headers: bearer(token), params: { cluster: CLUSTER, state: 'all' } })
          if (res.status() !== 429 || i === 1) return res.json()
          await page.waitForTimeout(61_000)
        }
      }
      const openWithStore = async (url: string) => {
        for (let i = 0; i < 2; i++) {
          const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/alertstore/alerts' && r.request().method() === 'GET', { timeout: 30_000 })
          await page.goto(url)
          if ((await read).status() !== 429) return
          await page.waitForTimeout(61_000)
        }
      }
      const noticeOf = (l: Obj) => (l.truncated ? [cutNote('inbox', l.alerts.length, l.total)] : [])
      const notices = () => page.evaluate(() => [...document.querySelectorAll('div.shrink-0')]
        .filter((d) => d.className.includes('border-amber-800/60') && !d.closest('[role="dialog"]'))
        .map((d) => (d as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))

      await test.step("the Alerts page: the store's list for the cluster was cut", async () => {
        const list = await listOf()
        expect(list.truncated, 'the store cut its list for the cluster').toBe(true)
        await openWithStore(`/alerts?cluster=${CLUSTER}`)
        await page.getByTestId('alert-inbox-table').waitFor()
        try {
          await expect.poll(notices, { timeout: 20_000 }).toEqual(noticeOf(list))
        } catch {
          // another run's alerts may have ended meanwhile: the store's answer now
          expect.soft(await notices(), 'Alerts page notices').toEqual(noticeOf(await listOf()))
        }
      })

      // the floating chat's sessions and answer stood in, so asking it shows what the screen sends (page_context)
      const sent: { base?: Obj; overlays?: Obj[] }[] = []
      const fulfil = async (route: Route, answer: Parameters<Route['fulfill']>[0]) => {
        try {
          await route.fulfill(answer)
        } catch { /* the page went on */ }
      }
      const chatRoutes: [RegExp, (route: Route) => Promise<void>][] = [
        [/\/api\/v1\/sessions(\?|$)/, (route) => (route.request().method() === 'POST'
          ? fulfil(route, { json: { id: 'e2e-cut-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
          : route.fallback())],
        [/\/api\/v1\/sessions\/e2e-cut-ctx-\d+(\?|$)/, (route) => fulfil(route, { json: { id: 'e2e-cut-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } })],
        [/\/api\/v1\/ai\/sessions\/e2e-cut-ctx-\d+\/floating-chat/, (route) => {
          sent.push(route.request().postDataJSON().page_context)
          return fulfil(route, { contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
        }],
      ]
      for (const [url, handler] of chatRoutes) await page.route(url, handler)
      routed = async () => {
        for (const [url, handler] of chatRoutes) await page.unroute(url, handler)
      }
      // the layers the floating chat sends for one question
      const askLayers = async (): Promise<Obj[]> => {
        if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
        const input = page.getByTestId('floating-chat-input')
        await expect(input).toBeVisible()
        const before = sent.length
        await input.fill('what is on this screen?')
        await input.press('Enter')
        await expect.poll(() => sent.length).toBe(before + 1)
        await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
        const ctx = sent[sent.length - 1]
        return [ctx.base, ...(ctx.overlays ?? [])].filter(Boolean)
      }

      await test.step("the floating chat: the store's list was cut, with its numbers", async () => {
        const ask = async () => (await askLayers()).find((l) => l?.data && 'counts' in l.data && 'items' in l.data)?.data?.alert_store_cut ?? null
        const list = await listOf()
        const want = list.truncated ? { listed: list.alerts.length, total: list.total } : null
        try {
          await expect.poll(ask, { timeout: 30_000 }).toEqual(want)
        } catch {
          const now = await listOf()
          expect.soft(await ask(), 'floating chat alert_store_cut').toEqual(now.truncated ? { listed: now.alerts.length, total: now.total } : null)
        }
      })

      await test.step("the alert window of an alert the store's list left out: Alertmanager now is unknown, with the store's numbers, also to the floating chat", async () => {
        const list = await listOf()
        const listed = new Set((list.alerts as Obj[]).map((a) => a.fingerprint))
        const left = amAlerts(ours).find((a) => !listed.has(a.fingerprint))
        expect(left, "an alert of this case the store's list left out").toBeTruthy()
        leftOut = left!
        expect((await (await post('firing', { labels: left!.labels, fingerprint: left!.fingerprint })).json()).stored).toBe(1)
        const inbox = await (await request.get('/api/v1/alerts/inbox', { headers: bearer(token), params: { cluster: CLUSTER, q: run, limit: 200 } })).json()
        const item = (inbox.items as Obj[]).find((i) => i.fingerprint === left!.fingerprint)
        expect(item, 'its inbox row').toBeTruthy()

        await openWithStore(`/alerts?cluster=${CLUSTER}&alert=${item.id}`)
        const meta = page.getByTestId('alert-detail').getByTestId('alert-detail-meta')
        await expect(meta).toBeVisible({ timeout: 15_000 })
        // the window's "Alertmanager now: …" entry, or null without one
        const shownLine = () => meta.evaluate((m, label) => [...m.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find((t) => t.startsWith(`${label}:`)) ?? null, EN.alertInbox.liveLabel)
        const lineOf = (l: Obj) => (l.truncated
          ? `${EN.alertInbox.liveLabel}: ${EN.alertInbox.liveUnknown.cut.replace('{{listed}}', String(l.alerts.length)).replace('{{total}}', String(l.total))}`
          : null)
        try {
          await expect.poll(shownLine, { timeout: 20_000 }).toBe(lineOf(list))
        } catch {
          expect.soft(await shownLine(), 'the window line').toBe(lineOf(await listOf()))
        }
        const windowLayer = async () => (await askLayers()).find((l) => l?.source === 'AlertDetailModal')?.data ?? null
        const want = (l: Obj) => ({ live: undefined, live_unknown: 'cut', alert_store_cut: { listed: l.alerts.length, total: l.total } })
        const pick = (d: Obj) => (d ? { live: d.live, live_unknown: d.live_unknown, alert_store_cut: d.alert_store_cut } : null)
        try {
          await expect.poll(async () => pick(await windowLayer()), { timeout: 30_000 }).toEqual(want(list))
        } catch {
          expect.soft(pick(await windowLayer()), "the window's AI layer").toEqual(want(await listOf()))
        }
      })
    } finally {
      await routed()
      // the inbox rows resolved, so the dev inbox does not keep them firing
      const endsAt = new Date().toISOString()
      if (fingerprint) await post('resolved', { labels: firstLabels, fingerprint }, { endsAt })
      if (leftOut) await post('resolved', { labels: leftOut.labels, fingerprint: leftOut.fingerprint }, { endsAt })
      await resolveCase()
    }
  })
})
