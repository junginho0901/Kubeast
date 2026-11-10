import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test'

// Number check of four of Kubeast's own screens against the API and the database:
// - Audit logs: a user of this run writes its own audit rows (every audit read is one); paging to the end while
//   it writes more holds each row once and the total of the first read, Refresh shows the rows since, the CSV holds
//   the rows the screen counts, the end minute counts the whole minute, and a filter past the CSV limit says so.
// - Session recordings: two rows the spec writes (e2e-n4d-rec-*) whose users differ in one character, found by a
//   filter holding "_" as text; the rows stay on screen while the next page or search loads.
// - Clusters: a Test leaves a line of what it found (self's version kubectl reads, a failure's reason) until that
//   cluster's next Test; the Health column is the server's.
// - AI chat: each session card's message count is the session API's.

const AUDIT = { path: '/admin/audit' }
const RECORDINGS = { path: '/admin/session-recordings' }
const CLUSTERS = { path: '/admin/clusters' }
const CHAT = { path: '/ai-chat', cluster: 'self' }

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const PREFIX = 'e2e-n4d-'
const PW = 'E2e-n4d-audit-Zq7x'
// the server's CSV limit, read from its source
const EXPORT_MAX = Number((fs.readFileSync(path.join(__dirname, '../../services/auth-service-go/internal/handler/auth_admin_audit_export.go'), 'utf8').match(/exportMaxRows = (\d+)/) ?? [])[1])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Entry = { ID: number; CreatedAt: string; ActorEmail: string; Action: string }
type AuditAnswer = { total: number; items: Entry[]; as_of?: number; export_limit?: number }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-admin-misc-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const psql = (sql: string) =>
  execFileSync('kubectl', ['--kubeconfig', kcPath, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql], { encoding: 'utf8' }).trim()

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// a minimal RFC 4180 reader: the CSV's records
function csvRecords(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++ }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row) }
  return out
}

const repeats = (ids: number[]) => ids.filter((id, i) => ids.indexOf(id) !== i)
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

