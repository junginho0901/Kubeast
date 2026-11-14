import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Page, type Request, type Route } from '@playwright/test'

import { AI_LAYER_EXEMPT, aiLayerScreens, clusterFor, visitUrl } from './ai-layer-screens'

// Opt-in, not in the default run: E2E_AI_LAYERS=1 npx playwright test --project=ai-layers (an estimated 15–20 min).
//
// Every screen of the app's sidebar config (ai-layer-screens.ts) but those ai-layer-exempt.json names is opened in six
// states, its reads answered in the browser: nothing on the cluster changes, and the floating chat's question is
// stopped and its body read, so no model is called (as floating-context.spec.ts does).
//   real        the cluster's own answer
//   refresh     after it, the page's Refresh answered 500 with a reason
//   refused     every read of the screen 403 with a reason
//   failed      every read of the screen 500 with a reason
//   not-served  every read an empty answer with X-Kubeast-Not-Installed — what k8s-service sends when the cluster's API
//               server answers a kind's list with 404 "the server could not find the requested resource" (handler/served.go)
//   empty       every read the cluster's answer with its lists emptied and its counts 0
// In the last four the live updates are held (the socket and the event streams stay open with nothing on them), so no
// row of the cluster comes in over the stood-in answer.
//
// One rule for every screen: a shared notice the screen shows — the "No permission" banner or a list's refusal row, a
// failed read or Refresh with its reason, "… is not installed / not served", an empty list's row — has a layer of the
// same meaning in what the floating chat is sent (refused naming the kinds, failed with the reason, not served naming
// the kind, zero items), and while the screen shows no rows no layer states a count the screen does not show. A screen
// with the cluster's answer and no notice sends its screen data (base). Each screen's states are attached as JSON.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REFUSED_REASON = 'e2e stand-in: this role may not list it (ai-layers)'
const FAILED_REASON = 'e2e stand-in: the list read failed on the server (ai-layers)'
// a read and its one retry (the app's queries retry once, a second later) have answered
const QUIET_MS = 1_200

type Layer = { source: string; summary: string; data?: Record<string, unknown> }
type PageContext = { path: string; page_type: string; base?: Layer | null; overlays: Layer[] }
type State = 'real' | 'refresh' | 'refused' | 'failed' | 'not-served' | 'empty'
type StandIn = { hits: string[]; lastHit: number; lift: () => Promise<void> }
// what the screen shows, read in the page
type Shown = {
  ready: boolean // the title is up and nothing says Loading
  refused: string[] // the "No permission" banner and the lists' refusal rows
  failed: string[] // the failed reads' rows and the "Refresh failed" line, without Retry
  notServed: string[] // "… is not installed / not served" rows
  emptyRow: boolean // a list's empty row ("No items.", "No results found." or the page's own words), no notice in it
  rows: number // table rows of more than one cell
  text: string // main's visible text
}
type Row = { state: State; problems: string[]; shown?: Omit<Shown, 'text' | 'ready'>; said?: Record<string, unknown>; note?: string }

// The floating chat's question, stopped in the browser: the page_context it carries is what the model would read.
async function captureFloating(page: Page) {
  const sent: PageContext[] = []
  let created = 0
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: `e2e-ai-layers-${++created}`, title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback(),
  )
  await page.route(/\/api\/v1\/sessions\/e2e-ai-layers-\d+(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-ai-layers', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }),
  )
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-ai-layers-\d+\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return sent
}

async function openChat(page: Page) {
  if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
  await expect(page.getByTestId('floating-chat-input')).toBeVisible()
}

async function closeChat(page: Page) {
  if ((await page.getByTestId('floating-chat-panel').count()) === 0) return
  await page.getByTestId('floating-chat-input').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('floating-chat-panel')).toHaveCount(0)
}

async function ask(page: Page, sent: PageContext[]): Promise<PageContext> {
  await openChat(page)
  const input = page.getByTestId('floating-chat-input')
  const before = sent.length
  await input.fill('what is on this screen?')
  await input.press('Enter')
  await expect.poll(() => sent.length).toBe(before + 1)
  // Enter does not send while an answer is still coming; the Send button is back when it has ended
  await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
  return sent[sent.length - 1]
}

