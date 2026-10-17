import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Admin → Investigations (features.alertInvestigation on in the dev values): the reports listed, one opened in the
// dialog (report, alert labels, tool calls), the ?id= link the audit summary carries, and nothing for a Read user.
// The test makes its own report through the webhook so it does not lean on another spec's rows.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function webhookToken(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-inv-page-'))
  const kc = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  const b64 = execSync(`kubectl --kubeconfig ${kc} -n kubeast get secret kubeast-secrets -o jsonpath={.data.ALERT_WEBHOOK_TOKEN}`, { encoding: 'utf8' })
  return Buffer.from(b64.trim(), 'base64').toString()
}

async function login(request: APIRequestContext, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function loginUI(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
}

const NAME = `E2EPage${Date.now()}`
let reportId = ''

test.describe.serial('Admin → Investigations', () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000)
    const admin = await login(request)
    const res = await request.post('/api/v1/alerts/webhook?cluster=self', {
      headers: { Authorization: `Bearer ${webhookToken()}` },
      data: {
        version: '4', status: 'firing', externalURL: 'http://alertmanager.e2e:9093',
        alerts: [{
          status: 'firing',
          labels: { alertname: NAME, severity: 'warning', namespace: 'default', deployment: 'e2e-unschedulable' },
          annotations: { summary: '<b>not bold</b> — the alert panel shows this as text' },
          startsAt: new Date().toISOString(), generatorURL: 'http://prometheus.e2e/graph', fingerprint: `page-${Date.now()}`,
        }],
      },
    })
    expect(await res.json()).toMatchObject({ accepted: 1 })
    await expect
      .poll(async () => {
        const list = await (await request.get('/api/v1/ai/investigations', { headers: bearer(admin), params: { cluster: 'self', limit: 50 } })).json()
        const row = list.items.find((r: { alertname: string }) => r.alertname === NAME)
        reportId = row?.id ?? ''
        return row?.status
      }, { timeout: 240_000, intervals: [3_000] })
      .toBe('done')
  })

  test('the admin menu leads to the list, the cluster filter keeps the report, and the dialog shows it', async ({ page, request }) => {
    const admin = await login(request)
    const detail = await (await request.get(`/api/v1/ai/investigations/${reportId}`, { headers: bearer(admin) })).json()

    await loginUI(page)
    // the admin group of the sidebar is open on an admin page
    await page.goto('/admin/audit')
    await page.getByTestId('nav-investigations').click()
    await expect(page).toHaveURL(/\/admin\/investigations$/)
    const row = page.getByTestId(`investigation-row-${reportId}`)
    await expect(row).toContainText(NAME)
    await expect(row).toContainText('default')

    await page.getByTestId('investigations-cluster-filter').fill('self')
    await page.getByTestId('investigations-search').click()
    await expect(row).toBeVisible()

    await page.getByTestId(`investigation-open-${reportId}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]id=${reportId}`))
    const modal = page.getByTestId('investigation-modal')
    await expect(modal.getByTestId('investigation-report')).toBeVisible()
    expect((await modal.getByTestId('investigation-report').innerText()).length).toBeGreaterThan(40)
    // The annotation is shown as text, not markup.
    await expect(modal).toContainText('<b>not bold</b>')
    expect(await modal.locator('b', { hasText: 'not bold' }).count()).toBe(0)
    if (detail.tool_calls.length > 0) {
      await expect(modal.getByTestId('investigation-tools').locator('tbody tr')).toHaveCount(detail.tool_calls.length)
    }
    await modal.getByRole('button', { name: /close|닫기/i }).last().click()
    await expect(modal).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]id=/)
  })

  test('the ?id= link from the audit summary opens the report directly', async ({ page }) => {
    await loginUI(page)
    await page.goto(`/admin/investigations?id=${reportId}`)
    await expect(page.getByTestId('investigation-modal').getByTestId('investigation-report')).toBeVisible()
    await expect(page.getByTestId('investigation-modal')).toContainText(NAME)
  })

  test('a Read user sees no menu entry and is sent away from the page', async ({ page, request }) => {
    const admin = await login(request)
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-invpage-${Date.now().toString(36)}@kubeast.local`
    const password = 'E2e-invpage-throwaway-1!'
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E investigations page', email, password, role_id: member.id } })
    expect(created.status()).toBe(201)
    const userId = (await created.json()).id as string
    try {
      await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
      await loginUI(page, email, password)
      await page.goto('/')
      await expect(page.getByTestId('sidebar-nav')).toBeVisible()
      await expect(page.getByTestId('nav-investigations')).toHaveCount(0)
      await page.goto('/admin/investigations')
      await expect(page).not.toHaveURL(/\/admin\/investigations/)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
