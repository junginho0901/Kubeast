import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Writes the server refuses say why where they were pressed, and the line stays: each case answers its request in
// the browser with a 409 and a reason of its own (the server is never asked, nothing changes), presses as a person
// would and holds the line under the action to "<what did not happen>: <that reason>" — also 6 s later.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the server said no'
const RUN = Date.now().toString(36)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const failed = (action: string) => EN.common.failed[action].replace('{{reason}}', REASON)

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}
// every request of these methods to a path the test names is refused in the browser
async function refuse(page: Page, matches: (pathname: string) => boolean, methods = ['POST', 'PUT', 'PATCH', 'DELETE']): Promise<string[]> {
  const seen: string[] = []
  await page.route((url) => matches(url.pathname), async (route) => {
    if (!methods.includes(route.request().method())) return route.fallback()
    seen.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: 409, json: { detail: REASON } })
  })
  return seen
}
async function stays(page: Page, testId: string, text: string): Promise<void> {
  await expect(page.getByTestId(testId)).toHaveText(text, { timeout: 15_000 })
  await page.waitForTimeout(6_000)
  await expect(page.getByTestId(testId), 'still there 6 s later').toHaveText(text)
}

test.describe('a refused write says why where it was pressed', () => {
  // each line is held for 6 s after it shows (stays), some cases twice
  test.setTimeout(90_000)
  test('Account → API keys: Revoke', async ({ page, request }) => {
    const admin = await login(request)
    const config = await (await request.get('/api/v1/auth/api-keys/config', { headers: bearer(admin) })).json()
    test.skip(!config.enabled, 'API keys are off on this install')
    const made = await request.post('/api/v1/auth/api-keys', { headers: bearer(admin), data: { name: `e2e-af-${RUN}`, expires_in_days: 1 } })
    expect(made.status(), await made.text()).toBe(201)
    const id = (await made.json()).id as string
    try {
      const seen = await refuse(page, (p) => p === `/api/v1/auth/api-keys/${id}`)
      await page.goto('/account')
      await page.getByTestId(`api-key-revoke-${id}`).click()
      await page.getByTestId(`api-key-revoke-confirm-${id}`).click()
      await stays(page, `api-key-error-${id}`, failed('revoke'))
      expect(seen).toEqual([`DELETE /api/v1/auth/api-keys/${id}`])
      await expect(page.getByTestId(`api-key-row-${id}`), 'the key is still listed').toHaveCount(1)
    } finally {
      await request.delete(`/api/v1/auth/api-keys/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('Teams: Add and Delete', async ({ page, request }) => {
    // a team of the run to press Delete on (made through the API, which the page's stand-in does not answer)
    const admin = await login(request)
    const name = `e2e-af-del-${RUN}`
    const made = await request.post('/api/v1/auth/admin/organizations', { headers: bearer(admin), data: { type: 'team', name } })
    expect(made.status(), await made.text()).toBe(201)
    const id = (await made.json()).id as number
    try {
      await refuse(page, (p) => p.startsWith('/api/v1/auth/admin/organizations'))
      await page.goto('/admin/organizations')
      await page.getByPlaceholder(EN.adminOrg.inputPlaceholder).fill(`e2e-af-${RUN}`)
      await page.getByPlaceholder(EN.adminOrg.inputPlaceholder).press('Enter')
      await stays(page, 'team-add-error', EN.adminOrg.addError.replace('{{reason}}', REASON))
      const row = page.getByTestId('teams-table').locator('tbody tr').filter({ hasText: name })
      await row.getByTitle(EN.adminOrg.deleteTitle).click()
      await page.getByTestId('confirm-dialog-ok').click()
      await stays(page, 'team-delete-error', failed('delete'))
      await expect(row, 'the team is still listed').toHaveCount(1)
    } finally {
      await request.delete(`/api/v1/auth/admin/organizations/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('AI Models: Delete and Activate', async ({ page, request }) => {
    const admin = await login(request)
    const res = await request.get('/api/v1/ai/model-configs', { headers: bearer(admin), failOnStatusCode: false })
    test.skip(!res.ok(), 'AI is off on this install')
    const configs = (await res.json()) as { id: number; name: string; enabled: boolean; used_for?: string[] }[]
    test.skip(configs.length === 0, 'no model configs')
    await refuse(page, (p) => p.startsWith('/api/v1/ai/model-configs/'), ['PATCH', 'DELETE'])
    await page.goto('/admin/ai-models')
    const first = configs[0]
    await page.getByTitle(EN.common.delete).first().click()
    await page.getByTestId('confirm-dialog-ok').click()
    await stays(page, `ai-model-delete-error-${first.id}`, failed('delete'))
    const idle = configs.find((c) => c.enabled && !(c.used_for ?? []).includes('chat'))
    if (idle) {
      await page.getByRole('button', { name: /^Activate$/ }).first().click()
      await page.getByTestId('confirm-dialog-ok').click()
      await expect(page.locator('[data-testid^="ai-model-activate-error-"]')).toHaveText(failed('change'), { timeout: 15_000 })
    }
  })

  test('CronJob drawer: Suspend and Run Now', async ({ page }) => {
    await refuse(page, (p) => p.startsWith('/api/v1/cluster/namespaces/default/cronjobs/e2e-fixture'))
    await page.goto(`/cluster/namespaces?cluster=self&detail=${encodeURIComponent('CronJob/default/e2e-fixture')}`)
    const toggle = page.getByRole('button', { name: new RegExp(`^(${EN.cronjob.suspend}|${EN.cronjob.resume})$`) })
    test.skip(!(await toggle.waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'the fixture CronJob drawer shows no Suspend')
    await toggle.click()
    await stays(page, 'cronjob-suspend-error', failed('change'))
    await page.getByRole('button', { name: EN.cronjob.runNow, exact: true }).first().click()
    await page.locator('[role=dialog],div.fixed.inset-0').getByRole('button', { name: EN.cronjob.runNow, exact: true }).click()
    await stays(page, 'workload-action-toast', `${EN.cronjob.runNowFailed.replace('{{reason}}', REASON)}✕`)
    await page.getByTestId('workload-action-toast').getByRole('button', { name: EN.common.close }).click()
    await expect(page.getByTestId('workload-action-toast'), 'closed when the person closes it').toHaveCount(0)
  })

  test('Node drawer: Cordon', async ({ page, request }) => {
    const admin = await login(request)
    const nodes = await (await request.get('/api/v1/cluster/nodes?cluster=self', { headers: bearer(admin) })).json()
    const node = ((Array.isArray(nodes) ? nodes : nodes.items) as { name: string }[])[0]?.name
    test.skip(!node, 'no node listed on self')
    await refuse(page, (p) => p === `/api/v1/cluster/nodes/${node}/cordon` || p === `/api/v1/cluster/nodes/${node}/uncordon`)
    await page.goto(`/cluster/namespaces?cluster=self&detail=${encodeURIComponent(`Node/${node}`)}`)
    await page.getByRole('button', { name: new RegExp(`^(${EN.nodes.actions.cordon}|${EN.nodes.actions.uncordon})$`) }).click({ timeout: 20_000 })
    await stays(page, 'node-cordon-error', failed('change'))
  })

  test('Account: Change password names why it was refused', async ({ page }) => {
    const seen = await refuse(page, (p) => p === '/api/v1/auth/change-password')
    await page.goto('/account')
    await page.getByRole('button', { name: EN.account.password.open }).click()
    const inputs = page.getByTestId('password-dialog').locator('input[type="password"]')
    await inputs.nth(0).fill('e2e-not-the-password')
    await inputs.nth(1).fill('E2e-af-new-Passw0rd!')
    await inputs.nth(2).fill('E2e-af-new-Passw0rd!')
    await page.getByRole('button', { name: EN.account.password.submit }).click()
    await stays(page, 'password-error', EN.account.password.failed.replace('{{reason}}', REASON))
    expect(seen, 'the request went out once and the server was not asked').toEqual(['POST /api/v1/auth/change-password'])
  })

  test('Namespaces: Create names why it was refused', async ({ page }) => {
    await refuse(page, (p) => p === '/api/v1/cluster/namespaces')
    await page.goto('/cluster/namespaces?cluster=self')
    await page.getByRole('button', { name: EN.namespaces.create.button }).click()
    await page.getByPlaceholder(EN.namespaces.create.namePlaceholder).fill(`e2e-af-${RUN}`)
    await page.getByTestId('namespace-create-dialog').getByRole('button', { name: EN.namespaces.create.submit, exact: true }).click()
    await stays(page, 'namespace-create-error', EN.namespaces.create.error.replace('{{reason}}', REASON))
  })

  test('AI Chat: Delete and Rename of a conversation', async ({ page, request }) => {
    const admin = await login(request)
    // the list is the conversations of the cluster on screen, so the conversation is made on that cluster
    const made = await request.post('/api/v1/sessions?cluster=self', { headers: bearer(admin), data: { title: `e2e-af-${RUN}` }, failOnStatusCode: false })
    test.skip(!made.ok(), `no conversation could be made: ${made.status()}`)
    const id = (await made.json()).id as string
    try {
      await refuse(page, (p) => p === `/api/v1/sessions/${id}`, ['PATCH', 'DELETE'])
      await page.goto('/ai-chat?cluster=self')
      const row = page.getByTitle(`e2e-af-${RUN}`).first()
      await expect(row, 'the conversation is in the list').toHaveCount(1, { timeout: 20_000 })
      await row.click({ button: 'right' })
      await page.getByRole('button', { name: EN.aiChat.delete, exact: true }).last().click()
      await page.getByTestId('confirm-dialog-ok').click()
      await stays(page, 'session-list-error', failed('delete'))
      await row.click({ button: 'right' })
      await page.getByRole('button', { name: EN.aiChat.rename, exact: true }).click()
      await page.keyboard.type('-renamed')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('session-list-error')).toHaveText(failed('change'), { timeout: 15_000 })
    } finally {
      await request.delete(`/api/v1/sessions/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
