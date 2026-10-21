import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator } from '@playwright/test'

// ai_service.py refactor (1,782 → 311줄, 5 신규 모듈로 분리) 회귀 spec.
// 분리된 5 모듈 (intent / quantities / optimization / diagnostics / oneshot) 의
// 핵심 동작이 그대로 살아있는지 시각 검증.
// LLM 응답 비결정적 — 휴리스틱 (한글 / 키워드 / UI 상태) 사용.

const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

// The chat page's cluster is "default" (the second kind cluster): ask for a namespace that has pods there, and
// check the answer against what kube-system really runs.
function kubeSystemPods(): string[] {
  const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-chat-')), 'kubeconfig')
  fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
  return execSync(`kubectl --kubeconfig ${kc} -n kube-system get pods -o jsonpath='{.items[*].metadata.name}'`, { encoding: 'utf8' })
    .trim().split(/\s+/).filter(Boolean)
}
const POD_QUERY = 'kube-system 네임스페이스의 pod 목록 알려줘'

// The answer's own text, the tool blocks left out: a tool result that lists the pods does not count as the answer.
const answerText = (el: Locator) => el.evaluate((n) => {
  const c = n.cloneNode(true) as HTMLElement
  c.querySelectorAll('.md-details').forEach((d) => d.remove())
  return c.textContent ?? ''
})

test.describe('ai_service refactor regression', () => {

  test('Korean greeting — build_language_directive 가 정상 동작 (Korean 응답)', async ({ page }) => {
    // The first request pays the cold prompt evaluation (system prompt + tool catalogue, ~7.6k tokens).
    test.setTimeout(90_000)
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const send = page.getByRole('button', { name: SEND_RE })

    await input.fill('안녕')
    await send.click()

    await expect(input).toBeEnabled({ timeout: 60_000 })
    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    const text = (await lastAssistant.innerText()).trim()
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/[가-힣]/)
  })

  test('Tool-calling — a tool is called and the answer names the pods kube-system runs', async ({ page }) => {
    const pods = kubeSystemPods()
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill(POD_QUERY)
    await page.getByRole('button', { name: SEND_RE }).click()

    // tool 호출 포함이라 일반 query 보다 길 수 있음
    await expect(input).toBeEnabled({ timeout: 90_000 })

    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    expect(await lastAssistant.locator('.md-details').count()).toBeGreaterThan(0)
    const answer = await answerText(lastAssistant)
    expect(pods.some((p) => answer.includes(p)), `the answer names one of ${pods.join(', ')}:\n${answer}`).toBe(true)
  })

  test('Stop streaming — chatStreamManager 가 SSE 중단', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const send = page.getByRole('button', { name: SEND_RE })
    const stop = page.getByRole('button', { name: /^중단$|^stop$/i })

    await input.fill('Kubernetes 의 deployment / service / pod 의 차이를 자세히 설명해줘')
    await send.click()

    await expect(stop).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(2000)
    await stop.click()
    await expect(input).toBeEnabled({ timeout: 5_000 })
    // the SSE really stopped: the answer does not grow any more
    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    const stopped = (await lastAssistant.innerText()).length
    await page.waitForTimeout(3000)
    expect((await lastAssistant.innerText()).length).toBe(stopped)
  })

  test('Copy 버튼 — intent.py 의 stripToolDetails 가 클립보드에서 tool 메타 제거', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const pods = kubeSystemPods()
    await input.fill(POD_QUERY)
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 90_000 })

    const copyBtn = page.getByRole('button', { name: /^copy$|^복사$/i }).last()
    await copyBtn.click()

    const clipboardText: string = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboardText.length).toBeGreaterThan(0)
    expect(clipboardText).not.toContain('<details>')
    expect(clipboardText).not.toContain('<summary>🔧')
    expect(pods.some((p) => clipboardText.includes(p)), clipboardText).toBe(true)
  })

  test('AI Chat / Dashboard 라우트 이동 후 stream manager 정상', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await expect(input).toBeVisible({ timeout: 10_000 })
    // the stream manager still streams after the route change: a short question gets an answer
    await input.fill('hi')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 60_000 })
    const answer = (await page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last().innerText()).trim()
    expect(answer.length).toBeGreaterThan(0)
  })
})
