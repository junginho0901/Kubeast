import { test, expect, type Page } from '@playwright/test'

// Colour modes (DESIGN.md "Colour modes"): the Account page's Color mode puts default (deep navy), dark (grey) or
// light (off-white) on <html data-color-mode>, keeps the choice in localStorage under kubeast.colorMode and sets it
// again before the first paint after a reload. Text on a surface (ink) follows the mode; white text on the sky stays
// white; the sign-in page keeps the default navy in every mode.

const KEY = 'kubeast.colorMode'
const PAGE_BG = { dark: 'rgb(20, 20, 20)', light: 'rgb(247, 248, 248)' }
// Chromium reports the default page colour in the oklch it is written in
const DEFAULT_BG = /^oklch\(0\.129 0\.042 264\.69/

const htmlMode = (page: Page) => page.evaluate(() => document.documentElement.dataset.colorMode ?? null)
const htmlBg = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY)
// the buttons fade their colours (transition-colors): poll until they settle
const colorOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color)

test.describe('Color mode', () => {
  test('Settings switches the mode, a reload keeps it, Default puts the navy back', async ({ page }) => {
    await page.goto('/account')
    await page.evaluate((k) => localStorage.removeItem(k), KEY)
    await page.reload()
    expect(await htmlMode(page)).toBeNull()
    await expect.poll(() => htmlBg(page)).toMatch(DEFAULT_BG)
    await expect(page.getByTestId('color-mode-default')).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('color-mode-dark').click()
    expect(await htmlMode(page)).toBe('dark')
    expect(await stored(page)).toBe('dark')
    await expect.poll(() => htmlBg(page)).toBe(PAGE_BG.dark)

    await page.getByTestId('color-mode-light').click()
    expect(await stored(page)).toBe('light')
    await page.reload()
    // set by public/color-mode.js before the app runs, and the control shows it
    expect(await htmlMode(page)).toBe('light')
    await expect.poll(() => htmlBg(page)).toBe(PAGE_BG.light)
    await expect(page.getByTestId('color-mode-light')).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('color-mode-default').click()
    expect(await htmlMode(page)).toBeNull()
    expect(await stored(page)).toBeNull()
    await expect.poll(() => htmlBg(page)).toMatch(DEFAULT_BG)
  })

  test('text on a surface follows the mode, white on the sky stays white', async ({ page }) => {
    await page.goto('/account')
    await page.getByTestId('color-mode-light').click()
    // the page title is ink: near-black on the off-white page
    await expect.poll(() => colorOf(page, 'main h1')).toBe('rgb(31, 35, 40)')
    // the selected mode is filled with the sky and its text stays white
    await expect.poll(() => colorOf(page, '[data-testid="color-mode-light"]')).toBe('rgb(255, 255, 255)')
    await page.getByTestId('color-mode-dark').click()
    await expect.poll(() => colorOf(page, 'main h1')).toBe('rgb(255, 255, 255)')
    await page.getByTestId('color-mode-default').click()
    await expect.poll(() => colorOf(page, 'main h1')).toBe('rgb(255, 255, 255)')
  })

  test('the sign-in page keeps the default navy in every mode', async ({ browser }) => {
    const cardBg: Record<string, string> = {}
    for (const mode of ['default', 'dark', 'light']) {
      const ctx = await browser.newContext()
      if (mode !== 'default') await ctx.addInitScript(([k, m]) => localStorage.setItem(k, m), [KEY, mode])
      const page = await ctx.newPage()
      await page.goto('/login')
      await expect(page.locator('input[autocomplete="email"]').first()).toBeVisible()
      expect(await htmlMode(page)).toBe(mode === 'default' ? null : mode)
      cardBg[mode] = await page
        .locator('[data-color-mode="default"] form')
        .first()
        .evaluate((el) => getComputedStyle(el.closest('.backdrop-blur-sm') ?? el).backgroundColor)
      await ctx.close()
    }
    expect(cardBg.dark).toBe(cardBg.default)
    expect(cardBg.light).toBe(cardBg.default)
  })
})
