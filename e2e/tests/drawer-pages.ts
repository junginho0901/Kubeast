import type { Locator } from '@playwright/test'

// Every page of a drawer list paged by the drawers' pager ("1-10 / N" with Prev and Next): back to its first page, then
// page by page to its last, the items each page draws (the texts of an item's cells — the elements cells selects in it,
// a table row's td, else the item's own text) and each page's range. scope holds one list and its pager; a list that
// fits one page has no pager and is read as it is.
export type Pages = { items: string[][]; pagers: string[] }

export async function everyPage(scope: Locator, items: string, cells?: string): Promise<Pages> {
  return scope.evaluate(async (root, { items, cells }) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const pager = () => [...root.querySelectorAll('span')].find((s) => /^\d+-\d+ \/ \d+$/.test(txt(s)))
    const button = (label: string) => {
      const p = pager()
      return p ? ([...(p.parentElement?.querySelectorAll('button') ?? [])].find((b) => txt(b) === label) as HTMLButtonElement | undefined) : undefined
    }
    // React draws a click on a later turn: wait until the range is no longer the one before it
    const moved = async (before: string) => {
      for (let i = 0; i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        const p = pager()
        if (!p || txt(p) !== before) return
      }
      throw new Error(`the pager stayed at ${before}`)
    }
    const turn = async (label: string) => {
      const b = button(label)
      if (!b || b.disabled) return false
      const before = txt(pager()!)
      b.click()
      await moved(before)
      return true
    }
    while (await turn('Prev')) { /* back to the first page */ }
    const read = () => [...root.querySelectorAll(items)].map((el) => {
      if (cells) return [...el.querySelectorAll(cells)].map(txt)
      return el.tagName === 'TR' ? [...el.querySelectorAll('td')].map(txt) : [txt(el)]
    })
    const out = { items: read(), pagers: pager() ? [txt(pager()!)] : [] as string[] }
    while (await turn('Next')) {
      out.items.push(...read())
      out.pagers.push(txt(pager()!))
    }
    return out
  }, { items, cells })
}

// What every page of a list of these items must read: the items in order and the range of each page of size.
export function pagesOf(items: string[][], size = 10): Pages {
  const pagers: string[] = []
  if (items.length > size) for (let i = 0; i < items.length; i += size) pagers.push(`${i + 1}-${Math.min(i + size, items.length)} / ${items.length}`)
  return { items, pagers }
}
