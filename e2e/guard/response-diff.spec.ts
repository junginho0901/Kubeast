import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

import { compileRules, routeOf, sortCells, type Answer, type Difference, type IgnoreRule } from './response-compare'
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, BASE, CLUSTER, DRAWER, DRAWER_KINDS, DRAWERS, NS_A, PW, ROLES, SIDEBAR,
  applyFixtures, bearer, drawerTargets, kubectl, login, loginUI, openCluster, quiet, removeFixtures, roleTable, track,
  type Role,
} from './shared'

// Safety net (a), the response comparison: the build under test against the build it replaces. Each user opens every
// sidebar screen, /account and a drawer of every kind on the new build; every GET the screens sent and the first answer
// of every live subscription they made are then asked of the old build, the new build and the old build again, one
// right after the other. Cells where the old build disagrees with itself are noise; where it agrees and the new build
// differs, also when asked again a minute later, is a real difference, which fails unless response-diff-ignore.json
// names it with a reason and a PR.
// Writes, AI answers, terminals and followed logs are left to the tests that act on them (e2e/actions, the AI specs,
// pod-exec, logs): a replay is only safe for reads, and a model answers differently each time.
// Needs scripts/before-stack.sh up <tag> and E2E_BEFORE_URL; E2E_DIFF_OUT keeps the table and the cells in a directory.

const BEFORE = (process.env.E2E_BEFORE_URL || '').replace(/\/$/, '')
const OUT = process.env.E2E_DIFF_OUT || ''
const RULES = (JSON.parse(fs.readFileSync(path.join(__dirname, 'response-diff-ignore.json'), 'utf8')) as { rules: IgnoreRule[] }).rules
const ignored = compileRules(RULES)
// The other clusters hold what self has none of: the alert store, tracing and the Gateway API, as the global admin.
const OTHER_CLUSTERS = ['default', 'test2']
const PAGES_AT_ONCE = 3
const SOCKET_BATCH = 40
const SECOND_LOOK_MS = 65_000
const STREAM = /event-stream|ndjson/
const FOLLOW = /[?&]follow=(true|1)\b/
const KEPT_HEADERS = ['content-type', 'x-kubeast-total', 'x-kubeast-access']

type Job = { screen: string; url: string; drawer: boolean }
type Sub = { clusterId: string; path: string; query: string }
type Seen = { gets: Map<string, Set<string>>; subs: Map<string, Sub & { screens: Set<string> }>; streams: Set<string>; failed: string[] }
type Row = {
  user: string; request: string; route: string; screens: string[]; status: (number | string)[]; cells: number
  real: Difference[]; known: (Difference & { why: string; pr: string })[]; noise: string[]
}

test.use({ trace: 'off', screenshot: 'off' }) // the table and the cells are this net's record; a trace of the whole walk takes minutes to save

const screenUrl = (p: string, cluster: string, extra = '') => `${p}${p.includes('?') ? '&' : '?'}cluster=${cluster}${extra}`

function jobsFor(role: Role, node: string): Job[] {
  const jobs: Job[] = []
  for (const p of [...new Set(SIDEBAR)]) {
    jobs.push({ screen: p, url: screenUrl(p, CLUSTER), drawer: false })
    jobs.push({ screen: `${p} (one namespace)`, url: screenUrl(p, CLUSTER, `&namespace=${NS_A}`), drawer: false })
  }
  jobs.push({ screen: '/account', url: screenUrl('/account', CLUSTER), drawer: false })
  for (const [kind, d] of Object.entries(DRAWERS)) {
    if ('skip' in d) continue
    for (const t of drawerTargets(kind, d, role, node)) {
      const api = t.api ? `&detailApi=${encodeURIComponent(t.api)}` : ''
      jobs.push({ screen: `drawer ${kind} (${t.view})`, url: `/account?cluster=${CLUSTER}&detail=${encodeURIComponent(t.ref)}${api}`, drawer: true })
    }
  }
  return jobs
}