// Reads no screen shows as its own, never stood in: the signed-in user and the admin settings, the cluster picker, the
// floating chat's conversation, the app's switches and the buttons' permission checks …
const APP_READS = /^\/api\/v1\/(auth\/|clusters(\/|$)|sessions(\/|$)|ai\/sessions\/|cluster\/(features|can-i|hygiene\/config)$)/
let appReads: Set<string> | undefined
// … and whatever else the app reads on a screen with no list of its own (the account page), learned once per worker.
async function readsOfTheApp(page: Page): Promise<Set<string>> {
  if (appReads) return appReads
  const seen = new Set<string>()
  const note = (r: Request) => {
    const u = new URL(r.url())
    if (r.method() === 'GET' && u.pathname.startsWith('/api/v1/')) seen.add(u.pathname)
  }
  page.on('request', note)
  await page.goto('/account?cluster=self')
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: 30_000 })
  await openChat(page)
  await page.waitForTimeout(2_000)
  page.off('request', note)
  appReads = seen
  return seen
}

// a key that says how many of something there are (not a page number or a page size)
const COUNT_KEY = /^(total|count|shown)$|_(count|total)$|^total_(?!pages$)/

// the cluster's answer with nothing in it: every list empty and every count 0
function emptied(v: unknown): unknown {
  if (Array.isArray(v)) return []
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' && COUNT_KEY.test(k) ? 0 : emptied(x)]))
}

// the list a path reads, as the app's list status names it (utils/forbiddenResource listSegmentFromUrl)
function listSegment(pathname: string): string {
  const parts = pathname.replace(/^\/api\/v1\//, '').replace(/^cluster\//, '').split('/').filter(Boolean)
  return parts[0] === 'namespaces' ? (parts[2] ?? 'namespaces') : (parts[0] ?? '')
}

// Answers every GET the screen makes under /api/v1/ but the app's own reads, until lifted.
async function standIn(page: Page, state: 'refused' | 'failed' | 'not-served' | 'empty', own: Set<string>): Promise<StandIn> {
  const s: StandIn = { hits: [], lastHit: 0, lift: async () => {} }
  const match = (u: URL) => u.pathname.startsWith('/api/v1/') && !APP_READS.test(u.pathname) && !own.has(u.pathname)
  const handler = async (route: Route) => {
    const req = route.request()
    if (req.method() !== 'GET') return route.fallback()
    // a live stream (pods, Helm releases) stays open with nothing on it
    if (req.resourceType() === 'eventsource') return new Promise<void>(() => {})
    const url = new URL(req.url())
    s.hits.push(url.pathname)
    s.lastHit = Date.now()
    // a page that moved on has dropped the request: its answer goes nowhere
    const answer = (a: Parameters<Route['fulfill']>[0]) => route.fulfill(a).catch(() => {})
    if (state === 'refused') return answer({ status: 403, json: { detail: REFUSED_REASON } })
    if (state === 'failed') return answer({ status: 500, json: { detail: FAILED_REASON } })
    let body: unknown = []
    try {
      const real = await route.fetch()
      if ((real.headers()['content-type'] ?? '').includes('json')) body = emptied(await real.json())
    } catch {
      // the page moved on, or the cluster did not answer: an empty list stands in
    }
    s.lastHit = Date.now()
    return answer({ status: 200, json: body, headers: state === 'not-served' ? { 'X-Kubeast-Not-Installed': listSegment(url.pathname) } : {} })
  }
  await page.route(match, handler)
  s.lift = () => page.unroute(match, handler)
  return s
}

async function readShown(page: Page): Promise<Shown> {
  return page.evaluate((loading: string) => {
    const main = document.querySelector('main')
    const visible = (e: Element) => e.getClientRects().length > 0
    const text = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()
    const all = (selector: string) => [...document.querySelectorAll(selector)].filter(visible)
    const rows = main ? [...main.querySelectorAll('tbody tr')].filter(visible) : []
    const oneCell = rows.filter((r) => r.children.length === 1 && (r.children[0] as HTMLTableCellElement).colSpan > 1)
    const mainText = main ? (main as HTMLElement).innerText : ''
    const h1 = main?.querySelector('h1')
    return {
      ready: !!h1 && visible(h1) && !mainText.includes(loading) && !main?.querySelector('[aria-busy="true"]'),
      refused: all('[data-testid="forbidden-banner"], [data-testid="table-forbidden"]').map(text),
      failed: all('[data-testid="table-load-error"], [data-testid="refresh-failed"]').map((e) => text(e).replace(/\s*Retry$/, '')),
      notServed: all('[data-testid="table-not-installed"]').map(text),
      emptyRow: oneCell.some((r) => !r.querySelector('[data-testid]') && text(r) !== '' && !text(r).includes(loading)),
      rows: rows.filter((r) => r.children.length > 1 && text(r) !== '').length,
      text: mainText,
    }
  }, EN.common.loading as string)
}

// The words a layer uses for each meaning: a key holding something (refused: [kinds], refresh_failed: {at, reason},
// forbidden_kinds, rollouts_error, not_installed …) or a value that is the word itself (status: 'refused').
const MEANING = {
  refused: { key: /^(refused|forbidden|no_permission)$|^(refused|forbidden)_|_(refused|forbidden)$/, value: /^(refused|forbidden|no_permission)$/ },
  failed: { key: /^(failed|error|errors)$|^(failed|error)_|_(failed|error|errors)$/, value: /^(failed|error|list_failed|read_failed|refresh_failed)$/ },
  notServed: { key: /^not_(served|installed)($|_)|_not_(served|installed)$/, value: /^(not_served|not_installed|notInstalled)$/ },
}
type Meaning = keyof typeof MEANING

const present = (v: unknown) =>
  v === true || (typeof v === 'number' && v > 0) || (typeof v === 'string' && v.trim() !== '') ||
  (Array.isArray(v) && v.length > 0) || (!!v && typeof v === 'object' && Object.keys(v).length > 0)

// every key of a layer's data and of the objects under it, with where it is; a list of items is not gone into, since
// what an item holds is about that object, not about how the read went
function entries(data: unknown, at: string, out: [string, unknown, string][] = []): [string, unknown, string][] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [k, v] of Object.entries(data)) {
    out.push([k, v, `${at}.${k}`])
    entries(v, `${at}.${k}`, out)
  }
  return out
}

