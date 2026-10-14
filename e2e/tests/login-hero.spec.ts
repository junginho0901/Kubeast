import { test, expect, type Page } from '@playwright/test'

// The sign-in page's left side: the icon drawn as particles that come in from all over the window on load
// and give way to the pointer, Kubernetes resource names around it in two depth layers that respond to hover, a
// plain list on narrow screens, and a still picture for reduced motion.

test.use({ storageState: { cookies: [], origins: [] } })

// Opaque pixels of the particle canvas within radius (CSS px) of a point in the hero box. The canvas covers
// the window, so the point is moved by where the hero sits in it.
async function inkAround(page: Page, x: number, y: number, radius: number): Promise<number> {
  return page.getByTestId('login-particles').evaluate(
    (canvas: HTMLCanvasElement, [hx, hy, r]) => {
      const hero = canvas.closest('[data-testid="login-hero"]')!.getBoundingClientRect()
      const [cx, cy] = [hero.left + hx, hero.top + hy]
      const dpr = canvas.width / canvas.clientWidth
      const ctx = canvas.getContext('2d')
      if (!ctx) return -1
      const size = Math.ceil(r * 2 * dpr)
      const data = ctx.getImageData(Math.floor((cx - r) * dpr), Math.floor((cy - r) * dpr), size, size).data
      let ink = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 40) ink++
      return ink
    },
    [x, y, radius] as [number, number, number],
  )
}