test.describe('number check: audit logs, session recordings, clusters, AI chat', () => {
  test('Audit logs: pages to the end keep the first read, the CSV holds what the screen counts, the end minute is whole', async ({ page, request }) => {
    test.setTimeout(240_000)
    expect(EXPORT_MAX, 'exportMaxRows read from the auth-service source').toBeGreaterThan(0)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const run = Date.now().toString(36)
    const email = `${PREFIX}${run}@kubeast.local`
    const roleName = `${PREFIX}audit-${run}`
    const cleanup = async () => {
      const users = (await (await request.get('/api/v1/auth/admin/users?limit=200', { headers: bearer(admin) })).json()) as { id: string; email?: string }[]
      for (const u of users.filter((u) => (u.email ?? '').startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: bearer(admin), failOnStatusCode: false })
      const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as { id: number; name: string }[]
      for (const r of roles.filter((r) => r.name.startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/roles/${r.id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
    await cleanup()
    try {
      const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: roleName, description: 'e2e audit pages', permissions: ['admin.audit.read'] } })
      expect(role.status(), await role.text()).toBeLessThan(300)
      const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E n4d ${run}`, email, password: PW, role_id: (await role.json()).id } })
      expect(made.status(), await made.text()).toBe(201)
      const user = await login(request, email, PW)
      // each audit read this user makes is an admin.audit.read row of its own
      const userReads = async (n: number) => {
        for (let i = 0; i < n; i += 10) {
          const res = await Promise.all(Array.from({ length: Math.min(10, n - i) }, () => request.get('/api/v1/auth/admin/audit-logs?action=e2e.n4d.none&limit=1', { headers: bearer(user) })))
          expect(res.map((r) => r.status())).toEqual(res.map(() => 200))
        }
      }
      const mine = `actor_email=${encodeURIComponent(email)}&action=admin.audit.read`
      const listMine = async (extra = ''): Promise<AuditAnswer> => (await (await request.get(`/api/v1/auth/admin/audit-logs?${mine}&limit=1000${extra}`, { headers: bearer(admin) })).json())
      const dbCount = (bound = '') => Number(psql(`SELECT count(*) FROM auth_audit_logs WHERE actor_email = '${email}' AND action = 'admin.audit.read'${bound}`))

      await userReads(60)
      const start = await listMine()
      expect([start.total, start.items.length, dbCount()], 'the user wrote 60 rows: API total, rows, database').toEqual([60, 60, 60])
      const startIds = start.items.map((e) => e.ID)

      // the screen's own reads of this user's rows
      const isMine = (r: Response) => r.url().includes('/api/v1/auth/admin/audit-logs?') && new URL(r.url()).searchParams.get('actor_email') === email
      const shown = (p: Page) => p.locator('main tbody:not([aria-hidden="true"]) tr').evaluateAll((rows) => rows.filter((r) => (r as HTMLTableRowElement).cells.length >= 7)
        .map((r) => [0, 1, 3].map((i) => (r as HTMLTableRowElement).cells[i].innerText.trim())))
      const wanted = (a: AuditAnswer) => page.evaluate((items) => {
        const pad = (n: number) => String(n).padStart(2, '0')
        const local = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
        return items.map((e) => [local(e.CreatedAt), e.ActorEmail, e.Action])
      }, a.items)
      const totalLine = page.locator('main span', { hasText: /^\d+ entr(y|ies)/ }).first()
      const entries = (n: number) => (n === 1 ? EN.adminAudit.total_one : EN.adminAudit.total).replace('{{total}}', String(n))

      await page.goto(AUDIT.path)
      await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 15_000 })
      await page.getByPlaceholder('k8s.pod.delete').fill('admin.audit.read')
      await page.getByPlaceholder('user@example.com').fill(email)
      // 25 a page, chosen in the table's footer (kept in this browser until the end of the test)
      await page.getByTestId('audit-pager').getByTestId('page-size-select').click()
      await page.getByTestId('audit-pager').getByRole('button', { name: /^25$/ }).click()
      let answer = page.waitForResponse(isMine)
      await page.getByRole('button', { name: new RegExp(`^${EN.adminAudit.apply}$`) }).click()
      const pages: AuditAnswer[] = [await (await answer).json()]
      await expect.poll(() => shown(page), { timeout: 15_000, message: 'page 1 shows its answer' }).toEqual(await wanted(pages[0]))

      await test.step('paging to the end while rows are written: each row once, the first read\'s total, no empty table between pages', async () => {
        // a moment the table has no rows, or loading / no results, while it pages
        await page.evaluate(() => {
          const w = window as Obj
          w.__auditFlash = []
          const body = document.querySelector('main tbody')!
          const check = () => {
            const rows = body.querySelectorAll('tr')
            const text = (body as HTMLElement).innerText
            if (rows.length === 0 || /Loading\.\.\.|No results found\./.test(text)) w.__auditFlash.push(rows.length === 0 ? '(no rows)' : text.slice(0, 40))
          }
          new MutationObserver(check).observe(body, { subtree: true, childList: true, characterData: true })
        })
        const next = page.getByTestId('audit-pager').getByRole('button', { name: EN.common.next, exact: true })
        for (let i = 0; i < 10 && !(await next.isDisabled()); i++) {
          await userReads(5)
          answer = page.waitForResponse(isMine)
          await next.click()
          const a = (await (await answer).json()) as AuditAnswer
          pages.push(a)
          await expect.poll(() => shown(page), { timeout: 15_000, message: `page ${pages.length} shows its answer` }).toEqual(await wanted(a))
        }
        const ids = pages.flatMap((p) => p.items.map((e) => e.ID))
        expect.soft(repeats(ids), 'rows shown on two pages').toEqual([])
        expect.soft(pages.map((p) => p.total), 'every page counts the first read').toEqual(pages.map(() => 60))
        expect.soft(sorted(ids), 'the pages hold the 60 rows of the first read').toEqual(sorted(startIds))
        expect.soft(await totalLine.innerText(), 'the total on screen').toBe(entries(60))
        expect.soft(await page.evaluate(() => (window as Obj).__auditFlash), 'the table never emptied between pages').toEqual([])
      })

      await test.step('Refresh reads the rows written since', async () => {
        answer = page.waitForResponse(isMine)
        await page.getByRole('button', { name: new RegExp(`^${EN.adminAudit.refresh}$`) }).click()
        const fresh = (await (await answer).json()) as AuditAnswer
        expect.soft(fresh.total, 'Refresh: the API total').toBe(dbCount())
        await expect.poll(() => totalLine.innerText(), { timeout: 15_000 }).toBe(entries(fresh.total))
        pages.push(fresh)
      })

      await test.step('the CSV holds the rows the screen counts, also when rows are written before it', async () => {
        const counted = pages[pages.length - 1]
        await userReads(3)
        const download = page.waitForEvent('download')
        await page.getByTestId('audit-export-csv').click()
        const file = await (await download).path()
        const records = csvRecords(fs.readFileSync(file as string, 'utf8').replace(/^﻿/, ''))
        const ids = records.slice(1).map((r) => Number(r[0]))
        expect.soft(ids.length, 'CSV rows = the total on screen').toBe(counted.total)
        expect.soft(repeats(ids), 'CSV rows twice').toEqual([])
        const listed = await listMine(counted.as_of ? `&as_of=${counted.as_of}` : '')
        expect.soft(sorted(ids), 'CSV rows = the rows the list counts').toEqual(sorted(listed.items.map((e) => e.ID)))
        // the export answer says how many matched
        const direct = await request.get(`/api/v1/auth/admin/audit-logs/export?${mine}${counted.as_of ? `&as_of=${counted.as_of}` : ''}`, { headers: bearer(admin) })
        expect.soft(direct.headers()['x-kubeast-total'], 'X-Kubeast-Total').toBe(String(counted.total))
      })

      await test.step('the end minute counts the whole minute', async () => {
        const oldest = start.items[start.items.length - 1].CreatedAt
        const minute = await page.evaluate((iso) => {
          const d = new Date(iso)
          d.setSeconds(0, 0)
          const pad = (n: number) => String(n).padStart(2, '0')
          return {
            typed: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
            since: d.toISOString(),
            until: new Date(d.getTime() + 59_999).toISOString().replace(/Z$/, '999Z'),
          }
        }, oldest)
        const inMinute = (await listMine(`&since=${minute.since}&until=${minute.until}`)).total
        expect(inMinute, `rows of ${minute.typed}`).toBeGreaterThan(0)
        await page.getByTestId('audit-filter-since').fill(minute.typed)
        await page.getByTestId('audit-filter-until').fill(minute.typed)
        answer = page.waitForResponse(isMine)
        await page.getByRole('button', { name: new RegExp(`^${EN.adminAudit.apply}$`) }).click()
        const sent = await answer
        expect.soft(new URL(sent.url()).searchParams.get('until'), 'the until the screen sent').toBe(minute.until)
        await expect.poll(() => totalLine.innerText(), { timeout: 15_000, message: `the total of ${minute.typed} to ${minute.typed}` }).toBe(entries(inMinute))
      })

      await test.step('past the CSV limit the screen says how many the CSV holds', async () => {
        answer = page.waitForResponse((r) => r.url().includes('/api/v1/auth/admin/audit-logs?') && !new URL(r.url()).searchParams.get('actor_email'))
        await page.getByRole('button', { name: new RegExp(`^${EN.adminAudit.reset}$`) }).click()
        const all = (await (await answer).json()) as AuditAnswer
        expect.soft(all.export_limit, 'the list answers the CSV limit').toBe(EXPORT_MAX)
        if (all.total <= EXPORT_MAX) {
          test.info().annotations.push({ type: 'skip-step', description: `only ${all.total} audit rows: within one CSV` })
          await expect.poll(() => totalLine.innerText(), { timeout: 15_000 }).toBe(entries(all.total))
          return
        }
        const cut = EN.adminAudit.exportCut.replace('{{limit}}', String(EXPORT_MAX)).replace('{{total}}', String(all.total))
        await expect.poll(() => totalLine.innerText(), { timeout: 15_000 }).toBe(`${entries(all.total)} · ${cut}`)
      })
    } finally {
      await page.evaluate(() => localStorage.removeItem('kubeast.listPageSize')).catch(() => {})
      await cleanup()
    }
  })

  test('Session recordings: the user filter takes _ as text, and the rows stay while the next page or search loads', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const run = Date.now().toString(36)
    const ids = [`${PREFIX}rec-${run}-1`, `${PREFIX}rec-${run}-2`]
    const typed = `${run}-a_b`
    psql(`DELETE FROM session_recordings WHERE id LIKE '${PREFIX}rec-%'`)
    try {
      psql(`INSERT INTO session_recordings (id, kind, user_email, cluster, target, storage, status, started_at) VALUES
        ('${ids[0]}', 'exec', '${PREFIX}${run}-a_b@kubeast.local', 'self', 'e2e-n4d', 's3', 'uploaded', now() - interval '1 second'),
        ('${ids[1]}', 'exec', '${PREFIX}${run}-axb@kubeast.local', 'self', 'e2e-n4d', 's3', 'uploaded', now())`)
      const list = async (params: Record<string, string>) =>
        (await (await request.get('/api/v1/cluster/recordings', { headers: bearer(admin), params: { cluster: '', ...params } })).json()) as { id: string }[]
      const all = await list({ limit: '500' })
      // the e-mails holding the text typed, "_" as itself
      const literal = Number(psql(`SELECT count(*) FROM session_recordings WHERE strpos(user_email, '${typed}') > 0`))
      expect(literal, `recordings whose user holds ${typed}`).toBe(1)

      await page.goto(RECORDINGS.path)
      // the rows that fit the screen, and how many there are: the footer's range against the database
      const rows = page.getByTestId('recordings-table').locator('tbody:not([aria-hidden="true"]) tr')
      const pager = page.getByTestId('recordings-pager')
      await expect(pager).toContainText(/Showing 1-\d+ of \d+/, { timeout: 15_000 })
      const [, first, last, total] = (/Showing (\d+)-(\d+) of (\d+)/.exec(await pager.innerText()) ?? []).map(Number)
      const size = last - first + 1
      expect.soft(total, 'the recordings counted = the database').toBe(Number(psql('SELECT count(*) FROM session_recordings')))
      expect.soft(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'the page scrolls by').toBeLessThanOrEqual(1)
      test.skip(all.length <= size, `only ${all.length} recordings: a single page of ${size}`)
      await expect(rows).toHaveCount(size, { timeout: 15_000 })
      await page.evaluate((texts) => {
        const w = window as Obj
        w.__recFlash = []
        const body = document.querySelector('[data-testid="recordings-table"] tbody')!
        const check = () => {
          const cells = [...body.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.trim())
          const hit = cells.find((c) => texts.includes(c))
          if (body.querySelectorAll('tr').length === 0 || hit) w.__recFlash.push(hit ?? '(no rows)')
        }
        new MutationObserver(check).observe(body, { subtree: true, childList: true, characterData: true })
      }, [EN.recordings.loading, EN.common.listEmpty])

      await pager.getByRole('button', { name: EN.common.next, exact: true }).click()
      await expect(rows.first()).toHaveAttribute('data-testid', `recording-row-${all[size].id}`, { timeout: 15_000 })
      expect.soft(await page.evaluate(() => (window as Obj).__recFlash.splice(0)), 'no loading or empty row while the next page loads').toEqual([])

      await page.getByPlaceholder('user@example.com').fill(typed)
      await page.getByRole('button', { name: new RegExp(`^${EN.recordings.filter.apply}$`) }).click()
      const ofRows = () => rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-testid')))
      await expect.poll(ofRows, { timeout: 15_000, message: `the rows of ${typed}` }).toEqual([`recording-row-${ids[0]}`])
      expect.soft((await list({ user: typed })).map((r) => `recording-row-${r.id}`), 'the API answers the same').toEqual([`recording-row-${ids[0]}`])
      expect.soft(await page.evaluate(() => (window as Obj).__recFlash), 'no loading or empty row while the search loads').toEqual([])
    } finally {
      psql(`DELETE FROM session_recordings WHERE id LIKE '${PREFIX}rec-%'`)
    }
  })

  test('Clusters: a Test leaves a line of what it found, the reason when it failed, until the next Test of that cluster', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    type Meta = { id: string; display_name: string; health_status?: string }
    type Result = { healthy: boolean; server_version?: string; server?: string; message?: string }
    const clusters = async () => ((await (await request.get('/api/v1/clusters', { headers: bearer(admin), params: { cluster: '' } })).json()).items ?? []) as Meta[]
    const before = await clusters()
    test.skip(!before.some((c) => c.id === 'default') || !before.some((c) => c.id === 'self'), 'needs the clusters self and default')
    const health = (status?: string) => (status ? EN.cluster.admin.healthValue[status] ?? status : '-')
    const said = (r: Result) => {
      const word = r.healthy ? EN.cluster.admin.testPassed : EN.cluster.admin.testFailed
      const detail = r.healthy ? r.server_version : r.message
      return detail ? `${word}: ${detail}` : word
    }
    // the cluster self is: what kubectl version reads of it
    const selfVersion = JSON.parse(execFileSync('kubectl', ['--kubeconfig', kcPath, '--context', 'kind-kubeast', 'version', '-o', 'json'], { encoding: 'utf8' })).serverVersion.gitVersion as string
    await page.goto(CLUSTERS.path)
    // a cluster's row: the one holding its Access button
    const row = (id: string) => page.getByTestId('clusters-table').locator('tbody tr').filter({ has: page.getByTestId(`access-cluster-${id}`) })
    // the status itself (the server's); the time of the last check and the Test's line are under it
    const cell = (id: string) => row(id).locator('td').nth(3).locator('> span').first()
    const line = (id: string) => page.getByTestId(`cluster-test-result-${id}`)
    const testButton = (id: string) => row(id).getByRole('button', { name: EN.cluster.admin.test, exact: true })
    const press = async (id: string) => {
      const tested = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/clusters/${id}/test` && r.request().method() === 'POST')
      const listed = page.waitForResponse((r) => /\/api\/v1\/clusters(\?|$)/.test(r.url()) && !r.url().includes('accessibleOnly') && r.request().method() === 'GET')
      await testButton(id).click()
      const res = await tested
      const list = ((await (await listed).json()).items ?? []) as Meta[]
      return { status: res.status(), body: (await res.json()) as Result, list }
    }
    await expect(line('default'), 'no line before a Test').toHaveText('')

    const d = await press('default')
    expect(d.status).toBe(200)
    await expect(line('default'), 'the Test of default').toHaveText(said(d.body), { timeout: 15_000 })
    await expect(cell('default'), 'the health the Test wrote').toHaveText(health(d.list.find((c) => c.id === 'default')?.health_status))

    // self is dialed (it used to answer healthy without asking): the version kubectl reads
    const s = await press('self')
    expect(s.body, 'self answers what its API server is').toMatchObject({ healthy: true, server_version: selfVersion })
    expect(s.body.server, 'the in-cluster Service address is not put on the row').toBeUndefined()
    await expect(line('self')).toHaveText(`${EN.cluster.admin.testPassed}: ${selfVersion}`, { timeout: 15_000 })
    await expect(line('default'), "default's line stays through another cluster's Test").toHaveText(said(d.body))

    // a failure says why: the server's reason for a cluster it could not reach, the refusal's for a request refused;
    // the button says it is waiting meanwhile
    const answers = [
      { status: 200, json: { healthy: false, message: 'connection failed: e2e stand-in, dial tcp 10.0.0.1:6443: i/o timeout' }, want: `${EN.cluster.admin.testFailed}: connection failed: e2e stand-in, dial tcp 10.0.0.1:6443: i/o timeout` },
      { status: 403, json: { detail: 'forbidden: e2e stand-in refusal' }, want: `${EN.cluster.admin.testFailed}: forbidden: e2e stand-in refusal` },
    ]
    const testPath = (u: URL) => u.pathname === '/api/v1/clusters/default/test'
    for (const a of answers) {
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      // by path: the app adds ?cluster= to every request
      await page.route(testPath, async (route) => { await held; await route.fulfill({ status: a.status, json: a.json }) })
      await testButton('default').click()
      await expect(testButton('default'), 'waiting').toBeDisabled()
      await expect(testButton('default')).toHaveAttribute('aria-busy', 'true')
      release()
      await expect(line('default')).toHaveText(a.want, { timeout: 15_000 })
      await expect(line('default').locator('span')).toHaveClass(/text-red-400/)
      await expect(testButton('default'), 'done').toBeEnabled()
      await page.unroute(testPath)
    }

    await page.reload()
    const after = await clusters()
    await expect(cell('default'), 'after a reload').toHaveText(health(after.find((c) => c.id === 'default')?.health_status), { timeout: 15_000 })
    await expect(line('default'), 'a line is of this visit').toHaveText('')
  })

  test('Clusters: a refused Delete and a failed store Check say why, and nothing is deleted', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ids = async () => (((await (await request.get('/api/v1/clusters', { headers: bearer(admin), params: { cluster: '' } })).json()).items ?? []) as { id: string }[]).map((c) => c.id).sort()
    const before = await ids()
    test.skip(!before.includes('default'), 'needs the cluster default')
    const reason = 'e2e stand-in: the cluster is in use'
    // the answers are stood in in the browser: the server is never asked to delete
    await page.route((url) => url.pathname === '/api/v1/clusters/default', (route) =>
      route.request().method() === 'DELETE' ? route.fulfill({ status: 409, json: { detail: reason } }) : route.fallback())
    await page.goto(CLUSTERS.path)
    await page.getByTestId('delete-cluster-default').click()
    await page.getByTestId('delete-confirm').click()
    await expect(page.getByTestId('delete-cluster-error')).toHaveText(EN.cluster.delete.failed.replace('{{reason}}', reason))
    await expect(page.getByTestId('delete-confirm'), 'the window stays for another try or Cancel').toBeEnabled()
    expect(await ids(), 'nothing deleted').toEqual(before)
    await page.getByRole('button', { name: EN.common.cancel, exact: true }).click()
    await page.getByTestId('delete-cluster-default').click()
    await expect(page.getByTestId('delete-cluster-error'), "a window opened again does not carry the last try's reason").toHaveCount(0)
    await page.getByRole('button', { name: EN.common.cancel, exact: true }).click()

    // Edit → Check: a store status the server refused names the server's reason, not the browser's status line
    const storeReason = 'e2e stand-in: the store did not answer'
    for (const p of ['/api/v1/cluster/prometheus/status', '/api/v1/cluster/logsearch/status']) {
      await page.route((url) => url.pathname === p, (route) => route.fulfill({ status: 502, json: { detail: storeReason } }))
    }
    await page.getByTestId('edit-cluster-default').click()
    await page.getByTestId('edit-prometheus-check').click()
    await expect(page.getByTestId('edit-prometheus-status')).toHaveText(EN.cluster.edit.prometheus.resultNone.replace('{{message}}', storeReason))
    await page.getByTestId('edit-logsearch-check').click()
    await expect(page.getByTestId('edit-logsearch-status')).toHaveText(EN.cluster.edit.logSearch.resultNone.replace('{{message}}', storeReason))
  })

  test('Clusters: the Health column says when the check it shows was made, the time the API answers', async ({ page }) => {
    const answered = page.waitForResponse((r) => /\/api\/v1\/clusters(\?|$)/.test(r.url()) && !r.url().includes('accessibleOnly') && r.request().method() === 'GET')
    await page.goto(CLUSTERS.path)
    type Meta = { id: string; last_healthcheck_at?: string }
    const items = ((await (await answered).json()).items ?? []) as Meta[]
    expect(items.length, 'clusters listed').toBeGreaterThan(0)
    const local = (iso: string) => page.evaluate((v) => {
      const pad = (n: number) => String(n).padStart(2, '0')
      const d = new Date(v)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }, iso)
    for (const c of items) {
      const line = page.getByTestId(`cluster-health-checked-${c.id}`)
      if (c.last_healthcheck_at) await expect.soft(line, c.id).toHaveText(EN.cluster.admin.healthChecked.replace('{{time}}', await local(c.last_healthcheck_at)), { timeout: 15_000 })
      else await expect.soft(line, `${c.id} was never checked`).toHaveCount(0)
    }
  })

  test('Audit logs: rows per page fit the screen, and a choice in the footer reads at once from the page holding the first row', async ({ page }) => {
    const reads: { limit: string | null; offset: string | null; total: number; items: number }[] = []
    page.on('response', async (r) => {
      if (!r.url().includes('/api/v1/auth/admin/audit-logs?')) return
      const q = new URL(r.url()).searchParams
      try {
        const body = (await r.json()) as { items: unknown[]; total: number }
        reads.push({ limit: q.get('limit'), offset: q.get('offset'), total: body.total, items: body.items.length })
      } catch { /* the page went on */ }
    })
    const rows = () => page.locator('main tbody:not([aria-hidden="true"]) tr').evaluateAll((all) => all.filter((r) => (r as HTMLTableRowElement).cells.length >= 7).length)
    const select = page.getByTestId('audit-pager').getByTestId('page-size-select')
    try {
      await page.goto(AUDIT.path)
      await expect(select, 'Fit to start with').toHaveText(EN.common.pageSize.fit, { timeout: 15_000 })
      // the table holds the rows of the last read, which asked as many as fit; the page does not scroll
      await expect.poll(async () => (reads.length ? (await rows()) === reads.at(-1)!.items : false), { timeout: 15_000, message: 'the table holds the last read' }).toBe(true)
      const fit = reads.at(-1)!
      expect.soft(fit.items, 'a page of rows that fit').toBe(Math.min(Number(fit.limit), fit.total))
      expect.soft(Number(fit.limit), 'rows that fit at 1440×900').toBeGreaterThanOrEqual(5)
      expect.soft(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'the page scrolls by').toBeLessThanOrEqual(1)
      const pagerBottom = await page.getByTestId('audit-pager').evaluate((el) => el.getBoundingClientRect().bottom)
      expect.soft(pagerBottom, 'the footer is on screen').toBeLessThanOrEqual(page.viewportSize()!.height)

      const answered = page.waitForResponse((r) => r.url().includes('/api/v1/auth/admin/audit-logs?') && new URL(r.url()).searchParams.get('limit') === '25')
      await select.click()
      await page.getByTestId('audit-pager').getByRole('button', { name: /^25$/ }).click()
      const answer = (await (await answered).json()) as { items: unknown[]; total: number }
      expect(reads.at(-1) && { limit: reads.at(-1)!.limit, offset: reads.at(-1)!.offset }, 'read at once, the first page held the first row, without pressing Search').toEqual({ limit: '25', offset: '0' })
      await expect(select, 'the dropdown').toHaveText('25')
      await expect.poll(rows, { timeout: 15_000, message: 'the table holds that many rows' }).toBe(answer.items.length)
      expect(answer.items.length).toBe(Math.min(25, answer.total))
    } finally {
      await page.evaluate(() => localStorage.removeItem('kubeast.listPageSize')).catch(() => {})
    }
  })

  test('AI chat: a conversation longer than a page says what it does not show, and reads it above, each message once', async ({ page, request }) => {
    test.setTimeout(180_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const title = `${PREFIX}long-${Date.now().toString(36)}`
    const created = await request.post(`/api/v1/sessions?cluster=${CHAT.cluster}`, { headers: bearer(admin), data: { title } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const id = (await created.json()).id as string
    const N = 205
    try {
      for (let from = 0; from < N; from += 50) {
        const messages = Array.from({ length: Math.min(50, N - from) }, (_, i) => ({ role: (from + i) % 2 ? 'assistant' : 'user', content: `e2e long ${from + i}` }))
        const saved = await request.post(`/api/v1/sessions/${id}/messages`, { headers: bearer(admin), data: { messages } })
        expect(saved.ok(), await saved.text()).toBeTruthy()
      }
      const detail = await (await request.get(`/api/v1/sessions/${id}`, { headers: bearer(admin) })).json() as { messages: unknown[]; messages_before: number }
      expect([detail.messages.length, detail.messages_before], 'the newest page and how many come before it').toEqual([100, 105])

      const said = (n: number) => EN.aiChat.earlier.hidden.replace('{{count}}', String(n))
      const texts = (root: string) => page.getByTestId(root).evaluate((el) => [...(el as HTMLElement).innerText.matchAll(/e2e long (\d+)/g)].map((m) => Number(m[1])))
      const inOrder = (from: number) => Array.from({ length: N - from }, (_, i) => from + i)
      const walk = async (root: string) => {
        await expect(page.getByTestId('chat-earlier-count')).toHaveText(said(105), { timeout: 20_000 })
        await expect.poll(() => texts(root), { timeout: 20_000, message: 'the newest page' }).toEqual(inOrder(105))
        const load = page.getByTestId('chat-earlier-load')
        await load.click()
        await expect(page.getByTestId('chat-earlier-count')).toHaveText(said(5), { timeout: 20_000 })
        await expect.poll(() => texts(root), { message: 'a page above it, each message once' }).toEqual(inOrder(5))
        await load.click()
        await expect(page.getByTestId('chat-earlier')).toHaveCount(0, { timeout: 20_000 })
        await expect.poll(() => texts(root), { message: 'every message' }).toEqual(inOrder(0))
      }

      await test.step('AI Chat', async () => {
        await page.goto(`${CHAT.path}?cluster=${CHAT.cluster}`)
        await page.locator(`[title="${title}"]`).first().click({ timeout: 20_000 })
        await walk('chat-messages')
      })

      await test.step('the floating chat', async () => {
        await page.addInitScript((sid) => sessionStorage.setItem('kubest.floatingChat.sessionId', sid), id)
        await page.goto(`/?cluster=${CHAT.cluster}`)
        await page.getByTestId('floating-chat-toggle').click({ timeout: 20_000 })
        await walk('floating-messages')
      })
    } finally {
      await request.delete(`/api/v1/sessions/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('AI chat: each session card counts the messages the session API holds', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const run = Date.now().toString(36)
    const made: { id: string; title: string; n: number }[] = []
    try {
      for (const n of [3, 1]) {
        const title = `${PREFIX}msg${n}-${run}`
        const created = await request.post(`/api/v1/sessions?cluster=${CHAT.cluster}`, { headers: bearer(admin), data: { title } })
        expect(created.ok(), await created.text()).toBeTruthy()
        const id = (await created.json()).id as string
        made.push({ id, title, n })
        const messages = Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `e2e n4d ${i}` }))
        const saved = await request.post(`/api/v1/sessions/${id}/messages`, { headers: bearer(admin), data: { messages } })
        expect(saved.ok(), await saved.text()).toBeTruthy()
      }
      for (const s of made) {
        const detail = await (await request.get(`/api/v1/sessions/${s.id}`, { headers: bearer(admin) })).json()
        expect((detail.messages as unknown[]).length, `${s.title}: the session's messages`).toBe(s.n)
      }

      const listed = page.waitForResponse((r) => r.url().includes('/api/v1/sessions?') && r.request().method() === 'GET')
      await page.goto(`${CHAT.path}?cluster=${CHAT.cluster}`)
      const sessions = (await (await listed).json()) as { id: string; title: string; message_count: number }[]
      const count = (n: number) => (n === 1 ? EN.aiChat.messageCount_one : EN.aiChat.messageCount).replace('{{count}}', String(n))
      // the cards on screen, top down: title and count
      const cards = () => page.evaluate(() => [...document.querySelectorAll('[title]')]
        .filter((el) => /^\d+ messages?$/.test((el.nextElementSibling as HTMLElement | null)?.innerText.trim() ?? ''))
        .map((el) => [el.getAttribute('title'), (el.nextElementSibling as HTMLElement).innerText.trim()]))
      await expect.poll(async () => (await cards()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      const onScreen = await cards()
      expect.soft(onScreen, 'the cards = the session list answer, in order').toEqual(sessions.slice(0, onScreen.length).map((s) => [s.title, count(s.message_count)]))
      for (const s of made) {
        expect.soft(onScreen.find(([title]) => title === s.title)?.[1], `${s.title}`).toBe(count(s.n))
      }
    } finally {
      for (const s of made) await request.delete(`/api/v1/sessions/${s.id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
