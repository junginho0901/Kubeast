import fs from 'node:fs'
import path from 'node:path'

import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { BASE, CLUSTER, DRAWER, DRAWERS, ROLES, SIDEBAR, applyFixtures, drawerTargets, openCluster, quiet, removeFixtures, track } from './shared'

// Accessibility net: every sidebar screen, /account and the first drawer of every kind on self, in each colour
// mode at 1440 x 900, held to WCAG 2.2 A and AA two ways.
// - axe-core with the tags wcag2a, wcag2aa, wcag21a, wcag21aa and wcag22aa. A finding a11y-baseline.json does not hold
//   fails, unless a11y-exempt.json names it with why; one the baseline holds and the screen no longer shows is listed,
//   so the baseline only shrinks. axe's own target-size is counted beside and not judged: it reads the element's box,
//   not the transparent ::after hit box the console gives its buttons (index.css).
// - Hit size, SC 2.5.8: how far from a control's centre a click still lands on it (document.elementFromPoint, so the
//   ::after box counts and a neighbour lying on top does not), in 1 px steps. Under 24 x 24 CSS px is a finding unless
//   a 24 px circle on its centre reaches no other control and no other small control's circle (the spacing exception),
//   or it is a link inside a sentence (the inline exception). A control in a table row is held to the same line: WCAG
//   has no table exception. Close, Back and the floating chat's controls under DESIGN.md's 40 (Interaction) are listed
//   apart and never fail: 40 is the design's line, not WCAG AA's.
// - What axe could not decide (incomplete) is written out for the people's pass, not judged.
// E2E_A11Y=1 runs it. E2E_A11Y_ONLY=<regular expression> narrows the screens (a PR's own area). E2E_A11Y_WRITE=1 writes
// what it found as the baseline (first at the release tag). E2E_A11Y_HITS_ZERO=1 also fails on any 24 x 24 finding the
// exempt file does not name, baseline or not. E2E_A11Y_OUT=<dir> keeps the tables. Without a baseline file it reports.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const MODES = ['default', 'dark', 'light'] as const
const VIEWPORT = { width: 1440, height: 900 }
const AT_ONCE = 2
const MIN = 24
const WIDE = 40
const TOLERANCE = 1
const MAX_CONTROLS = 600
const RUN = process.env.E2E_A11Y === '1'
const WRITE = process.env.E2E_A11Y_WRITE === '1'
const HITS_ZERO = process.env.E2E_A11Y_HITS_ZERO === '1'
const OUT = process.env.E2E_A11Y_OUT || ''
const ONLY = process.env.E2E_A11Y_ONLY ? new RegExp(process.env.E2E_A11Y_ONLY) : null
const BASELINE_FILE = path.join(__dirname, 'a11y-baseline.json')
const EXEMPT_FILE = path.join(__dirname, 'a11y-exempt.json')

type Mode = (typeof MODES)[number]
type Job = { id: string; mode: Mode; url: string; drawer: boolean }
type Control = {
  tag: string; role: string; testid: string; name: string; icon: string
  cx: number; cy: number; left: number; right: number; up: number; down: number
  inTable: boolean; inline: boolean; wide: boolean
}
type Finding = { check: string; key: string; extra: string }
type Screen = { id: string; found: Finding[]; wide: Finding[]; review: Finding[]; axeTargetSize: number; controls: number }
type Baseline = { made: Record<string, string>; screens: Record<string, string[]> }
type Exempt = { screen: RegExp; finding: RegExp; why: string }

test.use({ trace: 'off', screenshot: 'off' })

// A key that survives a new class, a moving count and a run's own object names; no mail address or key-like string.
function general(s: string): string {
  return s
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(kbk|sk-ant|ghp|gho|github_pat|xox[abpr])[-_A-Za-z0-9]{8,}/g, '<key>')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '<token>')
    .replace(/e2e-guard-[a-z0-9]+/g, 'e2e-guard-*')
    .replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}\b/g, '-*')
    .replace(/-[a-z0-9]{5}\b/g, '-*')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

