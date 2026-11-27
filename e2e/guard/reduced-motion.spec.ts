import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { VIEWS, WRITE, general, judge, keepPicture, openView, readBaseline, report, viewContext, writeBaseline, type Findings } from './a11y-views'
import { comparePictures } from './screen-compare'

// With reduced motion asked for (context reducedMotion: 'reduce'), DESIGN.md "Interaction" has the console's menus,
// disclosures, chevrons, meters and waiting indicators stand still, and the screen at rest look as it does without it.
// For each main screen, in the default colour mode at 1440 x 900, the findings are:
// - "moving …": an animation or transition running once the screen settled, and right after a sidebar group was opened
//   (named by its kind and where it is — the nearest test id and landmark — not by a class the design may rename);
// - "at rest differs": the picture with reduce and without it (animations stopped in both, old-new-old so that what
//   moves by itself is noise) differ by more than screen-compare's faint pixels.
// A finding the v0.7.9 baseline (reduced-motion-baseline.json) does not hold fails, unless a11y-views-intended.json
// names it (spec "reduced-motion"); one the baseline holds and the screen no longer shows is listed. The reduce picture
// of each screen goes to E2E_A11Y_VIEWS_OUT for the people's pass.
// The AI welcome particles and the sign-in scene keep moving by design: they draw on a canvas, which no CSS animation
// list holds, and neither is one of these screens.

const BASELINE_FILE = path.join(__dirname, 'reduced-motion-baseline.json')

test.use({ trace: 'off', screenshot: 'off' })

// The animations running in the page, each named by kind and place.
async function moving(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null
    const el = target instanceof Element ? target : null
    const kind = typeof CSSTransition !== 'undefined' && a instanceof CSSTransition ? `transition of ${a.transitionProperty}` : typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation ? 'animation' : 'script animation'
    const testid = el?.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
    const landmark = el?.closest('nav, main, header, aside, [role="dialog"], [role="complementary"]')
    const place = landmark ? (landmark.getAttribute('role') ?? landmark.tagName.toLowerCase()) : 'page'
    return `${kind} in ${place}${testid ? ` [${testid}]` : ''}`
  }))
  return raw.map(general)
}

const picture = (page: Page) => page.screenshot({ animations: 'disabled', caret: 'hide' })

test.describe('reduced motion on the main screens', () => {
  test('stand still and look the same at rest', async ({ browser }) => {
    const baseline = WRITE ? null : readBaseline(BASELINE_FILE)
    test.skip(!WRITE && !baseline, 'no reduced-motion-baseline.json: write it on the v0.7.9 install with E2E_A11Y_VIEWS_WRITE=1')
    test.setTimeout(900_000)
    const context = await viewContext(browser, { reducedMotion: 'reduce' })
    const tools = await browser.newContext()
    const compare = await tools.newPage()
    const found: Findings = {}
    const failed: string[] = []
    let asked = 0
    try {
      for (const view of VIEWS) {
        const page = await context.newPage()
        try {
          await openView(page, view)
          if (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) asked++
          const list = (await moving(page)).map((m) => `moving ${m}`)
          const group = page.getByTestId('sidebar-nav').locator(':scope > div > button').first()
          if (!view.drawer && (await group.count()) === 1) {
            await group.click()
            list.push(...(await moving(page)).map((m) => `moving after a sidebar group opened: ${m}`))
            await group.click()
          }
          const reduce = await picture(page)
          await page.emulateMedia({ reducedMotion: 'no-preference' })
          const plain = await picture(page)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          const again = await picture(page)
          if ((await comparePictures(compare, reduce, again)).pixels === 0 && (await comparePictures(compare, reduce, plain)).pixels > 0) list.push('at rest differs')
          keepPicture('reduced-motion', view, 'reduce', reduce)
          found[view.id] = [...new Set(list)].sort()
        } catch (e) {
          failed.push(`${view.id}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 160)}`)
        } finally {
          await page.close()
        }
      }
    } finally {
      await tools.close()
      await context.close()
    }
    // the context's setting reached every page: without it every check below passes on a screen that moves
    expect(asked, 'pages that read prefers-reduced-motion: reduce').toBe(VIEWS.length - failed.length)
    if (WRITE) {
      writeBaseline(BASELINE_FILE, found)
      await report('reduced-motion', null, found, failed)
      expect(failed, 'screens that did not open').toEqual([])
      expect(Object.keys(found)).toEqual(VIEWS.map((v) => v.id))
      return
    }
    const judged = judge('reduced-motion', found, baseline!.views)
    await report('reduced-motion', judged, found, failed)
    expect(failed, 'screens that did not open').toEqual([])
    expect(judged.added, 'motion or a changed picture at rest that v0.7.9 did not have').toEqual([])
    expect(judged.unusedRules, 'rules that passed nothing').toEqual([])
  })
})
