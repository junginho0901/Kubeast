import { test, expect, type APIRequestContext } from '@playwright/test'

// A model provider's refusals reach the user as what they are — no credit, too many requests, a refused key, an
// outage — named in the screen language with who acts on it. The model endpoint is the refusing stand-in in
// deploy/kind/devtools.yaml (the OpenAI answers as OpenAI documents them); each case is an economy-tier ModelConfig of
// provider custom (OpenAI-compatible, no key), which the floating assistant runs on, so the default model stays as it
// is. The Claude API answers go through the Anthropic adapter in the ai-service unit tests (that provider needs a key).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090'
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return { ...XRW, Authorization: `Bearer ${(await res.json()).access_token}` }
}

type ErrorEvent = { error: string; error_key: string; error_args: Record<string, string> }

// One economy config on the stand-in for the call; it and the session are removed after.
async function withStubModel<T>(request: APIRequestContext, headers: Record<string, string>, path: string, fn: (configName: string) => Promise<T>) {
  const name = `e2e-refusal-${path.split('/')[0]}-${Date.now().toString(36)}`
  const created = await request.post('/api/v1/ai/model-configs', {
    headers, data: { name, provider: 'custom', model: 'gpt-stub', base_url: `${STUB}/${path}`, tier: 'economy', enabled: true, is_default: false },
  })
  expect(created.ok(), `create ${name}: ${await created.text()}`).toBeTruthy()
  const id = (await created.json()).id
  try {
    return await fn(name)
  } finally {
    await request.delete(`/api/v1/ai/model-configs/${id}`, { headers })
  }
}

async function floatingError(request: APIRequestContext, headers: Record<string, string>): Promise<ErrorEvent> {
  const session = await request.post('/api/v1/sessions?cluster=self', { headers, data: { title: `e2e-refusal-${Date.now().toString(36)}` } })
  const sid = (await session.json()).id as string
  try {
    const res = await request.post(`/api/v1/ai/sessions/${sid}/floating-chat?cluster=self`, { headers, data: { message: 'hi' }, timeout: 120_000 })
    const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
    const err = events.find((e) => typeof e.error === 'string')
    expect(err, JSON.stringify(events).slice(0, 500)).toBeTruthy()
    return err as ErrorEvent
  } finally {
    await request.delete(`/api/v1/sessions/${sid}`, { headers })
  }
}

test.describe('AI provider refusals', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)

  test('each refusal comes with its kind', async ({ request }) => {
    const headers = await adminHeaders(request)
    for (const [path, key, words] of [
      ['credit/v1', 'modelCredit', 'insufficient_quota'], ['rate/v1', 'modelRateLimit', 'Rate limit reached'],
      ['auth/v1', 'modelAuth', 'Incorrect API key'], ['down/v1', 'modelUnavailable', 'overloaded'],
    ]) {
      const err = await withStubModel(request, headers, path, () => floatingError(request, headers))
      expect(err.error_key, `${path}: ${err.error}`).toBe(key)
      expect(err.error_args.provider).toBe('OpenAI-compatible')
      expect(err.error_args.detail).toContain(words) // the provider's own words stay, masked
    }
  })

  test('the floating assistant says it in the screen language, with who acts on it', async ({ page, request }) => {
    const headers = await adminHeaders(request)
    await withStubModel(request, headers, 'credit/v1', async () => {
      await page.goto('/')
      await page.evaluate(() => localStorage.setItem('i18nextLng', 'ko'))
      await page.goto('/')
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await input.fill('안녕')
      await input.press('Enter')
      const panel = page.getByTestId('floating-chat-panel')
      // the question stays and the refusal comes under it, also on a new conversation's first question
      await expect(panel).toContainText('공급자 계정의 크레딧이나 사용 한도가 다 떨어졌습니다', { timeout: 90_000 })
      await expect(panel).toContainText('안녕')
      await expect(panel).toContainText('관리자가 Admin → AI Models에서 확인하거나 다른 모델을 고르세요')
      await expect(panel).toContainText('(OpenAI-compatible)')
      await page.evaluate(() => localStorage.setItem('i18nextLng', 'en'))
    })
  })
})