function jobsForGlobalAdmin(): Job[] {
  const jobs: Job[] = []
  for (const cluster of [CLUSTER, ...OTHER_CLUSTERS]) {
    for (const p of [...new Set(SIDEBAR), '/account']) jobs.push({ screen: `${p} on ${cluster}`, url: screenUrl(p, cluster), drawer: false })
  }
  return jobs
}

// One screen in a page of its own, so nothing polls from the one before: what it asked and subscribed to while opening,
// and for a drawer what its YAML tab asked too.
async function visit(page: Page, job: Job, seen: Seen): Promise<void> {
  const t = track(page)
  page.on('response', (r) => {
    const u = new URL(r.url())
    const q = r.request()
    if (!u.pathname.startsWith('/api/') || q.method() !== 'GET') return
    // the revision a poll sends back belongs to the build that gave it; asking without one is the page's first read
    u.searchParams.delete('revision')
    const key = u.pathname + u.search
    if (FOLLOW.test(u.search) || STREAM.test(r.headers()['content-type'] ?? '')) {
      seen.streams.add(routeOf(key))
      return
    }
    if (!seen.gets.has(key)) seen.gets.set(key, new Set())
    seen.gets.get(key)!.add(job.screen)
  })
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      let m: { type?: string; clusterId?: string; path?: string; query?: string }
      try {
        m = JSON.parse(typeof f.payload === 'string' ? f.payload : f.payload.toString())
      } catch {
        return
      }
      if (m.type !== 'REQUEST' || !m.path) return
      const key = `${m.clusterId ?? ''} ${m.path}?${m.query ?? ''}`
      if (!seen.subs.has(key)) seen.subs.set(key, { clusterId: m.clusterId ?? '', path: m.path, query: m.query ?? '', screens: new Set() })
      seen.subs.get(key)!.screens.add(job.screen)
    })
  })
  await page.goto(job.url)
  await quiet(page, t, 500)
  if (!job.drawer) return
  const drawer = page.locator(DRAWER).last()
  await expect(drawer).toBeVisible({ timeout: 20_000 })
  await quiet(page, t, 500)
  const yaml = drawer.getByRole('button', { name: 'YAML', exact: true })
  if (await yaml.count()) {
    await yaml.first().click()
    await quiet(page, t, 500)
  }
}

async function collect(browser: Browser, jobs: Job[], open: (page: Page) => Promise<void>, state: string | undefined): Promise<Seen> {
  const seen: Seen = { gets: new Map(), subs: new Map(), streams: new Set(), failed: [] }
  const ctx = await browser.newContext({ baseURL: BASE, storageState: state ?? { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  try {
    const first = await ctx.newPage()
    await open(first)
    await first.close()
    let next = 0
    await Promise.all(Array.from({ length: PAGES_AT_ONCE }, async () => {
      for (;;) {
        const job = jobs[next++]
        if (!job) return
        const page = await ctx.newPage()
        try {
          await visit(page, job, seen)
        } catch (e) {
          seen.failed.push(`${job.screen}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 200)}`)
        } finally {
          await page.close()
        }
      }
    }))
    return seen
  } finally {
    await ctx.close()
  }
}

// One answer. A refusal for asking too often (the alert store's per-minute limit) waits and asks again: it says how
// often the runner asks, not what the build answers.
async function ask(base: string, key: string, token: string): Promise<Answer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(base + key, { headers: bearer(token), redirect: 'manual', signal: AbortSignal.timeout(60_000) })
      const text = await res.text()
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after')) || 20, 65) * 1000))
        continue
      }
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch { /* an answer that is not JSON is one cell */ }
      const headers: Record<string, string> = {}
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h)
        if (v) headers[h] = h === 'x-kubeast-access' ? Buffer.from(v, 'base64url').toString('utf8') : v
      }
      return { status: res.status, headers, body }
    } catch (e) {
      return { status: e instanceof Error ? e.name : 'error', body: null }
    }
  }
}

