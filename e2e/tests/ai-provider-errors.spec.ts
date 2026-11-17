import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { hasStandIn, STAND_IN, STAND_IN_ADDRESS, STAND_IN_SKIP } from './model-address-standin'

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

// One economy config on the stand-in for the call, with the time it was made; it and the session are removed after.
async function withStubModel<T>(request: APIRequestContext, headers: Record<string, string>, path: string, fn: (configName: string, madeAt: number) => Promise<T>, endpoint = STUB) {
  const name = `e2e-refusal-${path.split('/')[0]}-${Date.now().toString(36)}`
  const created = await request.post('/api/v1/ai/model-configs', {
    headers, data: { name, provider: 'custom', model: 'gpt-stub', base_url: `${endpoint}/${path}`, tier: 'economy', enabled: true, is_default: false },
  })
  expect(created.ok(), `create ${name}: ${await created.text()}`).toBeTruthy()
  const madeAt = Date.now()
  const id = (await created.json()).id
  try {
    return await fn(name, madeAt)
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

// Each ai-service replica reuses the economy config it read for 30 s, and a change clears it on the replica that took
// the change only: a question that reaches another replica soon after a config is made can still run on the config
// before it. That question is asked again in a new conversation; one sent after this time is held to its answer.
const CONFIG_REUSED_MS = 35_000
const REFUSED = 'AI 모델을 호출하지 못했습니다'

// The floating assistant on the home page in Korean, asked 안녕 until its answer has `expected` or was asked after the
// time a replica reuses the config made at madeAt. The panel is returned with that answer under the question.
async function askFloating(page: Page, madeAt: number, expected: string) {
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('i18nextLng', 'ko'))
  await page.goto('/')
  if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
  const panel = page.getByTestId('floating-chat-panel')
  const input = page.getByTestId('floating-chat-input')
  // a refusal, or an answer of the model used when no economy config is read
  const answered = panel.getByText(REFUSED).or(panel.getByTestId('floating-copy')).first()
  for (let asked = 0; ; asked++) {
    if (asked > 0) await page.getByTestId('floating-new-chat').click()
    await expect(answered).toHaveCount(0)
    const sentAt = Date.now()
    await input.fill('안녕')
    await input.press('Enter')
    await expect(answered).toBeVisible({ timeout: 90_000 })
    if ((await panel.innerText()).includes(expected) || sentAt - madeAt > CONFIG_REUSED_MS) return panel
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
    await withStubModel(request, headers, 'credit/v1', async (_name, madeAt) => {
      const panel = await askFloating(page, madeAt, '공급자 계정의 크레딧이나 사용 한도가 다 떨어졌습니다')
      // the question stays and the refusal comes under it, also on a new conversation's first question
      await expect(panel).toContainText('공급자 계정의 크레딧이나 사용 한도가 다 떨어졌습니다')
      await expect(panel).toContainText('안녕')
      await expect(panel).toContainText('관리자가 Admin → AI Models에서 확인하거나 다른 모델을 고르세요')
      await expect(panel).toContainText('(OpenAI-compatible)')
      await page.evaluate(() => localStorage.setItem('i18nextLng', 'en'))
    })
  })

  test('a model address refused when connecting says so to whoever asked, without the address', async ({ page, request }) => {
    test.skip(!hasStandIn(), STAND_IN_SKIP)
    const headers = await adminHeaders(request)
    const err = await withStubModel(request, headers, 'v1', () => floatingError(request, headers), STAND_IN)
    expect(err.error_key, err.error).toBe('modelAddress')
    expect(err.error_args.provider).toBe('OpenAI-compatible')
    expect(JSON.stringify(err)).not.toContain(STAND_IN_ADDRESS)

    await withStubModel(request, headers, 'v1', async (_name, madeAt) => {
      const panel = await askFloating(page, madeAt, '모델 주소가 허용되지 않아 아무것도 보내지 않았습니다')
      await expect(panel).toContainText('모델 주소가 허용되지 않아 아무것도 보내지 않았습니다')
      await expect(panel).toContainText('Admin → AI Models에서 이 모델의 연결 테스트로')
      await expect(panel).not.toContainText(STAND_IN_ADDRESS)
      await page.evaluate(() => localStorage.setItem('i18nextLng', 'en'))
    }, STAND_IN)
  })
})
