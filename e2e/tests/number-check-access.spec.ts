import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test'
import { rowsOfFirstPage } from './list-pages'

// Number check of Access Requests and Access Review against the API and the database:
// - Access Requests: a user of this run asks for Write on `default` and an admin rejects it, 205 times, then one
//   request stays pending. History pages through every decided request (the database count) and its search finds
//   the first one; the sidebar badge and the Pending tab count every pending request; switching tabs, turning
//   pages and searching never empty the table.
// - Access Review: three accounts of this run — one that never signed in and uses only an API key, one that signed
//   in 200 days ago and used a key now, one with admin.audit.read silent for 200 days (the sign-in and creation
//   backdated in the dev database, as dormant-accounts.spec does; the key use is a real exchange). The cards are
//   counted again from the report's own rows — "With admin permissions" and its global admins (a role with "*"),
//   Dormant as the dormant lock reads activity (sign-in, key use, creation), Never signed in — and Past reviews
//   pages through every sign-off (the database count) without a loading line between tabs or pages.

const ACCESS_REQUESTS = { path: '/admin/access-requests' }
const ACCESS_REVIEW = { path: '/admin/access-review' }

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const PREFIX = 'e2e-n4c-'
const PW = 'E2e-n4c-access-Kq4w'
const CLUSTER = 'default'
const REQUESTS = 205
const DAY = 86_400_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const soft = expect.configure({ soft: true })
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-access-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const psql = (sql: string) =>
  execFileSync('kubectl', ['--kubeconfig', kcPath, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql], { encoding: 'utf8' }).trim()
const dbCount = (sql: string) => Number(psql(sql))

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function roleIdOf(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const roles: Obj[] = Array.isArray(raw) ? raw : raw.roles || raw.items || []
  const role = roles.find((r) => String(r.name).toLowerCase() === name.toLowerCase())
  expect(role, `role ${name} exists`).toBeTruthy()
  return role.id
}

async function createUser(request: APIRequestContext, admin: string, email: string, roleId: number): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E n4c ${email.split('@')[0]}`, email, password: PW, role_id: roleId } })
  expect(res.status(), `create ${email}: ${await res.text()}`).toBe(201)
  return (await res.json()).id
}

// users and roles of this spec, from this run or one that stopped (their requests and keys go with them)
async function cleanup(request: APIRequestContext, admin: string) {
  const users = (await (await request.get('/api/v1/auth/admin/users?limit=200', { headers: bearer(admin) })).json()) as { id: string; email?: string }[]
  for (const u of users.filter((u) => (u.email ?? '').startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: bearer(admin), failOnStatusCode: false })
  const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as { id: number; name: string }[]
  for (const r of roles.filter((r) => r.name.startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/roles/${r.id}`, { headers: bearer(admin), failOnStatusCode: false })
}

const range = (start: number, end: number, total: number) =>
  EN.common.paginationRange.replace('{{start}}', String(start)).replace('{{end}}', String(end)).replace('{{total}}', String(total))
const pathIs = (r: Response, p: string) => new URL(r.url()).pathname === p

const flashes = (page: Page, name: string) => page.evaluate((n) => (window as Obj)[n] as string[], name)

