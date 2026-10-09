import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Create, edit and confirm windows share one frame (re-QA #19 #38 #53 #66 #68):
// Escape closes them, Tab stays inside, system objects ask for their name
// before a delete, and admin confirmations are in-app windows instead of the
// browser's window.confirm. Nothing here is created or deleted on a cluster
// except a temporary custom role that the last test removes.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

const topDialog = (page: Page) => page.locator('[role="dialog"]').last()

async function tabStaysInside(page: Page, presses = 15) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]')
      return dialogs.length > 0 && dialogs[dialogs.length - 1].contains(document.activeElement)
    })
    expect(inside, `Tab #${i + 1} left the window`).toBe(true)
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
      await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    })
  }

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

  test('admin confirmations are in-app windows, not window.confirm (#68)', async ({ page, request }) => {
    const headers = await adminHeaders(request)
    const name = `E2EModalRole${Date.now()}`
    const created = await request.post('/api/v1/auth/admin/roles', { headers, data: { name, description: 'modals.spec', permissions: ['menu.dashboard'] } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const roleExists = async () => ((await (await request.get('/api/v1/auth/roles', { headers })).json()) as Array<{ name: string }>).some((r) => r.name === name)
    let nativeDialogs = 0
    page.on('dialog', (d) => { nativeDialogs++; void d.dismiss() })
    try {
      await page.goto('/admin/roles')
      const row = page.locator('tr').filter({ hasText: name })
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
