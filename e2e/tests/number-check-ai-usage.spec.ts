import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test'

// Number check of two of Kubeast's own screens against the API and the database:
// - AI Usage: for each grouping (user, model, cluster) the rows on every page are the answer's, the answer's group
//   counts and totals are the audit rows' (ai.chat.complete and, in rows of their own, ai.investigation.run) in the
//   period the screen sent, the totals line and the pager say the same, and the table keeps the rows it shows —
//   under their own heading — while another grouping loads.
// - Investigations: "of total" is the API's and the database's, the status applies when picked, the cluster ID when
//   Search or Enter is pressed (and says so before), and 60 reports of one received time (inv-e2e-n4b-*, written to the
//   database for the run) page in id order with none twice and no empty table between pages.

const USAGE = { path: '/admin/ai-usage' }
const INVESTIGATIONS = { path: '/admin/investigations' }
const USAGE_API = '/api/v1/auth/admin/ai-usage'
const INVESTIGATIONS_API = '/api/v1/ai/investigations'

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const USAGE_SRC = fs.readFileSync(path.join(__dirname, '../../services/auth-service-go/internal/repository/ai_usage.go'), 'utf8')
// how many groups of each source one answer lists, read from the server's source
const LIMIT = Number((USAGE_SRC.match(/AIUsageLimit = (\d+)/) ?? [])[1] ?? 500)
const PREFIX = 'inv-e2e-n4b-'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Group = 'user' | 'model' | 'cluster'
type Source = 'chat' | 'investigation'
type Sums = { groups: number; requests: number; failures: number; total_tokens: number; tool_calls: number }
const SOURCES: Source[] = ['chat', 'investigation']
// the keys the server groups each source by (repository/ai_usage.go aiUsageKeyExpr) and the action it adds up
const KEY: Record<Group, Record<Source, string>> = {
  user: { chat: "COALESCE(actor_email, actor_user_id, '')", investigation: "COALESCE(actor_email, actor_user_id, '')" },
  model: { chat: "COALESCE(after->>'model', '')", investigation: "COALESCE(after->>'model', '')" },
  cluster: { chat: "COALESCE(after->>'cluster', '')", investigation: "COALESCE(cluster, '')" },
}
const ACTION: Record<Source, string> = { chat: 'ai.chat.complete', investigation: 'ai.investigation.run' }

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-ai-usage-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const psql = (sql: string) =>
  execFileSync('kubectl', ['--kubeconfig', kcPath, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql], { encoding: 'utf8' }).trim()

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const atPath = (r: Response, p: string) => new URL(r.url()).pathname === p && r.request().method() === 'GET'
const fill = (s: string, values: Record<string, string | number>) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(values[k]))

// counts and sums only: the audit rows of each source in [since, until)
function dbUsage(group: Group, since: string, until: string): Record<Source, Sums> {
  const out = {} as Record<Source, Sums>
  for (const s of SOURCES) {
    const [groups, requests, failures, tokens, tools] = psql(
      `SELECT count(DISTINCT ${KEY[group][s]}), count(*), count(*) FILTER (WHERE result = 'failure'), COALESCE(sum((after->>'total_tokens')::bigint), 0), COALESCE(sum((after->>'tool_calls')::bigint), 0)` +
      ` FROM auth_audit_logs WHERE action = '${ACTION[s]}' AND created_at >= '${since}' AND created_at < '${until}'`,
    ).split('|').map(Number)
    out[s] = { groups, requests, failures, total_tokens: tokens, tool_calls: tools }
  }
  return out
}

// what the page draws for a number (Math.round(n).toLocaleString() in the browser)
const formatted = (page: Page, ns: number[]) => page.evaluate((list) => list.map((n) => Math.round(n).toLocaleString()), ns)

// The range a list footer shows ("Showing a-b of n", ListPager), as [a, b, n]; [0, 0, 0] for "Showing 0 of 0".
async function shownRange(page: Page, pager: string): Promise<[number, number, number]> {
  const text = await page.getByTestId(pager).innerText()
  if (text.includes(EN.common.paginationEmpty)) return [0, 0, 0]
  const m = /Showing (\d+)-(\d+) of (\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1]
}