test.describe('number check: access requests and access review', () => {
  test('Access Requests: History pages through every decision and finds the first, the badges count every pending request', async ({ page, request }) => {
    test.setTimeout(420_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await (await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })).json()
    test.skip(!cfg.enabled, 'ACCESS_REQUESTS_ENABLED is off on this installation')
    const run = Date.now().toString(36)
    const email = `${PREFIX}ar-${run}@kubeast.local`
    const reasonOf = (i: number) => `e2e n4c ${run} #${String(i).padStart(3, '0')}.`
    await cleanup(request, admin)
    try {
      const userId = await createUser(request, admin, email, await roleIdOf(request, admin, 'Member'))
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      expect(grant.ok(), `grant Read on ${CLUSTER}: ${await grant.text()}`).toBeTruthy()
      const user = await login(request, email, PW)

      // one pending request at a time per user and cluster: ask, reject, again
      const ids: string[] = []
      for (let i = 1; i <= REQUESTS; i++) {
        const made = await request.post('/api/v1/auth/access-requests', { headers: bearer(user), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason: reasonOf(i) } })
        expect(made.status(), `request ${i}: ${made.status() === 201 ? '' : await made.text()}`).toBe(201)
        const id = (await made.json()).id as string
        const rejected = await request.post(`/api/v1/auth/admin/access-requests/${id}/reject`, { headers: bearer(admin), data: { note: `n4c ${i}` } })
        expect(rejected.status(), `reject ${i}`).toBe(200)
        ids.push(id)
      }
      const open = await request.post('/api/v1/auth/access-requests', { headers: bearer(user), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason: `e2e n4c ${run} pending` } })
      expect(open.status()).toBe(201)
      const pendingId = (await open.json()).id as string

      const dbDecided = dbCount(`SELECT count(*) FROM access_requests WHERE status <> 'pending'`)
      const dbPending = dbCount(`SELECT count(*) FROM access_requests WHERE status = 'pending'`)
      expect(dbCount(`SELECT count(*) FROM access_requests WHERE user_id = '${userId}' AND status = 'rejected'`), 'the rejections are in the database').toBe(REQUESTS)
      // the API's count of every match, next to its page
      const apiDecided = await request.get('/api/v1/auth/admin/access-requests?status=decided&limit=25', { headers: bearer(admin) })
      soft(apiDecided.headers()['x-kubeast-total'], 'API: X-Kubeast-Total of the decided requests').toBe(String(dbDecided))
      const apiPending = await request.get('/api/v1/auth/admin/access-requests?status=pending&limit=0', { headers: bearer(admin) })
      soft(apiPending.headers()['x-kubeast-total'], 'API: X-Kubeast-Total of the pending requests').toBe(String(dbPending))

      // the History answer (this build reads both tabs when the page opens)
      const historyAnswer = page.waitForResponse((r) => pathIs(r, '/api/v1/auth/admin/access-requests') && new URL(r.url()).searchParams.get('status') === 'decided', { timeout: 20_000 }).catch(() => null)
      await page.goto(ACCESS_REQUESTS.path)
      await expect(page.getByTestId(`access-request-row-${pendingId}`)).toBeVisible({ timeout: 15_000 })

      await test.step('the sidebar badge and the Pending tab count every pending request', async () => {
        const sidebar = page.getByTestId('nav-access-requests-badge')
        const tabBadge = page.getByTestId('access-requests-tab-pending').locator('span')
        await soft.poll(async () => [await sidebar.innerText(), await tabBadge.innerText()], { timeout: 15_000, message: 'badges = database count of pending requests' })
          .toEqual([String(dbPending), String(dbPending)])
      })

      const pager = page.getByTestId('access-requests-pager')
      const history = page.getByTestId('access-requests-table-history')
      const shownIds = () => history.locator('tr[data-testid^="access-request-row-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')!.replace('access-request-row-', '')))
      await Promise.race([historyAnswer, page.waitForTimeout(5_000)])
      await page.waitForTimeout(500) // the answer into the page's cache
      // a moment the table (and its pager, one box) shows no rows, a spinner or an empty-list line from here on
      await page.evaluate(({ empty }) => {
        const w = window as Obj
        w.__arFlash = []
        const box = document.querySelector('[data-testid="access-requests-pager"]')!.parentElement!
        new MutationObserver(() => {
          const body = box.querySelector('tbody')
          const rows = body ? body.querySelectorAll('tr[data-testid^="access-request-row-"]').length : 0
          const text = body ? (body as HTMLElement).innerText : ''
          const line = empty.find((e: string) => text.includes(e))
          if (rows === 0 || body!.querySelector('.animate-spin') || line) w.__arFlash.push(line ?? (rows === 0 ? '(no rows)' : '(spinner)'))
        }).observe(box, { subtree: true, childList: true, characterData: true, attributes: true })
      }, { empty: [EN.common.listEmpty, EN.common.noSearchResults] })

      await test.step('History pages through every decided request, each once', async () => {
        await page.getByTestId('access-requests-tab-history').click()
        await soft.poll(() => pager.innerText(), { timeout: 15_000, message: 'History: pager total = database count of decided requests' }).toContain(`of ${dbDecided}`)
        // a page is the rows the table fits on the screen, asked of the server
        const perPage = await rowsOfFirstPage(pager)
        soft(perPage, 'History: rows of a page').toBeGreaterThan(0)
        soft(await pager.innerText(), 'History: the first page').toContain(range(1, Math.min(perPage, dbDecided), dbDecided))
        const seen: string[] = []
        const next = pager.getByRole('button', { name: EN.common.next, exact: true })
        for (let i = 0; i < 40; i++) {
          seen.push(...(await shownIds()))
          if (await next.isDisabled()) break
          const before = await pager.innerText()
          await next.click()
          await expect.poll(() => pager.innerText(), { timeout: 15_000, message: `History page ${i + 2}` }).not.toBe(before)
        }
        soft(seen.length, 'History: rows over every page = database count of decided requests').toBe(dbDecided)
        soft(seen.filter((id, i) => seen.indexOf(id) !== i), 'History: rows on two pages').toEqual([])
        soft(ids.filter((id) => !seen.includes(id)).length, `History: this run's ${REQUESTS} rejections not on any page`).toBe(0)
        soft(seen.slice(0, perPage), 'History: the first page = the newest decisions').toEqual(ids.slice(-perPage).reverse())
      })

      await test.step('the History search finds the first decision', async () => {
        await page.getByTestId('access-requests-search').fill(`${run} #001.`)
        await soft.poll(shownIds, { timeout: 15_000, message: 'History search: the first request' }).toEqual([ids[0]])
        await soft.poll(() => pager.innerText(), { timeout: 15_000 }).toContain(range(1, 1, 1))
      })

      soft(await flashes(page, '__arFlash'), 'the table never emptied while switching tabs, turning pages or searching').toEqual([])
    } finally {
      await cleanup(request, admin)
    }
  })

  test('Access Review: the cards count the report\'s rows, Dormant as the lock reads it, Past reviews page through every sign-off', async ({ page, request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await (await request.get('/api/v1/auth/access-review/config', { headers: bearer(admin) })).json()
    test.skip(!cfg.enabled, 'ACCESS_REVIEW_ENABLED is off on this installation')
    const lockCfg = await (await request.get('/api/v1/auth/dormant-accounts/config', { headers: bearer(admin) })).json()
    const run = Date.now().toString(36)
    const keyOnly = `${PREFIX}keyonly-${run}@kubeast.local`
    const oldLoginKey = `${PREFIX}oldlogin-${run}@kubeast.local`
    const staleAuditor = `${PREFIX}auditor-${run}@kubeast.local`
    await cleanup(request, admin)
    try {
      const member = await roleIdOf(request, admin, 'Member')
      const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: `${PREFIX}audit-${run}`, description: 'e2e access review', permissions: ['admin.audit.read'] } })
      expect(role.status(), await role.text()).toBeLessThan(300)
      for (const e of [keyOnly, oldLoginKey]) {
        await createUser(request, admin, e, member)
        // the user issues a key and uses it once: the exchange records the key's last use
        const token = await login(request, e, PW)
        const key = await request.post('/api/v1/auth/api-keys', { headers: bearer(token), data: { name: `${PREFIX}key`, expires_in_days: 7 } })
        expect(key.status(), await key.text()).toBe(201)
        const exchange = await request.post('/api/v1/auth/token', { headers: { Authorization: `Bearer ${(await key.json()).key}` } })
        expect(exchange.status(), 'key exchange').toBe(200)
      }
      await createUser(request, admin, staleAuditor, (await role.json()).id)
      // 200 days back: no sign-in at all for the key-only account, an old one for the other two
      psql(`UPDATE auth_users SET last_login_at = NULL, created_at = NOW() - INTERVAL '200 days' WHERE email = '${keyOnly}'`)
      psql(`UPDATE auth_users SET last_login_at = NOW() - INTERVAL '200 days', created_at = NOW() - INTERVAL '200 days' WHERE email IN ('${oldLoginKey}', '${staleAuditor}')`)

      const reportAnswer = page.waitForResponse((r) => pathIs(r, '/api/v1/auth/admin/access-review'), { timeout: 30_000 })
      await page.goto(ACCESS_REVIEW.path)
      const rep: Obj = await (await reportAnswer).json()
      await expect(page.getByTestId('access-review-summary')).toBeVisible({ timeout: 15_000 })

      // the cards counted again from the answer's rows
      const perms = new Map<string, string[]>(rep.roles.map((r: Obj) => [r.name, r.permissions]))
      const privileged = (u: Obj) => (perms.get(u.global_role) ?? []).some((p) => p === '*' || p.startsWith('admin.'))
      const keyUse = new Map<string, number>()
      for (const k of rep.api_keys) if (k.last_used_at) keyUse.set(k.owner_email, Math.max(keyUse.get(k.owner_email) ?? 0, Date.parse(k.last_used_at)))
      const cutoff = Date.parse(rep.generated_at) - rep.settings.dormant_days * DAY
      const activity = (u: Obj) => Math.max(Date.parse(u.last_login_at ?? u.created_at), keyUse.get(u.email) ?? Date.parse(u.created_at))
      const users: Obj[] = rep.users
      const want = {
        admin: users.filter(privileged).length,
        full: users.filter((u) => (perms.get(u.global_role) ?? []).includes('*')).length,
        dormant: users.filter((u) => activity(u) < cutoff).length,
        never: users.filter((u) => !u.last_login_at).length,
      }
      const card = (k: string) => page.getByTestId(`access-review-card-${k}`).innerText()
      const fullLine = (want.full === 1 ? EN.accessReview.card.fullAdmins_one : EN.accessReview.card.fullAdmins).replace('{{count}}', String(want.full))

      await test.step('cards: with admin permissions and its global admins, dormant as the lock reads, never signed in', async () => {
        soft(await card('global_admins'), '"With admin permissions" card with the global admins beside it').toBe(`${EN.accessReview.card.adminPermissions}\n${want.admin}\n${fullLine}`)
        soft(await card('dormant'), 'Dormant card = accounts with no sign-in and no key use since the cutoff').toBe(`${EN.accessReview.card.dormant}\n${want.dormant}`)
        soft(await card('never_logged_in'), 'Never signed in card').toBe(`${EN.accessReview.card.neverLoggedIn}\n${want.never}`)
      })

      await test.step('this run\'s accounts: flags in the answer and on screen', async () => {
        const exempt = lockCfg.enabled && lockCfg.exempt_admins ? ['lock_exempt'] : []
        const expected: Record<string, string[]> = {
          [keyOnly]: ['never_logged_in', 'api_key_only'],
          [oldLoginKey]: ['api_key_only'],
          [staleAuditor]: ['global_admin', 'dormant', ...exempt],
        }
        const search = page.getByPlaceholder(EN.accessReview.search)
        for (const [e, flags] of Object.entries(expected)) {
          soft(users.find((u) => u.email === e)?.flags, `${e}: flags in the report`).toEqual(flags)
          await search.fill(e)
          const row = page.getByTestId('access-review-row')
          await soft.poll(async () => (await row.count()) === 1 ? row.first().locator('td').last().locator('span').allInnerTexts() : [], { timeout: 10_000, message: `${e}: flags on screen` })
            .toEqual(flags.map((f) => EN.accessReview.flags[f]))
        }
        await search.fill('')
      })

      await test.step('the API keys tab and the temporary grants count', async () => {
        const expired = rep.api_keys.filter((k: Obj) => k.flags.includes('expired')).length
        const tabCount = expired > 0
          ? EN.accessReview.tabCountExpired.replace('{{count}}', String(rep.api_keys.length)).replace('{{expired}}', String(expired))
          : `(${rep.api_keys.length})`
        soft(await page.getByTestId('access-review-tab-api_keys').innerText(), 'API keys tab: every key, the expired named').toBe(`${EN.accessReview.section.api_keys} ${tabCount}`)
        const since = String(rep.since).replace(/Z$/, '')
        soft(rep.access_requests_total, 'access_requests_total = database count of requests since the window start').toBe(dbCount(`SELECT count(*) FROM access_requests WHERE created_at >= '${since}'`))
      })

      await test.step('Past reviews: every sign-off over the pages, no loading line between tabs or pages', async () => {
        const dbReviews = dbCount('SELECT count(*) FROM access_reviews')
        const api = await request.get('/api/v1/auth/admin/access-review/history?limit=1', { headers: bearer(admin) })
        soft(api.headers()['x-kubeast-total'], 'API: X-Kubeast-Total of the sign-offs').toBe(String(dbReviews))
        await page.evaluate(({ lines }) => {
          const w = window as Obj
          w.__reviewFlash = []
          const main = document.querySelector('main') ?? document.body
          new MutationObserver(() => {
            const text = (main as HTMLElement).innerText
            const line = lines.find((l: string) => text.includes(l))
            if (line) w.__reviewFlash.push(line)
          }).observe(main, { subtree: true, childList: true, characterData: true })
        }, { lines: dbReviews > 0 ? [EN.accessReview.loading, EN.accessReview.noHistory] : [EN.accessReview.loading] })
        await page.getByTestId('access-review-tab-history').click()
        const rows = page.getByTestId('access-review-history-row')
        await expect.poll(() => rows.count(), { timeout: 15_000, message: 'Past reviews listed' }).toBeGreaterThan(0)
        const pager = page.getByTestId('access-review-history-pager')
        const perPage: number[] = []
        for (let i = 0; i < 100; i++) {
          perPage.push(await rows.count())
          // an older build has no pager: one list
          if ((await pager.count()) === 0) break
          const next = pager.getByRole('button', { name: EN.common.next, exact: true })
          if (await next.isDisabled()) break
          const before = await pager.innerText()
          await next.click()
          await expect.poll(() => pager.innerText(), { timeout: 15_000, message: `Past reviews page ${i + 2}` }).not.toBe(before)
        }
        soft(perPage.reduce((a, b) => a + b, 0), 'Past reviews: rows over every page = database count of sign-offs').toBe(dbReviews)
        soft(await pager.count(), 'Past reviews: a pager').toBe(1)
        soft(await flashes(page, '__reviewFlash'), 'no loading line when the tab opens or a page turns').toEqual([])
      })
    } finally {
      await cleanup(request, admin)
    }
  })
})
