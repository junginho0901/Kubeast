import { test, expect } from '@playwright/test'

// Regression: a resource detail drawer opened from a list modal must render IN
// FRONT of that list modal. Before the fix the drawer sat at a fixed z-index
// (1110) BELOW the generic modal overlay (1200), so it was hidden behind the
// list it was opened from. useModalStack now assigns z-index by open order.

test.describe('modal stacking — detail drawer over list modal', () => {
  test('detail drawer renders on top of the list modal that opened it', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Open a resource list modal from a dashboard stat card.
    await page.locator('button.card').first().waitFor({ timeout: 20000 })
    await page.locator('button.card').first().click()

    // Scope to the open list modal (the ModalOverlay) and click its first
    // resource row → openDetail() mounts the ResourceDetailDrawer.
    const modal = page.locator('div.fixed.inset-0.bg-black\\/50').first()
    await expect(modal).toBeVisible({ timeout: 10000 })
    const row = modal.locator('div.cursor-pointer.bg-slate-700').first()
    await row.waitFor({ timeout: 10000 })
    await row.click()

    // The drawer panel is the right-side fixed panel (max-w-[740px]).
    const panel = page.locator('[class*="max-w-[740px]"]')
    await expect(panel).toBeVisible({ timeout: 10000 })

    // Stacking assertion: the element at the drawer panel's center must belong
    // to the drawer — if it were behind the list modal, elementFromPoint would
    // return the modal instead.
    const onTop = await page.evaluate(() => {
      const panel = document.querySelector('[class*="max-w-[740px]"]') as HTMLElement | null
      if (!panel) return { found: false, onTop: false }
      const r = panel.getBoundingClientRect()
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 80)
      return { found: true, onTop: panel.contains(el) }
    })
    expect(onTop.found).toBe(true)
    expect(onTop.onTop, 'detail drawer must be the top-most element at its location').toBe(true)
  })
})