// The first answer of some subscriptions on one socket: what each sends until the socket has been quiet for a second.
async function firstAnswers(page: Page, base: string, cluster: string, subs: Sub[]): Promise<Record<string, Answer>> {
  const url = `${base.replace(/^http/, 'ws')}/api/v1/cluster/wsMultiplexer${cluster ? `?cluster=${encodeURIComponent(cluster)}` : ''}`
  const got = await page.evaluate(({ url, subs }) => new Promise<Record<string, { items: unknown[]; error: string | null }> | string>((resolve) => {
    const out: Record<string, { items: unknown[]; error: string | null }> = {}
    const started = Date.now()
    let last = started
    const ws = new WebSocket(url)
    for (const s of subs) out[`${s.path}?${s.query}`] = { items: [], error: null }
    ws.onopen = () => {
      last = Date.now()
      for (const s of subs) ws.send(JSON.stringify({ type: 'REQUEST', clusterId: s.clusterId, path: s.path, query: s.query }))
    }
    ws.onmessage = (e) => {
      last = Date.now()
      const m = JSON.parse(e.data as string) as { type: string; path: string; query: string; data?: { type?: string; object?: object }; error?: { message?: string } }
      const row = out[`${m.path}?${m.query}`]
      if (!row) return
      if (m.type === 'DATA') row.items.push({ ...(m.data?.object ?? {}), watchEvent: m.data?.type })
      else if (m.type === 'ERROR') row.error = m.error?.message ?? 'error'
    }
    ws.onerror = () => { clearInterval(tick); resolve('the socket failed') }
    const tick = setInterval(() => {
      if (Date.now() - last > 1_000 || Date.now() - started > 15_000) {
        clearInterval(tick)
        ws.close()
        resolve(out)
      }
    }, 100)
  }), { url, subs })
  const answers: Record<string, Answer> = {}
  for (const s of subs) {
    const key = `${s.path}?${s.query}`
    answers[key] = typeof got === 'string' ? { status: got, body: null } : { status: 'live', body: got[key] }
  }
  return answers
}

function rowOf(user: string, request: string, route: string, screens: Set<string>, a: Answer, n: Answer, b: Answer): Row {
  const sorted = sortCells(a, n, b)
  const real: Difference[] = []
  const known: Row['known'] = []
  for (const d of sorted.real) {
    const rule = ignored(route, d.cell)
    if (rule) known.push({ ...d, why: rule.why, pr: rule.pr })
    else real.push(d)
  }
  return { user, request, route, screens: [...screens].slice(0, 5), status: [a.status, n.status, b.status], cells: sorted.cells, real, known, noise: sorted.noise }
}

type Pages = { old: Page; fresh: Page }
const liveKey = (s: Sub) => `live ${s.clusterId} ${s.path}?${s.query}`

async function compareOnce(user: string, gets: [string, Set<string>][], subs: (Sub & { screens: Set<string> })[], token: string, pages: Pages): Promise<Row[]> {
  const rows: Row[] = []
  for (const [key, screens] of gets) {
    const a = await ask(BEFORE, key, token)
    const n = await ask(BASE, key, token)
    const b = await ask(BEFORE, key, token)
    rows.push(rowOf(user, key, routeOf(key), screens, a, n, b))
  }
  const byCluster = new Map<string, (Sub & { screens: Set<string> })[]>()
  for (const s of subs) byCluster.set(s.clusterId, [...(byCluster.get(s.clusterId) ?? []), s])
  for (const [cluster, list] of byCluster) {
    for (let i = 0; i < list.length; i += SOCKET_BATCH) {
      const batch = list.slice(i, i + SOCKET_BATCH)
      const a = await firstAnswers(pages.old, BEFORE, cluster, batch)
      const n = await firstAnswers(pages.fresh, BASE, cluster, batch)
      const b = await firstAnswers(pages.old, BEFORE, cluster, batch)
      for (const s of batch) {
        const key = `${s.path}?${s.query}`
        rows.push(rowOf(user, liveKey(s), `live ${s.path}`, s.screens, a[key], n[key], b[key]))
      }
    }
  }
  return rows
}

