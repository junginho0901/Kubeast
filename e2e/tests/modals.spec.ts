import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { turnToRow } from './list-pages'
import { sessionToken } from './session-token'

// Create, edit and confirm windows share one frame (re-QA #19 #38 #53 #66 #68):
// Escape closes them, Tab stays inside, system objects ask for their name
// before a delete, and admin confirmations are in-app windows instead of the
// browser's window.confirm. The Dashboard's windows close with a button named Close. Nothing here is created or deleted on a cluster
// except a temporary custom role that the last test removes.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return { Authorization: `Bearer ${sessionToken(res)}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// the detail drawer is a role=dialog too: a window is any other
const WINDOW = '[role="dialog"]:not([data-testid="resource-drawer"])'
const DRAWER = '[data-testid="resource-drawer"]'
const topDialog = (page: Page) => page.locator(WINDOW).last()

async function tabStaysInside(page: Page, presses = 15, selector = WINDOW, key = 'Tab') {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key)
    const inside = await page.evaluate((selector) => {
      const dialogs = document.querySelectorAll(selector)
      return dialogs.length > 0 && dialogs[dialogs.length - 1].contains(document.activeElement)
    }, selector)
    expect(inside, `${key} #${i + 1} left ${selector === WINDOW ? 'the window' : 'the drawer'}`).toBe(true)
  }
}

async function openDrawerDelete(page: Page, route: string, rowText: string, kind: string) {
  await page.goto(route)
  await page.locator('tbody tr').filter({ has: page.getByText(rowText, { exact: true }) }).first().click()
  await page.getByRole('button', { name: `Delete ${kind}` }).click()
  await expect(page.getByTestId('delete-dialog')).toBeVisible()
}