const keyOf = (c: { tag: string; role?: string; testid: string; name: string; icon: string }) =>
  `${c.tag}|${c.role ?? ''}|${c.testid}|${general(c.name)}|${c.icon}`
const line = (f: Finding) => `${f.check} ${f.key}`

function jobs(node: string): Job[] {
  const list: Job[] = []
  for (const mode of MODES) {
    for (const p of [...new Set(SIDEBAR), '/account']) {
      list.push({ id: `${mode} · ${p} on ${CLUSTER}`, mode, url: `${p}${p.includes('?') ? '&' : '?'}cluster=${CLUSTER}`, drawer: false })
    }
    for (const [kind, d] of Object.entries(DRAWERS)) {
      if ('skip' in d) continue
      const t = drawerTargets(kind, d, ROLES[0], node)[0]
      if (!t) continue
      const api = t.api ? `&detailApi=${encodeURIComponent(t.api)}` : ''
      list.push({ id: `${mode} · drawer ${kind} (${t.view})`, mode, url: `/account?cluster=${CLUSTER}&detail=${encodeURIComponent(t.ref)}${api}`, drawer: true })
    }
  }
  return list.filter((j) => !ONLY || ONLY.test(j.id))
}

async function open(page: Page, job: Job): Promise<void> {
  const t = track(page)
  await page.goto(BASE + job.url)
  t.last = Date.now()
  await quiet(page, t, 500)
  if (job.drawer) await page.locator(DRAWER).last().waitFor({ state: 'visible', timeout: 20_000 })
  await quiet(page, t, 500)
  const mode = await page.evaluate(() => document.documentElement.dataset.colorMode ?? 'default')
  if (mode !== job.mode) throw new Error(`the page is in ${mode}, not ${job.mode}`)
}

// In the page: every control on screen, how far a click from its centre still lands on it each way. Self-contained.
function probeControls({ max, drawer }: { max: number; drawer: string }) {
  const SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], ' +
    'input:not([type="hidden"]), select, textarea, summary'
  const vw = window.innerWidth
  const vh = window.innerHeight
  const clean = (s: string | null) => String(s || '').replace(/\s+/g, ' ').trim()
  const labelled = (el: Element) => clean((el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map((id) => (document.getElementById(id) || { textContent: '' }).textContent || '').join(' '))
  const nameOf = (el: Element) => clean(el.getAttribute('aria-label') || labelled(el) ||
    (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '') ||
    el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 120)
  const iconOf = (el: Element) => {
    const svg = el.querySelector('svg')
    return svg ? ([...svg.classList].find((c) => c.startsWith('lucide-')) || '') : ''
  }
  const hits = (el: Element, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false
    const h = document.elementFromPoint(x, y)
    return !!h && (h === el || el.contains(h))
  }
  const reach = (el: Element, cx: number, cy: number, dx: number, dy: number, half: number) => {
    let d = Math.max(0, Math.floor(half) - 1)
    if (!hits(el, cx + dx * d, cy + dy * d)) d = 0 // something lies on part of its own box: walk out from the centre
    const limit = Math.ceil(Math.max(half, 40)) + 2
    while (d < limit && hits(el, cx + dx * (d + 1), cy + dy * (d + 1))) d += 1
    return d
  }
  const controls = []
  for (const el of document.querySelectorAll(SEL)) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue
    if (el.closest('[aria-hidden="true"], [inert], .sr-only')) continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue // below the fold: not a target on this screen
    if (!hits(el, cx, cy)) continue // under a window or a menu: not a target now
    if (controls.length >= max) break
    const inDrawer = !!el.closest(drawer)
    const wide = el.matches('[data-testid="floating-chat-toggle"], .hit-area-40') ||
      !!el.closest('[data-testid="floating-chat-panel"]') ||
      (inDrawer && el.matches('button[title="Back"], button[aria-label="Close"]')) ||
      (!!el.closest('[role="dialog"]') && el.matches('button[aria-label="Close"]'))
    // a link inside a sentence: SC 2.5.8's inline exception
    const inline = el.tagName === 'A' && cs.display === 'inline' &&
      [...((el.parentElement && el.parentElement.childNodes) || [])].some((n) => n !== el && n.nodeType === 3 && (n.textContent || '').trim() !== '')
    controls.push({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', testid: el.getAttribute('data-testid') || '',
      name: nameOf(el), icon: iconOf(el), cx, cy,
      left: reach(el, cx, cy, -1, 0, r.width / 2), right: reach(el, cx, cy, 1, 0, r.width / 2),
      up: reach(el, cx, cy, 0, -1, r.height / 2), down: reach(el, cx, cy, 0, 1, r.height / 2),
      inTable: !!el.closest('table'), inline, wide,
    })
  }
  return controls
}

