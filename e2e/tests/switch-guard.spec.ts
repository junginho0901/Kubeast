import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test'

import { sidebarScreens } from './sidebar-screens'
import { afterSwitch, arm, disarm, holdAnswers, installSampler, pageNow, recording, rowNames, tellable, type Recording, type Watch } from './switch-guard'

// After a condition changes — the cluster, a namespace, a tab, a filter or a search, the object a drawer or window
// shows, the person signed in — no frame shows the condition before as the current one's. Each case opens condition A,
// works out what only A has (A's rows less the rows of B's answer), holds B's answer back, switches to B and watches
// for 1.5 s with the sampler of switch-guard.ts (every painted frame and every DOM state), then lets the answer go and
// waits for B's rows: from the frame that shows B on, none may hold a row, card, notice or word that only A has, and the
// screen may not go back to A (a loading line is fine). Cases: a cluster switch on every sidebar screen with rows or
// cards; a namespace switch on Deployments, Pods and Helm releases (Helm also no row before its list answers); the Alerts
// tabs and search and an alert window reached with the browser's Back; AI Usage's grouping; the Dashboard Pods window
// from one phase to another and to every pod; the Optimization window's namespace after an AI answer; the YAML of a
// custom resource of another CRD with the same name; a forced read of A answered after the switch; a read of A refused
// (403) or failed (500) after the switch; and the live connection and an AI Chat and a floating chat answer on their
// way across a sign-out and the next sign-in in one tab. Answers are stood in where dev has no fixed data (the inbox,
// AI usage, the Pods window, the AI streams); the cluster keeps nothing: two CRDs of the run, a throwaway Read account
// and the two chat conversations are removed after.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const WINDOW_MS = 1_500
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const run = Date.now().toString(36)
const soft = expect.configure({ soft: true })
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exactly = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`)

// what the run leaves to remove
const made = { crds: [] as string[], users: [] as string[], sessions: [] as string[] }

// kubectl on the kind cluster of `self`, read when a test first needs it
let kubeconfig = ''
function kubectl(args: string[], input?: string): string {
  if (!kubeconfig) {
    kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-switch-guard-')), 'kubeconfig')
    fs.writeFileSync(kubeconfig, execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8' }), { mode: 0o600 })
  }
  return execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function bearer(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.status(), `login ${ADMIN_EMAIL}`).toBe(200)
  return { Authorization: `Bearer ${(await res.json()).access_token}`, ...XRW }
}

// The page's reads under /api/v1/: the ones in flight (XHR) and the GETs that answered 200, with when.
function network(page: Page) {
  const open = new Set<Request>()
  let changed = Date.now()
  const reads: { url: string; at: number }[] = []
  const counts = (r: Request) => r.resourceType() === 'xhr' && r.url().includes('/api/v1/')
  page.on('request', (r) => {
    if (!counts(r)) return
    open.add(r)
    changed = Date.now()
  })
  const done = (r: Request) => {
    if (open.delete(r)) changed = Date.now()
  }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  page.on('response', (r) => {
    if (counts(r.request()) && r.request().method() === 'GET' && r.status() === 200) reads.push({ url: r.url(), at: Date.now() })
  })
  return {
    reads,
    // no read in flight for `ms`, at most `max`
    async quiet(ms = 400, max = 8_000) {
      const start = Date.now()
      while (Date.now() - start < max) {
        if (open.size === 0 && Date.now() - changed >= ms) return true
        await page.waitForTimeout(100)
      }
      return false
    },
  }
}

// a read of the cluster's data, not of who is signed in or of the registry
const clusterRead = (u: URL) => u.pathname.startsWith('/api/v1/') && !u.pathname.startsWith('/api/v1/auth/') && u.pathname !== '/api/v1/clusters'

// The answers of the same reads on another cluster, as one text.
async function answersOn(page: Page, urls: string[], cluster: string): Promise<string> {
  const unique = [...new Set(urls.map((u) => {
    const x = new URL(u)
    x.searchParams.set('cluster', cluster)
    return `${x.pathname}${x.search}`
  }))]
  const bodies = await Promise.all(unique.map(async (u) => {
    try {
      const r = await page.request.get(u, { headers: XRW, timeout: 15_000, failOnStatusCode: false })
      return r.ok() ? await r.text() : ''
    } catch {
      return ''
    }
  }))
  return bodies.join('\n')
}

const cardValues = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="stat-value"]')].map((el) => [el.getAttribute('data-testid') ?? '', (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()])))

// The screen once the new condition's answers came: a row its answers name, rows holding none of the old names (its
// own, read again since), its empty line, or no table at all.
async function showsNew(page: Page, theirs: string, old: string[], rows = 'main tbody tr'): Promise<boolean> {
  try {
    await expect.poll(async () => {
      const names = await rowNames(page, rows)
      if (names.length) return names.some((n) => theirs.includes(n)) || !names.some((n) => old.some((k) => n.includes(k)))
      return page.evaluate(({ rows, loading }) => {
        const table = document.querySelector(rows)?.closest('table') ?? document.querySelector('main table')
        if (!table) return true
        const line = [...table.querySelectorAll('tbody td[colspan]')].map((td) => (td as HTMLElement).innerText.trim()).find(Boolean)
        return !!line && !line.includes(loading)
      }, { rows, loading: EN.common.loading })
    }, { timeout: 15_000 }).toBe(true)
    return true
  } catch {
    return false
  }
}

async function pickCluster(page: Page, id: string) {
  await page.getByTestId('cluster-picker').click({ timeout: 10_000 })
  await page.getByTestId(`cluster-option-${id}`).click({ timeout: 10_000 })
}

// A sidebar screen opened in the page (a link press, no load), else by address.
async function openScreen(page: Page, screen: string, cluster: string) {
  const link = page.getByTestId('sidebar-nav').locator(`a[href="${screen}"]`).first()
  if (await link.count()) {
    await link.dispatchEvent('click')
    // the link is marked in the commit that draws the new page (a lazy page holds the old one until it loads)
    await expect(link).toHaveAttribute('aria-current', 'page', { timeout: 10_000 }).catch(() => undefined)
  } else {
    await page.goto(`${screen}${screen.includes('?') ? '&' : '?'}cluster=${cluster}`)
  }
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 15_000 })
}

// The trigger of a namespace dropdown showing `shown`, marked for the sampler, and how to pick another namespace in it.
async function namespaceControl(page: Page, shown: string): Promise<{ pick: (ns: string) => Promise<void> }> {
  const helm = page.getByTestId('helm-namespace')
  const trigger: Locator = (await helm.count())
    ? helm
    : page.locator('main div.relative > button:has(svg.lucide-chevron-down)').filter({ hasText: exactly(shown) }).first()
  await expect(trigger, `the namespace picker shows ${shown}`).toHaveText(exactly(shown), { timeout: 15_000 })
  await trigger.evaluate((el) => el.setAttribute('data-sg-probe', 'ns'))
  return {
    pick: async (ns) => {
      await trigger.click()
      const option = (await helm.count())
        ? page.getByTestId(`helm-namespace-opt-${ns}`)
        : trigger.locator('xpath=..').locator('div.absolute.top-full button').filter({ hasText: exactly(ns) }).first()
      await option.click({ timeout: 10_000 })
    },
  }
}

// Watches one switch: arm, act, 1.5 s with B's answer held, let it go, wait for B's screen, read every frame.
async function watchSwitch(page: Page, o: {
  hold: ReturnType<typeof holdAnswers>
  arming?: Parameters<typeof arm>[1]
  act: () => Promise<void>
  shown: () => Promise<boolean>
  watch: (releasedAt: number) => Watch
  // the read held is the new condition's: say so when the screen never asked it
  expectHeld?: boolean
}): Promise<{ problems: string[]; rec: Recording }> {
  await o.hold.ready
  await arm(page, o.arming)
  await o.act()
  await page.waitForTimeout(WINDOW_MS)
  const held = o.hold.held()
  const releasedAt = await pageNow(page)
  await o.hold.release()
  const shown = await o.shown()
  const rec = await recording(page)
  await disarm(page)
  const watch = o.watch(releasedAt)
  const problems = afterSwitch(rec, watch)
  if (o.expectHeld !== false && held === 0) problems.push(`${watch.what}: the screen asked no read of the new condition in ${WINDOW_MS} ms`)
  if (!shown) problems.push(`${watch.what}: the new condition's screen did not show after its answer came`)
  return { problems, rec }
}

