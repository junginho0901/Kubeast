import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// The assistant's stdout is the cluster's log pipeline. Model responses, tool
// arguments and tool results used to be printed there in full; now they are
// logged only with AI_DEBUG_DUMP=true and redacted. A chat turn that carries a
// credential-looking value must leave neither a response dump nor the value
// in the ai-service log.

const CLUSTER = 'self'
const NS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const MARKER = `hunter2-stdout-${Date.now().toString(36)}`
const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

// kubectl reads the ai-service log on the kind cluster the suite runs against:
// KUBECONFIG when set, else the repo-local .kubeconfig-kind, never the shell's
// default kubeconfig.
const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function aiServiceLog(since: string): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', ['-n', NS, 'logs', 'deploy/ai-service', '--all-containers', `--since=${since}`], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KUBECONFIG },
  })
}

test('a chat turn leaves no model response dump or credential in the ai-service log', async ({ page }) => {
  await page.goto(`/ai-chat?cluster=${CLUSTER}`)
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await expect(input).toBeVisible()
  const streamPromise = page.waitForResponse(
    (r) => /\/api\/v1\/ai\/sessions\/[^/]+\/chat/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 90_000 },
  )
  await input.fill(`DB 비밀번호는 ${MARKER} 입니다. 이 값을 담는 ConfigMap YAML 예시를 그대로 적어 보여줘.`)
  await page.getByRole('button', { name: SEND_RE }).click()
  const sessionId = (await streamPromise).url().match(/\/sessions\/([^/]+)\/chat/)?.[1]
  try {
    await expect(input).toBeEnabled({ timeout: 120_000 })

    const log = aiServiceLog('5m')
    expect(log, 'the turn must have reached ai-service').toContain('POST /api/v1/ai/sessions/')
    // every session turn used to print these; a credential the user typed could
    // sit inside the preview or a tool argument
    expect(log).not.toContain('[DEBUG] Full message preview')
    expect(log).not.toContain('[OPENAI RESPONSE]')
    expect(log).not.toContain('with args:')
    expect(log).not.toContain(MARKER)
  } finally {
    // The conversation is titled with the planted value: do not leave it in the list.
    if (sessionId) await page.request.delete(`/api/v1/sessions/${sessionId}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
  }
})