// SC 2.5.8 on what the probe found: the size line, then the spacing exception with 24 px circles on the centres.
function hitFindings(controls: Control[]): Finding[] {
  const w = (c: Control) => c.left + c.right + 1
  const h = (c: Control) => c.up + c.down + 1
  const under = (c: Control, edge: number) => Math.min(w(c), h(c)) <= edge - TOLERANCE - 0.5
  const out: Finding[] = []
  for (const a of controls) {
    const size = `${w(a)}x${h(a)}${a.inTable ? ' · in table' : ''}`
    if (a.wide && under(a, WIDE)) out.push({ check: 'hit-40', key: keyOf(a), extra: size })
    if (!under(a, MIN) || a.inline) continue
    const r = MIN / 2
    const clash = controls.some((b) => {
      if (b === a) return false
      const dx = Math.max(b.cx - b.left - a.cx, 0, a.cx - (b.cx + b.right))
      const dy = Math.max(b.cy - b.up - a.cy, 0, a.cy - (b.cy + b.down))
      if (Math.hypot(dx, dy) < r) return true // its circle reaches another control
      return under(b, MIN) && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 2 * r // two small controls' circles meet
    })
    if (clash) out.push({ check: 'hit-24', key: keyOf(a), extra: size })
  }
  return out
}

// In the page: what an axe target is, by what survives the design's new classes.
function describeTargets(selectors: (string | null)[]) {
  const clean = (s: string | null) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return selectors.map((s) => {
    let el: Element | null = null
    try { el = s ? document.querySelector(s) : null } catch { el = null }
    if (!el) return { tag: '', testid: '', name: '', icon: '' }
    const svg = el.querySelector('svg')
    const owner = el.closest('[data-testid]')
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || (owner ? owner.getAttribute('data-testid') || '' : ''),
      name: clean(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || ''),
      icon: svg ? ([...svg.classList].find((c) => c.startsWith('lucide-')) || '') : '',
    }
  })
}

