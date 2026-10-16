import { test, expect, type APIRequestContext } from '@playwright/test'

// Model config tier: with an enabled economy-tier config the floating assistant runs on it and the chat stays on
// the active (default) config; each stream names its tier in model_info. The economy config here is the dev Ollama
// model, so the spec works whichever model is the default (Ollama, or Haiku through scripts/kind-model-haiku.sh).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const OLLAMA = 'http://host.docker.internal:11434'

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

async function modelInfo(request: APIRequestContext, headers: Record<string, string>, path: string, message: string) {
  const res = await request.post(path, {
    headers: { ...headers, Accept: 'text/event-stream', 'X-Cluster-Name': 'self' },
    data: { message },
    timeout: 180_000,
  })
  expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy()
  const line = (await res.text()).split('\n').find((l) => l.startsWith('data: ') && l.includes('"model_info"'))
  expect(line, 'the stream names its model').toBeTruthy()
  return JSON.parse(line!.slice(6)).model_info as { provider: string; model: string; tier: string }
}

test.describe('AI model tier', () => {
  test.setTimeout(400_000)

  test('the floating assistant runs on the economy config, the chat on the default one', async ({ request, page }) => {
    const admin = await adminHeaders(request)
    const listed = await request.post('/api/v1/ai/model-configs/models', { headers: admin, data: { provider: 'ollama', base_url: `${OLLAMA}/v1` } })
    const models = (await listed.json()) as { models: Array<{ name: string }>; error?: string }
    test.skip(!models.models?.length, `the dev Ollama is not reachable (${models.error})`)
    const economyModel = models.models[0].name

    const name = `e2e-economy-${Date.now().toString(36)}`
    const created = await request.post('/api/v1/ai/model-configs', {
      headers: admin,
      data: { name, provider: 'ollama', model: economyModel, base_url: OLLAMA, tier: 'economy', enabled: true, is_default: false },
    })
    expect(created.ok(), `create: ${await created.text()}`).toBeTruthy()
    const config = await created.json()
    expect(config.tier).toBe('economy')
    const sessions: string[] = []
    try {
      const newSession = async () => {
        const s = await request.post('/api/v1/sessions', { headers: admin, data: { title: `e2e-tier-${Date.now().toString(36)}` } })
        expect(s.ok()).toBeTruthy()
        const id = (await s.json()).id as string
        sessions.push(id)
        return id
      }
      const active = await (await request.get('/api/v1/ai/model-configs/active', { headers: admin })).json()

      const chat = await modelInfo(request, admin, `/api/v1/ai/sessions/${await newSession()}/chat`, 'ok라고만 답해.')
      expect(chat.tier).toBe('default')
      expect(chat.model).toBe(active.model)

      const floating = await modelInfo(request, admin, `/api/v1/ai/sessions/${await newSession()}/floating-chat`, 'ok라고만 답해.')
      expect(floating).toMatchObject({ tier: 'economy', provider: 'ollama', model: economyModel })

      // The admin page marks the config as economy.
      await page.goto('/admin/ai-models')
      const card = page.locator('div.group.relative').filter({ hasText: name })
      await expect(card.getByTestId('tier-economy')).toHaveText(/Economy|경제형/)
    } finally {
      for (const id of sessions) await request.delete(`/api/v1/sessions/${id}`, { headers: admin })
      await request.delete(`/api/v1/ai/model-configs/${config.id}`, { headers: admin })
    }

    // Without it, the floating assistant is back on the default config.
    const id = (await (await request.post('/api/v1/sessions', { headers: admin, data: { title: 'e2e-tier-after' } })).json()).id as string
    try {
      const after = await modelInfo(request, admin, `/api/v1/ai/sessions/${id}/floating-chat`, 'ok라고만 답해.')
      expect(after.tier).toBe('default')
    } finally {
      await request.delete(`/api/v1/sessions/${id}`, { headers: admin })
    }
  })

  test('the API refuses a tier other than default or economy (400)', async ({ request }) => {
    const admin = await adminHeaders(request)
    const res = await request.post('/api/v1/ai/model-configs', {
      headers: admin,
      data: { name: `e2e-tier-bad-${Date.now().toString(36)}`, provider: 'ollama', model: 'x', base_url: OLLAMA, tier: 'cheap' },
      failOnStatusCode: false,
    })
    // The model-config API answers a schema error with 400 and the first error's message.
    expect(res.status()).toBe(400)
    expect(String((await res.json()).detail)).toContain("'economy'")
  })
})
