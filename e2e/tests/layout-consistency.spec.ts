import { test, expect, type Page } from '@playwright/test'

// Layout rules from the 2026-10 re-QA (PR-9a): the current sidebar entry is in view once the page has settled,
// the tab title names the screen, a list table too wide for its box folds its less important columns (the
// header still fills the table) and shows them again when there is room, and the admin tables at 1024 break no
// word inside (Korean words, hyphenated or e-mail values) and cut no value without a tooltip.

async function korean(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('i18nextLng', 'ko') } catch { /* private mode */ }
  })
}

// The header cells shown add up to the table's width: an empty row's colSpan or a filler row that counts more
// columns than the header shows would add empty columns on the right.
async function headerGap(page: Page): Promise<number> {
  return page.locator('main table').first().evaluate((t: HTMLTableElement) => {
    const cells = [...(t.tHead?.rows[0]?.cells ?? [])]
    const w = cells.reduce((n, c) => n + c.getBoundingClientRect().width, 0)
    return Math.round(t.getBoundingClientRect().width - w)
  })
}

test.describe('Layout consistency', () => {
  for (const href of ['/admin/session-recordings', '/admin/node-shell', '/workloads/pdbs']) {
    test(`the current sidebar entry is in view on ${href}`, async ({ page }) => {
      await page.goto(href)
      await expect(page.getByTestId('sidebar-nav').locator(`a[href="${href}"]`)).toBeInViewport({ ratio: 1 })
    })
  }

  test('the tab title names the screen', async ({ page }) => {
    await page.goto('/workloads/pods?cluster=self')
    await expect(page).toHaveTitle('Pods · Kubeast')
    await page.goto('/admin/audit')
    await expect(page).toHaveTitle('Audit Logs · Kubeast')
  })

  test('a list table wider than its box folds the optional columns first and keeps Age until the screen is narrow', async ({ page }) => {
    // ReplicaSets (1740 px with every column, the box is 1070 px at 1440): Images, Selector and Owner fold, the
    // columns left are narrowed to fit; at 1024 Namespace and Age fold too
    await page.goto('/workloads/replicasets?cluster=self')
    const table = page.locator('main table').first()
    await expect(table.locator('tbody tr').first()).toBeVisible()
    const overflow = () => table.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth)
    const images = table.locator('thead th', { hasText: /^Images$/ })
    const age = table.locator('thead th').last()
    await expect(images).toBeHidden()
    await expect(age).toBeVisible()
    await expect.poll(overflow).toBeLessThanOrEqual(1)
    expect(await headerGap(page)).toBeLessThanOrEqual(2)

    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(age).toBeHidden()
    expect(await headerGap(page)).toBeLessThanOrEqual(2)
  })

  test('an empty list keeps its header across the whole table', async ({ page }) => {
    await page.goto('/workloads/vpas?cluster=self')
    const table = page.locator('main table').first()
    await expect(table.locator('tbody tr').first()).toBeVisible()
    await expect.poll(() => headerGap(page)).toBeLessThanOrEqual(2)
  })

  test('admin tables at 1024 break no word inside and cut no value without a tooltip (ko)', async ({ page }) => {
    await korean(page)
    await page.setViewportSize({ width: 1024, height: 900 })
    for (const href of ['/admin/audit', '/admin/ai-usage', '/admin/cluster-hygiene', '/admin/session-recordings', '/admin/access-review']) {
      await page.goto(href)
      await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 15_000 })
      const found = await page.locator('main').evaluate((main) => {
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect()
          const s = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        }
        // a text broken over more lines than it has words (split at spaces and before an opening parenthesis)
        // was split inside a word
        const brokenWord = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent?.trim() ?? ''
            if (text.length < 2) continue
            const range = document.createRange()
            range.selectNodeContents(n)
            const tops = [...range.getClientRects()].filter((q) => q.width > 0).map((q) => q.top).sort((a, b) => a - b)
            let lines = tops.length ? 1 : 0
            for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 8) lines++
            if (lines > 1 && lines > text.split(/\s+|(?=[(（])/).length) return true
          }
          return false
        }
        const leaves = [...main.querySelectorAll('button, label, th, td, .badge, span.rounded-full, span.rounded-sm, p, h1, h2, h3, a')]
          .filter(visible)
          .filter((e) => e.children.length === 0 || e.tagName === 'BUTTON')
        const broken = leaves.filter(brokenWord).map((e) => (e as HTMLElement).innerText.trim().slice(0, 30))
        const cut = [...main.querySelectorAll<HTMLElement>('td, th')].filter(visible).filter((e) => {
          const s = getComputedStyle(e)
          const clipped = s.overflow === 'hidden' || s.textOverflow === 'ellipsis' || s.whiteSpace === 'nowrap'
          return e.scrollWidth > e.clientWidth + 2 && clipped && !e.querySelector('.truncate') && !e.title
        }).map((e) => e.innerText.trim().slice(0, 30))
        return { broken, cut }
      })
      expect(found, href).toEqual({ broken: [], cut: [] })
    }
  })
})