// Each build keeps a minute of some answers: one filled while the screens opened and one filled now can differ for that
// reason alone. A cell counts only if it still differs once those have expired, all three asked within a moment.
async function compareAll(user: string, seen: Seen, token: string, pages: Pages): Promise<Row[]> {
  const gets = [...seen.gets.entries()]
  const subs = [...seen.subs.values()]
  const first = await compareOnce(user, gets, subs, token, pages)
  const doubtful = new Map(first.filter((r) => r.real.length > 0 || r.known.length > 0).map((r) => [r.request, r]))
  if (doubtful.size === 0) return first
  await new Promise((r) => setTimeout(r, SECOND_LOOK_MS))
  const again = await compareOnce(user, gets.filter(([k]) => doubtful.has(k)), subs.filter((s) => doubtful.has(liveKey(s))), token, pages)
  const second = new Map(again.map((r) => [r.request, r]))
  return first.map((r) => {
    const later = second.get(r.request)
    if (!later) return r
    const stayed = (d: Difference) => later.real.some((x) => x.cell === d.cell) || later.known.some((x) => x.cell === d.cell)
    const gone = [...r.real, ...r.known].filter((d) => !stayed(d)).map((d) => d.cell)
    return { ...r, real: r.real.filter(stayed), known: r.known.filter(stayed), noise: [...r.noise, ...gone] }
  })
}

// The table: per route, how many requests, how many real and known differences and how much noise, with an example.
function table(rows: Row[], streams: string[], failed: string[]): string {
  const routes = new Map<string, Row[]>()
  for (const r of rows) routes.set(r.route, [...(routes.get(r.route) ?? []), r])
  const lines = [
    `requests ${rows.length} · real ${rows.reduce((n, r) => n + r.real.length, 0)} · known ${rows.reduce((n, r) => n + r.known.length, 0)} · noise ${rows.reduce((n, r) => n + r.noise.length, 0)} · cells ${rows.reduce((n, r) => n + r.cells, 0)}`,
    '', '| route | requests | real | known | noise | example |', '|---|---|---|---|---|---|',
  ]
  const sortedRoutes = [...routes.entries()].sort(([, a], [, b]) => b.reduce((n, r) => n + r.real.length, 0) - a.reduce((n, r) => n + r.real.length, 0))
  for (const [route, rs] of sortedRoutes) {
    const example = rs.flatMap((r) => r.real)[0]
    const text = example ? `\`${example.cell}\` ${example.kind}: ${example.old ?? '-'} → ${example.new ?? '-'}` : ''
    lines.push(`| ${route} | ${rs.length} | ${rs.reduce((n, r) => n + r.real.length, 0)} | ${rs.reduce((n, r) => n + r.known.length, 0)} | ${rs.reduce((n, r) => n + r.noise.length, 0)} | ${text.slice(0, 160).replace(/\|/g, '\\|')} |`)
  }
  lines.push('', `Streams left out: ${streams.join(', ') || 'none'}`, `Steps that did not run: ${failed.join(' · ') || 'none'}`)
  return lines.join('\n')
}

let ready = ''
let node = ''

test('the table has a drawer for every kind the code lists', () => {
  expect(DRAWER_KINDS.filter((k) => !(k in DRAWERS)), 'drawer kinds the table lacks').toEqual([])
})

