import fs from 'node:fs'
import path from 'node:path'

import { test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test'

import { BASE, CLUSTER, DRAWER, quiet, track } from './shared'

// What the three accessibility views share (aria-tree, reduced-motion and forced-colors specs): the
// main screens, a context as the signed-in user in the default colour mode at 1440 x 900, findings named so that a new
// class or a moving count does not change them, a baseline written at a release tag that later builds may only shrink,
// and the rules (a11y-views-intended.json) that let a difference a PR means pass with why and the PR.
// E2E_A11Y_VIEWS=1 runs them (playwright.config.ts, guard project). E2E_A11Y_VIEWS_WRITE=1 writes what a run found as
// each spec's baseline, at the v0.7.9 tag, E2E_A11Y_VIEWS_TAG naming it. E2E_A11Y_VIEWS_OUT=
// <dir> keeps the tables and pictures. Without its baseline file a spec skips and says so.

export const WRITE = process.env.E2E_A11Y_VIEWS_WRITE === '1'
export const OUT = process.env.E2E_A11Y_VIEWS_OUT || ''
const TAG = process.env.E2E_A11Y_VIEWS_TAG || ''
const VIEWPORT = { width: 1440, height: 900 }

export type View = { id: string; url: string; drawer: boolean }
const on = (p: string) => `${p}${p.includes('?') ? '&' : '?'}cluster=${CLUSTER}`
const drawer = (ref: string) => `/account?cluster=${CLUSTER}&detail=${encodeURIComponent(ref)}`
// one of each kind of screen the design reworks: the dashboard, the node map, charts, lists with and without filters,
// a list of releases, an admin list, the settings page and two drawers of objects every kind cluster has
export const VIEWS: View[] = [
  ...['/', '/cluster-view', '/monitoring', '/workloads/pods', '/workloads/deployments', '/cluster/nodes', '/network/services', '/helm/releases', '/admin/users', '/account']
    .map((p) => ({ id: p, url: on(p), drawer: false })),
  { id: 'drawer Namespace kube-system', url: drawer('Namespace/kube-system'), drawer: true },
  { id: 'drawer Deployment kube-system/coredns', url: drawer('Deployment/kube-system/coredns'), drawer: true },
]

// The signed-in user of the setup project in a new context: the stored cluster choice left out, so ?cluster= decides.
export async function viewContext(browser: Browser, media: Pick<BrowserContextOptions, 'reducedMotion' | 'forcedColors'> = {}): Promise<BrowserContext> {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.auth', 'user.json'), 'utf8')) as {
    cookies: never[]; origins: { localStorage: { name: string; value: string }[] }[]
  }
  const kept = state.origins.flatMap((o) => o.localStorage).filter((kv) => kv.name !== 'kubeast:current-cluster')
  const context = await browser.newContext({ storageState: { cookies: state.cookies, origins: [] }, viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC', ...media })
  await context.addInitScript((kept) => {
    for (const kv of kept) localStorage.setItem(kv.name, kv.value)
    localStorage.setItem('kubeast.colorMode', 'default')
  }, kept)
  return context
}

// The screen once its reads have answered (a drawer once it is open); throws when it did not settle.
export async function openView(page: Page, view: View, base = BASE): Promise<void> {
  const t = track(page)
  await page.goto(base + view.url)
  t.last = Date.now()
  await quiet(page, t, 500)
  if (view.drawer) await page.locator(DRAWER).last().waitFor({ state: 'visible', timeout: 20_000 })
  if (!(await quiet(page, t, 500)) && !(await quiet(page, t, 500))) throw new Error('the screen kept reading')
}

// A name that survives a run's own objects and a moving count or time: pod suffixes, digits and "5 minutes ago".
export function general(s: string): string {
  return s
    .replace(/\b(?:a|an|\d+) (?:second|minute|hour|day|week|month|year)s? ago\b/g, '<ago>')
    .replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}\b/g, '-*')
    .replace(/-[a-z0-9]{5}\b/g, '-*')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export type Findings = Record<string, string[]>
type Baseline = { made: { tag: string; at: string }; views: Findings }

export function readBaseline(file: string): Baseline | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline) : null
}

export function writeBaseline(file: string, views: Findings): void {
  fs.writeFileSync(file, `${JSON.stringify({ made: { tag: TAG, at: new Date().toISOString() }, views }, null, 1)}\n`)
}

// The rules a PR adds for a difference it means; a rule that passes nothing fails too, so it cannot hide the next one.
type Rule = { spec: string; view: string; finding: string; why: string; pr: string }
const RULES = (JSON.parse(fs.readFileSync(path.join(__dirname, 'a11y-views-intended.json'), 'utf8')) as { rules: Rule[] }).rules

export type Judged = { added: string[]; intended: string[]; gone: string[]; unusedRules: string[] }

// What a run found against the baseline, view by view and finding by finding (each counted as often as it came).
export function judge(spec: string, found: Findings, baseline: Findings): Judged {
  const rules = RULES.filter((r) => r.spec === spec).map((r) => ({ r, view: new RegExp(r.view), finding: new RegExp(r.finding), used: false }))
  const out: Judged = { added: [], intended: [], gone: [], unusedRules: [] }
  for (const view of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
    const left = [...(baseline[view] ?? [])]
    for (const f of found[view] ?? []) {
      const i = left.indexOf(f)
      if (i >= 0) {
        left.splice(i, 1)
        continue
      }
      const rule = rules.find((x) => x.view.test(view) && x.finding.test(f))
      if (rule) {
        rule.used = true
        out.intended.push(`${view}: ${f} (${rule.r.pr}: ${rule.r.why})`)
      } else out.added.push(`${view}: ${f}`)
    }
    out.gone.push(...left.map((f) => `${view}: ${f}`))
  }
  out.unusedRules = rules.filter((x) => !x.used).map((x) => `${x.r.view} ${x.r.finding} (${x.r.pr})`)
  return out
}

export async function report(name: string, judged: Judged | null, found: Findings, failed: string[]): Promise<void> {
  const lines = [`# ${name}`, '', `views: ${Object.keys(found).length}, did not open: ${failed.length}`]
  if (judged) {
    for (const [title, list] of [['new', judged.added], ['intended', judged.intended], ['gone since the baseline', judged.gone], ['rules that passed nothing', judged.unusedRules]] as const) {
      lines.push('', `## ${title} (${list.length})`, ...list.map((l) => `- ${l}`))
    }
  }
  lines.push('', '## did not open', ...failed.map((l) => `- ${l}`))
  const body = `${lines.join('\n')}\n`
  await test.info().attach(`${name}.md`, { body, contentType: 'text/markdown' })
  await test.info().attach(`${name}.json`, { body: JSON.stringify({ found, judged, failed }, null, 1), contentType: 'application/json' })
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `${name}.md`), body)
  }
}

export function keepPicture(spec: string, view: View, kind: string, picture: Buffer): void {
  if (!OUT) return
  const dir = path.join(OUT, spec)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${view.id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dashboard'}.${kind}.png`), picture)
}
