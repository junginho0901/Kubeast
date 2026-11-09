import { expect, type Page } from '@playwright/test'

// Reading a list that has the ListPager footer (components/ListPager.tsx) across its pages.

// how long a footer may take to come: the chromium project sets no action timeout, and a read inside expect.poll
// must fail and be asked again rather than wait for the whole test
const WAIT = 15_000

// The range and the total the footer says: "Showing 1-12 of 523" / "523개 중 1-12 표시".
export async function pagerRange(page: Page, pagerId: string): Promise<{ start: number; end: number; total: number }> {
  const text = (await page.getByTestId(pagerId).innerText({ timeout: WAIT })).replace(/\s+/g, ' ')
  const en = /Showing (\d+)-(\d+) of (\d+)/.exec(text)
  if (en) return { start: Number(en[1]), end: Number(en[2]), total: Number(en[3]) }
  const ko = /(\d+)개 중 (\d+)-(\d+) 표시/.exec(text)
  if (ko) return { start: Number(ko[2]), end: Number(ko[3]), total: Number(ko[1]) }
  if (/Showing 0 of 0|0개 중 0 표시/.test(text)) return { start: 0, end: 0, total: 0 }
  throw new Error(`${pagerId}: no range in "${text}"`)
}

// Every page of the list from the first, read in order with `read` once the footer names that page, then back to
// the first page.
export async function readEveryPage<T>(page: Page, pagerId: string, read: () => Promise<T[]>): Promise<T[]> {
  const pager = page.getByTestId(pagerId)
  const at = pager.getByText(/^\d+ \/ \d+$/)
  const next = pager.getByRole('button', { name: /^(Next|다음)$/ })
  const prev = pager.getByRole('button', { name: /^(Previous|Prev|이전)$/ })
  const [first, pages] = (await at.innerText({ timeout: WAIT })).split('/').map((s) => Number(s.trim()))
  for (let p = first; p > 1; p--) {
    await prev.click({ timeout: WAIT })
    await expect(at).toHaveText(`${p - 1} / ${pages}`)
  }
  const out: T[] = []
  for (let p = 1; p <= pages; p++) {
    if (p > 1) {
      await next.click({ timeout: WAIT })
      await expect(at).toHaveText(`${p} / ${pages}`)
    }
    out.push(...(await read()))
  }
  for (let p = pages; p > 1; p--) {
    await prev.click({ timeout: WAIT })
    await expect(at).toHaveText(`${p - 1} / ${pages}`)
  }
  return out
}

// The page holding what `find` finds: the footer's pages from the first until it is there.
export async function goToPageWith(page: Page, pagerId: string, find: () => Promise<boolean>): Promise<void> {
  const pager = page.getByTestId(pagerId)
  const at = pager.getByText(/^\d+ \/ \d+$/)
  const next = pager.getByRole('button', { name: /^(Next|다음)$/ })
  for (;;) {
    if (await find()) return
    const [p, pages] = (await at.innerText({ timeout: WAIT })).split('/').map((s) => Number(s.trim()))
    expect(p, `${pagerId}: not on any page`).toBeLessThan(pages)
    await next.click({ timeout: WAIT })
    await expect(at).toHaveText(`${p + 1} / ${pages}`)
  }
}

// The page itself does not scroll at this size: the list and its footer fit the screen (the body scrolls inside).
export async function pageScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
}