// the layers about the screen's reads: WatchProblemNotice says the live updates stopped, which is its own notice
const readLayers = (ctx: PageContext) => [ctx.base, ...ctx.overlays].filter((l): l is Layer => !!l && l.source !== 'WatchProblemNotice')

const saying = (ctx: PageContext, meaning: Meaning) => readLayers(ctx).filter((l) =>
  entries(l.data, l.source).some(([k, v]) => (MEANING[meaning].key.test(k) && present(v)) || (typeof v === 'string' && MEANING[meaning].value.test(v))))

function countsSaid(ctx: PageContext): { where: string; value: number }[] {
  const out: { where: string; value: number }[] = []
  for (const l of readLayers(ctx)) {
    for (const [k, v, where] of entries(l.data, l.source)) if (typeof v === 'number' && COUNT_KEY.test(k)) out.push({ where, value: v })
    for (const m of l.summary.matchAll(/(\d+)\s*개/g)) out.push({ where: `${l.source} summary "${m[0]}"`, value: Number(m[1]) })
  }
  return out
}

const saysZero = (ctx: PageContext) => countsSaid(ctx).some((c) => c.value === 0) || readLayers(ctx).some((l) =>
  entries(l.data, l.source).some(([k, v]) => /(^|_)(items|rows|results|events|list)$/.test(k) && Array.isArray(v) && v.length === 0))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fromTemplate = (s: string, name: string) => new RegExp(escapeRe(s).replace(escapeRe(`{{${name}}}`), '(.+?)'))
