import { test, expect, type APIResponse, type Page } from '@playwright/test'

// Admin → AI Models with provider "Claude subscription" (claude-code): the form shows the personal-use notice and
// the token variable and has no base URL or provider model list. Where this install cannot run it (the chart switch
// off, or an image without Claude Code) the entry is greyed out with "Not set up", and picking it shows the reason
// and keeps Test and Create off; where it can, the connection test reports what ai-service says. Saving such a
// config is refused by the API while the provider is off, and no other provider may name the token variable.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'

async function dropIfCreated(page: Page, res: APIResponse) {
  if (res.ok()) {
    const { id } = await res.json()
    await page.request.delete(`/api/v1/ai/model-configs/${id}`, { headers: XRW })
  }
}

test.describe('Claude subscription provider', () => {
  test('the form warns that it is for personal use and says before Test or Save when it cannot run here', async ({ page }) => {
    const availability = (await (await page.request.get('/api/v1/ai/model-configs/providers', { headers: XRW })).json()).providers['claude-code']
    const apiTest = await (await page.request.post('/api/v1/ai/model-configs/test', {
      headers: XRW, data: { provider: 'claude-code', model: 'claude-sonnet-5-5', api_key_env: TOKEN_ENV },
    })).json()

    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    const notice = page.getByTestId('claude-subscription-notice')
    await expect(notice).toHaveCount(0)
    await page.getByTestId('provider-select').click()
    const option = page.getByTestId('provider-option-claude-code')
    if (availability.available) await expect(option).not.toContainText(/Not set up|설정 안 됨/)
    else await expect(option).toContainText(/Not set up|설정 안 됨/)
    await option.click()

    await expect(notice).toContainText(/Personal use only|개인용으로만/)
    await expect(notice).toContainText(/Anthropic/)
    await expect(notice).toContainText('ai.providers.claudeCode.enabled')
    await expect(page.getByPlaceholder(TOKEN_ENV)).toHaveValue(TOKEN_ENV)
    await expect(page.getByPlaceholder(/api\.example\.com|localhost:11434/)).toHaveCount(0)  // no base URL field
    await expect(page.getByTestId('model-list-source')).toHaveText(/Claude Code has no model list|모델 목록을 제공하지 않습니다/)
    await expect(page.getByTestId('model-select')).toContainText('Claude Sonnet 5.5')

    const testButton = page.getByRole('button', { name: /^(Test|연결 테스트)$/ })
    const createButton = page.getByRole('button', { name: /^(Create|생성)$/ })
    if (!availability.available) {
      // the reason the API gives, shown at once; nothing to fill in before learning it
      expect(availability.reason).toMatch(/ai\.providers\.claudeCode\.enabled/)
      expect(apiTest.message).toBe(availability.reason)
      await expect(page.getByTestId('provider-unavailable')).toContainText(availability.reason)
      await page.getByPlaceholder(/my-gpt4/).fill('e2e-sub-form')  // name and model set: only the provider holds them off
      await expect(testButton).toBeDisabled()
      await expect(createButton).toBeDisabled()
    } else {
      await expect(page.getByTestId('provider-unavailable')).toHaveCount(0)
      await testButton.click()
      if (apiTest.success) {
        await expect(page.getByText(/Connection successful/)).toBeVisible({ timeout: 120_000 })
      } else {
        // on without the token in ai-service: 400 naming the variable
        const reason = apiTest.message ?? apiTest.detail
        expect(reason).toMatch(/CLAUDE_CODE_OAUTH_TOKEN|Claude Code/)
        await expect(page.getByText(reason, { exact: false })).toBeVisible({ timeout: 120_000 })
      }
    }

    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-anthropic').click()
    await expect(notice).toHaveCount(0)
  })

  test('saving is refused while the provider is off, and other providers may not name the token', async ({ page }) => {
    const probe = await (await page.request.post('/api/v1/ai/model-configs/test', {
      headers: XRW, data: { provider: 'claude-code', model: 'claude-sonnet-5-5', api_key_env: TOKEN_ENV },
    })).json()
    const reason: string = probe.message ?? probe.detail ?? ''
    const off = /ai\.providers\.claudeCode\.enabled|WITH_CLAUDE_CODE/.test(reason)

    const sub = await page.request.post('/api/v1/ai/model-configs', {
      headers: XRW, data: { name: 'e2e-claude-sub', provider: 'claude-code', model: 'claude-sonnet-5-5', api_key_env: TOKEN_ENV, enabled: false },
    })
    try {
      if (off) {
        expect(sub.status()).toBe(400)
        expect((await sub.json()).detail).toContain(reason)
      } else {
        expect(sub.status()).toBe(200)
        expect((await sub.json()).provider).toBe('claude-code')
      }
    } finally {
      await dropIfCreated(page, sub)
    }

    const borrowed = await page.request.post('/api/v1/ai/model-configs', {
      headers: XRW, data: { name: 'e2e-borrowed-token', provider: 'openai', model: 'gpt-5-mini', api_key_env: TOKEN_ENV, enabled: false },
    })
    try {
      expect(borrowed.status()).toBe(400)
      expect((await borrowed.json()).detail).toContain('only provider claude-code')
    } finally {
      await dropIfCreated(page, borrowed)
    }

    const withBase = await page.request.post('/api/v1/ai/model-configs/test', {
      headers: XRW, data: { provider: 'claude-code', model: 'claude-sonnet-5-5', api_key_env: TOKEN_ENV, base_url: 'https://api.example.com' },
    })
    expect(withBase.status()).toBe(400)
    expect((await withBase.json()).detail).toContain('takes no base_url')
  })
})
