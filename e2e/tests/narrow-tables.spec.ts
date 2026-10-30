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

// every screen the sidebar lists (the admin ones too) and the account page
async function screens(page: Page) {
  await page.goto('/?cluster=self')
  const nav = page.getByTestId('sidebar-nav')
  await expect(nav.locator('a[href^="/"]').first()).toBeAttached()
  const paths = [...new Set(await nav.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')))]
  expect(paths.length, 'the sidebar lists every screen').toBeGreaterThan(70)
  return [...paths, '/account']
}

// A header row whose title and buttons did not fit on one line pushed the whole page sideways in a portrait window:
// the title went under the sidebar and the buttons past the right edge (Mutating- and ValidatingWebhookConfigurations
// at 1 070 px). The row (.page-head) now sends the buttons to the next line. Its buttons were not all alike either:
// grey Create on the kinds a controller makes, grey export and bulk upload, a grey Metrics toggle, smaller Helm ones.
test.describe('page headers', () => {
  test('at 1070 px no screen of the sidebar slides sideways', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1070, height: 1000 })
    const slid: string[] = []
    for (const path of await screens(page)) {
      await page.goto(`${path}${path.includes('?') ? '&' : '?'}cluster=self`)
      await expect(page.locator('main h1').first()).toBeVisible()
      await page.waitForTimeout(300)
      const r = await page.evaluate(() => {
        const h1 = document.querySelector('main h1')!
        const main = document.querySelector('main')!
        const row = h1.closest('.page-head') ?? h1.parentElement?.parentElement
        const controls = row ? [...row.querySelectorAll('button, a, input, select')].filter((e) => e.getBoundingClientRect().width > 0) : []
        return {
          pageOver: document.documentElement.scrollWidth - innerWidth,
          mainOver: main.scrollWidth - main.clientWidth,
          titleLeft: h1.getBoundingClientRect().left,
          titleOver: h1.scrollWidth - h1.clientWidth, // the title's longest word past its block, under the buttons
          controlsRight: controls.reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0),
        }
      })
      if (r.pageOver > 1 || r.mainOver > 1 || r.titleLeft < 256 || r.titleOver > 1 || r.controlsRight > 1071) {
        slid.push(`${path}: page +${r.pageOver}, main +${r.mainOver}, title at ${Math.round(r.titleLeft)} +${r.titleOver}, buttons end ${Math.round(r.controlsRight)}`)
      }
    }
    expect(slid).toEqual([])
  })

  for (const mode of ['default', 'dark', 'light']) {
    test(`in the ${mode} colour mode every header button is the same blue`, async ({ page }) => {
      test.setTimeout(300_000)
      await page.setViewportSize({ width: 1440, height: 900 })
      const paths = await screens(page)
      await page.evaluate((m) => (m === 'default' ? localStorage.removeItem('kubeast.colorMode') : localStorage.setItem('kubeast.colorMode', m)), mode)
      const odd: string[] = []
      const looks = new Map<string, string>()
      for (const path of paths) {
        await page.goto(`${path}${path.includes('?') ? '&' : '?'}cluster=self`)
        await expect(page.locator('main h1').first()).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.dataset.colorMode ?? 'default')).toBe(mode)
        // the buttons placed in the header row itself; a dropdown's or a tab group's buttons sit one level down
        const buttons = await page.evaluate(() => {
          const head = document.querySelector('main h1')!.closest('.page-head')
          const areas = head ? [...head.children].slice(1) : []
          return areas
            .flatMap((a) => (a.matches('button, a.btn') ? [a] : [...a.children].filter((e) => e.matches('button, a.btn'))))
            .map((b) => ({ text: (b.textContent ?? '').trim().slice(0, 30), primary: b.classList.contains('btn-primary'), bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color }))
        })
        for (const b of buttons) {
          if (!b.primary) odd.push(`${path} "${b.text}" is not btn-primary`)
          looks.set(`${b.bg} / ${b.fg}`, `${path} "${b.text}"`)
        }
      }
      expect(odd).toEqual([])
      expect([...looks.keys()], `header buttons by background / text: ${[...looks.values()].join(', ')}`).toHaveLength(1)
    })
  }
})
