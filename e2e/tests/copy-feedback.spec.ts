import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A Copy the browser refuses — the Clipboard API and the execCommand fallback both, as on a page some browsers
// will not let write — says so instead of "Copied"; a value shown only once (a new API key) keeps the line, so
// the person knows to select it by hand.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))

async function refuseClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('NotAllowedError')) }, configurable: true })
    document.execCommand = () => false
  })
}

test.describe('a refused Copy says so', () => {
  test('a new API key: the line stays under the key', async ({ page }) => {
    await refuseClipboard(page)
    // the key is made in the browser (the server is not asked), so no key is left behind
    await page.route((u) => u.pathname === '/api/v1/auth/api-keys', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await route.fulfill({ status: 201, json: { id: 'e2e-copy', user_id: 'e2e', name: 'e2e-copy', key_prefix: 'kbk_e2e', key: 'kbk_e2e_not_a_real_key', cluster_ids: null, role_ceiling: 'Read', expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: new Date().toISOString() } })
    })
    await page.goto('/account')
    const open = page.getByTestId('api-key-create-open')
    test.skip(!(await open.waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'API keys are off on this install')
    await open.click()
    await page.getByTestId('api-key-name').fill('e2e-copy')
    await page.getByTestId('api-key-submit').click()
    await page.getByTestId('api-key-copy').click()
    await expect(page.getByTestId('api-key-copy-failed')).toHaveText(EN.common.copyFailed)
    await page.waitForTimeout(4_000)
    await expect(page.getByTestId('api-key-copy-failed'), 'it stays: the key is not shown again').toHaveText(EN.common.copyFailed)
  })

  test("a drawer's YAML tab: Not copied, not Copied", async ({ page }) => {
    await refuseClipboard(page)
    await page.goto(`/namespaces?cluster=self&detail=${encodeURIComponent('ConfigMap/default/kube-root-ca.crt')}`)
    await page.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 20_000 })
    const copy = page.getByTestId('yaml-copy')
    await expect(copy).toBeEnabled({ timeout: 20_000 })
    await copy.click()
    await expect(copy).toHaveText(EN.common.notCopied)
    await expect(copy).toHaveAttribute('title', EN.common.copyFailed)
  })
})
