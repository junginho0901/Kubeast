import { test, expect, type Page } from '@playwright/test'

import { comparePictures, compileIntended, FAINT_DELTA, FAINT_PIXELS, TOLERANCE } from './screen-compare'

// The picture comparison on its own, with pictures drawn in the browser: no cluster.

async function picture(page: Page, draw: string): Promise<Buffer> {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#101010">${draw}</body></html>`)
  return page.screenshot()
}
const square = (colour: string, left = 10) => `<div style="position:absolute;left:${left}px;top:20px;width:30px;height:10px;background:${colour}"></div>`
const grey = (n: number) => `rgb(${n},${n},${n})`

test.describe('the picture comparison', () => {
  test.use({ viewport: { width: 100, height: 60 }, storageState: { cookies: [], origins: [] } })

  test('the same picture has no differing pixels', async ({ page }) => {
    const a = await picture(page, square('#fff'))
    expect(await comparePictures(page, a, a)).toMatchObject({ pixels: 0, box: null, marked: null })
  })

  test('a moved shape is found by value, with where it is and a marked picture', async ({ page }) => {
    const a = await picture(page, square('#fff'))
    const b = await picture(page, square('#fff', 20))
    const out = await comparePictures(page, a, b)
    expect(out.pixels).toBe(10 * 10 * 2) // the left strip it left and the right strip it took
    expect(out.box).toEqual({ x: 10, y: 20, width: 40, height: 10 })
    expect(out.size).toBe('100x60')
    expect(out.marked?.subarray(1, 4).toString(), 'the marked picture is a PNG').toBe('PNG')
  })

  test('one pixel is enough', async ({ page }) => {
    const a = await picture(page, '')
    const b = await picture(page, '<div style="position:absolute;left:5px;top:5px;width:1px;height:1px;background:#fff"></div>')
    expect(await comparePictures(page, a, b)).toMatchObject({ pixels: 1, box: { x: 5, y: 5, width: 1, height: 1 } })
  })

  test('a colour change past the tolerance counts and one within it does not', async ({ page }) => {
    const base = await picture(page, square(grey(100)))
    const within = await picture(page, square(grey(100 + TOLERANCE)))
    const past = await picture(page, square(grey(100 + TOLERANCE + 1)))
    expect((await comparePictures(page, base, within)).pixels).toBe(0)
    expect((await comparePictures(page, base, past)).pixels).toBe(30 * 10)
  })

  test('a few faint pixels are a redraw; more of them, or one strong one, are a difference', async ({ page }) => {
    const spot = (colour: string, width: number) => `<div style="position:absolute;left:5px;top:5px;width:${width}px;height:1px;background:${colour}"></div>`
    const base = await picture(page, spot(grey(100), FAINT_PIXELS + 1))
    const faint = (width: number) => picture(page, spot(grey(100), FAINT_PIXELS + 1) + spot(grey(100 + FAINT_DELTA), width))
    expect((await comparePictures(page, base, await faint(FAINT_PIXELS))).pixels, 'as many as a redraw moves').toBe(0)
    expect((await comparePictures(page, base, await faint(FAINT_PIXELS + 1))).pixels, 'one more').toBe(FAINT_PIXELS + 1)
    const strong = await picture(page, spot(grey(100), FAINT_PIXELS + 1) + spot(grey(100 + FAINT_DELTA + 1), 1))
    expect((await comparePictures(page, base, strong)).pixels, 'one pixel moved further').toBe(1)
  })

  test('pictures of two sizes differ where only one has pixels', async ({ page }) => {
    const small = await picture(page, '')
    await page.setViewportSize({ width: 100, height: 70 })
    const tall = await picture(page, '')
    const out = await comparePictures(page, small, tall)
    expect(out.pixels).toBe(100 * 10)
    expect(out.size).toBe('100x60 / 100x70')
  })

  test('an intended change names its screens; one with no reason or PR is refused', () => {
    const match = compileIntended([{ screen: '/workloads/pods', why: 'because', pr: '#1' }])
    expect(match('default · /workloads/pods on self')?.pr).toBe('#1')
    expect(match('default · /cluster/nodes on self')).toBeNull()
    expect(() => compileIntended([{ screen: 'x', why: '', pr: '#1' }])).toThrow(/reason and a PR/)
    expect(() => compileIntended([{ screen: 'x', why: 'y', pr: '' }])).toThrow(/reason and a PR/)
  })
})
