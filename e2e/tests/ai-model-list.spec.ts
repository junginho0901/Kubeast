import { test, expect, type Page } from '@playwright/test'

// Admin → AI Models → Add Model: the model dropdown lists what the provider itself lists (the dev Ollama, through
// ai-service), and falls back to the built-in list with a note when the provider's list cannot be read (Anthropic
// without ANTHROPIC_API_KEY in the dev install). The models compared come from the same API the form calls.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const OLLAMA = 'http://host.docker.internal:11434/v1'

async function openOptions(page: Page): Promise<string[]> {
  await page.getByTestId('model-select').click()
  const ids = await page.locator('[data-testid^="model-option-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('model-option-'.length)))
  await page.getByTestId('model-select').click()
  return ids
}

test.describe('AI model list from the provider', () => {
  test('Ollama lists its own models; Anthropic without a key falls back to the built-in list', async ({ page }) => {
    const res = await page.request.post('/api/v1/ai/model-configs/models', { headers: XRW, data: { provider: 'ollama', base_url: OLLAMA } })
    expect(res.status()).toBe(200)
    const listed = await res.json()
    test.skip(/Connect|Timeout/.test(listed.error ?? ''), `the dev Ollama is not reachable (${listed.error})`)
    expect(listed.models.length, `Ollama list: ${listed.error ?? ''}`).toBeGreaterThan(0)

    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    await page.getByPlaceholder(/localhost:11434|api\.example\.com/).fill(OLLAMA)

    const source = page.getByTestId('model-list-source')
    await expect(source).toHaveText(new RegExp(`\\(${listed.models.length}\\)|${listed.models.length}개`), { timeout: 15_000 })
    expect(await openOptions(page)).toEqual(listed.models.map((m: { name: string }) => m.name))
    // a new config starts on a model the provider has, not on the built-in default
    await expect(page.getByTestId('model-select')).toContainText(listed.models[0].label ?? listed.models[0].name)

    const anthropic = await (await page.request.post('/api/v1/ai/model-configs/models', {
      headers: XRW, data: { provider: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY' },
    })).json()
    expect(anthropic.models).toEqual([])
    expect(anthropic.error).toContain('ANTHROPIC_API_KEY')

    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-anthropic').click()
    await expect(source).toHaveText(/Built-in list|기본 목록/, { timeout: 15_000 })
    expect(await openOptions(page)).toContain('claude-haiku-5-5')
  })
})
