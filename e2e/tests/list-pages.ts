import { expect, type Locator, type Page } from '@playwright/test'

// The list pages page as many rows as fit the screen (or the footer's fixed choice), so a row a test made is not
// always on the first page.

// Presses the footer's Next until the row shows; says whether it did.
export async function turnToRow(page: Page, pagerTestId: string, row: Locator, most = 100): Promise<boolean> {
  const pager = page.getByTestId(pagerTestId)
  await pager.waitFor({ timeout: 15_000 })
  await row.first().waitFor({ timeout: 3_000 }).catch(() => undefined)
  for (let i = 0; i < most && (await row.count()) === 0; i++) {
    const next = pager.getByRole('button', { name: /^(Next|다음)$/ })
    if (await next.isDisabled()) break
    const before = await pager.innerText()
    await next.click()
    await expect.poll(() => pager.innerText(), { timeout: 15_000 }).not.toBe(before)
  }
  return (await row.count()) > 0
}

// The rows of a full page, read from the footer's range ("Showing 1-12 of 205", "205개 중 1-12 표시").
export async function rowsOfFirstPage(pager: Locator): Promise<number> {
  const m = (await pager.innerText()).match(/(\d+)\s*-\s*(\d+)/)
  return m ? Number(m[2]) - Number(m[1]) + 1 : 0
}

// The page itself does not scroll at this size: the table and its footer fit the screen.
export async function pageScrolls(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
}
