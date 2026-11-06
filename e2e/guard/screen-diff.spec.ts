import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

import { comparePictures, compileIntended, type IntendedRule } from './screen-compare'
import { CLUSTER, DRAWER, DRAWER_KINDS, DRAWERS, BASE, ROLES, SIDEBAR, applyFixtures, drawerTargets, openCluster, quiet, removeFixtures, track } from './shared'

// Safety net (b), the screen comparison: the build under test against the build it replaces, picture by picture. Every
// sidebar screen, /account and a drawer of every kind on self in each colour mode, and the sidebar on default and
// test2, opened on both builds at the same moment with the clock fixed. Two pictures that differ are looked at again
// (old, new, old: old differing from itself is noise) and, a minute later when each build's cache has expired, once
// more; what still differs fails unless screen-diff-intended.json names it with a reason and a PR. A selector in
// screen-diff-masks.json covers a value that moves by itself, with why.
// Needs scripts/before-stack.sh up <tag>, E2E_BEFORE_URL and E2E_SCREEN_DIFF=1; E2E_DIFF_OUT keeps the table and the
// pictures of each difference in a directory.

const BEFORE = (process.env.E2E_BEFORE_URL || '').replace(/\/$/, '')
const OUT = process.env.E2E_DIFF_OUT || ''
const read = <T>(file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')) as T
const intended = compileIntended(read<{ rules: IntendedRule[] }>('screen-diff-intended.json').rules)
const MASKS = read<{ rules: { screen: string; selector: string; why: string }[] }>('screen-diff-masks.json').rules.map((r) => ({ ...r, screen: new RegExp(r.screen) }))
const MODES = ['default', 'dark', 'light'] as const
const OTHER_CLUSTERS = ['default', 'test2']
const VIEWPORT = { width: 1440, height: 1600 }
const PAIRS_AT_ONCE = 3
const SECOND_LOOK_MS = 65_000
// E2E_SCREEN_ONLY=<regular expression> compares only the screens it matches, to look at one again
const ONLY = process.env.E2E_SCREEN_ONLY ? new RegExp(process.env.E2E_SCREEN_ONLY) : null

type Mode = (typeof MODES)[number]
type Job = { id: string; mode: Mode; url: string; drawer: boolean }
type Row = { id: string; verdict: 'same' | 'noise' | 'real' | 'intended'; pixels: number; box: unknown; size: string; why?: string; pr?: string }

test.use({ trace: 'off', screenshot: 'off' }) // this net's own pictures are its record

const withCluster = (p: string, cluster: string) => `${p}${p.includes('?') ? '&' : '?'}cluster=${cluster}`

function jobs(node: string): Job[] {
  const list: Job[] = []
  for (const mode of MODES) {
    for (const p of [...new Set(SIDEBAR), '/account']) list.push({ id: `${mode} · ${p} on ${CLUSTER}`, mode, url: withCluster(p, CLUSTER), drawer: false })
    for (const [kind, d] of Object.entries(DRAWERS)) {
      if ('skip' in d) continue
      for (const t of drawerTargets(kind, d, ROLES[0], node)) {
        const api = t.api ? `&detailApi=${encodeURIComponent(t.api)}` : ''
        list.push({ id: `${mode} · drawer ${kind} (${t.view})`, mode, url: `/account?cluster=${CLUSTER}&detail=${encodeURIComponent(t.ref)}${api}`, drawer: true })
      }
    }
  }
  for (const cluster of OTHER_CLUSTERS) {
    for (const p of [...new Set(SIDEBAR)]) list.push({ id: `default · ${p} on ${cluster}`, mode: 'default', url: withCluster(p, cluster), drawer: false })
  }
  return list
}

async function open(page: Page, base: string, job: Job): Promise<void> {
  const t = track(page)
  await page.goto(base + job.url)
  await quiet(page, t, 500)
  if (job.drawer) await page.locator(DRAWER).last().waitFor({ state: 'visible', timeout: 20_000 }).then(() => quiet(page, t, 500))
}

// A graph lays itself out some time after its data came, and on a busy machine two pictures can match before that.
async function graphAtRest(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport').first()
  if ((await viewport.count()) === 0) return
  const end = Date.now() + 15_000
  let last: string | null = null
  let since = Date.now()
  while (Date.now() < end && Date.now() - since < 1_500) {
    const now = await viewport.getAttribute('style')
    if (now !== last) {
      last = now
      since = Date.now()
    }
    await page.waitForTimeout(100)
  }
}

// A picture once two in a row are the same, or the last of six.
async function steady(page: Page, job: Job): Promise<Buffer> {
  await graphAtRest(page)
  const mask = (): Locator[] => MASKS.filter((m) => m.screen.test(job.id)).map((m) => page.locator(m.selector))
  let last: Buffer | null = null
  for (let i = 0; i < 6; i++) {
    const shot = await page.screenshot({ animations: 'disabled', caret: 'hide', mask: mask() })
    if (last?.equals(shot)) return shot
    last = shot
    await page.waitForTimeout(400)
  }
  return last!
}

function keepPictures(job: Job, pictures: Record<string, Buffer | null>): void {
  if (!OUT) return
  const name = job.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const dir = path.join(OUT, 'pictures')
  fs.mkdirSync(dir, { recursive: true })
  for (const [kind, picture] of Object.entries(pictures)) if (picture) fs.writeFileSync(path.join(dir, `${name}.${kind}.png`), picture)
}

async function look(context: BrowserContext, compare: Page, job: Job): Promise<Row> {
  const [old, fresh] = [await context.newPage(), await context.newPage()]
  try {
    await Promise.all([open(old, BEFORE, job), open(fresh, BASE, job)])
    // a screen that drew nothing is no comparison: both builds failing the same way must not pass
    const text = await fresh.locator('body').innerText()
    if (text.trim().length < 20) throw new Error('the new build drew nothing')
    const a = await steady(old, job)
    const b = await steady(fresh, job)
    const first = await comparePictures(compare, a, b)
    if (first.pixels === 0) return { id: job.id, verdict: 'same', pixels: 0, box: null, size: first.size }
    const again = await steady(old, job)
    const self = await comparePictures(compare, a, again)
    if (self.pixels > 0) {
      keepPictures(job, { old: a, again, marked: self.marked })
      return { id: job.id, verdict: 'noise', pixels: self.pixels, box: self.box, size: self.size }
    }
    keepPictures(job, { old: a, new: b, marked: first.marked })
    return { id: job.id, verdict: 'real', pixels: first.pixels, box: first.box, size: first.size }
  } finally {
    await Promise.all([old.close(), fresh.close()])
  }
}

function table(rows: Row[], failed: string[]): string {
  const count = (v: Row['verdict']) => rows.filter((r) => r.verdict === v).length
  const lines = [
    `screens ${rows.length} · same ${count('same')} · real ${count('real')} · intended ${count('intended')} · noise ${count('noise')} · did not open ${failed.length}`,
    '', '| screen | verdict | pixels | where | why |', '|---|---|---|---|---|',
  ]
  const order: Row['verdict'][] = ['real', 'intended', 'noise']
  for (const v of order) {
    for (const r of rows.filter((x) => x.verdict === v)) {
      lines.push(`| ${r.id} | ${r.verdict} | ${r.pixels} | ${JSON.stringify(r.box)} | ${r.why ? `${r.why} (${r.pr})` : ''} |`)
    }
  }
  lines.push('', `Did not open: ${failed.join(' · ') || 'none'}`)
  return lines.join('\n')
}

let ready = ''
let node = ''

test('the table has a drawer for every kind the code lists', () => {
  expect(DRAWER_KINDS.filter((k) => !(k in DRAWERS)), 'drawer kinds the table lacks').toEqual([])
})

test.describe('screen comparison — the new build looks as the old one, but for what a PR says', () => {
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

  test('every screen and drawer in every colour mode', async ({ browser }: { browser: Browser }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(3_600_000)
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.auth', 'user.json'), 'utf8')) as {
      cookies: never[]; origins: { localStorage: { name: string; value: string }[] }[]
    }
    const kept = state.origins.flatMap((o) => o.localStorage).filter((kv) => kv.name !== 'kubeast:current-cluster')
    const now = new Date()
    const contexts = new Map<Mode, BrowserContext>()
    for (const mode of MODES) {
      const context = await browser.newContext({ storageState: { cookies: state.cookies, origins: [] }, viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC' })
      await context.clock.setFixedTime(now)
      await context.addInitScript(({ kept, mode }) => {
        for (const kv of kept) localStorage.setItem(kv.name, kv.value)
        localStorage.setItem('kubeast.colorMode', mode)
      }, { kept, mode })
      contexts.set(mode, context)
    }
    const tools = await browser.newContext()
    const compare = await tools.newPage()
    const failed: string[] = []
    const pass = async (list: Job[]) => {
      const rows: Row[] = []
      let next = 0
      await Promise.all(Array.from({ length: PAIRS_AT_ONCE }, async () => {
        for (;;) {
          const job = list[next++]
          if (!job) return
          try {
            rows.push(await look(contexts.get(job.mode)!, compare, job))
          } catch (e) {
            failed.push(`${job.id}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 160)}`)
          }
        }
      }))
      return rows
    }
    try {
      const all = jobs(node).filter((j) => !ONLY || ONLY.test(j.id))
      const first = await pass(all)
      const doubtful = new Set(first.filter((r) => r.verdict === 'real').map((r) => r.id))
      let rows = first
      if (doubtful.size > 0) {
        await new Promise((r) => setTimeout(r, SECOND_LOOK_MS))
        const second = new Map((await pass(all.filter((j) => doubtful.has(j.id)))).map((r) => [r.id, r]))
        rows = first.map((r) => (doubtful.has(r.id) ? (second.get(r.id) ?? r) : r))
      }
      rows = rows.map((r) => {
        const rule = r.verdict === 'real' ? intended(r.id) : null
        return rule ? { ...r, verdict: 'intended' as const, why: rule.why, pr: rule.pr } : r
      })
      const report = table(rows, failed)
      await test.info().attach('screen-diff.md', { body: report, contentType: 'text/markdown' })
      await test.info().attach('screen-diff.json', { body: JSON.stringify({ rows }, null, 1), contentType: 'application/json' })
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true })
        fs.writeFileSync(path.join(OUT, 'screen-diff.md'), report)
        fs.writeFileSync(path.join(OUT, 'screen-diff.json'), JSON.stringify({ rows }, null, 1))
      }
      console.log(report.split('\n')[0])
      // nearly every screen compared: noise on many would be a comparison that says little
      if (!ONLY) expect(rows.length, 'screens compared').toBeGreaterThan(300)
      expect(rows.filter((r) => r.verdict === 'noise').length / rows.length, 'share of screens that move by themselves').toBeLessThan(0.1)
      expect(failed, 'screens and drawers that did not open').toEqual([])
      expect(rows.filter((r) => r.verdict === 'real').map((r) => `${r.id}: ${r.pixels} pixels at ${JSON.stringify(r.box)}`), 'a change a PR means goes in screen-diff-intended.json with a reason and a PR').toEqual([])
    } finally {
      await tools.close()
      for (const context of contexts.values()) await context.close()
    }
  })
})