const REFUSAL = [fromTemplate(EN.layout.forbidden.body, 'resources'), fromTemplate(EN.common.forbiddenEmpty, 'resource')]
const NOT_SERVED = [fromTemplate(EN.common.notInstalledEmpty, 'resource'), fromTemplate(EN.common.notServedEmpty, 'resource')]
// the notices' own sentences, which a layer's summary may say instead of a key
const sentences = (texts: string[], patterns: RegExp[]) => texts.flatMap((t) => patterns.map((p) => p.exec(t)?.[0] ?? '')).filter(Boolean)
// the kinds the notices name ("Deployment, Namespace" in the banner)
const kindsNamed = (texts: string[], patterns: RegExp[]) => [...new Set(texts.flatMap((t) => patterns.flatMap((p) => p.exec(t)?.[1]?.split(', ') ?? [])))]
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const NUMBER = /(?<![\w.:-])\d+(?![\w.:%-])/g
function numbersOn(shown: Shown): Set<number> {
  // the list footer's "Showing 0 of 0" stands for a list it never got while a refusal or a failure shows
  const text = shown.refused.length || shown.failed.length ? shown.text.split(EN.common.paginationEmpty).join(' ') : shown.text
  return new Set([...text.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(NUMBER)].map((m) => Number(m[0])))
}

// What the layers fail to say of what the screen shows, by the one rule.
function judge(state: State, shown: Shown, ctx: PageContext): string[] {
  const out: string[] = []
  const summaries = readLayers(ctx).map((l) => l.summary.replace(/\s+/g, ' '))
  const sayItsSentence = (said: string[]) => said.some((s) => summaries.some((t) => t.includes(s)))
  const namesEach = (layers: Layer[], kinds: string[], what: string) => {
    const named = flat(JSON.stringify(layers))
    for (const k of kinds) if (!named.includes(flat(k))) out.push(`the screen names ${k} as ${what}; the layer saying ${what} does not`)
  }

  if (shown.refused.length) {
    const kinds = kindsNamed(shown.refused, REFUSAL)
    const layers = saying(ctx, 'refused')
    if (layers.length) namesEach(layers, kinds, 'refused')
    else if (!sayItsSentence(sentences(shown.refused, REFUSAL))) out.push(`the screen says no permission (${kinds.join(', ') || shown.refused[0]}); no layer says refused`)
  }
  if (shown.failed.length) {
    if (!saying(ctx, 'failed').length && !sayItsSentence(shown.failed)) out.push(`the screen says "${shown.failed[0]}"; no layer says failed`)
    const json = JSON.stringify(ctx)
    for (const reason of [FAILED_REASON, REFUSED_REASON]) {
      if (shown.failed.some((t) => t.includes(reason)) && !json.includes(reason)) out.push(`the screen gives the reason "${reason}"; no layer does`)
    }
  }
  if (shown.notServed.length) {
    const kinds = kindsNamed(shown.notServed, NOT_SERVED)
    const layers = saying(ctx, 'notServed')
    if (layers.length) namesEach(layers, kinds, 'not served')
    else if (!sayItsSentence(sentences(shown.notServed, NOT_SERVED))) out.push(`the screen says "${shown.notServed[0]}"; no layer says not served`)
  }
  const notice = shown.refused.length + shown.failed.length + shown.notServed.length > 0
  if (shown.emptyRow && !notice) {
    if (!saysZero(ctx)) out.push('the screen shows an empty list; no layer says zero items')
    for (const m of ['refused', 'failed', 'notServed'] as const) {
      if (saying(ctx, m).length) out.push(`the screen shows an empty list and no notice; ${saying(ctx, m).map((l) => l.source).join(', ')} says ${m}`)
    }
  }
  // with no rows on the screen every count a layer states must be one the screen shows ("No items." shows a zero)
  if (state !== 'real' && state !== 'refresh' && shown.rows === 0) {
    const numbers = numbersOn(shown)
    for (const c of countsSaid(ctx)) {
      if (!numbers.has(c.value) && !(c.value === 0 && shown.emptyRow)) out.push(`a layer says ${c.where} = ${c.value}; the screen shows no ${c.value}`)
    }
  }
  if (state === 'real' && !notice && !ctx.base?.summary) out.push('the screen shows its data and no notice; the layers have no screen data (base)')
  return out
}

const brief = ({ refused, failed, notServed, emptyRow, rows }: Shown) => ({ refused, failed, notServed, emptyRow, rows })
const briefSaid = (ctx: PageContext) => ({
  base: ctx.base ? ctx.base.summary : null,
  overlays: ctx.overlays.map((o) => o.source),
  refused: saying(ctx, 'refused').map((l) => l.source),
  failed: saying(ctx, 'failed').map((l) => l.source),
  notServed: saying(ctx, 'notServed').map((l) => l.source),
  counts: countsSaid(ctx),
})

