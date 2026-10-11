import { test, expect } from '@playwright/test'

// AI Chat 회귀 — Phase 2.3 의 streaming.py 추출 (4a~4c) 의 자동 검증.
// 이전엔 사용자가 brower 로 매 PR 확인했지만 토큰 비용은 자동/수동 동일하고
// 사용자 시간만 줄어드는 거라 자동화. 매 e2e 실행 시 LLM 호출 ~3~4회
// (각 ~1~3k 토큰).
//
// LLM 응답은 비결정적 — content snapshot 비교 X, 휴리스틱으로 (한글 포함 /
// 키워드 매칭 / UI 상태 전환) 검증.

const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i
const STOP_RE = /^중단$|^stop$/i

test.describe('AI Chat', () => {
  test('initial render — input area visible', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: /AI.*(어시스턴트|Assistant|Chat)/i })).toBeVisible()
    await expect(page.getByPlaceholder(PLACEHOLDER_RE)).toBeVisible()
    await expect(page.getByRole('button', { name: SEND_RE })).toBeVisible()
    await expect(page).toHaveTitle(/^AI Chat · Kubeast$/)
    expect(errors).toEqual([])
  })

  test('Korean greeting — streaming response in Korean', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const sendButton = page.getByRole('button', { name: SEND_RE })

    await input.fill('안녕')
    await sendButton.click()

    // user message 즉시 표시
    await expect(page.locator('div.flex-row-reverse').filter({ hasText: '안녕' })).toBeVisible({
      timeout: 5000,
    })

    // streaming 시작 → input disabled + Stop 보임
    await expect(input).toBeDisabled({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: STOP_RE })).toBeVisible()

    // streaming 끝 → input enabled
    await expect(input).toBeEnabled({ timeout: 60_000 })

    // assistant 응답에 한글 포함 (LLM 이 한국어로 응답해야)
    const assistantMessages = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)')
    const lastAssistant = assistantMessages.last()
    const text = (await lastAssistant.innerText()).trim()
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/[가-힣]/) // 한글 음절 1자 이상
  })

  test('tool-calling query — pod list shows 🔧 marker and pod info', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const sendButton = page.getByRole('button', { name: SEND_RE })

    await input.fill('default 네임스페이스의 pod 목록 알려줘')
    await sendButton.click()

    // streaming 끝까지 — tool 호출 (k8s_get_resources) 포함이라 일반 query 보다 길 수 있음
    await expect(input).toBeEnabled({ timeout: 90_000 })

    // 마지막 assistant message 안에 🔧 marker (tool call indicator) 또는
    // pod 관련 키워드가 있어야 함
    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    const text = await lastAssistant.innerText()
    // tool 호출 메타가 표시되는지 (chatStreamManager 가 <details>🔧 박음) +
    // 답변에 pod 리소스 관련 텍스트
    expect(text).toMatch(/🔧|pod|파드/i)
  })

  test('stop button cancels streaming mid-response', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const sendButton = page.getByRole('button', { name: SEND_RE })
    const stopButton = page.getByRole('button', { name: STOP_RE })

    // 답변이 길게 나올 만한 query
    await input.fill('Kubernetes 의 deployment / service / pod 의 차이를 자세히 설명해줘')
    await sendButton.click()

    // streaming 시작 확인
    await expect(stopButton).toBeVisible({ timeout: 10_000 })

    // 중간에 Stop 클릭 (응답 첫 글자 도착 후)
    await page.waitForTimeout(2000)
    await stopButton.click()

    // input 즉시 또는 1~2초 안에 enabled 복귀 (streaming 종료)
    await expect(input).toBeEnabled({ timeout: 5_000 })
    await expect(stopButton).toHaveCount(0)
    // the stream really stopped: the answer does not grow any more
    const lastAssistant = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    const stopped = (await lastAssistant.innerText()).length
    await page.waitForTimeout(3000)
    expect((await lastAssistant.innerText()).length).toBe(stopped)
  })

  test('copy button strips tool details from clipboard', async ({ page, context }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    const sendButton = page.getByRole('button', { name: SEND_RE })

    // tool 호출 query — message.content 에 <details>🔧 가 박힘
    await input.fill('default 네임스페이스의 pod 목록 알려줘')
    await sendButton.click()
    await expect(input).toBeEnabled({ timeout: 90_000 })

    // Copy 버튼 클릭 (마지막 assistant message). 영어 i18n: "Copy" / 한국어: "복사".
    const copyButton = page.getByRole('button', { name: /^copy$|^복사$/i }).last()
    await copyButton.click()

    // clipboard 내용에 <details> HTML 메타가 없어야 함 (stripToolDetails 동작)
    const clipboardText: string = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboardText.length).toBeGreaterThan(0)
    expect(clipboardText).not.toContain('<details>')
    expect(clipboardText).not.toContain('<summary>🔧')
  })

  test('clicking same session twice does not blank the chat', async ({ page }) => {
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')

    // baseline 세션 생성 — 짧은 query
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('hi')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 30_000 })

    // 좌측 sidebar 의 첫 번째 세션 (방금 생성된 것) 찾아서 두 번 연달아 클릭
    // session item selector — 사이드바 안의 클릭 가능한 세션 행
    const firstSession = page.locator('[class*="cursor-pointer"]').filter({ hasText: /hi|새 채팅|new chat/i }).first()
    await firstSession.click()
    const messages = page.locator('div.flex.gap-3.p-6')
    await expect(messages.first()).toBeVisible({ timeout: 5_000 })
    const before = await messages.count()

    // 같은 세션 재클릭 직후 — welcome 화면 ("Start a new chat") 이 뜨면 안 됨
    await firstSession.click()
    await page.waitForTimeout(1000)
    expect(await messages.count()).toBe(before)

    // welcome 화면의 quick questions 영역이 보이지 않아야 함
    const welcomeHeading = page.getByText(/Start a new chat|새 채팅을 시작|새 대화/i).first()
    await expect(welcomeHeading).not.toBeVisible({ timeout: 2000 }).catch(() => {
      // 만약 visible 이라면 이전 버그 재발 — fail 메시지 명확히
      throw new Error('welcome 화면이 같은 세션 재클릭 후 보임 (회귀)')
    })

    // user message ("hi") 가 여전히 보여야 함
    await expect(page.locator('div.flex-row-reverse').filter({ hasText: 'hi' })).toBeVisible({
      timeout: 3_000,
    })
  })
})
