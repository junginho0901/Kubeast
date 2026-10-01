import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// What the assistant's tools return is masked before it reaches the model:
// a ConfigMap with a password and a connection string is planted, the chat is
// asked for its YAML, and the stream the model consumed must carry the
// placeholders, not the values. The audit row records what was masked.
// Depends on the dev LLM calling the tool (as the other ai-* specs do).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
// `self` is the in-cluster registration auth.setup creates: the cluster Kubeast
// runs on, which is also where kubectl (KUBECONFIG) plants the ConfigMap and
// where kubeast-secrets lives. `default` may be another registered cluster.
const CLUSTER = 'self'
const NS = 'default'
const NAME = 'redaction-e2e'
const STAMP = Date.now().toString(36)
const PW_VALUE = `hunter2-${STAMP}`
const URL_PW = `s3cr3t-${STAMP}`
// Same selectors as ai-chat.spec.ts.
const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

// The ConfigMap is planted with kubectl against the kind cluster the suite runs
// against: KUBECONFIG when set, else the repo-local .kubeconfig-kind. Never the
// shell's default kubeconfig — that may be a real cluster — so with neither the
// test refuses to run kubectl at all.
const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function kubectl(args: string[], input?: string): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KUBECONFIG } })
}

test.describe('AI tool results are redacted', () => {
  let token = ''

  test.beforeAll(async ({ request }) => {
    token = await adminToken(request)
    const yaml = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${NAME}`,
      `  namespace: ${NS}`,
      'data:',
      `  DB_PASSWORD: ${PW_VALUE}`,
      `  DATABASE_URL: postgres://app:${URL_PW}@db:5432/app`,
      '  LOG_LEVEL: debug',
      '',
    ].join('\n')
    kubectl(['apply', '-f', '-'], yaml)
  })

  test.afterAll(async () => {
    try {
      kubectl(['delete', 'configmap', NAME, '-n', NS, '--ignore-not-found'])
    } catch {
      // best effort
    }
  })

  test('the chat stream carries placeholders instead of the ConfigMap credentials', async ({ page, request }) => {
    await page.goto(`/ai-chat?cluster=${CLUSTER}`)
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await expect(input).toBeVisible()

    // Capture the SSE body the UI receives — it holds the tool result the model saw.
    const streamPromise = page.waitForResponse(
      (r) => /\/api\/v1\/ai\/sessions\/[^/]+\/chat/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 90_000 },
    )
    await input.fill(`${NS} 네임스페이스의 configmap ${NAME} 의 YAML 을 k8s_get_resource_yaml 로 보여줘`)
    await page.getByRole('button', { name: SEND_RE }).click()
    const stream = await streamPromise
    await expect(input).toBeEnabled({ timeout: 120_000 })
    const body = await stream.text()

    expect(body, 'the tool must have run').toContain('function_result')
    expect(body).not.toContain(PW_VALUE)
    expect(body).not.toContain(URL_PW)
    expect(body).toContain('DB_PASSWORD: <REDACTED:DB_PASSWORD>')
    expect(body).toContain('postgres://app:<REDACTED:password>@db:5432/app')
    expect(body).toContain('LOG_LEVEL: debug')

    // audit: the ai.tool.call row names what was masked
    const since = new Date(Date.now() - 180_000).toISOString()
    const audit = await request.get('/api/v1/auth/admin/audit-logs', {
      headers: { Authorization: `Bearer ${token}` },
      params: { action: 'ai.tool.call', since, limit: 50 },
    })
    expect(audit.ok()).toBeTruthy()
    const { items } = (await audit.json()) as { items: Array<Record<string, any>> }
    const withRedaction = items.filter((e) => {
      const after = e.After ?? e.after ?? {}
      return after.tool === 'k8s_get_resource_yaml' && after.redacted && after.redacted.count >= 1
    })
    expect(withRedaction.length, JSON.stringify(items.slice(0, 3))).toBeGreaterThanOrEqual(1)
  })

  test('a Secret is readable for the assistant but its values are stripped', async ({ page }) => {
    await page.goto(`/ai-chat?cluster=${CLUSTER}`)
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const streamPromise = page.waitForResponse(
      (r) => /\/api\/v1\/ai\/sessions\/[^/]+\/chat/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 90_000 },
    )
    // kubeast-secrets exists in the kubeast namespace on the dev cluster.
    await input.fill('kubeast 네임스페이스의 secret kubeast-secrets 의 YAML 을 k8s_get_resource_yaml 로 보여줘')
    await page.getByRole('button', { name: SEND_RE }).click()
    const stream = await streamPromise
    await expect(input).toBeEnabled({ timeout: 120_000 })
    const body = await stream.text()
    expect(body).toContain('function_result')
    expect(body).toContain('<REDACTED:secret>')
    // no base64 secret value: every data value is the placeholder
    expect(body).not.toMatch(/DEFAULT_ADMIN_PASSWORD: [A-Za-z0-9+/=]{8,}/)
  })
})