const rectsApart = (a: DOMRect | { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

// The page once the way in is over.
async function openSettled(page: Page) {
  await page.goto('/login')
  await expect(page.getByTestId('login-hero')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 })
}

test.describe('sign-in page particle hero', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('on load the dots and names come in from all over the window and settle', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'commit' })
    // the first frames after the dots are made: the icon's centre still empty, the names still hidden
    const early = await page.evaluate(
      () =>
        new Promise<{ ink: number; opacity: number; state: string }>((resolve) => {
          let frames = 0
          const tick = () => {
            const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="login-particles"]')
            if (!canvas?.dataset.dots || ++frames < 2) return requestAnimationFrame(tick)
            const dpr = canvas.width / canvas.clientWidth
            const r = 30
            const hero = canvas.closest('[data-testid="login-hero"]')!.getBoundingClientRect()
            const cx = hero.left + hero.width / 2
            const cy = hero.top + hero.height / 2 - hero.height * 0.12
            const size = Math.ceil(r * 2 * dpr)
            const data = canvas.getContext('2d')!.getImageData(Math.floor((cx - r) * dpr), Math.floor((cy - r) * dpr), size, size).data
            let ink = 0
            for (let i = 3; i < data.length; i += 4) if (data[i] > 40) ink++
            const words = [...document.querySelectorAll<HTMLElement>('[data-testid="login-word"]')].map((e) => e.parentElement!)
            const opacity = words.reduce((sum, w) => sum + Number(w.style.opacity || '1'), 0) / words.length
            resolve({ ink, opacity, state: document.querySelector<HTMLElement>('[data-testid="login-hero"]')!.dataset.state ?? '' })
          }
          requestAnimationFrame(tick)
        }),
    )
    expect(early.state).toBe('entering')
    expect(early.opacity).toBeLessThan(0.5)

    const hero = page.getByTestId('login-hero')
    await expect(hero).toHaveAttribute('data-state', 'ready', { timeout: 10_000 })
    const box = (await hero.boundingBox())!
    const settled = await inkAround(page, box.width / 2, box.height / 2 - box.height * 0.12, 30)
    expect(settled).toBeGreaterThan(200)
    // at first only the few dots that happened to start there
    expect(early.ink).toBeLessThan(settled * 0.3)
    // landed: nothing left faded or out of focus
    const left = await page.getByTestId('login-word').evaluateAll((els) => els.filter((e) => e.parentElement!.style.opacity || e.parentElement!.style.filter).length)
    expect(left).toBe(0)
  })

  test('draws the icon as particles and places the resource names in two layers', async ({ page }) => {
    await openSettled(page)
    const hero = page.getByTestId('login-hero')
    await expect(hero).toBeVisible()
    await expect.poll(async () => Number(await page.getByTestId('login-particles').getAttribute('data-dots')), { timeout: 10_000 }).toBeGreaterThan(1000)
    const box = (await hero.boundingBox())!
    // particles gathered at the icon: ink at the centre once they settle
    await expect.poll(() => inkAround(page, box.width / 2, box.height / 2 - box.height * 0.12, 30), { timeout: 10_000 }).toBeGreaterThan(200)

    const near = page.getByTestId('login-word')
    await expect(near).toHaveCount(12)
    await expect(near.first()).toHaveText(/^[A-Z][A-Za-z]+$/)
    const nearBoxes = await near.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
    for (const r of nearBoxes) {
      expect(r.left).toBeGreaterThanOrEqual(box.x - 20)
      expect(r.right).toBeLessThanOrEqual(box.x + box.width + 20)
    }
    for (let i = 0; i < nearBoxes.length; i++)
      for (let j = i + 1; j < nearBoxes.length; j++) expect(rectsApart(nearBoxes[i], nearBoxes[j]), `${i}/${j}`).toBe(true)
    expect(await page.getByTestId('login-ambient').count()).toBeGreaterThanOrEqual(15)
    // the far layer is dimmer and softer than the near one
    const farStyle = await page.getByTestId('login-ambient').first().evaluate((e) => ({ o: Number(getComputedStyle(e).opacity), f: getComputedStyle(e).filter }))
    expect(farStyle.o).toBeLessThan(0.55)
    expect(farStyle.f).toContain('blur')
    // the h1 logo stays (brand-icon.spec.ts)
    await expect(page.locator('h1').getByTestId('brand-logo')).toHaveAttribute('src', '/icon.svg')
  })

  test('particles give way around the pointer and come back', async ({ page }) => {
    await openSettled(page)
    const box = (await page.getByTestId('login-hero').boundingBox())!
    const px = box.width / 2
    const py = box.height / 2 - box.height * 0.12
    await expect.poll(() => inkAround(page, px, py, 14), { timeout: 10_000 }).toBeGreaterThan(80)
    const before = await inkAround(page, px, py, 14)
    await page.mouse.move(box.x + px, box.y + py, { steps: 6 })
    await expect.poll(() => inkAround(page, px, py, 14), { timeout: 5000 }).toBeLessThan(before * 0.6)
    await page.mouse.move(box.x + 5, box.y + 5, { steps: 6 })
    await expect.poll(() => inkAround(page, px, py, 14), { timeout: 8000 }).toBeGreaterThan(before * 0.75)
  })

  // The names float all the time, so Playwright's hover (which waits for the element to stand still) never
  // fires: move the pointer onto the middle of the name instead.
  const pointAt = async (page: Page, loc: ReturnType<Page['getByTestId']>) => {
    const b = (await loc.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 })
  }

  test('a name grows and brightens under the pointer, the far layer less and into focus', async ({ page }) => {
    await openSettled(page)
    // the widest near name: the pointer stays on it while the layer shifts with the pointer
    const near = page.getByTestId('login-word')
    const widths = await near.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
    const nearWord = near.nth(widths.indexOf(Math.max(...widths)))
    const nearBefore = Number(await nearWord.evaluate((e) => getComputedStyle(e).opacity))
    await pointAt(page, nearWord)
    await expect.poll(() => nearWord.evaluate((e) => getComputedStyle(e).scale)).toBe('1.12')
    expect(Number(await nearWord.evaluate((e) => getComputedStyle(e).opacity))).toBeGreaterThan(nearBefore)

    // a far name clear of the logo and the near layer
    const far = page.getByTestId('login-ambient')
    const hero = (await page.getByTestId('login-hero').boundingBox())!
    let target = -1
    for (let i = 0; i < (await far.count()) && target < 0; i++) {
      const b = (await far.nth(i).boundingBox())!
      if (Math.hypot(b.x + b.width / 2 - (hero.x + hero.width / 2), b.y + b.height / 2 - (hero.y + hero.height / 2)) > hero.height * 0.42) target = i
    }
    expect(target).toBeGreaterThanOrEqual(0)
    const word = far.nth(target)
    const farBefore = Number(await word.evaluate((e) => getComputedStyle(e).opacity))
    await pointAt(page, word)
    await expect.poll(() => word.evaluate((e) => getComputedStyle(e).scale)).toBe('1.08')
    await expect.poll(() => word.evaluate((e) => getComputedStyle(e).filter)).toBe('blur(0px)')
    expect(Number(await word.evaluate((e) => getComputedStyle(e).opacity))).toBeGreaterThan(farBefore)
    // a name under the pointer holds still (it moves by its wrapper)
    const held = await word.evaluate((e) => e.parentElement!.style.transform)
    expect(held).toContain('translate3d')
    await page.waitForTimeout(400)
    expect(await word.evaluate((e) => e.parentElement!.style.transform)).toBe(held)
  })
})

test('narrow screens get the names as a list, no canvas', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 600, height: 900 }, storageState: { cookies: [], origins: [] } })
  await page.goto('/login')
  await expect(page.getByTestId('login-hero')).toBeHidden()
  await expect(page.locator('ul:not(.sr-only) li', { hasText: 'Deployments' })).toBeVisible()
  expect(await page.locator('ul:not(.sr-only) li').count()).toBe(12)
  await page.close()
})

test('reduced motion draws the icon still', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [] } })
  await page.goto('/login')
  await expect.poll(async () => Number(await page.getByTestId('login-particles').getAttribute('data-dots')), { timeout: 10_000 }).toBeGreaterThan(1000)
  // no way in: everything is in place from the start
  await expect(page.getByTestId('login-hero')).toHaveAttribute('data-state', 'ready')
  const box = (await page.getByTestId('login-hero').boundingBox())!
  const first = await inkAround(page, box.width / 2, box.height / 2, 60)
  expect(first).toBeGreaterThan(500)
  await page.waitForTimeout(500)
  expect(await inkAround(page, box.width / 2, box.height / 2, 60)).toBe(first)
  await page.close()
})
