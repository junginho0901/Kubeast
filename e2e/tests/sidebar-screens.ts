import { expect, type Page } from '@playwright/test'

// Every screen the sidebar lists (the admin ones too), read on `self` once the list holds still for a second: some
// entries come after the features and permissions answers. screen-consistency.spec.ts and switch-guard.spec.ts walk it.
export async function sidebarScreens(page: Page): Promise<string[]> {
  await page.goto('/?cluster=self')
  const nav = page.getByTestId('sidebar-nav')
  await expect(nav.locator('a[href^="/"]').first()).toBeAttached()
  const hrefs = async () => [...new Set(await nav.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')))]
  let paths: string[] = []
  await expect.poll(async () => {
    const before = (await hrefs()).length
    await page.waitForTimeout(1_000)
    paths = await hrefs()
    return paths.length === before ? paths.length : 0
  }, { timeout: 30_000, message: 'the sidebar lists every screen' }).toBeGreaterThan(70)
  return paths
}

// Layout follows the page's entry in the sidebar for a second after a page change (scrollIntoView on each resize of
// the menu): a full-page picture waits until the menu's scroll reads the same twice, 1.1 s apart, so that second is
// over and the picture shows the menu where it rests.
export async function sidebarStill(page: Page): Promise<void> {
  const nav = page.getByTestId('sidebar-nav')
  let last: number | null = null
  await expect.poll(async () => {
    const now = await nav.evaluate((n) => n.scrollTop)
    const still = now === last
    last = now
    return still
  }, { intervals: [1_100], timeout: 15_000, message: 'the sidebar menu holds still' }).toBe(true)
}
