import { test, expect, type Page } from '@playwright/test'

// A table-fixed list squeezed by a narrow window (a portrait monitor) fitted its other columns and left the one with no
// width of its own — the alert, the name — at 1–2 px, its text one letter per line (useAdaptiveTable's fitTable).
// That column now keeps at least 128 px (MIN_AUTO_COLUMN 160, narrowed by at most a fifth), the other steps go on,
// and a wide window keeps every column.

const SCREENS = [
  { path: '/alerts?cluster=default', name: 'Alerts' },
  { path: '/configuration/secrets?cluster=self', name: 'Secrets' },
  { path: '/custom-resources/groups?cluster=self', name: 'CRD groups' },
  { path: '/gateway/policies?cluster=self', name: 'Gateway policies' },
]

// the shown header cells of each table-fixed table on the page with no width class of their own, and their widths
async function autoColumns(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('table')].flatMap((t) => {
    if (getComputedStyle(t).tableLayout !== 'fixed') return []
    const fold = t.parentElement?.getAttribute('data-fold')
    return [...(t.tHead?.rows[0]?.cells ?? [])]
      .filter((c) => !/(^|\s)w-(?!auto\b)\S+/.test(c.className))
      .filter((c) => !((fold && c.classList.contains('col-optional')) || (fold === 'low' && c.classList.contains('col-low'))))
      .map((c) => ({ name: c.textContent?.trim() ?? '', width: Math.round(c.getBoundingClientRect().width) }))
  }))
}

test.describe('list tables in a narrow window', () => {
  for (const width of [1080, 900]) {
    test(`at ${width} px the column with no width of its own keeps 128 px or more`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      for (const screen of SCREENS) {
        await page.goto(screen.path)
        await expect(page.locator('table thead th:visible').first()).toBeVisible()
        await page.waitForTimeout(300) // fitTable runs on the next animation frame after a size change
        const cols = await autoColumns(page)
        expect(cols.length, `${screen.name}: a table-fixed table with a column of no width`).toBeGreaterThan(0)
        for (const c of cols) expect(c.width, `${screen.name} "${c.name}" at ${width} px`).toBeGreaterThanOrEqual(128)
      }
    })
  }

  test('a wide window keeps every Alerts column', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/alerts?cluster=default')
    const table = page.getByTestId('alert-inbox-table')
    await expect(table.locator('thead th').first()).toBeVisible()
    await page.waitForTimeout(300)
    expect(await table.evaluate((t) => t.parentElement?.getAttribute('data-fold') ?? null)).toBeNull()
    const widths = await table.locator('thead th').evaluateAll((ths) => ths.map((th) => Math.round(th.getBoundingClientRect().width)))
    expect(widths.length).toBe(8)
    for (const w of widths) expect(w).toBeGreaterThan(80)
  })
})