async function look(context: BrowserContext, job: Job): Promise<Screen> {
  const page = await context.newPage()
  try {
    await open(page, job)
    const controls = (await page.evaluate(probeControls, { max: MAX_CONTROLS, drawer: DRAWER })) as Control[]
    // options() first: it replaces every option, the runOnly withTags() sets too, and axe then runs every rule it has
    const axe = await new AxeBuilder({ page }).options({ resultTypes: ['violations', 'incomplete'] }).withTags(TAGS).analyze()
    const nodes: { kind: 'violation' | 'incomplete'; rule: string; impact: string; target: string | null; extra: string }[] = []
    for (const v of axe.violations) for (const n of v.nodes) nodes.push({ kind: 'violation', rule: v.id, impact: n.impact ?? '', target: lastSelector(n.target), extra: '' })
    for (const v of axe.incomplete) for (const n of v.nodes) {
      const data = ((n.any && n.any[0]) || { data: null }).data as { messageKey?: string } | null
      nodes.push({ kind: 'incomplete', rule: v.id, impact: n.impact ?? '', target: lastSelector(n.target), extra: data?.messageKey ?? '' })
    }
    const described = await page.evaluate(describeTargets, nodes.map((n) => n.target))
    const hits = hitFindings(controls)
    const found: Finding[] = hits.filter((f) => f.check !== 'hit-40')
    const wide: Finding[] = hits.filter((f) => f.check === 'hit-40')
    const review: Finding[] = []
    let axeTargetSize = 0
    nodes.forEach((n, i) => {
      const d = described[i]
      const f = { check: `axe:${n.rule}`, key: keyOf({ ...d, role: '' }), extra: n.extra || n.impact }
      if (n.kind === 'incomplete') review.push(f)
      else if (n.rule === 'target-size') axeTargetSize += 1
      else found.push(f)
    })
    return { id: job.id, found: dedupe(found), wide: dedupe(wide), review: dedupe(review), axeTargetSize, controls: controls.length }
  } finally {
    await page.close()
  }
}

function lastSelector(target: unknown): string | null {
  if (!Array.isArray(target) || target.length === 0) return null
  const last = target[target.length - 1]
  return typeof last === 'string' ? last : null
}

function dedupe(list: Finding[]): Finding[] {
  const seen = new Set<string>()
  return list.filter((f) => (seen.has(line(f)) ? false : (seen.add(line(f)), true)))
}

function readExempt(): Exempt[] {
  if (!fs.existsSync(EXEMPT_FILE)) return []
  const rules = JSON.parse(fs.readFileSync(EXEMPT_FILE, 'utf8')).rules as { screen: string; finding: string; why: string }[]
  return rules.map((r) => {
    if (!r.why?.trim()) throw new Error(`an exemption needs a why: ${JSON.stringify(r)}`)
    return { screen: new RegExp(r.screen), finding: new RegExp(r.finding), why: r.why }
  })
}

function report(rows: Screen[], fresh: string[], gone: string[], failed: string[]): string {
  const total = (pick: (s: Screen) => number) => rows.reduce((n, s) => n + pick(s), 0)
  const by = (check: string) => total((s) => s.found.filter((f) => f.check === check).length)
  const lines = [
    `screens ${rows.length} · controls ${total((s) => s.controls)} · axe findings ${total((s) => s.found.filter((f) => f.check.startsWith('axe:')).length)} · ` +
      `hit-24 ${by('hit-24')} · hit-40 (not judged) ${total((s) => s.wide.length)} · axe target-size (not judged) ${total((s) => s.axeTargetSize)} · ` +
      `to review ${total((s) => s.review.length)} · new ${fresh.length} · gone ${gone.length} · did not open ${failed.length}`,
    '', '| screen | finding | where |', '|---|---|---|',
  ]
  for (const s of rows) for (const f of [...s.found, ...s.wide]) lines.push(`| ${s.id} | ${f.check} | ${f.key} ${f.extra} |`)
  lines.push('', `New: ${fresh.join(' · ') || 'none'}`, `Gone: ${gone.join(' · ') || 'none'}`, `Did not open: ${failed.join(' · ') || 'none'}`)
  return lines.join('\n')
}

let ready = ''
let node = ''