test.describe('switch guard: nothing of the condition before after a switch', () => {
  test.afterAll(async ({ request }) => {
    if (made.crds.length) kubectl(['delete', 'crd', ...made.crds, '--ignore-not-found', '--wait=true', '--timeout=120s'])
    if (made.users.length || made.sessions.length) {
      const admin = await bearer(request)
      for (const id of made.sessions) await request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: admin, failOnStatusCode: false })
      for (const id of made.users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a cluster switch on every sidebar screen with rows or cards shows none of the cluster before', async ({ page }, testInfo) => {
    test.setTimeout(600_000)
    await installSampler(page)
    const net = network(page)
    const screens = await sidebarScreens(page)
    const clusters = ((await (await page.request.get('/api/v1/clusters', { headers: XRW })).json()).items ?? []) as { id: string; display_name?: string }[]
    const named = Object.fromEntries(clusters.map((c) => [c.id, c.display_name || c.id]))
    expect(Object.keys(named), 'the dev registry holds self and default').toEqual(expect.arrayContaining(['self', 'default']))

    let [from, to] = ['self', 'default']
    const checked: string[] = []
    const notes: string[] = []
    const problems: string[] = []
    for (const screen of screens) {
      const started = Date.now()
      await openScreen(page, screen, from)
      await net.quiet()
      const names = (await rowNames(page)).filter(tellable)
      const cards = await cardValues(page)
      if (!names.length && !Object.keys(cards).length) {
        notes.push(`${screen} on ${from}: no rows or cards`)
        continue
      }
      // every read the screen made, those of who is signed in too: a row they answer is the same on the other cluster
      const urls = net.reads.filter((r) => r.at >= started && new URL(r.url).searchParams.get('cluster') === from).map((r) => r.url)
      const theirs = await answersOn(page, urls, to)
      let mine = [...new Set(names.filter((n) => !theirs.includes(n)))]
      if (!mine.length && !Object.keys(cards).length) {
        notes.push(`${screen} on ${from}: every row is in ${to}'s answers too`)
        continue
      }
      const what = `${screen} ${from} → ${to}`
      const target = to
      const hold = holdAnswers(page, (u, r) => r.method() === 'GET' && u.searchParams.get('cluster') === target && clusterRead(u))
      await hold.ready
      await arm(page)
      await pickCluster(page, to)
      await page.waitForTimeout(WINDOW_MS)
      const held = hold.held()
      await hold.release()
      const shown = await showsNew(page, theirs, mine)
      await net.quiet()
      const after = await cardValues(page)
      const rec = await recording(page)
      await disarm(page)
      // a name still there once the new cluster's answers came may be one its answers did not carry (a row of the
      // screen's own, a read outside /api/v1 GETs): open the screen on the new cluster afresh and leave out what it shows
      const still = mine.filter((k) => rec.frames.at(-1)?.rows.some((row) => row.includes(k)))
      if (still.length) {
        await page.goto(`${screen}${screen.includes('?') ? '&' : '?'}cluster=${to}`)
        await expect(page.locator('main h1').first()).toBeVisible({ timeout: 15_000 })
        await net.quiet()
        const fresh = await rowNames(page, 'main tbody tr', 50)
        const theirsToo = still.filter((k) => fresh.some((row) => row.includes(k)))
        if (theirsToo.length) notes.push(`${what}: ${theirsToo.join(', ')} are ${to}'s too (not in its GET answers)`)
        mine = mine.filter((k) => !theirsToo.includes(k))
      }
      const oldCards = Object.fromEntries(Object.entries(cards).filter(([id, v]) => after[id] !== v))
      problems.push(...afterSwitch(rec, { what, switched: (f) => f.cluster.startsWith(named[target]), oldRows: mine, oldCards }))
      if (held === 0) problems.push(`${what}: the screen asked no read of ${to} in ${WINDOW_MS} ms`)
      if (!shown) problems.push(`${what}: ${to}'s rows did not show after its answers came`)
      checked.push(`${what}: ${mine.length} rows and ${Object.keys(oldCards).length} cards only ${from} has`)
      ;[from, to] = [to, from]
    }
    await testInfo.attach('cluster-switch-screens.json', { body: JSON.stringify({ checked, notes }, null, 2), contentType: 'application/json' })
    expect(checked.length, `screens with something only one cluster has (${notes.length} without: see the attachment)`).toBeGreaterThanOrEqual(15)
    expect(problems, 'frames that showed the cluster before after the picker showed the new one').toEqual([])
  })

  test('a namespace switch on Deployments, Pods and Helm releases shows no row of the namespace before', async ({ page }) => {
    test.setTimeout(120_000)
    await installSampler(page)
    const net = network(page)
    const cases = [
      { screen: '/workloads/deployments', from: 'kubeast', to: 'kube-system', read: (ns: string) => `/api/v1/cluster/namespaces/${ns}/deployments?cluster=self`, isRead: (u: URL, ns: string) => u.pathname === `/api/v1/cluster/namespaces/${ns}/deployments` },
      { screen: '/workloads/pods', from: 'kubeast', to: 'kube-system', read: (ns: string) => `/api/v1/cluster/pods/page?namespace=${ns}&offset=0&limit=500&cluster=self`, isRead: (u: URL, ns: string) => u.pathname === '/api/v1/cluster/pods/page' && u.searchParams.get('namespace') === ns },
      // Helm's watch may not draw rows of the new namespace before its list answers either
      { screen: '/helm/releases', from: '', to: 'kube-system', read: (ns: string) => `/api/v1/helm/releases?namespace=${ns}&cluster=self`, isRead: (u: URL, ns: string) => u.pathname === '/api/v1/helm/releases' && u.searchParams.get('namespace') === ns, earlyRows: true },
    ]
    const problems: string[] = []
    for (const c of cases) {
      await test.step(`${c.screen}: ${c.from || 'all'} → ${c.to}`, async () => {
        await page.goto(`${c.screen}?cluster=self${c.from ? `&namespace=${c.from}` : ''}`)
        await expect(page.locator('main tbody tr td:nth-child(2)').first(), `${c.screen} lists ${c.from || 'every namespace'}`).toBeVisible({ timeout: 20_000 })
        await net.quiet()
        const theirs = await (await page.request.get(c.read(c.to), { headers: XRW })).text()
        const mine = [...new Set((await rowNames(page)).filter(tellable).filter((n) => !theirs.includes(n)))]
        expect(mine.length, `${c.screen}: rows of ${c.from || 'every namespace'} that ${c.to} does not have`).toBeGreaterThan(0)
        const control = await namespaceControl(page, c.from || EN.helmReleases.allNamespaces)
        const { problems: found } = await watchSwitch(page, {
          hold: holdAnswers(page, (u) => c.isRead(u, c.to)),
          arming: { probes: { ns: '[data-sg-probe="ns"]' } },
          act: () => control.pick(c.to),
          shown: () => showsNew(page, theirs, mine),
          watch: (releasedAt) => ({ what: `${c.screen} ${c.from || 'all'} → ${c.to}`, switched: (f) => f.probes.ns === c.to, oldRows: mine, noRowsBefore: c.earlyRows ? releasedAt : undefined }),
        })
        problems.push(...found)
      })
    }
    expect(problems, 'frames that showed the namespace before after the picker showed the new one').toEqual([])
  })

  test('the Alerts inbox shows no row of the tab or search before, and an alert window none of the alert before', async ({ page }) => {
    test.setTimeout(120_000)
    await installSampler(page)
    const at = new Date(Date.now() - 10 * 60_000).toISOString()
    const item = (id: string, alertname: string, status: 'firing' | 'resolved') => ({
      id, cluster: 'self', fingerprint: `fp-${id}`, alertname, severity: 'info', namespace: 'default', labels: { alertname, severity: 'info' },
      summary: `switch guard ${alertname}`, status, starts_at: at, resolved_at: status === 'resolved' ? at : null, first_received_at: at,
      last_received_at: at, received_count: 1, acknowledged: false, acked_by: '', acked_at: null, assignee: '', done: false, done_by: '',
      done_at: null, investigation: null,
    })
    const firing = [1, 2, 3].map((i) => item(`sg-${run}-f${i}`, `SgFiring${i}${run}`, 'firing'))
    const [r1, r2] = [item(`sg-${run}-r1`, `SgResolvedOne${run}`, 'resolved'), item(`sg-${run}-r2`, `SgResolvedTwo${run}`, 'resolved')]
    const all = [...firing, r1, r2]
    await page.route((u) => u.pathname === '/api/v1/alerts/inbox', async (route) => {
      const u = new URL(route.request().url())
      const status = u.searchParams.get('status') ?? ''
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const items = all.filter((a) => (!status || a.status === status) && a.alertname.toLowerCase().includes(q))
      await route.fulfill({ json: { items, total: items.length, counts: { firing: 3, stale: 0, resolved: 2 }, stale_hours: 24, severities: ['info'] } })
    })
    await page.route((u) => u.pathname.startsWith('/api/v1/alerts/inbox/'), async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
      const one = all.find((a) => a.id === id)
      await route.fulfill(one
        ? { json: { ...one, annotations: { summary: one.summary }, generator_url: '', alertmanager_url: '', receiver: 'kubeast', note: '', note_by: '', note_at: null } }
        : { status: 404, json: { detail: 'not found' } })
    })
    const ROWS = '[data-testid="alert-inbox-table"] tbody tr'
    const inboxRows = () => page.locator(`${ROWS}[data-testid^="alert-row-"]`).evaluateAll((trs) => trs.map((tr) => (tr.getAttribute('data-testid') ?? '').slice('alert-row-'.length)))
    const problems: string[] = []

    await page.goto('/alerts?cluster=self')
    await expect(page.getByTestId('alert-tab-resolved'), 'the dev values turn the inbox on (features.alertInvestigation)').toHaveCount(1, { timeout: 20_000 })
    await expect.poll(inboxRows, { timeout: 15_000 }).toEqual(all.map((a) => a.id))

    await test.step('All → Resolved: no firing row while the Resolved answer is held', async () => {
      const { problems: found } = await watchSwitch(page, {
        hold: holdAnswers(page, (u) => u.pathname === '/api/v1/alerts/inbox' && u.searchParams.get('status') === 'resolved'),
        arming: { rows: ROWS, probes: { tab: { sel: '[data-testid^="alert-tab-"].bg-primary-600', attr: 'data-testid' } } },
        act: () => page.getByTestId('alert-tab-resolved').click(),
        shown: () => expect.poll(inboxRows, { timeout: 10_000 }).toEqual([r1.id, r2.id]).then(() => true, () => false),
        watch: () => ({ what: 'Alerts All → Resolved', switched: (f) => f.probes.tab === 'alert-tab-resolved', oldRows: firing.map((a) => a.alertname) }),
      })
      problems.push(...found)
    })

    await test.step('a search: no row the search leaves out while its answer is held', async () => {
      const { problems: found } = await watchSwitch(page, {
        hold: holdAnswers(page, (u) => u.pathname === '/api/v1/alerts/inbox' && u.searchParams.get('q') === r1.alertname),
        arming: { rows: ROWS },
        act: () => page.getByTestId('alert-inbox-search').fill(r1.alertname),
        shown: () => expect.poll(inboxRows, { timeout: 10_000 }).toEqual([r1.id]).then(() => true, () => false),
        // the box shows the words at once and the page asks after a pause: from the moment it asks
        watch: () => ({ what: 'Alerts search', askedFor: (u) => u.pathname === '/api/v1/alerts/inbox' && u.searchParams.get('q') === r1.alertname, oldRows: [r2.alertname] }),
      })
      problems.push(...found)
    })

    await test.step('Back to the window of another alert: none of the note written in the one before', async () => {
      await page.getByTestId(`alert-row-${r1.id}`).click()
      await expect(page.getByTestId('alert-detail').locator('h2').first()).toHaveText(r1.alertname, { timeout: 15_000 })
      // a page of its own in the history (the window replaces its address), then the other alert's window
      await page.getByTestId('sidebar-nav').locator('a[href="/alerts"]').first().dispatchEvent('click')
      await expect(page.getByTestId('alert-detail')).toHaveCount(0, { timeout: 10_000 })
      await page.getByTestId('alert-inbox-search').fill('')
      await expect.poll(inboxRows, { timeout: 10_000 }).toEqual([r1.id, r2.id])
      await page.getByTestId(`alert-row-${r2.id}`).click()
      await expect(page.getByTestId('alert-detail').locator('h2').first()).toHaveText(r2.alertname, { timeout: 15_000 })
      const note = `switch guard note for ${r2.alertname}`
      await page.getByTestId('alert-note').fill(note)
      await arm(page, { rows: '[data-sg-none]', probes: { title: '[data-testid="alert-detail"] h2', note: { sel: '[data-testid="alert-note"]', value: true } } })
      await page.goBack()
      await expect(page.getByTestId('alert-detail').locator('h2').first()).toHaveText(r1.alertname, { timeout: 15_000 })
      await page.waitForTimeout(WINDOW_MS)
      const rec = await recording(page)
      await disarm(page)
      problems.push(...afterSwitch(rec, { what: `Alert window ${r2.alertname} → ${r1.alertname}`, switched: (f) => f.probes.title === r1.alertname, oldProbes: { note } }))
      soft(await page.getByTestId('alert-note').inputValue(), `${r1.alertname}'s note field`).toBe('')
    })
    expect(problems, 'frames that showed the tab, search or alert before').toEqual([])
  })

  test('AI Usage grouped by another key shows no row or total of the grouping before', async ({ page }) => {
    test.setTimeout(60_000)
    await installSampler(page)
    const row = (key: string, requests: number) => ({
      source: 'chat', key, requests, failures: 0, prompt_tokens: 100 * requests, cached_tokens: null, prompt_chars: null,
      completion_tokens: 50 * requests, total_tokens: 150 * requests, token_requests: requests, tool_calls: 0, avg_duration_ms: 1200,
      last_at: new Date(Date.now() - 3_600_000).toISOString(),
    })
    const sums = (rows: ReturnType<typeof row>[]) => {
      const add = (k: 'requests' | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'token_requests') => rows.reduce((n, r) => n + r[k], 0)
      const chat = { groups: rows.length, rows: rows.length, requests: add('requests'), failures: 0, prompt_tokens: add('prompt_tokens'), completion_tokens: add('completion_tokens'), total_tokens: add('total_tokens'), token_requests: add('token_requests'), tool_calls: 0, truncated: false }
      const none = { groups: 0, rows: 0, requests: 0, failures: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, token_requests: 0, tool_calls: 0, truncated: false }
      return { chat, investigation: none, all: chat }
    }
    const byGroup: Record<string, ReturnType<typeof row>[]> = {
      user: [row(`sg-user-a-${run}@kubeast.local`, 11), row(`sg-user-b-${run}@kubeast.local`, 7)],
      model: [row(`sg-model-${run}`, 23)],
      cluster: [row('self', 23)],
    }
    await page.route((u) => u.pathname === '/api/v1/auth/admin/ai-usage', async (route) => {
      const u = new URL(route.request().url())
      const group = u.searchParams.get('group') ?? 'user'
      const rows = byGroup[group] ?? []
      await route.fulfill({ json: { since: u.searchParams.get('since'), until: u.searchParams.get('until'), group, rows, limit: null, truncated: false, totals: sums(rows) } })
    })
    await page.goto('/admin/ai-usage')
    const table = page.getByTestId('ai-usage-table')
    await expect(table.locator('tbody')).toContainText(byGroup.user[0].key, { timeout: 20_000 })
    const totals = (await page.locator('main .ml-auto.text-xs').first().innerText()).replace(/\s+/g, ' ').trim()
    const group = page.getByTestId('ai-usage-group')
    const { problems } = await watchSwitch(page, {
      hold: holdAnswers(page, (u) => u.pathname === '/api/v1/auth/admin/ai-usage' && u.searchParams.get('group') === 'model'),
      arming: { rows: '[data-testid="ai-usage-table"] tbody tr', probes: { group: '[data-testid="ai-usage-group"]', totals: 'main .ml-auto.text-xs' } },
      act: async () => {
        await group.click()
        await group.locator('xpath=..').getByRole('button', { name: EN.adminAIUsage.group.model, exact: true }).click()
      },
      shown: () => expect(table.locator('tbody')).toContainText(byGroup.model[0].key, { timeout: 10_000 }).then(() => true, () => false),
      watch: () => ({ what: 'AI Usage user → model', switched: (f) => f.probes.group.includes(EN.adminAIUsage.group.model), oldRows: byGroup.user.map((r) => r.key), oldProbes: { totals } }),
    })
    expect(problems, 'frames that showed the user grouping after the picker showed Model').toEqual([])
  })

  test('the Dashboard Pods window for another phase or every pod shows no row or count of the window before', async ({ page }) => {
    test.setTimeout(90_000)
    await installSampler(page)
    const pod = (name: string, phase: string) => ({
      name, namespace: 'e2e-switch-guard', phase, status: phase === 'Succeeded' ? 'Completed' : phase === 'Failed' ? 'Error' : 'Running',
      ready: phase === 'Running' ? '1/1' : '0/1', restart_count: 0, node_name: 'e2e-node', pod_ip: '', created_at: '', containers: [],
    })
    const running = Array.from({ length: 60 }, (_, i) => pod(`e2e-sg-run-${String(i + 1).padStart(3, '0')}`, 'Running'))
    const failed = [pod('e2e-sg-failed-1', 'Failed'), pod('e2e-sg-failed-2', 'Failed')]
    const done = [pod('e2e-sg-done-1', 'Succeeded'), pod('e2e-sg-done-2', 'Succeeded'), pod('e2e-sg-done-3', 'Succeeded')]
    const pods = [...running, ...failed, ...done]
    await page.route(/\/api\/v1\/cluster\/pods\/page(\?|$)/, async (route) => {
      const u = new URL(route.request().url())
      const phase = u.searchParams.get('phase')
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const matched = pods.filter((p) => (!phase || p.phase === phase) && p.name.includes(q))
      try {
        await route.fulfill({ json: {
          items: matched.slice(offset, offset + limit), total: matched.length,
          stats: { total: pods.length, ready: 60, not_ready: 0, pending: 0, terminating: 0, error: 2, restarted: 0, completed: 3, top_reasons: [] },
          revision: '', source: 'index',
        } })
      } catch { /* the page went on */ }
    })
    const ROWS = 'div.cursor-pointer:has([data-testid="resource-modal-pod-status"])'
    const names = () => page.locator(`${ROWS} h3`).allInnerTexts()
    const total = page.getByTestId('resource-modal-total')
    const podCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Pod (status|상태)$/ }) })
    const column = (phase: string) => podCard.locator('svg g').filter({ has: page.locator('title', { hasText: new RegExp(`^${phase}:`) }) }).first()
    const close = async () => {
      await page.keyboard.press('Escape')
      await expect(total).toHaveCount(0)
    }
    const isWindowRead = (u: URL) => u.pathname === '/api/v1/cluster/pods/page' && u.searchParams.get('sort') !== 'health'
    const problems: string[] = []

    await page.goto('/?cluster=self')
    await column('Failed').click({ timeout: 20_000 })
    await expect.poll(names, { timeout: 15_000 }).toEqual(failed.map((p) => p.name))
    const failedTotal = (await total.innerText()).trim()
    await close()

    await test.step('Failed → Succeeded', async () => {
      const { problems: found } = await watchSwitch(page, {
        hold: holdAnswers(page, (u) => isWindowRead(u) && u.searchParams.get('phase') === 'Succeeded'),
        arming: { rows: ROWS, probes: { total: '[data-testid="resource-modal-total"]' } },
        act: () => column('Succeeded').click(),
        shown: () => expect.poll(names, { timeout: 10_000 }).toEqual(done.map((p) => p.name)).then(() => true, () => false),
        watch: () => ({ what: 'Pods window Failed → Succeeded', fromArm: true, oldRows: failed.map((p) => p.name), oldProbes: { total: failedTotal } }),
      })
      problems.push(...found)
    })

    await test.step('Succeeded → every pod', async () => {
      const doneTotal = (await total.innerText()).trim()
      await close()
      const { problems: found } = await watchSwitch(page, {
        hold: holdAnswers(page, (u) => isWindowRead(u) && !u.searchParams.get('phase') && !u.searchParams.get('q')),
        arming: { rows: ROWS, probes: { total: '[data-testid="resource-modal-total"]' } },
        act: () => page.getByTestId('stat-pods').click(),
        shown: () => expect.poll(async () => (await names())[0], { timeout: 10_000 }).toBe(running[0].name).then(() => true, () => false),
        // the first page of every pod holds the Running ones: no Succeeded row and not the Succeeded count
        watch: () => ({ what: 'Pods window Succeeded → every pod', fromArm: true, oldRows: done.map((p) => p.name), oldProbes: { total: doneTotal } }),
      })
      problems.push(...found)
    })
    expect(problems, 'frames of the Pods window that showed the window before').toEqual([])
  })

  test('the Optimization window for another namespace shows none of the AI answer or rows of the namespace before', async ({ page }) => {
    test.setTimeout(90_000)
    await installSampler(page)
    const marker = (ns: string) => `SG-OPT-${ns}-${run} explanation`
    // the AI explanation is answered in the browser: no model
    await page.route('**/api/v1/ai/suggest-optimization/stream*', async (route) => {
      const ns = new URL(route.request().url()).searchParams.get('namespace') ?? ''
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify({ kind: 'observed', content: `table of ${ns}` })}\n\ndata: ${JSON.stringify({ content: marker(ns) })}\n\ndata: [DONE]\n\n`,
      })
    })
    await page.goto('/?cluster=self')
    await page.getByRole('button', { name: new RegExp(esc(EN.dashboard.quickActions.optimization.title)) }).first().click({ timeout: 20_000 })
    const trigger = page.locator(`button[title="${EN.dashboard.optimization.selectNamespaceTitle}"]`)
    // the picker is disabled while the namespaces load and names the namespace the window opened on after
    await expect(trigger).toBeEnabled({ timeout: 15_000 })
    const from = (await trigger.innerText()).trim()
    expect(from, 'the window opened on a namespace').not.toBe(EN.dashboard.optimization.selectNamespace)
    const to = from === 'kube-system' ? 'default' : 'kube-system'
    await page.getByRole('button', { name: EN.dashboard.optimization.run, exact: true }).click({ timeout: 20_000 })
    await expect(page.getByTestId('optimization-ai'), 'the dev install has AI on and draws the answer').toContainText(marker(from), { timeout: 20_000 })
    const mine = await page.getByTestId('optimization-open').allInnerTexts()
    const theirs = await (await page.request.get(`/api/v1/cluster/optimization?namespace=${to}&cluster=self`, { headers: XRW })).text()
    const oldRows = [...new Set(mine.map((n) => n.trim()).filter(tellable).filter((n) => !theirs.includes(n)))]
    await trigger.evaluate((el) => el.setAttribute('data-sg-probe', 'ns'))
    const { problems } = await watchSwitch(page, {
      hold: holdAnswers(page, (u) => u.pathname === '/api/v1/cluster/optimization' && u.searchParams.get('namespace') === to),
      arming: { rows: '[data-testid="optimization-row"]', probes: { ns: '[data-sg-probe="ns"]', ai: '[data-testid="optimization-ai"]', observed: 'details' } },
      act: async () => {
        await trigger.click()
        await trigger.locator('xpath=..').locator('div.absolute.top-full button').filter({ hasText: exactly(to) }).first().click({ timeout: 10_000 })
      },
      // the new namespace's rows (each in its answer), or its empty or failed table
      shown: () => expect.poll(async () => {
        const rows = await page.getByTestId('optimization-open').allInnerTexts()
        if (rows.length) return rows.every((n) => theirs.includes(n.trim()))
        return (await page.getByTestId('optimization-table-empty').count()) + (await page.getByTestId('optimization-table-error').count()) > 0
      }, { timeout: 15_000 }).toBe(true).then(() => true, () => false),
      watch: () => ({ what: `Optimization ${from} → ${to}`, switched: (f) => f.probes.ns === to, oldTexts: [marker(from)], oldRows }),
    })
    expect(problems, 'frames of the Optimization window that showed the namespace before').toEqual([])
  })

  test('the YAML tab of a custom resource shows none of another CRD\'s resource of the same name', async ({ page }) => {
    test.setTimeout(180_000)
    await installSampler(page)
    const NAME = 'e2e-switch-guard'
    const kinds = [
      { group: 'a.switchguard.kubeast.io', plural: 'guardpools', singular: 'guardpool', kind: 'GuardPool', holds: `pool-of-a-${run}` },
      { group: 'b.switchguard.kubeast.io', plural: 'guardclasses', singular: 'guardclass', kind: 'GuardClass', holds: `class-of-b-${run}` },
    ]
    const crdNames = kinds.map((k) => `${k.plural}.${k.group}`)
    made.crds.push(...crdNames)
    kubectl(['delete', 'crd', ...crdNames, '--ignore-not-found', '--wait=true', '--timeout=120s'])
    // two cluster-scoped kinds of their own CRDs, as Karpenter's NodePool and EC2NodeClass, each with an object named alike
    kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: kinds.map((k) => ({
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
      metadata: { name: `${k.plural}.${k.group}`, labels: { 'kubeast.io/e2e': 'switch-guard' } },
      spec: {
        group: k.group, scope: 'Cluster', names: { plural: k.plural, singular: k.singular, kind: k.kind },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } } } }],
      },
    })) }))
    kubectl(['wait', '--for', 'condition=established', '--timeout=60s', ...crdNames.map((n) => `crd/${n}`)])
    kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: kinds.map((k) => ({ apiVersion: `${k.group}/v1`, kind: k.kind, metadata: { name: NAME }, spec: { holds: k.holds } })) }))

    await page.goto('/custom-resources/instances?cluster=self')
    await page.locator('main input[type="text"]').first().fill('switchguard', { timeout: 20_000 })
    const row = (kind: string) => page.locator('main tbody tr').filter({ hasText: kind }).filter({ hasText: NAME }).first()
    // the list may be the server's from before the objects: read it again until both show
    await expect.poll(async () => {
      if ((await row('GuardPool').count()) && (await row('GuardClass').count())) return true
      await page.locator('.page-head').getByRole('button', { name: exactly(EN.crInstancesPage.refresh) }).click({ timeout: 10_000 }).catch(() => undefined)
      return false
    }, { timeout: 60_000, intervals: [2_000] }).toBe(true)

    const drawer = page.locator(DRAWER).last()
    const lines = drawer.locator('.monaco-editor .view-lines').first()
    await row('GuardPool').click()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 20_000 })
    await expect(lines).toContainText(kinds[0].holds, { timeout: 20_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator(DRAWER)).toHaveCount(0)

    // within the ten seconds the first YAML counts as fresh: the second resource's drawer, then its YAML tab
    await row('GuardClass').click()
    await expect(drawer).toContainText('GuardClass', { timeout: 15_000 })
    const { problems } = await watchSwitch(page, {
      hold: holdAnswers(page, (u) => u.pathname === '/api/v1/cluster/resources/yaml' && u.searchParams.get('resource_type') === crdNames[1]),
      arming: { rows: '[data-sg-none]' },
      act: () => drawer.getByRole('button', { name: 'YAML', exact: true }).click(),
      shown: () => expect(lines).toContainText(kinds[1].holds, { timeout: 15_000 }).then(() => true, () => false),
      watch: () => ({ what: 'YAML GuardPool → GuardClass', switched: (f) => f.drawer.includes('GuardClass'), oldTexts: [kinds[0].group, kinds[0].holds] }),
    })
    await page.keyboard.press('Escape')
    kubectl(['delete', 'crd', ...crdNames, '--ignore-not-found', '--wait=true', '--timeout=120s'])
    expect(problems, 'frames of the GuardClass drawer that showed the GuardPool YAML').toEqual([])
  })

  test('a forced read of the cluster before, answered after the switch, writes none of its rows into the new cluster\'s list', async ({ page }) => {
    test.setTimeout(90_000)
    await installSampler(page)
    await page.goto('/workloads/deployments?cluster=self')
    await expect(page.locator('main tbody tr td:nth-child(2)').first()).toBeVisible({ timeout: 20_000 })
    const theirs = await (await page.request.get('/api/v1/cluster/deployments/all?force_refresh=false&cluster=default', { headers: XRW })).text()
    const mine = [...new Set((await rowNames(page)).filter(tellable).filter((n) => !theirs.includes(n)))]
    expect(mine.length, 'Deployments only self has').toBeGreaterThan(0)
    const forced = holdAnswers(page, (u) => u.pathname === '/api/v1/cluster/deployments/all' && u.searchParams.get('cluster') === 'self' && u.searchParams.get('force_refresh') === 'true')
    await forced.ready
    await page.locator('.page-head').getByRole('button', { name: exactly(EN.deployments.refresh) }).click()
    await expect.poll(() => forced.held(), { message: 'the forced read of self is held' }).toBeGreaterThan(0)
    await arm(page)
    await pickCluster(page, 'default')
    const shown = await showsNew(page, theirs, mine)
    await forced.release()
    await page.waitForTimeout(WINDOW_MS)
    const rec = await recording(page)
    await disarm(page)
    const problems = afterSwitch(rec, { what: 'Deployments self → default, self\'s Refresh answered after', switched: (f) => f.cluster.startsWith('default'), oldRows: mine })
    if (!shown) problems.push('default\'s Deployments did not show before self\'s forced read was answered')
    expect(problems, 'frames of default\'s Deployments that showed self\'s rows').toEqual([])
  })

  test('a read of the cluster before refused or failed after the switch puts no notice or reason on the new cluster', async ({ page }) => {
    test.setTimeout(120_000)
    await installSampler(page)
    const problems: string[] = []
    for (const status of [403, 500]) {
      await test.step(`self's list answered ${status} after the switch`, async () => {
        const late = holdAnswers(page, (u, r) => r.method() === 'GET' && u.pathname === '/api/v1/cluster/deployments/all' && u.searchParams.get('cluster') === 'self')
        await late.ready
        await page.goto('/workloads/deployments?cluster=self')
        await expect.poll(() => late.held(), { timeout: 15_000, message: 'self\'s list read is held' }).toBeGreaterThan(0)
        await arm(page)
        await pickCluster(page, 'default')
        const theirs = await (await page.request.get('/api/v1/cluster/deployments/all?force_refresh=false&cluster=default', { headers: XRW })).text()
        const shown = await showsNew(page, theirs, [])
        await late.release({ status, json: { detail: `switch guard stand-in ${status}` } })
        await page.waitForTimeout(WINDOW_MS)
        // an empty list shows the list's own line: a search that matches nothing
        await page.getByPlaceholder(EN.deployments.searchPlaceholder).fill(`zz-switch-guard-none-${run}`)
        const line = page.locator('main tbody td[colspan]').first()
        await expect(line).not.toHaveText(exactly(EN.common.loading), { timeout: 10_000 })
        await page.waitForTimeout(300)
        const rec = await recording(page)
        await disarm(page)
        problems.push(...afterSwitch(rec, { what: `Deployments self → default, self's read answered ${status} after`, switched: (f) => f.cluster.startsWith('default'), noNotice: true }))
        if (!shown) problems.push(`${status}: default's Deployments did not show`)
        soft(await line.innerText(), `${status}: the empty search's line on default`).toBe(EN.common.noSearchResults)
        soft(await page.getByTestId('forbidden-banner').count(), `${status}: the forbidden notice on default`).toBe(0)
      })
    }
    expect(problems, 'frames of default\'s Deployments that showed self\'s refusal or failure').toEqual([])
  })

  test('signing out closes the live connection and ends the answer on its way; the next person signing in in the same tab gets a connection of their own and none of it', async ({ browser, request }) => {
    test.setTimeout(180_000)
    const admin = await bearer(request)
    const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name === 'Member').id
    const email = `e2e-sg-read-${run}@kubeast.local`
    const password = `e2e-sg-read-${run}-pw`
    const user = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E switch guard read', email, password, role_id: member } })
    expect(user.status(), await user.text()).toBe(201)
    const id = (await user.json()).id as string
    made.users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)

    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await ctx.newPage()
    await installSampler(page)
    const sockets: { opened: number; closed: number | null }[] = []
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/wsMultiplexer')) return
      const s = { opened: Date.now(), closed: null as number | null }
      sockets.push(s)
      ws.on('close', () => { s.closed = Date.now() })
    })
    const signIn = async (who: string, secret: string) => {
      await page.locator('input[autocomplete="email"]').first().fill(who)
      await page.locator('input[type="password"]').first().fill(secret)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
    }
    const openNow = (before: number) => sockets.filter((s) => s.opened < before && s.closed === null).length
    const toScreen = async (href: string) => page.getByTestId('sidebar-nav').locator(`a[href="${href}"]`).first().dispatchEvent('click')
    // the two answers of the person before, held in the browser (no model) and answered after the next one signs in
    const QUESTION = `switch guard question ${run}`
    const FLOATING_QUESTION = `switch guard floating question ${run}`
    const LETTERS = `SG-ANSWER-${run} letters of the person before`
    const FLOATING_LETTERS = `SG-FLOATING-${run} letters of the person before`
    const sse = (content: string) => `data: ${JSON.stringify({ content })}\n\ndata: [DONE]\n\n`
    const chat = holdAnswers(page, (u) => /^\/api\/v1\/ai\/sessions\/[^/]+\/chat$/.test(u.pathname))
    const floating = holdAnswers(page, (u) => /^\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat$/.test(u.pathname))
    const AI_STOP = '[data-testid="chat-input"] ~ button.bg-red-600'
    const FLOATING_STOP = '[data-testid="floating-chat-panel"] button.bg-red-600'
    const openFloating = async () => {
      await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click({ timeout: 20_000 })
      await expect(page.getByTestId('floating-chat-panel')).toHaveCSS('pointer-events', 'auto')
    }

    try {
      await chat.ready
      await floating.ready
      await page.goto('/login')
      await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
      await page.goto('/ai-chat?cluster=self')
      await page.getByTestId('chat-input').fill(QUESTION, { timeout: 20_000 })
      await page.getByRole('button', { name: /전송|send/i }).click()
      await expect.poll(() => chat.held(), { message: 'the AI Chat answer is held' }).toBeGreaterThan(0)
      await expect(page.locator(AI_STOP), 'AI Chat shows Stop while its answer is held').toHaveCount(1)
      // the answer goes on in the background while another page is open, as it does for a person
      await toScreen('/workloads/deployments')
      await expect(page.locator('main h1').first()).toHaveText(/Deployments/, { timeout: 20_000 })
      await expect.poll(() => sockets.filter((s) => s.closed === null).length, { timeout: 20_000, message: 'the live list opened a connection' }).toBeGreaterThan(0)
      await openFloating()
      await page.getByTestId('floating-chat-input').fill(FLOATING_QUESTION)
      await page.getByTestId('floating-chat-input').press('Enter')
      await expect.poll(() => floating.held(), { message: 'the floating chat answer is held' }).toBeGreaterThan(0)
      await expect(page.locator(FLOATING_STOP), 'the floating chat shows Stop while its answer is held').toHaveCount(1)
      made.sessions.push(...[...chat.urls(), ...floating.urls()].map((u) => u.pathname.split('/')[5]))
      await page.evaluate(() => { (window as unknown as { __sgDocument: string }).__sgDocument = 'kept' })

      await page.getByRole('button', { name: EN.layout.logout, exact: true }).click()
      await expect(page).toHaveURL(/\/login/)
      const signedOut = Date.now()
      await soft.poll(() => openNow(signedOut), { timeout: 10_000, message: 'the connection opened before the sign-out is closed after it' }).toBe(0)

      // from the sign-in page on: the next person's account card, both chats' Stop and waiting dots and every word of them
      await arm(page, {
        rows: '[data-sg-none]',
        probes: {
          account: 'a[href="/account"]',
          aiStop: AI_STOP,
          aiWaiting: { sel: '[data-testid="chat-messages"] .animate-bounce', attr: 'class' },
          aiText: '[data-testid="chat-messages"]',
          floatingStop: { sel: FLOATING_STOP, attr: 'class' },
          floatingWaiting: { sel: '[data-testid="floating-waiting"]', attr: 'data-testid' },
          floatingText: '[data-testid="floating-messages"]',
        },
      })
      await signIn(email, password)
      await toScreen('/ai-chat')
      await expect(page.getByTestId('chat-input'), 'the next person\'s AI Chat').toHaveCount(1, { timeout: 20_000 })
      await page.waitForTimeout(WINDOW_MS)
      // the person before's answer arrives now: none of its letters reach this person's AI Chat
      await chat.release({ contentType: 'text/event-stream', body: sse(LETTERS) })
      await page.waitForTimeout(WINDOW_MS)

      // the sign-in page opens no list: a connection opened after the sign-out is the next person's
      await toScreen('/workloads/deployments')
      await expect(page.locator('main h1').first()).toHaveText(/Deployments/, { timeout: 20_000 })
      await soft.poll(() => sockets.filter((s) => s.opened > signedOut && s.closed === null).length, { timeout: 20_000, message: 'the next person\'s live list has a connection of its own' }).toBeGreaterThan(0)
      soft(openNow(signedOut), 'connections of the person before still open').toBe(0)
      await openFloating()
      await page.waitForTimeout(WINDOW_MS)
      await floating.release({ contentType: 'text/event-stream', body: sse(FLOATING_LETTERS) })
      await page.waitForTimeout(WINDOW_MS)

      const rec = await recording(page)
      await disarm(page)
      const problems = afterSwitch(rec, {
        what: 'sign-out, next person signed in',
        switched: (f) => f.probes.account.includes(email),
        noProbes: ['aiStop', 'aiWaiting', 'floatingStop', 'floatingWaiting'],
        oldTexts: [LETTERS, FLOATING_LETTERS, QUESTION, FLOATING_QUESTION],
      })
      soft(problems, 'frames after the next person signed in that showed the answers of the person before').toEqual([])
      expect(await page.evaluate(() => (window as unknown as { __sgDocument?: string }).__sgDocument), 'the tab was not reloaded in between').toBe('kept')
    } finally {
      // an answer still held when a step failed: let it go before the tab closes
      await chat.release({ status: 503, json: { detail: 'switch guard: the test ended' } }).catch(() => undefined)
      await floating.release({ status: 503, json: { detail: 'switch guard: the test ended' } }).catch(() => undefined)
      await ctx.close()
    }
  })
})
