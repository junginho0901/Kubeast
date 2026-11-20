import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'

// The notice bands in every colour mode, read as drawn (DESIGN.md "Colour modes"). Each band shows only in a state no
// screen of screen-consistency.spec.ts is opened in, so each is made to show here with the browser's answers changed
// (page.route, page.routeWebSocket): nothing is written to the cluster or the database. axe-core's color-contrast rule
// reads the band in light, default and dark, and a picture of it in light goes into the report.
// frontend/src/utils/colorModeContrast.test.ts holds the same classes to the tokens without a browser.

const KEY = 'kubeast.colorMode'
const MODES = ['light', 'default', 'dark'] as const
const CLUSTER = 'self'

const htmlMode = (page: Page) => page.evaluate(() => document.documentElement.dataset.colorMode ?? 'default')

async function setMode(page: Page, mode: string) {
  await page.evaluate(([k, m]) => (m === 'default' ? localStorage.removeItem(k) : localStorage.setItem(k, m)), [KEY, mode])
}

// texts under WCAG's contrast inside `selector`, as "where: target (fg on bg, ratio)"
async function lowContrast(page: Page, selector: string, where: string) {
  const result = await new AxeBuilder({ page }).withRules(['color-contrast']).include(selector).analyze()
  return result.violations.flatMap((v) => v.nodes.map((n) => {
    const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number }
    return `${where}: ${n.target.join(' ')} (${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1)`
  }))
}

// Opens `path` in each mode, makes the band show (`show`, after `beforeLoad` and the load) and reads every band of
// `selectors` there.
async function readInEveryMode(
  page: Page, info: TestInfo, path: string, selectors: string[],
  { show, beforeLoad }: { show?: (page: Page) => Promise<void>; beforeLoad?: () => void } = {},
) {
  const low: string[] = []
  await page.goto(path)
  for (const mode of MODES) {
    await setMode(page, mode)
    beforeLoad?.()
    await page.reload()
    expect(await htmlMode(page)).toBe(mode)
    if (show) await show(page)
    for (const selector of selectors) {
      const band: Locator = page.locator(selector).first()
      await expect(band).toBeVisible({ timeout: 30_000 })
      low.push(...await lowContrast(page, selector, `${selector} ${mode}`))
      if (mode === 'light') await info.attach(`${selector.replace(/\W+/g, '-')}-light.png`, { body: await band.screenshot(), contentType: 'image/png' })
    }
  }
  expect(low).toEqual([])
}

// the real answer with `change` made to its JSON
const changed = (change: (body: any) => void) => async (route: Route) => {
  const response = await route.fetch()
  const body = await response.json()
  change(body)
  await route.fulfill({ response, json: body })
}

