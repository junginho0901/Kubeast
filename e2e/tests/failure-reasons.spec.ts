import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A refusal says the server's reason, not the HTTP library's words ("AxiosError: Request failed with status code 409")
// or a bare status ("HTTP 403"): AI Chat's first question when the conversation could not be made, and AI
// Optimization refused before its stream began. Each refusal is answered in the browser with a reason of its own,
// so no model is called and nothing on the cluster changes.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the conversation limit is reached'

test.describe("a refusal says the server's reason", () => {
  test('AI Chat: a conversation that could not be made', async ({ page }) => {
    await page.route((u) => u.pathname === '/api/v1/sessions', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 409, json: { detail: REASON } }) : route.fallback())
    await page.goto('/ai-chat?cluster=self')
    const welcome = page.locator('h2', { hasText: EN.aiChat.emptyTitle }).locator('xpath=..')
    await welcome.locator('.grid button').first().click({ timeout: 30_000 })
    const said = EN.aiChat.errorSessionCreate.replace('{{error}}', REASON)
    await expect(page.getByText(said, { exact: true })).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByText(/AxiosError|status code 409/)).toHaveCount(0)
  })

  test('AI Optimization: refused before the stream began', async ({ page }) => {
    await page.route((u) => u.pathname === '/api/v1/ai/suggest-optimization/stream', (route) =>
      route.fulfill({ status: 403, json: { detail: REASON } }))
    await page.goto('/?cluster=default')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kube-system', exact: true }).click()
    await expect(page.getByTestId('optimization-table')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: /^Explain with AI$|^AI 설명$/ }).click()
    const line = page.getByTestId('optimization-stream-error')
    await expect(line).toContainText(REASON, { timeout: 20_000 })
    await expect(line).not.toContainText('HTTP 403')
  })
})
