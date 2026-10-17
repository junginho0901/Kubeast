import { test, expect, type Locator, type Page } from '@playwright/test'

// The floating chat sends what is on screen (page_context) with each question. These tests stop the request in the
// browser and read that body: no session is created and no model is called.

type Layer = { source: string; summary: string; data?: Record<string, unknown> }
type PageContext = { path: string; page_type: string; base?: Layer | null; overlays: Layer[] }

// Every menu with a screen of its own, on the cluster that has what it shows: self (the dev install) for most,
// default (the second cluster) for the pages that need Kyverno, metrics-server or OpenCost. Advanced Search sends
// nothing until something is searched.
const MENUS: [string, string][] = [
  '/', '/cluster/namespaces', '/cluster/resource-graph', '/timeline', '/cluster/nodes',
  '/workloads/pods', '/workloads/deployments', '/workloads/statefulsets', '/workloads/daemonsets', '/workloads/replicasets',
  '/workloads/jobs', '/workloads/cronjobs', '/workloads/hpas', '/workloads/vpas', '/workloads/pdbs', '/storage',
  '/network/services', '/network/endpoints', '/network/endpointslices', '/network/ingresses', '/network/ingressclasses',
  '/network/networkpolicies', '/gateway/gateways', '/gateway/gatewayclasses', '/gateway/httproutes', '/gateway/grpcroutes',
  '/gateway/referencegrants', '/gateway/backendtlspolicies', '/gateway/policies', '/gpu/dashboard', '/gpu/nodes', '/gpu/pods',
  '/gpu/deviceclasses', '/gpu/resourceclaims', '/gpu/resourceclaimtemplates', '/gpu/resourceslices',
  '/security/serviceaccounts', '/security/roles', '/security/clusterroles', '/security/rolebindings',
  '/security/clusterrolebindings', '/configuration/configmaps', '/configuration/secrets', '/cluster/resourcequotas',
  '/cluster/limitranges', '/cluster/priorityclasses', '/cluster/runtimeclasses', '/cluster/leases',
  '/cluster/mutatingwebhookconfigurations', '/cluster/validatingwebhookconfigurations',
  '/cluster/validatingadmissionpolicies', '/cluster/mutatingadmissionpolicies', '/custom-resources/instances',
  '/custom-resources/groups', '/helm/releases', '/cluster-view',
].map((path): [string, string] => [path, 'self']).concat([
  ['/security/policyreports', 'default'], ['/monitoring', 'default'], ['/cost', 'default'],
])

async function captureFloating(page: Page) {
  const sent: PageContext[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-floating-ctx', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback(),
  )
  await page.route(/\/api\/v1\/sessions\/e2e-floating-ctx(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-floating-ctx', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }),
  )
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-floating-ctx\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return sent
}

// client-side navigation, as a sidebar click does (page.goto would reload the app and its layers)
async function navigate(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

// opens the window if it is closed; the window's code loads on first open, so wait for the input
async function openChat(page: Page) {
  if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
  await expect(page.getByTestId('floating-chat-input')).toBeVisible()
}

async function ask(page: Page, sent: PageContext[]): Promise<PageContext> {
  const input = page.getByTestId('floating-chat-input')
  await openChat(page)
  const before = sent.length
  await input.fill('what is on this screen?')
  await input.press('Enter')
  await expect.poll(() => sent.length).toBe(before + 1)
  // Enter does not send while an answer is still coming; the Send button is back when it has ended
  await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
  return sent[sent.length - 1]
}

// the screen data once the page is shown (a page whose code loads on first open shows after a moment) and has put
// its data there (when the page's data has loaded)
async function askForBase(page: Page, sent: PageContext[], path: string, timeoutMs = 10000): Promise<PageContext> {
  const until = Date.now() + timeoutMs
  let ctx = await ask(page, sent)
  while ((ctx.path !== path || !ctx.base?.summary) && Date.now() < until) {
    await page.waitForTimeout(500)
    ctx = await ask(page, sent)
  }
  return ctx
}

// true when the element at the centre of the locator's box belongs to it (nothing is drawn over it)
async function onTop(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })
}