test.describe('response comparison — the new build answers as the old one, but for what a PR says', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    if (!BEFORE || BEFORE === BASE) {
      ready = 'E2E_BEFORE_URL names no other build (scripts/before-stack.sh up <tag>)'
      return
    }
    ready = openCluster()
    if (ready !== '') return
    ;({ node } = await applyFixtures())
  })

  test.afterAll(() => removeFixtures(node))

  test('every GET and first live answer of every screen and drawer, as each user', async ({ browser, request }: { browser: Browser; request: APIRequestContext }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(3_600_000)
    const rows: Row[] = []
    const streams = new Set<string>()
    const failed: string[] = []
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const member = (await roleTable(request, admin)).find((r) => r.name.toLowerCase() === 'member')
    expect(member, 'the Member role').toBeTruthy()

    const compareUser = async (user: string, jobs: Job[], tokenOf: () => Promise<string>, open: (page: Page) => Promise<void>, state?: string) => {
      const seen = await collect(browser, jobs, open, state)
      failed.push(...seen.failed.map((f) => `${user} ${f}`))
      for (const s of seen.streams) streams.add(s)
      const ctx = await browser.newContext({ baseURL: BASE, storageState: state ?? { cookies: [], origins: [] }, locale: 'en-US' })
      try {
        const fresh = await ctx.newPage()
        await open(fresh)
        // A socket is opened from a page of its own origin (the console's connect-src is 'self'); the sign-in cookie is the host's, whatever the port.
        await fresh.goto(`${BASE}/api/v1/auth/jwks.json`)
        const old = await ctx.newPage()
        await old.goto(`${BEFORE}/api/v1/auth/jwks.json`)
        rows.push(...await compareAll(user, seen, await tokenOf(), { old, fresh }))
      } finally {
        await ctx.close()
      }
      console.log(`${user}: GET ${seen.gets.size} · live ${seen.subs.size} · streams ${seen.streams.size} · not run ${seen.failed.length} (${new Date().toISOString()})`)
    }

    for (const role of ROLES) {
      const email = `e2e-guard-${Date.now().toString(36)}-${role.key}@kubeast.local`
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E guard ${role.key}`, email, password: PW, role_id: member!.id } })
      expect(created.status(), `create ${email}`).toBe(201)
      const userId = (await created.json()).id as string
      try {
        const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: role.grant, ...(role.scoped ? { namespaces: [NS_A] } : {}) } })
        expect(grant.status(), await grant.text()).toBe(200)
        await compareUser(role.key, jobsFor(role, node), () => login(request, email, PW), (page) => loginUI(page, email))
      } finally {
        await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      }
    }
    await compareUser('global-admin', jobsForGlobalAdmin(), () => login(request, ADMIN_EMAIL, ADMIN_PASSWORD), async (page) => { await page.goto('/account') }, path.join(__dirname, '..', '.auth', 'user.json'))

    const images = kubectl(['-n', 'kubeast', 'get', 'deployment', '-o', 'custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'], undefined, true)
    const report = table(rows, [...streams].sort(), failed)
    await test.info().attach('response-diff.md', { body: report, contentType: 'text/markdown' })
    await test.info().attach('response-diff.json', { body: JSON.stringify({ images, rows }, null, 1), contentType: 'application/json' })
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true })
      fs.writeFileSync(path.join(OUT, 'response-diff.md'), report)
      fs.writeFileSync(path.join(OUT, 'response-diff.json'), JSON.stringify({ images, rows }, null, 1))
    }
    console.log(report.split('\n')[0])

    // A comparison of nothing passes nothing: most answers must have been answers, from both builds.
    const fine = rows.filter((r) => r.status[1] === 200 || r.status[1] === 'live').length
    expect(rows.length, 'requests compared').toBeGreaterThan(200)
    expect(fine / rows.length, 'share of requests the new build answered').toBeGreaterThan(0.5)
    expect(failed, 'screens and drawers that did not open').toEqual([])
    const unexplained = rows.flatMap((r) => r.real.map((d) => `${r.user} ${r.request} ${d.cell} ${d.kind}: ${d.old} → ${d.new}`.slice(0, 300)))
    expect(unexplained.slice(0, 200), `${unexplained.length} real differences; a known one goes in response-diff-ignore.json with a reason and a PR`).toEqual([])
  })
})
