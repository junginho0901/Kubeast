import { test, expect, type APIResponse, type Page } from '@playwright/test'

// Azure OpenAI is its v1 API only: the form asks for https://<resource>.openai.azure.com/openai/v1/ and a deployment
// name, deployment URLs and api-version are refused on save and on test with the v1 form in the message, and the
// connection test runs the chat's own client. There is no Azure account in the dev install: the dev Ollama's
// OpenAI-compatible /v1 stands in for the endpoint (it ignores the key headers), one short "ping".

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const OLLAMA = 'http://host.docker.internal:11434/v1'
const V1_FORM = 'https://<resource>.openai.azure.com/openai/v1/'

async function dropIfCreated(page: Page, res: APIResponse) {
  if (res.status() !== 200) return
  const { id } = await res.json()
  if (id) await page.request.delete(`/api/v1/ai/model-configs/${id}`, { headers: XRW })
}

test.describe('Azure OpenAI (v1 API)', () => {
  test('the form asks for the v1 endpoint and a deployment name', async ({ page }) => {
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-azure').click()
    await expect(page.getByPlaceholder(V1_FORM)).toBeVisible()
    // the narrow field cuts the placeholder off: the line under it says how it ends
    await expect(page.getByTestId('base-url-hint')).toContainText('/openai/v1/')
    // no built-in list: the deployment name is typed
    await expect(page.getByTestId('model-select')).toHaveCount(0)
    await expect(page.getByTestId('model-input')).toHaveAttribute('placeholder', 'my-gpt-deployment')
    await expect(page.getByTestId('model-hint')).toHaveText(/deployment name|배포 이름/)
    await expect(page.getByText('API Version')).toHaveCount(0)
    // a key variable the server takes (AZURE_API_KEY was refused on save)
    await expect(page.locator('input[value="KUBEAST_AI_KEY_AZURE"]')).toHaveCount(1)
  })

  test('deployment URLs and api-version are refused on save and on test, with the v1 form', async ({ page }) => {
    for (const base_url of [
      'https://res.openai.azure.com/openai/deployments/gpt4o',
      'https://res.openai.azure.com/openai/v1/?api-version=2024-10-21',
    ]) {
      const tested = await page.request.post('/api/v1/ai/model-configs/test', {
        headers: XRW, data: { provider: 'azure', model: 'my-deployment', base_url, api_key: 'e2e-azure-key' },
      })
      expect(tested.status(), base_url).toBe(400)
      expect((await tested.json()).detail).toContain(V1_FORM)

      const saved = await page.request.post('/api/v1/ai/model-configs', {
        headers: XRW, data: { name: 'e2e-azure-old', provider: 'azure', model: 'my-deployment', base_url, api_key_env: 'KUBEAST_AI_KEY_AZURE', enabled: false },
      })
      try {
        expect(saved.status(), base_url).toBe(400)
        expect((await saved.json()).detail).toContain(V1_FORM)
      } finally {
        await dropIfCreated(page, saved)
      }
    }

    const empty = await page.request.post('/api/v1/ai/model-configs/test', {
      headers: XRW, data: { provider: 'azure', model: 'my-deployment', base_url: '', api_key: 'e2e-azure-key' },
    })
    expect(empty.status()).toBe(400)
    expect((await empty.json()).detail).toContain('v1 endpoint')
  })

  test('the connection test reaches an OpenAI-compatible v1 endpoint through the chat client', async ({ page }) => {
    const listed = await (await page.request.post('/api/v1/ai/model-configs/models', { headers: XRW, data: { provider: 'ollama', base_url: OLLAMA } })).json()
    test.skip(!listed.models?.length, `the dev Ollama is not reachable (${listed.error ?? 'no models'})`)
    const model: string = listed.models.find((m: { name: string }) => m.name === 'granite4.1:3b')?.name ?? listed.models[0].name

    const res = await page.request.post('/api/v1/ai/model-configs/test', {
      headers: XRW, data: { provider: 'azure', model, base_url: OLLAMA, api_key: 'e2e-azure-key' },
      timeout: 120_000,
    })
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, message: 'Connection successful' })
  })
})
