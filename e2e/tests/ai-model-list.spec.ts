import { test, expect, type Page } from '@playwright/test'
import { hasStandIn, STAND_IN, STAND_IN_ADDRESS, STAND_IN_SKIP } from './model-address-standin'

// Admin → AI Models → Add Model: the model dropdown lists what the provider itself lists (an Ollama address answering
// the OpenAI-compatible /models, through ai-service — the dev model-stub's /ok/ endpoint, deploy/kind/devtools.yaml, so
// no local model server is needed), and falls back to the built-in list with a note when the provider's list cannot be
// read (Anthropic without ANTHROPIC_API_KEY in the dev install; with the key — scripts/kind-model-haiku.sh up —
// Anthropic lists its own models the same way). The models compared come from the same API the form calls.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090/ok/v1'

async function openOptions(page: Page): Promise<string[]> {
  await page.getByTestId('model-select').click()
  const ids = await page.locator('[data-testid^="model-option-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('model-option-'.length)))
  await page.getByTestId('model-select').click()
  return ids
}

test.describe('AI model list from the provider', () => {
  test('a list the service refused says why on the form', async ({ page }) => {
    await page.route(/\/api\/v1\/ai\/model-configs\/models(\?|$)/, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'audit unavailable' }),
    }))
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    const source = page.getByTestId('model-list-source')
    await expect(source).toHaveText(/(Built-in list|기본 목록).*audit unavailable/, { timeout: 15_000 })
    await expect(source).not.toContainText('status code')
    await expect(source).toHaveAttribute('title', 'audit unavailable')
  })

  // A CA field that holds no PEM certificate is the admin's to fix: the list line and Test say so (they answered 500
  // when ssl refused it). Save refuses it with the same words (test_model_config_input.py).
  test('a CA that is not a certificate is named on the list line and on Test', async ({ page }) => {
    const NOT_PEM = 'CA certificate: not a certificate in PEM form (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)'
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    await page.getByPlaceholder(/localhost:11434|api\.example\.com/).fill(STUB)
    await page.locator('details', { hasText: /Advanced|고급/ }).locator('summary').click()
    await page.getByPlaceholder(/-----BEGIN CERTIFICATE-----/).fill('한국어 인증서 아님')
    await expect(page.getByTestId('model-list-source')).toHaveText(new RegExp(`(Built-in list|기본 목록).*${NOT_PEM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 15_000 })

    const tested = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ai/model-configs/test')
    await page.getByRole('button', { name: /^(Test|연결 테스트)$/ }).click()
    const answer = await tested
    expect([answer.status(), (await answer.json()).detail]).toEqual([400, NOT_PEM])
    await expect(page.getByText(NOT_PEM, { exact: true })).toHaveCount(1)
  })

  test('the form says which address was refused when connecting, on the list and on Test', async ({ page }) => {
    test.skip(!hasStandIn(), STAND_IN_SKIP)
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    await page.getByPlaceholder(/localhost:11434|api\.example\.com/).fill(STAND_IN)

    const source = page.getByTestId('model-list-source')
    await expect(source).toHaveText(new RegExp(`(Built-in list|기본 목록).*when connecting.*${STAND_IN_ADDRESS.replace(/\./g, '\\.')}`), { timeout: 15_000 })
    await expect(source).toHaveAttribute('title', new RegExp(STAND_IN_ADDRESS.replace(/\./g, '\\.')))

    // the screen's requests carry ?cluster=
    const tested = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ai/model-configs/test')
    await page.getByRole('button', { name: /^(Test|연결 테스트)$/ }).click()
    const answer = await (await tested).json()
    expect(answer.success).toBe(false)
    expect(answer.message).toContain(STAND_IN_ADDRESS)
    // Test's result is the message alone; the list's line above holds the same words after its own
    await expect(page.getByText(answer.message, { exact: true })).toHaveText(new RegExp(STAND_IN_ADDRESS.replace(/\./g, '\\.')))
  })

  test('an Ollama address lists its own models; Anthropic lists its own with a key and falls back to the built-in list without', async ({ page }) => {
    const res = await page.request.post('/api/v1/ai/model-configs/models', { headers: XRW, data: { provider: 'ollama', base_url: STUB } })
    expect(res.status()).toBe(200)
    const listed = await res.json()
    test.skip(/Connect|Timeout|404/.test(listed.error ?? ''), `the dev model-stub is not reachable — kubectl apply -f deploy/kind/devtools.yaml (${listed.error})`)
    expect(listed.models.map((m: { name: string }) => m.name), `list: ${listed.error ?? ''}`).toEqual(['stub-large', 'stub-small'])

    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    await page.getByPlaceholder(/localhost:11434|api\.example\.com/).fill(STUB)

    const source = page.getByTestId('model-list-source')
    await expect(source).toHaveText(new RegExp(`\\(${listed.models.length}\\)|${listed.models.length}개`), { timeout: 15_000 })
    expect(await openOptions(page)).toEqual(listed.models.map((m: { name: string }) => m.name))
    // a new config starts on a model the provider has, not on the built-in default
    await expect(page.getByTestId('model-select')).toContainText(listed.models[0].label ?? listed.models[0].name)

    const anthropic = await (await page.request.post('/api/v1/ai/model-configs/models', {
      headers: XRW, data: { provider: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY' },
    })).json()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-anthropic').click()
    if (anthropic.models?.length) {
      // The dev install has ANTHROPIC_API_KEY (scripts/kind-model-haiku.sh up): the provider's own list, as above.
      await expect(source).toHaveText(new RegExp(`\\(${anthropic.models.length}\\)|${anthropic.models.length}개`), { timeout: 15_000 })
      expect(await openOptions(page)).toEqual(anthropic.models.map((m: { name: string }) => m.name))
      expect(anthropic.models.map((m: { name: string }) => m.name)).toContain('claude-haiku-5-5')
    } else {
      expect(anthropic.error).toContain('ANTHROPIC_API_KEY')
      await expect(source).toHaveText(/Built-in list|기본 목록/, { timeout: 15_000 })
      expect(await openOptions(page)).toContain('claude-haiku-5-5')
    }
  })
})