test.describe('modal windows', () => {
  const windows: Array<{ name: string; route: string; open: (page: Page) => Promise<void> }> = [
    { name: 'ConfigMap from YAML', route: '/configuration/configmaps?cluster=self', open: (p) => p.getByRole('button', { name: 'Create ConfigMap' }).click() },
    { name: 'Namespace', route: '/cluster/namespaces?cluster=self', open: (p) => p.getByRole('button', { name: 'Create Namespace' }).first().click() },
    { name: 'user', route: '/admin/users', open: (p) => p.getByRole('button', { name: 'Add user' }).first().click() },
    { name: 'role', route: '/admin/roles', open: (p) => p.getByRole('button', { name: 'Create Role' }).first().click() },
    { name: 'cluster registration', route: '/admin/clusters', open: (p) => p.getByRole('button', { name: 'Register cluster' }).first().click() },
    { name: 'AI model', route: '/admin/ai-models', open: (p) => p.getByRole('button', { name: 'Add Model' }).first().click() },
    { name: 'API key', route: '/account', open: (p) => p.getByRole('button', { name: 'Create key' }).first().click() },
    { name: 'password change', route: '/account', open: (p) => p.getByRole('button', { name: 'Change password' }).first().click() },
  ]

  for (const w of windows) {
    test(`the ${w.name} window keeps Tab inside and closes on Escape`, async ({ page }) => {
      await page.goto(w.route)
      await w.open(page)
      await expect(topDialog(page)).toBeVisible()
      await tabStaysInside(page)
      await page.keyboard.press('Escape')
      await expect(page.locator(WINDOW)).toHaveCount(0)
    })
  }

  test('the drawer is a modal dialog named by its kind and name: Tab stays in it, a Delete window over it takes Tab, ⌘/ or Ctrl+/ reaches the chat', async ({ page }) => {
    await page.goto('/configuration/configmaps?cluster=self')
    await page.locator('tbody tr').filter({ has: page.getByText('kube-root-ca.crt', { exact: true }) }).first().click()
    const drawer = page.getByRole('dialog', { name: 'ConfigMap kube-root-ca.crt', exact: true })
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    await expect(drawer).toHaveAttribute('data-testid', 'resource-drawer')
    await expect(drawer.locator('h2')).toBeFocused()
    // from the title it opens on, both ways round, never to the page behind
    await tabStaysInside(page, 15, DRAWER, 'Shift+Tab')
    await tabStaysInside(page, 15, DRAWER)

    // the floating chat is beside the drawer, not in its Tab order: its shortcut opens it and Escape comes back
    const mac = await page.evaluate(() => {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
      return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '')
    })
    const back = await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML)
    await page.keyboard.press(mac ? 'Meta+Slash' : 'Control+Slash')
    const input = page.getByTestId('floating-chat-input')
    await expect(input, 'the chat opens with the focus in its input').toBeFocused()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await page.getByTestId('floating-chat-panel').evaluate((p) => p.contains(document.activeElement)), `Tab #${i + 1} in the chat`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('floating-chat-panel')).toHaveCount(0)
    await expect(drawer, 'Escape in the chat leaves the drawer open').toHaveCount(1)
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML), 'the focus is back where it was in the drawer').toBe(back)

    await page.getByRole('button', { name: 'Delete ConfigMap' }).click()
    await expect(page.getByTestId('delete-dialog')).toBeVisible()
    await tabStaysInside(page, 8)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('delete-dialog')).toHaveCount(0)
    await tabStaysInside(page, 8, DRAWER)
    await page.keyboard.press('Escape')
    await expect(page.locator(DRAWER)).toHaveCount(0)
  })

  test("Escape on a drawer's Delete window closes that window and leaves the drawer; the next one closes the drawer", async ({ page }) => {
    // Codex QA Q14: the window left the stack on its Escape, and the same key then closed the drawer under it
    await openDrawerDelete(page, '/configuration/configmaps?cluster=self', 'kube-root-ca.crt', 'ConfigMap')
    const drawer = page.locator(DRAWER)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('delete-dialog')).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(drawer, 'the drawer stays').toHaveCount(1)
    await expect(page).toHaveURL(/[?&]detail=ConfigMap/)
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]detail=/)
  })

  test('a system object asks for its name before the delete; an ordinary one does not (#38)', async ({ page }) => {
    await openDrawerDelete(page, '/workloads/daemonsets?cluster=self', 'kindnet', 'DaemonSet')
    const confirm = page.getByTestId('delete-dialog-confirm')
    await expect(page.getByTestId('delete-dialog')).toContainText('system object')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('type-to-confirm').fill('kindne')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('type-to-confirm').fill('kindnet')
    await expect(confirm).toBeEnabled()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('delete-dialog')).toHaveCount(0)

    await openDrawerDelete(page, '/configuration/configmaps?cluster=self', 'kube-root-ca.crt', 'ConfigMap')
    await expect(page.getByTestId('type-to-confirm')).toHaveCount(0)
    await expect(page.getByTestId('delete-dialog-confirm')).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('delete-dialog')).toHaveCount(0)
  })

  test('the namespaces Kubernetes keeps get a notice instead of a delete button (#38)', async ({ page }) => {
    await openDrawerDelete(page, '/cluster/namespaces?cluster=self', 'default', 'Namespace')
    await expect(page.getByTestId('delete-refused')).toContainText('does not allow deleting Namespace "default"')
    await expect(page.getByTestId('delete-dialog-confirm')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('the Dashboard windows close with the button named Close; a search typed in one clears with Clear the search', async ({ page }) => {
    // the top-right X of each window and of its search box showed only an aria-hidden icon: a button with no name
    await page.goto('/?cluster=self')
    const quick = (label: string) => () => page.locator('button').filter({ hasText: label }).first().click()
    const windows = [
      { title: 'Pods', open: () => page.getByTestId('stat-pods').click(), search: 'Search...' },
      { title: 'Issues', open: quick('Check issues') },
      { title: 'Storage analysis', open: quick('Storage analysis') },
      { title: 'Optimization suggestions', open: quick('Optimization suggestions') },
    ]
    for (const w of windows) {
      await w.open()
      const heading = page.locator('h2').filter({ hasText: new RegExp(`^\\s*${w.title}\\s*$`) })
      await expect(heading).toHaveCount(1)
      if (w.search) {
        const box = page.getByPlaceholder(w.search, { exact: true })
        await box.fill('e2e-close-name')
        await page.getByRole('button', { name: 'Clear the search', exact: true }).click()
        await expect(box, `${w.title}: the search is cleared`).toHaveValue('')
      }
      const close = page.getByRole('button', { name: 'Close', exact: true })
      await expect(close, `${w.title}: one button named Close`).toHaveCount(1)
      await close.click()
      await expect(heading, `${w.title}: closed by it`).toHaveCount(0)
    }
  })

  test('admin confirmations are in-app windows, not window.confirm (#68)', async ({ page, request }) => {
    const headers = await adminHeaders(request)
    const name = withUndo(`E2EModalRole${Date.now()}`, async (n) => { const role = ((await (await request.get('/api/v1/auth/roles', { headers })).json()) as Array<{ id: number; name: string }>).find((r) => r.name === n); if (role) await request.delete(`/api/v1/auth/admin/roles/${role.id}`, { headers }) })
    const created = await request.post('/api/v1/auth/admin/roles', { headers, data: { name, description: 'modals.spec', permissions: ['menu.dashboard'] } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const roleExists = async () => ((await (await request.get('/api/v1/auth/roles', { headers })).json()) as Array<{ name: string }>).some((r) => r.name === name)
    let nativeDialogs = 0
    page.on('dialog', (d) => { nativeDialogs++; void d.dismiss() })
    try {
      await page.goto('/admin/roles')
      const row = page.locator('tr').filter({ hasText: name })
      // the list pages as many roles as fit the screen; a new role comes last
      expect(await turnToRow(page, 'roles-pager', row), `${name} on a page of Roles`).toBe(true)
      await row.locator('button[title="Delete"]').click()
      await expect(page.getByTestId('confirm-dialog')).toContainText(name)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
      expect(await roleExists()).toBe(true)

      await row.locator('button[title="Delete"]').click()
      await page.getByTestId('confirm-dialog-ok').click()
      await expect.poll(roleExists, { timeout: 10_000 }).toBe(false)
      expect(nativeDialogs).toBe(0)
    } finally {
      if (await roleExists()) {
        const roles = (await (await request.get('/api/v1/auth/roles', { headers })).json()) as Array<{ id: number; name: string }>
        const r = roles.find((x) => x.name === name)
        if (r) await request.delete(`/api/v1/auth/admin/roles/${r.id}`, { headers })
      }
    }
  })
})

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
