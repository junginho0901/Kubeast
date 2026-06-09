import { test as setup, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

const STORAGE_STATE = path.resolve(__dirname, '../.auth/user.json')

// Login once and persist storage state. Subsequent specs reuse it via
// `test.use({ storageState })` — see the spec files.
setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_USER_EMAIL
  const password = process.env.E2E_USER_PASSWORD

  if (!email || !password) {
    throw new Error(
      'E2E_USER_EMAIL and E2E_USER_PASSWORD must be set. ' +
        'These should map to a valid kubeast user account on the kind cluster.',
    )
  }

  await page.goto('/')
  // Login form has unlabeled inputs; target by autocomplete attribute
  // and password type which are stable across i18n / theme changes.
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()

  // After successful submit the login form is replaced by app shell.
  // Wait for any "no longer on login screen" signal — the email input
  // disappears.
  await page.waitForFunction(
    () => !document.querySelector('input[autocomplete="email"]'),
    { timeout: 20000 },
  )
  // Sanity check: a real navigation chrome element should be on screen.
  await expect(page.locator('body')).toBeVisible()

  // Provision a second cluster so the multi-cluster switch / RBAC e2e has
  // something to switch to. 'self' = the in-cluster ServiceAccount (k8s mode),
  // distinct from the external 'default'. Idempotent — a 409 (already
  // registered) is fine.
  const token = await page.evaluate(() => localStorage.getItem('kubeast:access-token'))
  if (token) {
    await page.request.post('/api/v1/clusters', {
      headers: { Authorization: `Bearer ${token}` },
      data: { mode: 'self', display_name: 'self' },
      failOnStatusCode: false,
    })
  }

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true })
  await page.context().storageState({ path: STORAGE_STATE })
})
