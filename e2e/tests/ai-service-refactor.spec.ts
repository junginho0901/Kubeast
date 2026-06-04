import { test, expect } from '@playwright/test'

// ai_service.py refactor (1,782 → 311줄, 5 신규 모듈로 분리) 회귀 spec.
// 분리된 5 모듈 (intent / quantities / optimization / diagnostics / oneshot) 의
// 핵심 동작이 그대로 살아있는지 시각 검증.
// LLM 응답 비결정적 — 휴리스틱 (한글 / 키워드 / UI 상태) 사용.

const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

test.describe('ai_service refactor regression', () => {

  test('Korean greeting — build_language_directive 가 정상 동작 (Korean 응답)', async ({ page }) => {
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

  test('Tool-calling — k8s_get_resources 호출 + tools.py 의 get_tools_definition 정상', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('default 네임스페이스의 pod 목록 알려줘')
    await page.getByRole('button', { name: SEND_RE }).click()

    // tool 호출 포함이라 일반 query 보다 길 수 있음
    await expect(input).toBeEnabled({ timeout: 90_000 })

    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    const text = await lastAssistant.innerText()
    // 🔧 marker 또는 pod 관련 키워드 — tool 호출 + 답변 둘 중 하나
    expect(text).toMatch(/🔧|pod|파드/i)
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
  })

  test('Copy 버튼 — intent.py 의 stripToolDetails 가 클립보드에서 tool 메타 제거', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('default 네임스페이스의 pod 목록 알려줘')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 90_000 })

    const copyBtn = page.getByRole('button', { name: /^copy$|^복사$/i }).last()
    await copyBtn.click()

    const clipboardText: string = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboardText.length).toBeGreaterThan(0)
    expect(clipboardText).not.toContain('<details>')
    expect(clipboardText).not.toContain('<summary>🔧')
  })

  test('AI Chat / Dashboard 라우트 이동 후 stream manager 정상', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    await expect(page.getByPlaceholder(PLACEHOLDER_RE)).toBeVisible({ timeout: 10_000 })
  })
})
