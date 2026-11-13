import { test, expect, type APIRequestContext } from '@playwright/test'

// The Settings page's API key card and the MCP options in it. With chart ai.enabled off there is no ai-service, and
// /api/v1/ai/mcp/config is the gateway's 503 after its 3 s connect timeout: the card asks nothing of it and says in the
// options' place that MCP needs AI. With AI on and ai-service not answering, the card says the gateway's reason there.
// Both are stood in on cluster self (the features' ai.enabled, the MCP config's answer); nothing on the cluster moves.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const FEATURES = /\/api\/v1\/cluster\/features(\?|$)/
const MCP_CONFIG = /\/api\/v1\/ai\/mcp\/config(\?|$)/
const NOT_AVAILABLE = 'AI is not available: ai.enabled is off or ai-service is down'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('the API key card when AI is off or does not answer', () => {
  test.beforeAll(async ({ request }) => {
    const admin = await login(request)
    const keys = await (await request.get('/api/v1/auth/api-keys/config', { headers: bearer(admin) })).json()
    test.skip(!keys.enabled, 'API keys are off on this installation (auth.apiKeys.enabled)')
  })

  test('AI off: the MCP config is not asked and one line says MCP needs AI', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (r) => { if (MCP_CONFIG.test(new URL(r.url()).pathname)) asked.push(r.url()) })
    await page.route(FEATURES, async (route) => {
      const res = await route.fetch()
      await route.fulfill({ response: res, json: { ...(await res.json()), ai: { enabled: false }, alertInvestigation: { enabled: false } } })
    })
    await page.goto(`/account?cluster=${CLUSTER}`)
    await expect(page.getByTestId('api-key-mcp-ai-off')).toHaveText(
      /^(Connecting an AI agent \(MCP\) needs AI, which is off on this installation \(ai\.enabled\)\.|AI 에이전트 연결\(MCP\)에는 AI가 필요한데, 이 설치에서는 AI가 꺼져 있습니다\(ai\.enabled\)\.)$/,
      { timeout: 20_000 },
    )
    await expect(page.getByTestId('api-key-mcp')).toHaveCount(0)
    // the gateway would have answered by now had it been asked
    await page.waitForTimeout(4_000)
    expect(asked, 'no request to the absent ai-service').toEqual([])
  })

  test('AI on, ai-service not answering: the gateway\'s reason in the options\' place', async ({ page }) => {
    let answered = 0
    await page.route(MCP_CONFIG, (route) => {
      answered += 1
      return route.fulfill({ status: 503, json: { detail: NOT_AVAILABLE } })
    })
    await page.goto(`/account?cluster=${CLUSTER}`)
    await expect(page.getByTestId('api-key-mcp-failed')).toHaveText(
      new RegExp(`^(Could not read whether AI agents \\(MCP\\) can connect|AI 에이전트\\(MCP\\)를 연결할 수 있는지 읽지 못했습니다): ${NOT_AVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      { timeout: 20_000 },
    )
    expect(answered, 'the card asked (and tried once more)').toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId('api-key-mcp-ai-off')).toHaveCount(0)
  })
})