async function rightEdge(locator: Locator): Promise<number> {
  const box = (await locator.boundingBox())!
  return box.x + box.width
}

test.describe('floating chat screen data', () => {
  test('every menu sends its screen data, on the first visit and when opened again', async ({ page }) => {
    test.setTimeout(600_000)
    const sent = await captureFloating(page)
    await page.goto('/?cluster=self')
    await openChat(page)
    const missing: string[] = []
    for (const visit of ['first', 'again']) {
      for (const [path, cluster] of MENUS) {
        await navigate(page, `${path}?cluster=${cluster}`)
        const ctx = await askForBase(page, sent, path)
        if (ctx.path !== path || !ctx.base?.summary) missing.push(`${visit} ${path} (sent for ${ctx.path})`)
      }
    }
    expect(missing).toEqual([])
  })

  test('over a modal the floating chat is in front; Escape in it closes only the chat and Tab stays in it', async ({ page }) => {
    const sent = await captureFloating(page)
    await page.goto('/?cluster=self')
    await page.locator('button.card').first().click()
    const modal = page.locator('div.fixed.inset-0.bg-black\\/50').first()
    await expect(modal).toBeVisible()

    const toggle = page.getByTestId('floating-chat-toggle')
    expect(await onTop(toggle), 'the floating chat button is above the modal backdrop').toBe(true)
    await toggle.click()
    const panel = page.getByTestId('floating-chat-panel')
    await expect(panel).toHaveCSS('opacity', '1')
    expect(await onTop(panel), 'the floating chat window is above the modal backdrop').toBe(true)
    expect((await ask(page, sent)).path).toBe('/')

    const input = page.getByTestId('floating-chat-input')
    await input.focus()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
      expect(await panel.evaluate((el) => el.contains(document.activeElement)), `Tab ${i + 1} stays in the floating chat`).toBe(true)
    }

    await input.focus()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(modal, 'the modal stays open').toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal, 'Escape outside the chat still closes the modal').toHaveCount(0)
  })

  test('with the detail drawer open the floating chat moves left of it and reads it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const sent = await captureFloating(page)
    await page.goto('/workloads/pods?cluster=self')
    await page.locator('table tbody tr').first().click()
    const drawer = page.locator('[class*="max-w-[740px]"]')
    await expect(drawer).toBeVisible()
    const drawerLeft = (await drawer.boundingBox())!.x

    const toggle = page.getByTestId('floating-chat-toggle')
    await expect.poll(() => rightEdge(toggle), 'the button moves left of the drawer').toBeLessThanOrEqual(drawerLeft)
    expect(await onTop(toggle)).toBe(true)
    await toggle.click()
    const panel = page.getByTestId('floating-chat-panel')
    await expect(panel).toHaveCSS('opacity', '1')
    expect(await rightEdge(panel), 'the window ends left of the drawer').toBeLessThanOrEqual(drawerLeft)
    expect((await panel.boundingBox())!.x, 'and starts right of the sidebar').toBeGreaterThanOrEqual(256)
    expect((await ask(page, sent)).overlays.map((o) => o.source)).toContain('ResourceDetailDrawer')

    await page.getByTestId('floating-chat-input').focus()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(drawer, 'the drawer stays open').toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect.poll(() => rightEdge(toggle), 'back to the corner').toBeGreaterThan(1400)
  })

  test('on a screen too narrow for the drawer and the window side by side the chat stays in the corner, in front', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/workloads/pods?cluster=self')
    await page.locator('table tbody tr').first().click()
    await expect(page.locator('[class*="max-w-[740px]"]')).toBeVisible()
    const toggle = page.getByTestId('floating-chat-toggle')
    expect(await rightEdge(toggle)).toBeGreaterThan(1240)
    expect(await onTop(toggle)).toBe(true)
  })
})