// every row of the usage table on the current page (not the filler rows under them): key, investigation badge,
// requests, prompt, cached, completion, total, "*", tool calls, failures
const usageRowsOnScreen = (page: Page, badge: string) =>
  page.getByTestId('ai-usage-table').locator('tbody:not([aria-hidden="true"]) tr').evaluateAll((trs, b) => trs.filter((tr) => (tr as HTMLTableRowElement).cells.length >= 10).map((tr) => {
    const c = (tr as HTMLTableRowElement).cells
    const first = (i: number) => (c[i].firstChild?.textContent ?? '').trim()
    return [c[0].querySelector('span')?.textContent?.trim() ?? '', c[0].innerText.includes(b), first(1), first(2), first(3), first(4), first(5), c[5].innerText.includes('*'), first(6), first(8)]
  }), badge)

test.describe('number check: AI usage and investigations', () => {
  test('AI Usage: every row is the answer\'s, totals and group counts are the audit rows\', alert investigations in rows of their own', async ({ page }) => {
    test.setTimeout(240_000)
    expect(LIMIT, 'AIUsageLimit read from the auth-service source').toBeGreaterThan(0)
    const badge = EN.adminAIUsage.source.investigationRow
    const usageAnswer = (group: Group) => page.waitForResponse((r) => atPath(r, USAGE_API) && new URL(r.url()).searchParams.get('group') === group)
    const refresh = page.locator('main').getByRole('button', { name: EN.common.refresh, exact: true })
    const groupDropdown = page.getByTestId('ai-usage-group')
    const pick = (label: string) => groupDropdown.locator('xpath=..').getByRole('button', { name: label, exact: true })

    let pending = usageAnswer('user')
    await page.goto(USAGE.path)
    const firstRes = await pending
    const params = new URL(firstRes.url()).searchParams
    const since = params.get('since')!
    const until = params.get('until')!
    expect([since, until].every((v) => /^\d{4}-\d{2}-\d{2}T/.test(v)), `the period the screen sent: ${since} – ${until}`).toBe(true)

    // the answer and the database read before and after it; read again when an audit row of the period came in between
    const settled = async (group: Group, act: () => Promise<unknown>) => {
      let before = dbUsage(group, since, until)
      pending = usageAnswer(group)
      await act()
      let res = await pending
      let db = dbUsage(group, since, until)
      for (let i = 0; i < 2 && JSON.stringify(db) !== JSON.stringify(before); i++) {
        before = db
        pending = usageAnswer(group)
        await refresh.click()
        res = await pending
        db = dbUsage(group, since, until)
      }
      return { answer: (await res.json()) as Obj, db }
    }

    const checkGroup = async (group: Group, answer: Obj, db: Record<Source, Sums>) => {
      const listed = (s: Source) => Math.min(db[s].groups, LIMIT)
      for (const s of SOURCES) {
        const t = answer.totals?.[s]
        expect.soft(t ? { groups: t.groups, requests: t.requests, failures: t.failures, total_tokens: t.total_tokens, tool_calls: t.tool_calls } : t,
          `${group}: the answer's ${s} totals = the audit rows'`).toEqual(db[s])
        expect.soft((answer.rows as Obj[]).filter((r) => (r.source ?? 'chat') === s).length, `${group}: ${s} rows listed`).toBe(listed(s))
      }
      expect.soft(answer.truncated, `${group}: cut`).toBe(SOURCES.some((s) => db[s].groups > LIMIT))

      // every page of the table against the answer
      const want = await Promise.all((answer.rows as Obj[]).map(async (r) => {
        const [requests, prompt, cached, completion, total, tools, failures] = await formatted(page, [r.requests, r.prompt_tokens, r.cached_tokens ?? 0, r.completion_tokens, r.total_tokens, r.tool_calls, r.failures])
        return [r.key || '-', r.source === 'investigation', requests, prompt, typeof r.cached_tokens === 'number' ? cached : '-', completion, total, r.token_requests < r.requests, tools, failures]
      }))
      // the page fits the screen (Fit): each page is the rows its footer says it shows, the pages follow on
      const rows: Obj[] = []
      const next = page.getByTestId('ai-usage-pager').getByRole('button', { name: EN.common.next, exact: true })
      const onScreen = async () => {
        const [a, b, n] = await shownRange(page, 'ai-usage-pager')
        const got = await usageRowsOnScreen(page, badge)
        return { a, n, rows: got, matches: got.length === b - a + 1 && JSON.stringify(got) === JSON.stringify(want.slice(a - 1, b)) }
      }
      for (let p = 0; p <= want.length && want.length > 0; p++) {
        const from = rows.length
        let shown = await onScreen()
        try {
          await expect.poll(async () => {
            shown = await onScreen()
            return { a: shown.a, n: shown.n, matches: shown.matches }
          }, { timeout: 15_000 }).toEqual({ a: from + 1, n: want.length, matches: true })
        } catch {
          expect.soft(shown.rows, `${group}: page ${p + 1} (footer from ${shown.a} of ${shown.n}) = the answer's rows from ${from + 1}`).toEqual(want.slice(from, from + Math.max(shown.rows.length, 1)))
        }
        if (shown.rows.length === 0) break
        rows.push(...shown.rows)
        if (await next.isDisabled()) break
        await next.click()
      }
      if (want.length === 0) expect.soft(await shownRange(page, 'ai-usage-pager'), `${group}: no rows`).toEqual([0, 0, 0])
      expect.soft(rows, `${group}: the rows on every page = the answer's`).toEqual(want)
      expect.soft(rows.filter((r) => r[1]).length, `${group}: alert investigation rows = their groups in the audit rows`).toBe(listed('investigation'))
      const shownTotal = listed('chat') + listed('investigation')
      const [, , counted] = await shownRange(page, 'ai-usage-pager')
      expect.soft(counted, `${group}: the pager counts ${shownTotal} rows`).toBe(shownTotal)
      // the table and its footer fit the screen: the page does not scroll
      expect.soft(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), `${group}: the page scrolls by`).toBeLessThanOrEqual(1)
      expect.soft(await page.getByTestId('ai-usage-table').locator('thead th').first().innerText(), `${group}: the table heading`).toBe(EN.adminAIUsage.group[group])

      // the totals line: every group of the period, chat and alert investigations apart
      const all = SOURCES.reduce((a, s) => ({ requests: a.requests + db[s].requests, failures: a.failures + db[s].failures, tokens: a.tokens + db[s].total_tokens, tools: a.tools + db[s].tool_calls }), { requests: 0, failures: 0, tokens: 0, tools: 0 })
      const [aReq, aTok, aTools, aFail, cTok, cReq, iTok, iReq] = await formatted(page, [all.requests, all.tokens, all.tools, all.failures, db.chat.total_tokens, db.chat.requests, db.investigation.total_tokens, db.investigation.requests])
      const u = EN.adminAIUsage
      const line1 = `${u.totals}: ${aReq} ${u.requests} · ${aTok} ${u.tokens} · ${aTools} ${u.toolCalls}${all.failures > 0 ? ` · ${aFail} ${u.failures}` : ''}`
      const line2 = `${u.source.chat}: ${cTok} ${u.tokens} (${cReq} ${u.requests}) · ${u.source.investigation}: ${iTok} ${u.tokens} (${iReq} ${u.runs})`
      const totalsText = (await page.locator('main .ml-auto.text-xs').first().innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
      expect.soft(totalsText, `${group}: the totals line`).toEqual([line1, line2])

      // a cut source says so under the table, with the answer's numbers
      const note = await page.locator('main p.text-xs').last().innerText()
      for (const s of SOURCES) {
        const cut = fill(u.cut, { source: u.source[s], group: u.group[group], shown: (await formatted(page, [listed(s)]))[0], groups: (await formatted(page, [db[s].groups]))[0] })
        expect.soft(note.includes(cut), `${group}: ${s} cut note`).toBe(db[s].groups > LIMIT)
      }
    }

    let userAnswer: Obj = null
    await test.step('grouped by user', async () => {
      await expect(page.getByTestId('ai-usage-table').locator('tbody tr').first()).toBeVisible({ timeout: 15_000 })
      const { answer, db } = await settled('user', () => refresh.click())
      expect(db.chat.requests + db.investigation.requests, 'the period has audit rows to compare').toBeGreaterThan(0)
      userAnswer = answer
      await checkGroup('user', answer, db)
    })

    await test.step('to model: the rows on screen stay, under their own heading, until the model answer comes', async () => {
      await page.evaluate((args) => {
        const w = window as Obj
        w.__usageFlash = []
        const body = document.querySelector('[data-testid="ai-usage-table"] tbody')!
        const check = () => {
          const rows = body.querySelectorAll('tr')
          const text = (body as HTMLElement).innerText
          if (rows.length === 0 || text.includes(args.loading) || text.includes(args.none)) w.__usageFlash.push(rows.length === 0 ? '(no rows)' : text.slice(0, 40))
        }
        new MutationObserver(check).observe(body, { subtree: true, childList: true, characterData: true })
      }, { loading: EN.common.loading, none: EN.common.noSearchResults })
      const isModel = (url: URL) => url.pathname === USAGE_API && url.searchParams.get('group') === 'model'
      const slow = async (route: Obj) => {
        await new Promise((r) => setTimeout(r, 2_000))
        try { await route.continue() } catch { /* the page went on */ }
      }
      await page.route(isModel, slow)
      try {
        const { answer, db } = await settled('model', async () => {
          await groupDropdown.click()
          await pick(EN.adminAIUsage.group.model).click()
          await page.waitForTimeout(700)
          // the page went back to 1; the user answer's first page is what is drawn
          expect.soft(await page.getByTestId('ai-usage-table').locator('thead th').first().innerText(), 'while the model answer loads: the heading of the rows shown').toBe(EN.adminAIUsage.group.user)
          expect.soft((await usageRowsOnScreen(page, badge))[0]?.[0], 'while the model answer loads: the user rows stay').toBe(userAnswer?.rows?.[0]?.key || '-')
        })
        await expect.poll(() => page.getByTestId('ai-usage-table').locator('thead th').first().innerText(), { timeout: 15_000 }).toBe(EN.adminAIUsage.group.model)
        expect.soft(await page.evaluate(() => (window as Obj).__usageFlash), 'the table never emptied while the grouping changed').toEqual([])
        await checkGroup('model', answer, db)
      } finally {
        await page.unroute(isModel, slow)
      }
    })

    await test.step('grouped by cluster', async () => {
      const { answer, db } = await settled('cluster', async () => {
        await groupDropdown.click()
        await pick(EN.adminAIUsage.group.cluster).click()
      })
      await checkGroup('cluster', answer, db)
      expect.soft(await page.evaluate(() => (window as Obj).__usageFlash), 'the table never emptied while the grouping changed').toEqual([])
    })
  })

  test('Investigations: "of total" = API = database, filters say when they apply, same-time reports page in id order', async ({ page, request }) => {
    test.setTimeout(180_000)
    const admin = await login(request)
    const run = Date.now().toString(36)
    const cluster = `e2e-n4b-${run}`
    const ids = Array.from({ length: 60 }, (_, i) => `${PREFIX}${run}-${String(i).padStart(2, '0')}`)
    const expectedOrder = [...ids].reverse() // one received time: the newest id first
    const cleanup = () => psql(`DELETE FROM alert_investigations WHERE id LIKE '${PREFIX}%'`)
    const dbCount = (where = '') => Number(psql(`SELECT count(*) FROM alert_investigations${where ? ` WHERE ${where}` : ''}`))
    const pager = page.getByTestId('investigations-pager')
    // the footer's range (ListPager), and the rows per page the screen fits: the limit of its last read
    const range = async () => {
      const text = await pager.innerText()
      return /Showing \d+-\d+ of \d+/.exec(text)?.[0] ?? (text.includes(EN.common.paginationEmpty) ? EN.common.paginationEmpty : text)
    }
    const rangeOf = (start: number, end: number, total: number) => (total === 0 ? EN.common.paginationEmpty : fill(EN.common.paginationRange, { start, end, total }))
    const per = () => Number(lastList?.url?.searchParams?.get('limit') ?? 0)
    const rowIds = () => page.locator('[data-testid^="investigation-row-"]').evaluateAll((trs) => trs.map((t) => t.getAttribute('data-testid')!.slice('investigation-row-'.length)))
    const card = page.locator('main .card').first()
    // until the screen shows what the database says now (alerts can be investigated meanwhile), then the last of both
    const settle = async (what: () => Promise<string>, want: () => string, ms = 15_000) => {
      const end = Date.now() + ms
      let got = await what()
      let exp = want()
      while (got !== exp && Date.now() < end) {
        await page.waitForTimeout(300)
        got = await what()
        exp = want()
      }
      return [got, exp]
    }
    // the answer to the list request sent last: answers can come back in another order (the first render asks with the
    // estimated page size and the measured one at the same moment, and the estimate's answer may come second)
    let lastList: Obj = null
    let sentLists = 0
    const sentOrder = new Map<unknown, number>()
    page.on('request', (q) => {
      if (new URL(q.url()).pathname === INVESTIGATIONS_API && q.method() === 'GET') sentOrder.set(q, ++sentLists)
    })
    page.on('response', async (r) => {
      if (atPath(r, INVESTIGATIONS_API)) {
        const order = sentOrder.get(r.request()) ?? 0
        try {
          const body = await r.json()
          if (!lastList || order >= lastList.order) lastList = { url: new URL(r.url()), body, order }
        } catch { /* the page went on */ }
      }
    })

    cleanup()
    try {
      // two hours old and without tokens: outside the investigator's hourly cap and daily token count while they exist
      psql(`INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, status, received_at, last_seen_at, iterations)
            SELECT format('${PREFIX}${run}-%s', lpad(i::text, 2, '0')), '${cluster}', format('fp-%s', i), 'E2eN4bSameTime', 'info', 'done',
                   date_trunc('second', now() at time zone 'utc') - interval '2 hours', now() at time zone 'utc', 1
              FROM generate_series(0, 59) AS i`)
      expect(dbCount(`cluster = '${cluster}'`), 'the 60 reports of the run').toBe(60)

      await page.goto(INVESTIGATIONS.path)
      await expect(page.locator('[data-testid^="investigation-row-"]').first()).toBeVisible({ timeout: 15_000 })

      await test.step('"of total": the screen, the API and the database', async () => {
        const [got, exp] = await settle(range, () => { const n = dbCount(); return rangeOf(1, Math.min(per(), n), n) })
        expect.soft(got, 'all reports: range on screen').toBe(exp)
        // the rows that fit the screen: the page does not scroll, the footer is in view
        expect.soft(per(), 'rows per page asked').toBeGreaterThanOrEqual(5)
        expect.soft(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'the page scrolls by').toBeLessThanOrEqual(1)
        const [apiTotal, dbTotal] = await settle(async () => String(lastList?.body?.total), () => String(dbCount()), 5_000)
        expect.soft(apiTotal, 'all reports: the API total').toBe(dbTotal)
      })

      await page.evaluate((args) => {
        const w = window as Obj
        w.__invFlash = []
        const body = document.querySelector('[data-testid="investigations-table"] tbody')!
        const check = () => {
          const rows = body.querySelectorAll('tr')
          const text = (body as HTMLElement).innerText
          if (rows.length === 0 || text.includes(args.loading) || text.includes(args.none)) w.__invFlash.push(rows.length === 0 ? '(no rows)' : text.slice(0, 40))
        }
        new MutationObserver(check).observe(body, { subtree: true, childList: true, characterData: true })
      }, { loading: EN.investigations.loading, none: EN.common.listEmpty })

      await test.step('a status applies when picked', async () => {
        const status = page.locator('main label', { hasText: new RegExp(`^${EN.investigations.filter.status}$`) }).locator('xpath=..')
        await status.locator('button').first().click()
        await status.getByRole('button', { name: EN.investigations.status.done, exact: true }).click()
        const [got, exp] = await settle(range, () => { const n = dbCount("status = 'done'"); return rangeOf(1, Math.min(per(), n), n) })
        expect.soft(got, 'Done picked, no Search: range on screen = the done reports').toBe(exp)
        const doneAnswer = async () => (lastList?.url?.searchParams?.get('status') === 'done' ? String(lastList.body.total) : 'no answer for status=done')
        const [apiTotal, dbTotal] = await settle(doneAnswer, () => String(dbCount("status = 'done'")), 5_000)
        expect.soft(apiTotal, 'the API total of the done reports').toBe(dbTotal)
        await status.locator('button').first().click()
        await status.getByRole('button', { name: EN.investigations.status.all, exact: true }).click()
        const [back, backExp] = await settle(range, () => { const n = dbCount(); return rangeOf(1, Math.min(per(), n), n) })
        expect.soft(back, 'All picked again: every report').toBe(backExp)
      })

      await test.step('a cluster ID typed but not applied says so; Enter applies it', async () => {
        const input = page.getByTestId('investigations-cluster-filter')
        await input.fill(cluster)
        await page.waitForTimeout(500)
        expect.soft((await card.innerText()).includes(EN.investigations.filter.pending), 'typed, not applied: the note').toBe(true)
        const n = dbCount()
        expect.soft(await range(), 'typed, not applied: still every report').toBe(rangeOf(1, Math.min(per(), n), n))
        await input.press('Enter')
        const [got, exp] = await settle(range, () => rangeOf(1, Math.min(per(), 60), 60), 10_000)
        expect.soft(got, 'Enter: the run\'s 60 reports').toBe(exp)
        // Search applies it as before (also where Enter did not)
        await page.getByTestId('investigations-search').click()
        await expect.poll(range, { timeout: 15_000 }).toBe(rangeOf(1, Math.min(per(), 60), 60))
        expect.soft((await card.innerText()).includes(EN.investigations.filter.pending), 'applied: no note').toBe(false)
      })

      await test.step('same-time reports page in id order, each once, the table kept between pages', async () => {
        const size = per()
        expect(size, 'rows per page the screen asks').toBeGreaterThanOrEqual(5)
        await expect.poll(rowIds, { timeout: 15_000 }).toHaveLength(Math.min(size, 60))
        const shown = await rowIds()
        await page.evaluate(() => { (window as Obj).__invFlash = [] })
        const next = pager.getByRole('button', { name: EN.common.next, exact: true })
        for (let p = 2; shown.length < 60 && p <= 60; p++) {
          const before = shown.length
          await next.click()
          await expect.poll(range, { timeout: 15_000, message: `page ${p}` }).toBe(rangeOf(before + 1, Math.min(before + size, 60), 60))
          shown.push(...(await rowIds()))
        }
        // the API's pages of the same size
        const apiPages: Obj[] = []
        for (let offset = 0; offset < 60; offset += size) {
          apiPages.push(await (await request.get(INVESTIGATIONS_API, { headers: bearer(admin), params: { cluster, limit: size, offset } })).json())
        }
        const apiIds = apiPages.flatMap((a) => a.items.map((r: Obj) => r.id))
        expect.soft(shown.filter((id, i) => shown.indexOf(id) !== i), 'reports on two pages').toEqual([])
        expect.soft(shown, 'the pages: one received time, newest id first').toEqual(expectedOrder)
        expect.soft(apiIds, 'the API pages: the same order').toEqual(expectedOrder)
        expect.soft(apiPages.map((a) => a.total), 'the API total').toEqual(apiPages.map(() => 60))
        expect.soft(await range(), 'the last page: range').toBe(rangeOf(Math.floor(59 / size) * size + 1, 60, 60))
        expect.soft(await next.isDisabled(), 'no page after the last').toBe(true)
        expect.soft(await page.evaluate(() => (window as Obj).__invFlash), 'no loading or empty row while the next page loads').toEqual([])
      })
    } finally {
      cleanup()
    }
  })
})