test.describe('accessibility — WCAG 2.2 A and AA by axe-core, and the size of what one presses', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    if (!RUN) {
      ready = 'E2E_A11Y=1 runs the accessibility net'
      return
    }
    ready = openCluster()
    if (ready !== '') return
    ;({ node } = await applyFixtures())
  })

  test.afterAll(() => {
    if (node) removeFixtures(node)
  })

  test('every screen and drawer in every colour mode', async ({ browser }: { browser: Browser }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(3_600_000)
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.auth', 'user.json'), 'utf8')) as {
      cookies: never[]; origins: { localStorage: { name: string; value: string }[] }[]
    }
    const kept = state.origins.flatMap((o) => o.localStorage).filter((kv) => kv.name !== 'kubeast:current-cluster' && kv.name !== 'kubeast.colorMode')
    const contexts = new Map<Mode, BrowserContext>()
    for (const mode of MODES) {
      const context = await browser.newContext({ storageState: { cookies: state.cookies, origins: [] }, viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC' })
      // the app's own way: the default mode is no key at all (utils/colorMode.ts)
      await context.addInitScript(({ kept, mode }) => {
        for (const kv of kept) localStorage.setItem(kv.name, kv.value)
        if (mode === 'default') localStorage.removeItem('kubeast.colorMode')
        else localStorage.setItem('kubeast.colorMode', mode)
      }, { kept, mode })
      contexts.set(mode, context)
    }
    const exempt = readExempt()
    const baseline: Baseline | null = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null
    const failed: string[] = []
    const rows: Screen[] = []
    try {
      const list = jobs(node)
      let next = 0
      await Promise.all(Array.from({ length: AT_ONCE }, async () => {
        for (;;) {
          const job = list[next++]
          if (!job) return
          try {
            rows.push(await look(contexts.get(job.mode)!, job))
          } catch (e) {
            failed.push(`${job.id}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 160)}`)
          }
        }
      }))
      rows.sort((a, b) => a.id.localeCompare(b.id))
      const named = (id: string, f: Finding) => exempt.find((x) => x.screen.test(id) && x.finding.test(line(f)))
      const fresh: string[] = []
      const gone: string[] = []
      for (const s of rows) {
        const held = new Set(baseline?.screens[s.id] ?? [])
        for (const f of s.found) if (baseline && !held.has(line(f)) && !named(s.id, f)) fresh.push(`${s.id}: ${line(f)} (${f.extra})`)
        const now = new Set(s.found.map(line))
        for (const k of held) if (!now.has(k)) gone.push(`${s.id}: ${k}`)
      }
      const hitsLeft = rows.flatMap((s) => s.found.filter((f) => f.check.startsWith('hit-') && !named(s.id, f)).map((f) => `${s.id}: ${line(f)} (${f.extra})`))
      const text = report(rows, fresh, gone, failed)
      await test.info().attach('a11y.md', { body: text, contentType: 'text/markdown' })
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true })
        fs.writeFileSync(path.join(OUT, 'a11y.md'), text)
        fs.writeFileSync(path.join(OUT, 'a11y.json'), JSON.stringify({ rows }, null, 1))
        fs.writeFileSync(path.join(OUT, 'to-review.json'), JSON.stringify(rows.map((s) => ({ id: s.id, review: s.review })), null, 1))
      }
      console.log(text.split('\n')[0])
      if (WRITE) {
        const made = { at: new Date().toISOString(), build: process.env.E2E_A11Y_BUILD || '', axe: 'tags ' + TAGS.join(' '), playwright: test.info().config.version }
        const screens = Object.fromEntries(rows.map((s) => [s.id, s.found.map(line).sort()]))
        fs.writeFileSync(BASELINE_FILE, JSON.stringify({ made, screens } satisfies Baseline, null, 1) + '\n')
        expect(fs.existsSync(BASELINE_FILE), 'the baseline was written').toBe(true)
      }
      if (!ONLY) expect(rows.length, 'screens and drawers looked at').toBeGreaterThan(200)
      expect(failed, 'screens and drawers that did not open').toEqual([])
      if (baseline && !WRITE) expect(fresh, 'findings the baseline does not hold: fix them, or name them in a11y-exempt.json with why').toEqual([])
      if (HITS_ZERO) expect(hitsLeft, 'controls under 24 x 24 CSS px without the spacing or inline exception').toEqual([])
    } finally {
      for (const context of contexts.values()) await context.close()
    }
  })
})
