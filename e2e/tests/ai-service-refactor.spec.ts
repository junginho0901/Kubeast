import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'

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

// The conversation the chat screen makes for its first question, and its removal after the test, passed or not.
const conversationMade = (page: Page) =>
  page.waitForResponse((r) => /\/api\/v1\/sessions(\?|$)/.test(r.url()) && r.request().method() === 'POST', { timeout: 15_000 })
const deleteConversation = (page: Page, id: string) =>
  page.request.delete(`/api/v1/sessions/${id}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false })

test.describe('ai_service refactor regression', () => {

  test('Korean greeting — build_language_directive 가 정상 동작 (Korean 응답)', async ({ page }) => {
    // The first request pays the cold prompt evaluation (system prompt + tool catalogue, ~7.6k tokens).
    test.setTimeout(90_000)
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const send = page.getByRole('button', { name: SEND_RE })

    await input.fill('안녕')
    const created = conversationMade(page)
    await send.click()
    const sessionId = withUndo((await (await created).json()).id as string, (i) => deleteConversation(page, i))
    try {
      // the answer starts (right after the click the input can still be enabled), then ends
      await expect(input).toBeDisabled({ timeout: 15_000 })
      await expect(input).toBeEnabled({ timeout: 60_000 })
      const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
      const text = (await lastAssistant.innerText()).trim()
      expect(text.length).toBeGreaterThan(0)
      expect(text).toMatch(/[가-힣]/)
    } finally {
      await deleteConversation(page, sessionId)
    }
  })

  test('Tool-calling — a tool is called and the answer names the pods kube-system runs', async ({ page }) => {
    const pods = kubeSystemPods()
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill(POD_QUERY)
    const created = conversationMade(page)
    await page.getByRole('button', { name: SEND_RE }).click()
    const sessionId = withUndo((await (await created).json()).id as string, (i) => deleteConversation(page, i))
    try {
      // tool 호출 포함이라 일반 query 보다 길 수 있음
      await expect(input).toBeDisabled({ timeout: 15_000 })
      await expect(input).toBeEnabled({ timeout: 90_000 })

      const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
      expect(await lastAssistant.locator('.md-details').count()).toBeGreaterThan(0)
      const answer = await answerText(lastAssistant)
      expect(pods.some((p) => answer.includes(p)), `the answer names one of ${pods.join(', ')}:\n${answer}`).toBe(true)
    } finally {
      await deleteConversation(page, sessionId)
    }
  })

  test('Stop streaming — chatStreamManager 가 SSE 중단', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const send = page.getByRole('button', { name: SEND_RE })
    const stop = page.getByRole('button', { name: /^중단$|^stop$/i })

    await input.fill('Kubernetes 의 deployment / service / pod 의 차이를 자세히 설명해줘')
    const created = conversationMade(page)
    await send.click()
    const sessionId = withUndo((await (await created).json()).id as string, (i) => deleteConversation(page, i))
    try {
      await expect(stop).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(2000)
      await stop.click()
      await expect(input).toBeEnabled({ timeout: 5_000 })
      // the SSE really stopped: the answer does not grow any more (stopped before the first word, there is no answer
      // bubble at all). The answer is measured without the action row under it, which opens after the stop and adds
      // "Stopped · usage not available"
      const assistants = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)')
      const answerLength = () => assistants.last().evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLElement
        copy.querySelectorAll('[data-testid="message-actions-row"]').forEach((row) => row.remove())
        return (copy.textContent ?? '').length
      })
      const before = await assistants.count()
      const stopped = before ? await answerLength() : 0
      await page.waitForTimeout(3000)
      expect(await assistants.count()).toBe(before)
      if (before) {
        expect(await answerLength(), 'the answer stopped growing').toBe(stopped)
        await expect(assistants.last().getByTestId('message-actions-row'), 'the row under it says it stopped').toContainText(/Stopped|멈춤/, { timeout: 10_000 })
      }
    } finally {
      await deleteConversation(page, sessionId)
    }
  })

  test('Copy 버튼 — intent.py 의 stripToolDetails 가 클립보드에서 tool 메타 제거', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const pods = kubeSystemPods()
    await input.fill(POD_QUERY)
    const created = conversationMade(page)
    await page.getByRole('button', { name: SEND_RE }).click()
    const sessionId = withUndo((await (await created).json()).id as string, (i) => deleteConversation(page, i))
    try {
      await expect(input).toBeDisabled({ timeout: 15_000 })
      await expect(input).toBeEnabled({ timeout: 90_000 })

      const copyBtn = page.getByRole('button', { name: /^copy$|^복사$/i }).last()
      await copyBtn.click()

      const clipboardText: string = await page.evaluate(() => navigator.clipboard.readText())
      expect(clipboardText.length).toBeGreaterThan(0)
      expect(clipboardText).not.toContain('<details>')
      expect(clipboardText).not.toContain('<summary>🔧')
      expect(pods.some((p) => clipboardText.includes(p)), clipboardText).toBe(true)
    } finally {
      await deleteConversation(page, sessionId)
    }
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
    const created = conversationMade(page)
    await page.getByRole('button', { name: SEND_RE }).click()
    const sessionId = withUndo((await (await created).json()).id as string, (i) => deleteConversation(page, i))
    try {
      await expect(input).toBeDisabled({ timeout: 15_000 })
      await expect(input).toBeEnabled({ timeout: 60_000 })
      const answer = (await page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last().innerText()).trim()
      expect(answer.length).toBeGreaterThan(0)
    } finally {
      await deleteConversation(page, sessionId)
    }
  })
})

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
