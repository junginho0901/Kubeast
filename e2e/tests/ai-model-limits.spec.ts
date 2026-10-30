import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// A model's own limits — the answer length (options.max_tokens) and the tool result length (options.tool_result_chars)
// — and what each config is used for (used_for, by ai-service's own rules). The configs here are economy-tier endpoints
// of the dev model-stub (deploy/kind/devtools.yaml), which the floating assistant runs on, so the default model is not
// touched: /ok/ answers "ok", /tool/ first calls k8s_get_resources (services of all namespaces as JSON, longer than
// 6 000 characters on the dev cluster), /reasoning/ refuses max_tokens and temperature as OpenAI does for a reasoning
// model, and GET /_calls says what each chat request under them asked.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090'
const CUT = '\n... (truncated for LLM) ...'

type Call = {
  case: string
  max_tokens: number | null
  max_completion_tokens: number | null
  temperature: boolean
  tool_results: number[]
  tool_truncated: boolean[]
}
type Config = { id: number; name: string; options: Record<string, unknown> | null; used_for: string[] }

function selfKubectl(): ((...args: string[]) => string) | null {
  try {
    const kubeconfig = execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-limits-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (...args: string[]) => execFileSync('kubectl', ['--kubeconfig', kcPath, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

test.describe('AI model limits', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)
  const id = Date.now().toString(36)
  let kubectl: ((...args: string[]) => string) | null = null
  let admin: Record<string, string> = {}
  const configs: number[] = []
  const sessions: string[] = []

  function stub(method: 'GET' | 'DELETE'): Call[] {
    const py = `import urllib.request as u;print(u.urlopen(u.Request("http://127.0.0.1:8090/_calls",method="${method}")).read().decode())`
    return JSON.parse(kubectl!('-n', 'kubeast-devtools', 'exec', 'deploy/model-stub', '--', 'python', '-c', py)).calls
  }

  async function list(request: APIRequestContext): Promise<Config[]> {
    const res = await request.get('/api/v1/ai/model-configs', { headers: admin })
    expect(res.ok()).toBeTruthy()
    return res.json()
  }

  async function economy(request: APIRequestContext, data: Record<string, unknown>): Promise<Config> {
    const res = await request.post('/api/v1/ai/model-configs', {
      headers: admin, data: { model: 'stub-small', tier: 'economy', enabled: true, is_default: false, ...data },
    })
    expect(res.ok(), `create: ${await res.text()}`).toBeTruthy()
    const config = await res.json()
    configs.push(config.id)
    return config
  }

  async function floating(request: APIRequestContext): Promise<string> {
    const s = await request.post('/api/v1/sessions', { headers: admin, data: { title: `e2e-limits-${id}` } })
    expect(s.ok()).toBeTruthy()
    const sid = (await s.json()).id as string
    sessions.push(sid)
    const res = await request.post(`/api/v1/ai/sessions/${sid}/floating-chat`, {
      headers: { ...admin, Accept: 'text/event-stream', 'X-Cluster-Name': 'self' },
      data: { message: 'ok라고만 답해.' },
      timeout: 180_000,
    })
    expect(res.ok(), `floating chat: ${res.status()}`).toBeTruthy()
    return res.text()
  }

  test.beforeAll(async ({ request }) => {
    admin = await adminHeaders(request)
    kubectl = selfKubectl()
    let reason = kubectl ? '' : 'kind get kubeconfig --name kubeast failed'
    if (!reason) {
      try {
        stub('GET')
      } catch (e) {
        reason = `the dev model-stub has no /_calls — kubectl apply -f deploy/kind/devtools.yaml, then restart deploy/model-stub (${String(e).slice(0, 160)})`
      }
    }
    test.skip(!!reason, reason)
  })

  test.afterAll(async ({ request }) => {
    for (const sid of sessions) await request.delete(`/api/v1/sessions/${sid}`, { headers: admin })
    for (const cid of configs) await request.delete(`/api/v1/ai/model-configs/${cid}`, { headers: admin })
  })

  test('the form saves the two limits in the options and each card says what the server runs on it', async ({ page, request }) => {
    const name = `e2e-limits-form-${id}`
    const byName = async () => (await list(request)).find((c) => c.name === name)
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    await page.getByPlaceholder(/localhost:11434|api\.example\.com/).fill(`${STUB}/ok`)
    await page.getByPlaceholder(/my-gpt4/).fill(name)
    await page.getByTestId('tier-select').click()
    await page.getByTestId('tier-option-economy').click()

    // out of range: said on the page, nothing saved
    await page.getByTestId('max-tokens-input').fill('1234')
    await page.getByTestId('tool-result-chars-input').fill('999')
    await page.getByRole('button', { name: /^(Create|생성)$/ }).click()
    await expect(page.getByTestId('limits-error')).toHaveText(/1,000.*200,000/)
    expect(await byName()).toBeUndefined()

    await page.getByTestId('tool-result-chars-input').fill('1,500')
    await page.getByRole('button', { name: /^(Create|생성)$/ }).click()
    await expect.poll(async () => (await byName())?.options ?? null).toEqual({ max_tokens: 1234, tool_result_chars: 1500 })
    const saved = (await byName())!
    configs.push(saved.id)

    // the newest enabled economy config runs the floating assistant and the history summaries; one config the chat
    const configsNow = await list(request)
    expect(configsNow.find((c) => c.id === saved.id)!.used_for).toEqual(['floating', 'summary'])
    const chat = configsNow.filter((c) => c.used_for.includes('chat'))
    expect(chat.map((c) => c.name), 'one config runs the chat').toHaveLength(1)

    // the cards say what the server said
    await page.reload()
    const card = (n: string) => page.locator('div.group.relative').filter({ has: page.getByText(n, { exact: true }) })
    await expect(card(name).getByTestId('model-used-for')).toHaveText(/Used for: Floating assistant · History summaries|쓰는 곳: 플로팅 어시스턴트 · 이력 요약/)
    await expect(card(chat[0].name).getByTestId('model-used-for')).toContainText(/Chat|채팅/)
    await expect(card(chat[0].name).getByText(/^(Active|활성)$/)).toHaveCount(1)
    await expect(card(name).getByText(/^(Active|활성)$/)).toHaveCount(0)

    // the edit form shows them in their fields, not in the generation options; emptied, nothing is kept
    await card(name).getByTitle(/^(Edit|편집)$/).click()
    await expect(page.getByTestId('max-tokens-input')).toHaveValue('1234')
    await expect(page.getByTestId('tool-result-chars-input')).toHaveValue('1500')
    await expect(page.getByPlaceholder(/"num_ctx"/)).toHaveValue('')
    await page.getByTestId('max-tokens-input').fill('')
    await page.getByTestId('tool-result-chars-input').fill('')
    await page.getByRole('button', { name: /^(Update|수정)$/ }).click()
    await expect.poll(async () => {
      const c = await byName()
      return c ? c.options : 'missing'
    }).toBeNull()
  })

  test("the floating assistant asks for its model's answer length and gets tool results cut to its length", async ({ request }) => {
    const config = await economy(request, {
      name: `e2e-limits-tool-${id}`, provider: 'ollama', base_url: `${STUB}/tool`, options: { max_tokens: 1234, tool_result_chars: 1500 },
    })
    const run = async () => {
      stub('DELETE')
      const text = await floating(request)
      expect(text).toContain('"content": "ok"')
      const calls = stub('GET').filter((c) => c.case === 'tool')
      const answered = calls.filter((c) => c.tool_results.length)
      expect(answered, 'one request carried the tool result').toHaveLength(1)
      return { calls, result: answered[0] }
    }

    const own = await run()
    expect(own.calls.map((c) => c.max_tokens)).toEqual([1234, 1234])
    expect(own.result.tool_results).toEqual([1500 + CUT.length])
    expect(own.result.tool_truncated).toEqual([true])

    // without them: 4 096 tokens and 6 000 characters, as before
    const res = await request.patch(`/api/v1/ai/model-configs/${config.id}`, { headers: admin, data: { options: null } })
    expect(res.ok(), await res.text()).toBeTruthy()
    const plain = await run()
    expect(plain.calls.map((c) => c.max_tokens)).toEqual([4096, 4096])
    expect(plain.result.tool_results).toEqual([6000 + CUT.length])
  })

  test('a ModelConfig resource carries the two limits and its CA certificate to the config', async ({ request }) => {
    const name = `e2e-limits-cr-${id}`
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBe2e\n-----END CERTIFICATE-----'
    const resource = (spec: Record<string, unknown>) => JSON.stringify({
      apiVersion: 'ai.kubeast.io/v1alpha1', kind: 'ModelConfig', metadata: { name, namespace: 'kubeast' },
      spec: { provider: 'ollama', model: 'stub-small', baseURL: `${STUB}/ok`, enabled: false, ...spec },
    })
    const apply = (spec: Record<string, unknown>) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-limits-cr-')), 'mc.json')
      fs.writeFileSync(file, resource(spec))
      return kubectl!('apply', '-f', file)
    }
    try {
      // out of the schema's range: the API server refuses it, nothing is stored
      expect(() => apply({ toolResultChars: 500 })).toThrow(/toolResultChars/)
      apply({ maxTokens: 2048, toolResultChars: 4000, caCert: pem, ollama: { options: { num_ctx: '8192' } } })
      await expect.poll(async () => {
        const c = (await list(request)).find((x) => x.name === name) as (Config & { ca_cert?: string }) | undefined
        return c ? { options: c.options, ca_cert: c.ca_cert } : 'missing'
      }, { timeout: 30_000 }).toEqual({ options: { num_ctx: '8192', max_tokens: 2048, tool_result_chars: 4000 }, ca_cert: pem })
    } finally {
      kubectl!('-n', 'kubeast', 'delete', 'modelconfig', name, '--ignore-not-found')
    }
    await expect.poll(async () => (await list(request)).some((x) => x.name === name), { timeout: 30_000 }).toBe(false)
  })

  test('a reasoning model: the chat leaves out what it refuses, the length goes as max_completion_tokens', async ({ request }) => {
    await economy(request, { name: `e2e-limits-reasoning-${id}`, provider: 'custom', base_url: `${STUB}/reasoning/v1` })
    stub('DELETE')
    expect(await floating(request)).toContain('"content": "ok"')
    const calls = stub('GET').filter((c) => c.case === 'reasoning')
    // refused for max_tokens, then for the temperature, then answered; the next request leaves both out at once
    expect(calls.map((c) => [c.max_tokens, c.max_completion_tokens, c.temperature])).toEqual([
      [4096, null, true], [null, 4096, true], [null, 4096, false],
    ])
    stub('DELETE')
    expect(await floating(request)).toContain('"content": "ok"')
    expect(stub('GET').filter((c) => c.case === 'reasoning').map((c) => [c.max_tokens, c.max_completion_tokens, c.temperature]))
      .toEqual([[null, 4096, false]])

    // the connection test: Azure sends max_completion_tokens from the start, an OpenAI-compatible one after the refusal
    // (another model name: what stub-small refused is remembered for it)
    stub('DELETE')
    for (const data of [
      { provider: 'azure', model: 'stub-small', base_url: `${STUB}/reasoning/openai/v1`, api_key: 'e2e-azure-key' },
      { provider: 'custom', model: 'stub-large', base_url: `${STUB}/reasoning/v1`, api_key: 'e2e-key' },
    ]) {
      const res = await request.post('/api/v1/ai/model-configs/test', { headers: admin, data, timeout: 120_000 })
      expect(await res.json(), data.provider).toMatchObject({ success: true, message: 'Connection successful' })
    }
    expect(stub('GET').map((c) => [c.max_tokens, c.max_completion_tokens])).toEqual([[null, 5], [5, null], [null, 5]])
  })
})
