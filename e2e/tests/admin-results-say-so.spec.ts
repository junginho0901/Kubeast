import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// What an admin press made or took away is said where it was pressed, as a Create from YAML's line is: a new account
// and a new role are named under the page's header (the list may show them on another page), an API key just issued
// is brought into view (it is shown only this once), a revoked key is named in its card, and the expiry field keeps
// what was typed. Each object is of this run and removed after; a key is revoked by the test itself.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const run = () => `e2e-ar-${Date.now().toString(36)}`
const created = (objects: string) => EN.yamlCreate.created.replace('{{objects}}', objects)

test.describe('an admin press says what it made or took away', () => {
  test('a new account is named under the header', async ({ page }) => {
    const name = run()
    const email = `${name}@kubeast.local`
    let id = ''
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /^(Add user|사용자 추가)$/ }).first().click()
      const dialog = page.getByTestId('create-user-dialog')
      await dialog.locator('input').first().fill(name)
      await dialog.locator('input[type="email"]').fill(email)
      await dialog.locator('input[type="password"]').fill('e2e-admin-results-1')
      await page.getByTestId('create-user-role').click()
      await dialog.getByRole('button', { name: 'Member', exact: true }).click()
      const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/admin/users')
      await dialog.locator('button[type="submit"]').click()
      const res = await answer
      expect(res.status()).toBe(201)
      id = (await res.json()).id
      await expect(dialog).toHaveCount(0)
      const line = page.getByTestId('yaml-created')
      await expect(line).toContainText(created(`User/${name} (${email})`))
      await expect(line).toBeInViewport()
      await page.waitForTimeout(3_000)
      await expect(line, 'it stays').toBeInViewport()
    } finally {
      if (id) expect((await page.request.delete(`/api/v1/auth/admin/users/${id}`, { headers: XRW })).ok()).toBeTruthy()
    }
  })

  test('a new role is named under the header', async ({ page }) => {
    const name = run()
    let id = ''
    try {
      await page.goto('/admin/roles')
      await page.getByRole('button', { name: 'Create Role' }).first().click()
      const dialog = page.getByTestId('role-dialog')
      await dialog.locator('input').first().fill(name)
      const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/admin/roles')
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      const res = await answer
      expect(res.status()).toBe(201)
      id = String((await res.json()).id)
      await expect(dialog).toHaveCount(0)
      const line = page.getByTestId('yaml-created')
      await expect(line).toContainText(created(`Role/${name}`))
      await expect(line).toBeInViewport()
    } finally {
      if (id) expect((await page.request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: XRW })).ok()).toBeTruthy()
    }
  })

  test('an API key just issued is in view, and its revoke is named in the card', async ({ page }) => {
    await page.goto('/account')
    const open = page.getByTestId('api-key-create-open')
    test.skip(!(await open.waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'API keys are off on this install')
    const name = run()
    let id = ''
    try {
      await open.click()
      await page.getByTestId('api-key-name').fill(name)
      const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/api-keys')
      await page.getByTestId('api-key-submit').click()
      const res = await answer
      expect(res.status()).toBe(201)
      id = (await res.json()).id
      await expect(page.getByTestId('api-key-created'), 'the key shown only this once is on screen').toBeInViewport()

      await page.getByTestId(`api-key-revoke-${id}`).click()
      await page.getByTestId(`api-key-revoke-confirm-${id}`).click()
      const revoked = page.getByTestId('api-key-revoked')
      await expect(revoked).toContainText(EN.apiKeys.revoked.replace('{{name}}', name))
      await expect(page.getByTestId('api-key-created'), 'a revoked key is not offered to copy').toHaveCount(0)
      await expect(page.getByTestId(`api-key-row-${id}`)).toHaveCount(0)
      const keys = await (await page.request.get('/api/v1/auth/api-keys', { headers: XRW })).json()
      expect(keys.map((k: { id: string }) => k.id), 'the key is gone on the server').not.toContain(id)
      id = ''
    } finally {
      if (id) await page.request.delete(`/api/v1/auth/api-keys/${id}`, { headers: XRW })
    }
  })

  test('the expiry field keeps what was typed: -1 stays -1 and is refused', async ({ page }) => {
    await page.goto('/account')
    const open = page.getByTestId('api-key-create-open')
    test.skip(!(await open.waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'API keys are off on this install')
    const config = await (await page.request.get('/api/v1/auth/api-keys/config', { headers: XRW })).json()
    await open.click()
    await page.getByTestId('api-key-name').fill(run())
    const days = page.getByTestId('api-key-days')
    // emptied with fill, not a select-all key: in headless Chromium on macOS Control+A moves to the line's start, so
    // "-1" landed before the 30 the window starts with (-130)
    await days.fill('')
    await days.pressSequentially('-1')
    await page.keyboard.press('Tab')
    await expect(days).toHaveValue('-1')
    await expect(page.getByTestId('api-key-days-problem')).toHaveText(EN.apiKeys.daysRange.replace('{{max}}', String(config.max_days)))
    await expect(page.getByTestId('api-key-submit')).toBeDisabled()
    await days.fill('')
    await days.pressSequentially('7')
    await expect(days, 'no 0 left in front').toHaveValue('7')
    await expect(page.getByTestId('api-key-days-problem')).toHaveCount(0)
    await page.getByTestId('api-key-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})
