import { test, expect, type Page } from '@playwright/test'

// How chat answers show (AI chat and the floating chat): the Kubeast icon by each answer, tables with row and column
// lines, a stopped answer that keeps its text and says its usage is not available (also after a reload), a list that
// follows new text only while the reader is at the bottom, and in the floating chat the waiting dots, the title and a
// copy icon by each finished answer. The table and icon test stores a conversation through the session API (no
// model); the others need the dev default model.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const STOPPED_RE = /Stopped · usage not available|멈춤 · 사용량을 표시할 수 없음/
const TABLE_ANSWER = ['Pods by phase:', '', '| Namespace | Running | Pending |', '|---|---|---|', '| default | 3 | 0 |', '| kube-system | 9 | 1 |'].join('\n')

async function newSession(page: Page, title: string, messages?: { role: string; content: string }[]): Promise<string> {
  const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
  expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
  const id = (await created.json()).id as string
  if (messages) {
    const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, { headers: XRW, data: { messages } })
    expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
  }
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  await page.getByText(title, { exact: true }).first().click()
  return id
}

async function dropSession(page: Page, id: string) {
  await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW, failOnStatusCode: false })
}

function ask(page: Page, text: string) {
  return (async () => {
    await page.getByTestId('chat-input').fill(text)
    await page.getByRole('button', { name: /전송|send/i }).click()
  })()
}

test.describe('Chat answers', () => {
  test('answers carry the Kubeast icon and their tables have row and column lines', async ({ page }) => {
    const id = await newSession(page, `e2e-table-${Date.now().toString(36)}`, [
      { role: 'user', content: 'pods by phase' },
      { role: 'assistant', content: TABLE_ANSWER },
    ])
    try {
      const bubble = page.locator(ASSISTANT).last()
      await expect(bubble.getByTestId('assistant-avatar')).toHaveAttribute('src', '/icon.svg')
      const cell = bubble.getByTestId('chat-table').locator('td').first()
      await expect(cell).toHaveText('default')
      const borders = await cell.evaluate((el) => {
        const s = getComputedStyle(el)
        return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth]
      })
      expect(borders).toEqual(['1px', '1px', '1px', '1px'])
    } finally {
      await dropSession(page, id)
    }
  })

  test('a stopped answer keeps its text and says the usage is not available, also after a reload', async ({ page }) => {
    test.setTimeout(150_000)
    const title = `e2e-stop-${Date.now().toString(36)}`
    const id = await newSession(page, title)
    try {
      await ask(page, 'Kubernetes 의 Deployment, Service, Pod 의 차이를 아주 자세히 길게 설명해줘')
      const bubble = page.locator(ASSISTANT).last()
      // stop once the answer has started to show
      await expect.poll(async () => (await bubble.innerText()).length, { timeout: 90_000 }).toBeGreaterThan(40)
      await page.getByRole('button', { name: /^중단$|^stop$/i }).click()
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 10_000 })
      await expect(bubble.getByTestId('turn-usage')).toHaveText(STOPPED_RE)

      // saved with the stopped marker and the text shown
      await expect.poll(async () => {
        const detail = await (await page.request.get(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW })).json()
        const last = detail.messages[detail.messages.length - 1]
        return last.role === 'assistant' && last.content.length > 40 ? last.usage : null
      }).toEqual({ stopped: true })

      await page.reload()
      await page.getByText(title, { exact: true }).first().click()
      await expect(page.locator(ASSISTANT).last().getByTestId('turn-usage')).toHaveText(STOPPED_RE)
    } finally {
      await dropSession(page, id)
    }
  })

  test('scrolling up stops the list following new text; jumping to the latest follows again', async ({ page }) => {
    test.setTimeout(150_000)
    const id = await newSession(page, `e2e-scroll-${Date.now().toString(36)}`)
    try {
      await ask(page, "1부터 120까지 각 숫자를 '- 숫자' 형식의 마크다운 목록으로 한 줄에 하나씩, 다른 말 없이 써줘")
      const list = page.getByTestId('chat-messages')
      const overflow = () => list.evaluate((el) => el.scrollHeight - el.clientHeight)
      await expect.poll(overflow, { timeout: 90_000 }).toBeGreaterThan(400)

      // the reader scrolls up: the jump control shows and the view stays where the reader left it
      await list.hover()
      await page.mouse.wheel(0, -300)
      const jump = page.getByTestId('jump-to-latest')
      await expect(jump).toBeVisible()
      const left = await list.evaluate((el) => el.scrollTop)
      await page.waitForTimeout(1500)
      expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - left)).toBeLessThanOrEqual(2)

      await jump.click()
      await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(80)
      await expect(jump).toHaveCount(0)
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 90_000 })
      await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(80)
    } finally {
      await dropSession(page, id)
    }
  })

  test('the floating chat waits with dots, shows its icon and title, and copies a finished answer', async ({ page, context }) => {
    test.setTimeout(150_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/?cluster=self')
    await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click()
    await expect(page.getByText('AI Chat', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('floating-title-icon')).toHaveAttribute('src', '/icon.svg')

    const input = page.getByTestId('floating-chat-input')
    await input.fill('Kubeast 가 뭔지 한 문장으로 말해줘')
    await input.press('Enter')
    // the dots stand in the answer's place until its first letter
    await expect(page.getByTestId('floating-waiting')).toBeVisible({ timeout: 15_000 })

    const answer = page.getByTestId('floating-answer').last()
    const copy = answer.getByTestId('floating-copy')
    await expect(copy).toBeVisible({ timeout: 90_000 })
    await expect(answer.getByTestId('floating-assistant-avatar')).toHaveAttribute('src', '/icon.svg')
    await expect(page.getByTestId('floating-waiting')).toHaveCount(0)
    const shown = (await answer.locator('.prose').innerText()).trim()
    await copy.click()
    await expect(copy).toHaveAttribute('aria-label', /Copied|복사됨/)
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(shown)
  })
})
