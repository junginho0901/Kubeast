import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { rowsOfFirstPage, turnToRow } from './list-pages'

// The admin screens count every user, not the first page the users API answers (200): with more than 200 accounts,
// a team's member count and members, a role's user count and users, the Users list with its pager and the users
// Cluster access offers are each compared with every user the API lists page by page. The spec makes a team, a
// custom role and 205 users in both, and removes them after; a run cut short is cleaned up by the next one (the
// e2e-uc- names). The Teams, Roles and Users lists page as many rows as fit the screen: the team and the role are
// found by turning their pages, and the Users pages are as long as its first.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const PREFIX = 'e2e-uc-'
// past the users API's largest page (200)
const N = 205
// users per bulk request: each password is hashed, so a request of 100 can take longer than is pleasant
const BATCH = 25
const PW = 'E2e-ucount-Zq7x'
const TEAMS = { path: '/admin/organizations' }
const ROLES = { path: '/admin/roles' }
const USERS = { path: '/admin/users' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type User = { id: string; name: string; email?: string | null; team?: string | null; role?: { id: number; name: string } | null }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login ${ADMIN_EMAIL}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// every user, newest first, read 200 at a time until a page comes back empty
async function allUsers(request: APIRequestContext, token: string): Promise<User[]> {
  const out: User[] = []
  for (let offset = 0; offset < 100_000;) {
    const res = await request.get(`/api/v1/auth/admin/users?limit=200&offset=${offset}`, { headers: bearer(token) })
    expect(res.status(), await res.text()).toBe(200)
    const page = (await res.json()) as User[]
    if (page.length === 0) break
    out.push(...page)
    offset += page.length
  }
  return out
}

async function cleanup(request: APIRequestContext, token: string) {
  const users = (await allUsers(request, token)).filter((u) => (u.email ?? '').startsWith(PREFIX))
  for (let i = 0; i < users.length; i += 10) {
    await Promise.all(users.slice(i, i + 10).map((u) => request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: bearer(token), failOnStatusCode: false })))
  }
  const teams = (await (await request.get('/api/v1/auth/organizations?type=team', { headers: bearer(token) })).json()) as { id: number; name: string }[]
  for (const t of teams.filter((t) => t.name.startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/organizations/${t.id}`, { headers: bearer(token), failOnStatusCode: false })
  const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(token) })).json()) as { id: number; name: string }[]
  for (const r of roles.filter((r) => r.name.startsWith(PREFIX))) await request.delete(`/api/v1/auth/admin/roles/${r.id}`, { headers: bearer(token), failOnStatusCode: false })
  const left = (await allUsers(request, token)).filter((u) => (u.email ?? '').startsWith(PREFIX))
  expect(left.map((u) => u.email), 'no e2e-uc- user is left').toEqual([])
}

// A members window (team or role): the count in its heading and every row's cells
async function membersWindow(page: Page, title: string) {
  return page.evaluate((title) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => [...d.querySelectorAll('h2')].some((h) => txt(h) === title))
    if (!dialog) return null
    const heading = dialog.querySelector('h2')?.parentElement?.querySelector('p')
    return {
      count: heading ? (txt(heading).match(/\((\d+)\)$/) ?? [])[1] ?? null : null,
      rows: [...dialog.querySelectorAll('table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt)),
    }
  }, title)
}

// the count beside a name on the Teams list or the Roles table (the button holding the name and its badge)
async function badge(page: Page, name: string) {
  return page.evaluate((name) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const button = [...document.querySelectorAll('button')].find((b) => b.firstElementChild?.tagName === 'SPAN' && txt(b.firstElementChild) === name)
    return button && button.children[1] ? txt(button.children[1]) : null
  }, name)
}

// the value once it is as wanted (20 s), else what it is, compared softly
async function settled(read: () => Promise<unknown>, want: unknown, what: string) {
  try {
    await expect.poll(read, { timeout: 20_000 }).toEqual(want)
  } catch {
    expect.soft(await read(), what).toEqual(want)
  }
}

test.describe('number check — admin screens count every user', () => {
  test('teams, roles, the Users list and Cluster access with more users than one page of the API', async ({ page, request }) => {
    test.setTimeout(600_000)
    const token = await login(request)
    const run = Date.now().toString(36)
    const team = `${PREFIX}team-${run}`
    const roleName = `${PREFIX}role-${run}`
    await cleanup(request, token)
    try {
      const made = await request.post('/api/v1/auth/admin/organizations', { headers: bearer(token), data: { type: 'team', name: team } })
      expect(made.status(), await made.text()).toBeLessThan(300)
      const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(token), data: { name: roleName, description: 'e2e user counts', permissions: ['menu.dashboard'] } })
      expect(role.status(), await role.text()).toBeLessThan(300)
      const roleId = (await role.json()).id as number
      const wanted = Array.from({ length: N }, (_, i) => ({
        name: `E2E count ${run} ${String(i).padStart(3, '0')}`, email: `${PREFIX}${run}-${String(i).padStart(3, '0')}@kubeast.local`, password: PW, role_id: roleId, team,
      }))
      for (let i = 0; i < wanted.length; i += BATCH) {
        const res = await request.post('/api/v1/auth/admin/users/bulk', { headers: bearer(token), data: { users: wanted.slice(i, i + BATCH) }, timeout: 120_000 })
        expect(res.status(), await res.text()).toBe(200)
        expect((await res.json()).errors ?? []).toEqual([])
      }

      const users = await allUsers(request, token)
      const inTeam = users.filter((u) => u.team === team)
      const withRole = users.filter((u) => u.role?.id === roleId)
      expect(users.length, 'the API lists more users than its largest page').toBeGreaterThan(200)
      expect(inTeam.length, 'the API lists every user made in the team').toBe(N)
      expect(withRole.length, 'the API lists every user made with the role').toBe(N)

      await test.step('Teams: the member count and every member', async () => {
        await page.goto(TEAMS.path)
        expect(await turnToRow(page, 'teams-pager', page.getByTestId('teams-table').locator('tr', { hasText: team })), `${team} on a page of Teams`).toBe(true)
        await settled(() => badge(page, team), String(inTeam.length), `${team} member count`)
        await page.locator('button', { has: page.locator('span', { hasText: new RegExp(`^${team}$`) }) }).first().click()
        await settled(() => membersWindow(page, team), {
          count: String(inTeam.length),
          rows: inTeam.map((u) => [u.name, u.email ?? '-', u.role?.name ?? '-']),
        }, `${team} members`)
      })

      await test.step('Roles: the user count and every user with the role', async () => {
        await page.goto(ROLES.path)
        expect(await turnToRow(page, 'roles-pager', page.getByTestId('roles-table').locator('tr', { hasText: roleName })), `${roleName} on a page of Roles`).toBe(true)
        await settled(() => badge(page, roleName), String(withRole.length), `${roleName} user count`)
        await page.locator('button', { has: page.locator('span', { hasText: new RegExp(`^${roleName}$`) }) }).first().click()
        await settled(() => membersWindow(page, roleName), {
          count: String(withRole.length),
          rows: withRole.map((u) => [u.name, u.email ?? '-', u.team ?? '-']),
        }, `${roleName} users`)
      })

      await test.step('Users: the search over every user, page by page', async () => {
        const mine = users.filter((u) => [u.name, u.email, u.team].some((v) => (v ?? '').toLowerCase().includes(`${PREFIX}${run}`)))
        await page.goto(USERS.path)
        const search = page.getByTestId('admin-users-search')
        await search.waitFor()
        await search.fill(`${PREFIX}${run}`)
        const pager = page.getByTestId('admin-users-pager')
        await expect.poll(() => pager.innerText(), { timeout: 20_000, message: 'Users pager counts the search' }).toContain(`of ${mine.length}`)
        // as many rows as fit the screen, the same on every page
        const USERS_PAGE = await rowsOfFirstPage(pager)
        expect(USERS_PAGE, 'rows of a Users page').toBeGreaterThan(0)
        const range = (p: number) => EN.common.paginationRange
          .replace('{{start}}', String((p - 1) * USERS_PAGE + 1)).replace('{{end}}', String(Math.min(p * USERS_PAGE, mine.length))).replace('{{total}}', String(mine.length))
        const read = () => page.evaluate(() => {
          const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
          const pagerEl = document.querySelector('[data-testid="admin-users-pager"]')
          return {
            // the range beside the rows-per-page choice
            range: pagerEl ? (txt(pagerEl).match(/Showing \d+-\d+ of \d+/) ?? [null])[0] : null,
            emails: [...document.querySelectorAll('[data-testid^="user-detail-"]')].map((b) => (b.getAttribute('data-testid') ?? '').slice('user-detail-'.length)),
          }
        })
        const pages = Math.ceil(mine.length / USERS_PAGE)
        const want = Array.from({ length: pages }, (_, i) => ({ range: range(i + 1), emails: mine.slice(i * USERS_PAGE, (i + 1) * USERS_PAGE).map((u) => u.email ?? u.id) }))
        const got: Obj[] = []
        await settled(async () => (await read()).range, want[0].range, 'Users pager, first page')
        for (let p = 1; p <= pages + 1; p++) {
          got.push(await read())
          const next = pager.getByRole('button', { name: EN.common.next })
          if (await next.isDisabled()) break
          const before = got[got.length - 1].range
          await next.click()
          await expect.poll(async () => (await read()).range).not.toBe(before)
        }
        expect.soft(got, 'Users pages').toEqual(want)
      })

      await test.step('Cluster access: the users it offers are every user without a grant on the cluster', async () => {
        const grants = (await (await request.get('/api/v1/auth/admin/clusters/self/user-roles', { headers: bearer(token) })).json()) as { user_id: string }[]
        const granted = new Set(grants.map((g) => g.user_id))
        const offered = users.filter((u) => !granted.has(u.id)).map((u) => u.id)
        await page.goto('/admin/clusters')
        await page.getByTestId('access-cluster-self').click()
        await page.getByTestId('cluster-access-list').waitFor()
        const read = async () => {
          if ((await page.locator('[data-testid^="cluster-access-add-user-opt-"]').count()) === 0) await page.getByTestId('cluster-access-add-user').click()
          return page.locator('[data-testid^="cluster-access-add-user-opt-"]').evaluateAll((els) =>
            els.map((e) => (e.getAttribute('data-testid') ?? '').slice('cluster-access-add-user-opt-'.length)))
        }
        await settled(read, offered, 'users Cluster access offers')
      })
    } finally {
      await cleanup(request, token)
    }
  })
})
