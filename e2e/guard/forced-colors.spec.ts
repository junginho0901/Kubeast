import path from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'

import { VIEWS, WRITE, general, judge, keepPicture, openView, readBaseline, report, viewContext, writeBaseline, type Findings } from './a11y-views'
import { DRAWER } from './shared'

// In forced colours (Windows contrast themes; page.emulateMedia({ forcedColors: 'active' })) the browser paints text,
// backgrounds and borders in the theme's few colours and drops box shadows. Two things then disappear without a sign:
// - "focus not shown …": a control whose keyboard focus is a ring (a box shadow) and no outline. Each screen's first
//   TABS controls after its main region (a drawer's own, for a drawer) are reached with Tab and read for an outline of
//   1px or more, named by role and name;
// - "mark lost …": a mark that says something by its fill alone — a status dot, a bar's segment: an element with no
//   text and no child, a fill of its own in normal colours, and in forced colours neither forced-color-adjust: none nor
//   a border to show it. Named by the nearest test id and landmark.
// A finding the v0.7.9 baseline (forced-colors-baseline.json) does not hold fails, unless a11y-views-intended.json
// names it (spec "forced-colors"); one the baseline holds and the screen no longer shows is listed. The picture in
// forced colours of each screen goes to E2E_A11Y_VIEWS_OUT for the people's pass (what reads well is theirs to say).

const BASELINE_FILE = path.join(__dirname, 'forced-colors-baseline.json')
const TABS = 30

test.use({ trace: 'off', screenshot: 'off' })

type Marked = Window & { __a11yMarks?: { el: Element; place: string }[] }

// In normal colours: the marks drawn by a fill alone, kept on window for the forced-colours look.
async function markFills(page: Page): Promise<number> {
  return page.evaluate(() => {
    const opaque = (c: string) => !/^(transparent|rgba\(.*,\s*0\))$/.test(c.replace(/\s+/g, ' '))
    const fillBehind = (el: Element): string => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor
        if (opaque(c)) return c
      }
      return getComputedStyle(document.body).backgroundColor
    }
    const marks: { el: Element; place: string }[] = []
    for (const el of document.body.querySelectorAll('div, span, i, b, li, td')) {
      if (el.childElementCount > 0 || (el.textContent ?? '').trim() !== '') continue
      const box = el.getBoundingClientRect()
      if (box.width < 2 || box.height < 2 || box.height > 40 || box.bottom < 0 || box.top > innerHeight) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.backgroundImage !== 'none' || !opaque(style.backgroundColor) || style.backgroundColor === fillBehind(el)) continue
      const testid = el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
      const landmark = el.closest('nav, main, header, aside, [role="dialog"], [role="complementary"]')
      marks.push({ el, place: `${landmark ? (landmark.getAttribute('role') ?? landmark.tagName.toLowerCase()) : 'page'}${testid ? ` [${testid}]` : ''}` })
    }
    ;(window as Marked).__a11yMarks = marks
    return marks.length
  })
}

// In forced colours: the marks nothing shows any more.
async function lostMarks(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => ((window as Marked).__a11yMarks ?? []).filter(({ el }) => {
    const style = getComputedStyle(el)
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const s = style as unknown as Record<string, string>
      return s[`border${side}Style`] !== 'none' && parseFloat(s[`border${side}Width`]) >= 1
    })
    return el.isConnected && style.getPropertyValue('forced-color-adjust') !== 'none' && !border
  }).map(({ place }) => place))
  return [...new Set(raw.map(general))]
}

// Tab through the first controls after `start`; each one whose focus shows no outline.
async function focusWithoutOutline(page: Page, start: Locator): Promise<string[]> {
  await start.evaluate((el) => {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    ;(el as HTMLElement).focus()
  })
  const out: string[] = []
  for (let i = 0; i < TABS; i++) {
    await page.keyboard.press('Tab')
    const seen = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const style = getComputedStyle(el)
      const name = (el.getAttribute('aria-label') || (el.textContent ?? '').trim() || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 60)
      return { who: `${el.getAttribute('role') ?? el.tagName.toLowerCase()} "${name}"`, shown: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1 }
    })
    if (!seen) break
    if (!seen.shown) out.push(general(seen.who))
  }
  return [...new Set(out)]
}

test.describe('forced colours on the main screens', () => {
  test('show every focus and every mark drawn by its fill', async ({ browser }) => {
    const baseline = WRITE ? null : readBaseline(BASELINE_FILE)
    test.skip(!WRITE && !baseline, 'no forced-colors-baseline.json: write it on the v0.7.9 install with E2E_A11Y_VIEWS_WRITE=1')
    test.setTimeout(900_000)
    const context = await viewContext(browser, { forcedColors: 'none' })
    const found: Findings = {}
    const failed: string[] = []
    let forced = 0
    let marks = 0
    try {
      for (const view of VIEWS) {
        const page = await context.newPage()
        try {
          await openView(page, view)
          marks += await markFills(page)
          await page.emulateMedia({ forcedColors: 'active' })
          if (await page.evaluate(() => matchMedia('(forced-colors: active)').matches)) forced++
          const list = (await lostMarks(page)).map((m) => `mark lost in ${m}`)
          const start = view.drawer ? page.locator(DRAWER).last() : page.locator('main').first()
          list.push(...(await focusWithoutOutline(page, start)).map((w) => `focus not shown on ${w}`))
          await page.mouse.move(0, 0)
          keepPicture('forced-colors', view, 'forced', await page.screenshot({ animations: 'disabled', caret: 'hide' }))
          found[view.id] = [...new Set(list)].sort()
        } catch (e) {
          failed.push(`${view.id}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 160)}`)
        } finally {
          await page.close()
        }
      }
    } finally {
      await context.close()
    }
    // forced colours reached every page and the screens had marks to look at (the dashboard's bars, the status dots)
    expect(forced, 'pages that read forced-colors: active').toBe(VIEWS.length - failed.length)
    expect(marks, 'marks drawn by their fill on the main screens').toBeGreaterThan(10)
    if (WRITE) {
      writeBaseline(BASELINE_FILE, found)
      await report('forced-colors', null, found, failed)
      expect(failed, 'screens that did not open').toEqual([])
      expect(Object.keys(found)).toEqual(VIEWS.map((v) => v.id))
      return
    }
    const judged = judge('forced-colors', found, baseline!.views)
    await report('forced-colors', judged, found, failed)
    expect(failed, 'screens that did not open').toEqual([])
    expect(judged.added, 'a focus or a mark that forced colours hide and v0.7.9 did not').toEqual([])
    expect(judged.unusedRules, 'rules that passed nothing').toEqual([])
  })
})
