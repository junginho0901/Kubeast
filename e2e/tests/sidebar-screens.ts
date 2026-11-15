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
