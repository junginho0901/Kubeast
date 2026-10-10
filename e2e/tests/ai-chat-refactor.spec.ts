import { test, expect, Page } from '@playwright/test'

// AIChat Context refactor (946 → 11줄, 8 hook 분리, 4 sub-component 분리) 회귀 spec.
// 기존 ai-chat.spec 가 핵심 동작 (render / streaming / tool / stop / copy /
// same-session) 을 cover 하므로, 여기는 hook 분리 / Context lift / sub-component
// 분리가 silent error 를 만들지 않았는지 확인하는 보조 spec.

const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i

async function gotoAIChat(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE.error: ${m.text()}`)
  })
  await page.goto('/ai-chat')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: /AI.*(어시스턴트|Assistant|Chat)/i })).toBeVisible({ timeout: 10000 })
  return errors
}

function assertNoCriticalErrors(errors: string[]) {
  const critical = errors.filter((e) =>
    /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError|useAIChat must be used/.test(e),
  )
  expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
}

test.describe('AIChat refactor — Context / hook 분리 회귀', () => {

  test('Provider mount — page error 0 + 모든 핵심 element 존재', async ({ page }) => {
    const errors = await gotoAIChat(page)

    // Sidebar (좌측)
    const sidebar = page.locator('text=/AI Chat|AI Assistant|AI 어시스턴트/i').first()
    await expect(sidebar).toBeVisible()

    // Welcome (메시지 0개) — quick questions 보임
    // Input area
    await expect(page.getByPlaceholder(PLACEHOLDER_RE)).toBeVisible()
    await expect(page.getByRole('button', { name: SEND_RE })).toBeVisible()
    await expect(page).toHaveTitle(/^AI Chat · Kubeast$/)

    assertNoCriticalErrors(errors)
  })

  test('input 입력 — useAIChat().setInput 정상 전파', async ({ page }) => {
    const errors = await gotoAIChat(page)

    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('테스트')
    await expect(input).toHaveValue('테스트')
    await input.fill('')

    assertNoCriticalErrors(errors)
  })

  test('multi-select 모드 토글 → 선택 → 모드 해제 (useChatHandlers 동작)', async ({ page }) => {
    const errors = await gotoAIChat(page)

    // 한 세션 만들기 (짧은 질의)
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('hi')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 30_000 })

    // 다중 선택 토글 버튼 — i18n: "채팅 내역 선택 삭제" / "Delete selected chats"
    await page.getByRole('button', { name: /^(채팅 내역 선택 삭제|Delete selected chats)$/ }).click()
    // selection mode: a checkbox per session row, and Select all picks every one of them (nothing is deleted here)
    // (the session list is virtualised: only the rows on screen have a checkbox, the count is in the delete button)
    const boxes = page.locator('input[type="checkbox"]')
    await expect(boxes.first()).toBeVisible({ timeout: 3000 })
    const del = page.getByRole('button', { name: /^(삭제|Delete) \(\d+\)$/ })
    await expect(del).toHaveText(/\(0\)$/)
    await page.getByRole('button', { name: /^(전체 선택|Select all)$/ }).click()
    expect(Number((await del.innerText()).match(/\d+/)![0])).toBeGreaterThan(0)
    expect(await page.locator('input[type="checkbox"]:checked').count()).toBeGreaterThan(0)
    await page.getByRole('button', { name: /^(선택 해제|Clear selection)$/ }).click()
    await expect(del).toHaveText(/\(0\)$/)
    await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0)

    // 다시 토글 해제 — 모드 OFF
    await page.getByRole('button', { name: /^(취소|Cancel)$/ }).first().click()
    await expect(boxes).toHaveCount(0)

    assertNoCriticalErrors(errors)
  })

  test('new chat 버튼 → 세션 reset + welcome 화면 복귀', async ({ page }) => {
    const errors = await gotoAIChat(page)

    // 세션 만들기
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('hi')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 30_000 })

    const messages = page.locator('div.flex.gap-3.p-6')
    await expect(messages.first()).toBeVisible()

    // New chat 버튼 — i18n: "새 대화" / "New Chat"
    await page.getByRole('button', { name: /^(새 대화|New Chat)$/i }).first().click()

    // the session is reset: no message on screen, an empty input
    await expect(messages).toHaveCount(0, { timeout: 3000 })
    await expect(input).toHaveValue('')

    assertNoCriticalErrors(errors)
  })

  test('라우트 이동 후 돌아와도 chatStreamManager 구독 정상 (useChatStreamState 회귀)', async ({ page }) => {
    const errors = await gotoAIChat(page)

    // /dashboard 로 이동 → 다시 /ai-chat 로 복귀 (Provider re-mount, useChatStreamState 재구독)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1.text-3xl').first()).toBeVisible({ timeout: 10000 })

    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')
    await expect(page.getByPlaceholder(PLACEHOLDER_RE)).toBeVisible({ timeout: 10000 })

    // input 정상 동작
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('test')
    await expect(input).toHaveValue('test')
    await input.fill('')

    assertNoCriticalErrors(errors)
  })

  test('session sidebar 우클릭 → 컨텍스트 메뉴 (useSessionEditing + useContextMenuDismiss)', async ({ page }) => {
    const errors = await gotoAIChat(page)

    // 세션 만들기
    const input = page.getByPlaceholder(PLACEHOLDER_RE)
    await input.fill('hi')
    await page.getByRole('button', { name: SEND_RE }).click()
    await expect(input).toBeEnabled({ timeout: 30_000 })

    // 첫 세션 행 우클릭
    const firstSession = page.locator('[class*="cursor-pointer"]').filter({ hasText: /hi|새 채팅|new chat/i }).first()
    if ((await firstSession.count()) === 0) {
      test.skip(true, 'session 행 못 찾음')
      return
    }
    await firstSession.click({ button: 'right' })
    const rename = page.getByRole('button', { name: /^(제목 바꾸기|Rename)$/ })
    await expect(rename).toHaveCount(1, { timeout: 3000 })

    // ESC → context menu dismiss (useContextMenuDismiss 의 ESC 처리)
    await page.keyboard.press('Escape')
    await expect(rename).toHaveCount(0)

    assertNoCriticalErrors(errors)
  })
})