// Reads the screen and asks the floating chat until the layers say what it shows, or the time is up: once the screen
// has stopped loading and, with a stand-in, its reads have answered.
async function holdState(page: Page, sent: PageContext[], screenPath: string, state: State, s: StandIn | null): Promise<Row> {
  const started = Date.now()
  const limit = state === 'real' ? 20_000 : 15_000
  let row: Row | null = null
  for (;;) {
    const shown = await readShown(page)
    const quiet = !s || (s.hits.length > 0 && Date.now() - s.lastHit >= QUIET_MS)
    if (quiet && (shown.ready || Date.now() - started > 8_000)) {
      const ctx = await ask(page, sent)
      const problems = ctx.path === screenPath ? judge(state, shown, ctx) : [`the floating chat was sent the screen of ${ctx.path}`]
      row = { state, problems, shown: brief(shown), said: briefSaid(ctx) }
      if (problems.length === 0) return row
    }
    if (Date.now() - started > limit) {
      if (row) return row
      const why = s && s.hits.length === 0 ? "the screen read nothing the stand-in answers (each read it made counts as the app's own)" : 'the screen did not stop loading'
      return { state, problems: [why], shown: brief(shown) }
    }
    await page.waitForTimeout(400)
  }
}

test.describe('the floating chat is sent what each screen shows', () => {
  for (const href of aiLayerScreens()) {
    const screenPath = href.split('?')[0]
    const cluster = clusterFor(href)
    test(`${href}: refused, failed, not served, empty and the real answer read the same in the layers`, async ({ page }) => {
      test.setTimeout(180_000)
      const sent = await captureFloating(page)
      const own = await readsOfTheApp(page)
      const url = visitUrl(href, cluster)
      const rows: Row[] = []

      await page.goto(url)
      rows.push(await holdState(page, sent, screenPath, 'real', null))

      const refresh = page.locator('.page-head').first().getByRole('button', { name: /^(Refresh|새로고침)$/ }).first()
      if (await refresh.isVisible()) {
        await closeChat(page)
        const failing = await standIn(page, 'failed', own)
        await refresh.click()
        if (await page.getByTestId('refresh-failed').first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
          rows.push(await holdState(page, sent, screenPath, 'refresh', failing))
        } else {
          rows.push({ state: 'refresh', problems: [], note: 'no "Refresh failed" line came after Refresh' })
        }
        await failing.lift()
      }

      await page.routeWebSocket(/\/wsMultiplexer/, () => {})
      for (const state of ['refused', 'failed', 'not-served', 'empty'] as const) {
        const answering = await standIn(page, state, own)
        await page.goto(url)
        rows.push(await holdState(page, sent, screenPath, state, answering))
        await answering.lift()
      }

      await test.info().attach('ai-layers.json', { body: JSON.stringify({ href, cluster, rows }, null, 2), contentType: 'application/json' })
      expect(rows.flatMap((r) => r.problems.map((p) => `${r.state}: ${p}`)), `${href} on ${cluster}`).toEqual([])
    })
  }

  test('the screens ai-layer-exempt.json names send the floating chat nothing', async ({ page }) => {
    test.setTimeout(120_000)
    const sent = await captureFloating(page)
    const sending: string[] = []
    for (const e of AI_LAYER_EXEMPT) {
      await page.goto(visitUrl(e.path, clusterFor(e.path)))
      // what a screen registers comes with its data
      await page.waitForTimeout(2_000)
      if (new URL(page.url()).pathname !== e.path) {
        test.info().annotations.push({ type: 'not on this install', description: e.path })
        continue
      }
      // AI Chat draws no floating chat
      if ((await page.getByTestId('floating-chat-toggle').count()) === 0) continue
      const ctx = await ask(page, sent)
      if (ctx.path !== e.path || ctx.base || ctx.overlays.length) {
        sending.push(`${e.path}: ${JSON.stringify({ path: ctx.path, base: ctx.base?.source ?? null, overlays: ctx.overlays.map((o) => o.source) })}`)
      }
    }
    expect(sending, 'a screen named as sending nothing sends something').toEqual([])
  })
})