// a read the page sent just before the test ended (a list asked again) is not answered after the page closes
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.describe('notice bands in every colour mode', () => {
  test('the no-permission band', async ({ page }, info) => {
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 403, json: { detail: 'forbidden' } }) : route.fallback())
    await readInEveryMode(page, info, `/cluster/nodes?cluster=${CLUSTER}`, ['[data-testid="forbidden-banner"]'])
  })

  test('the band of a list that stopped following', async ({ page }, info) => {
    let asked: object | undefined
    let answer: ((frame: object) => void) | undefined
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        if (!asked && msg.type === 'REQUEST') asked = msg
        server.send(message)
      })
      let relay = true
      server.onMessage((message) => { if (relay) ws.send(message) })
      answer = (frame) => {
        relay = false
        ws.send(JSON.stringify(frame))
      }
    })
    // a list that watches; the Pods list polls
    await readInEveryMode(page, info, `/workloads/deployments?cluster=${CLUSTER}`, ['[data-testid="watch-problem-notice"]'], {
      beforeLoad: () => { asked = undefined },
      show: async () => {
        await expect.poll(() => Boolean(asked), { timeout: 20_000 }).toBe(true)
        answer!({ ...asked, type: 'ERROR', error: { message: 'max subscriptions reached', reason: 'limit' } })
      },
    })
  })

  test('the band of custom resource kinds not read', async ({ page }, info) => {
    await page.route(/\/api\/v1\/cluster\/custom-resources\/all/, changed((body) => { body.forbidden_kinds = ['widgets.example.com'] }))
    await readInEveryMode(page, info, `/custom-resources/instances?cluster=${CLUSTER}`, ['[data-testid="cr-instances-notice"]'])
  })

  test('the Resource Graph band of kinds not read', async ({ page }, info) => {
    await page.route(/\/api\/v1\/resource-graph\?/, changed((body) => { body.forbidden_kinds = ['secrets'] }))
    await readInEveryMode(page, info, `/cluster/resource-graph?namespace=default&cluster=${CLUSTER}`, ['[data-testid="resource-graph-forbidden"]'])
  })

  test('the pending-requests count', async ({ page }, info) => {
    await page.route(/\/api\/v1\/auth\/admin\/access-requests\?/, (route) =>
      route.fulfill({ status: 200, json: [], headers: { 'X-Kubeast-Total': '3' } }))
    await readInEveryMode(page, info, '/admin/access-requests', [
      '[data-testid="nav-access-requests-badge"]',
      '[data-testid="access-requests-tab-pending"] span.rounded-full',
    ])
  })

  test('the Cluster Hygiene bands: lists not read, a cut list and a past sign-off', async ({ page }, info) => {
    const config = await page.request.get(`/api/v1/cluster/hygiene/config?cluster=${CLUSTER}`)
    test.skip(!config.ok() || !(await config.json()).enabled, 'cluster hygiene report is off (features.hygiene.enabled)')
    let report: unknown
    await page.route(/\/api\/v1\/cluster\/hygiene\?/, changed((body) => {
      body.report.collectors = [{ what: 'secrets', error: 'secrets is forbidden' }]
      body.report.truncated = true
      report = body.report
    }))
    const review = {
      id: 'e2e-color-mode', cluster: CLUSTER, reviewed_by_email: 'e2e@example.com', reviewed_at: new Date().toISOString(),
      note: 'colour mode', counts: { critical: 0, warning: 0, info: 0, exempt: 0 },
    }
    await page.route(/\/api\/v1\/cluster\/hygiene\/history\?/, (route) =>
      route.fulfill({ status: 200, json: [review], headers: { 'X-Kubeast-Total': '1' } }))
    await page.route(/\/api\/v1\/cluster\/hygiene\/snapshot\//, (route) =>
      route.fulfill({ status: 200, json: { ...review, snapshot: { cluster: CLUSTER, report } } }))
    const pick = async (p: Page) => {
      await p.getByTestId('hygiene-cluster').click()
      await p.getByTestId(`hygiene-cluster-opt-${CLUSTER}`).click()
    }
    await readInEveryMode(page, info, '/cluster/hygiene', ['[data-testid="hygiene-collectors"]', '[data-testid="hygiene-truncated"]'], { show: pick })
    await readInEveryMode(page, info, '/cluster/hygiene', ['[data-testid="hygiene-snapshot-banner"]'], {
      show: async (p) => {
        await pick(p)
        await p.getByTestId('hygiene-tab-history').click()
        await p.getByTestId('hygiene-history-row').first().getByRole('button').click()
      },
    })
  })

  test('the Access Review band of a past sign-off', async ({ page }, info) => {
    let live: unknown
    await page.route(/\/api\/v1\/auth\/admin\/access-review(\?[^/]*)?$/, changed((body) => { live = body }))
    const review = {
      id: 'e2e-color-mode', reviewed_by_email: 'e2e@example.com', reviewed_at: new Date().toISOString(), note: 'colour mode',
      counts: { users: 0, global_admins: 0, dormant: 0, api_keys_active: 0 },
    }
    await page.route(/\/api\/v1\/auth\/admin\/access-review\/history\?/, (route) =>
      route.fulfill({ status: 200, json: [review], headers: { 'X-Kubeast-Total': '1' } }))
    await page.route(/\/api\/v1\/auth\/admin\/access-review\/history\/[^?]+/, (route) =>
      route.fulfill({ status: 200, json: { ...review, snapshot: live } }))
    await readInEveryMode(page, info, '/admin/access-review', ['[data-testid="access-review-snapshot-banner"]'], {
      show: async (p) => {
        await p.getByTestId('access-review-tab-history').click()
        await p.getByTestId('access-review-history-row').first().getByRole('button').click()
      },
    })
  })

  test('the sign-in page keeps the default colours of its texts and icons in light', async ({ browser }, info) => {
    const seen: Record<string, string[]> = {}
    const low: string[] = []
    for (const mode of MODES) {
      const ctx = await browser.newContext()
      if (mode !== 'default') await ctx.addInitScript(([k, m]) => localStorage.setItem(k, m), [KEY, mode])
      const page = await ctx.newPage()
      // a refused sign-in answered in the browser: no attempt reaches the server
      await page.route(/\/api\/v1\/auth\/login/, (route) => route.fulfill({ status: 401, json: { detail: 'Invalid email or password' } }))
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill('nobody@example.com')
      await page.locator('input[autocomplete="current-password"]').first().fill('wrong-password')
      await page.locator('[data-color-mode="default"] button[type="submit"]').first().click()
      const band = page.locator('[data-color-mode="default"] form div[aria-live="polite"]').first()
      await expect(band).toBeVisible()
      expect(await htmlMode(page)).toBe(mode)
      low.push(...await lowContrast(page, '[data-color-mode="default"] form div[aria-live="polite"]', `sign-in ${mode}`))
      seen[mode] = [
        await band.evaluate((el) => getComputedStyle(el).color),
        await band.evaluate((el) => getComputedStyle(el).backgroundColor),
        await page.locator('[data-color-mode="default"] svg.lucide-lock').first().evaluate((el) => getComputedStyle(el).color),
      ]
      if (mode === 'light') await info.attach('sign-in-error-light.png', { body: await band.screenshot(), contentType: 'image/png' })
      await ctx.close()
    }
    expect(low).toEqual([])
    expect(seen.light).toEqual(seen.default)
    expect(seen.dark).toEqual(seen.default)
  })
})
