import { test, expect, type Locator, type Page } from '@playwright/test'

// AI chat: a tool call's <details> opens and closes with the sidebar groups' height transition (the closed body is
// zero high and inert), and the Copy row sits under the answer with its height kept while the answer streams, so the
// message does not grow when the answer ends. The disclosure test stores a conversation through the session API, so
// it needs no model; the streaming test needs the dev default model.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const TOOL_MESSAGE = [
  '<details><summary>🔧 k8s_get_resources</summary>',
  '',
  '<details><summary><strong>📋 Arguments</strong></summary>',
  '',
  '```json',
  '{"resource_type": "pods", "namespace": "default"}',
  '```',
  '</details>',
  '',
  '<details><summary><strong>📊 Results</strong></summary>',
  '',
  '```',
  'NAME READY STATUS',
  'web-1 1/1 Running',
  '```',
  '</details>',
  '</details>',
  '',
  'There is one pod, **web-1**, and it is running.',
].join('\n')

async function bodyHeight(body: Locator): Promise<number> {
  return body.evaluate((el) => el.getBoundingClientRect().height)
}

async function openSession(page: Page, title: string) {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  await page.getByText(title, { exact: true }).first().click()
}

test.describe('AI chat — tool disclosure and the action row', () => {
  test('a tool call opens and closes with the height transition; the Copy row is under the answer', async ({ page }) => {
    const title = `e2e-disclosure-${Date.now().toString(36)}`
    // chat sessions belong to a cluster
    const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
    expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=self`, {
        headers: XRW,
        data: { messages: [{ role: 'user', content: 'list the pods' }, { role: 'assistant', content: TOOL_MESSAGE }] },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await openSession(page, title)

      const bubble = page.locator(ASSISTANT).last()
      const tool = bubble.getByRole('button', { name: /🔧 k8s_get_resources/ })
      const toolBody = bubble.getByTestId('md-details-body').first()
      await expect(tool).toHaveAttribute('aria-expanded', 'false')
      expect(await bodyHeight(toolBody)).toBe(0)
      expect(await toolBody.evaluate((el) => (el as HTMLElement).inert)).toBe(true)
      const style = await toolBody.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { property: cs.transitionProperty, duration: cs.transitionDuration }
      })
      expect(style.property).toContain('grid-template-rows')
      expect(style.duration.split(',')[0].trim()).toBe('0.2s')

      await tool.click()
      await expect(tool).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(() => bodyHeight(toolBody)).toBeGreaterThan(40)
      expect(await toolBody.evaluate((el) => (el as HTMLElement).inert)).toBe(false)

      // the nested Arguments block opens the same way
      const args = bubble.getByRole('button', { name: /📋 Arguments/ })
      await args.click()
      await expect(args).toHaveAttribute('aria-expanded', 'true')
      await expect(bubble.getByText('"resource_type": "pods"', { exact: false })).toBeVisible()

      await tool.click()
      await expect(tool).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(() => bodyHeight(toolBody)).toBe(0)

      // the action row is the bubble's last block, under the answer text, with the Copy button in it
      const actions = bubble.getByTestId('message-actions')
      const answer = bubble.getByText('There is one pod', { exact: false })
      const [actionsBox, answerBox] = [await actions.boundingBox(), await answer.boundingBox()]
      expect(actionsBox!.y).toBeGreaterThan(answerBox!.y + answerBox!.height - 1)
      await expect(actions.getByRole('button', { name: /^copy$|^복사$/i })).toBeVisible()
    } finally {
      await page.request.delete(`/api/v1/sessions/${sessionId}?cluster=self`, { headers: XRW, failOnStatusCode: false })
    }
  })

  test('the action row keeps its height while the answer streams, so the message does not grow at the end', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto('/ai-chat')
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(/메시지|message|질문|ask/i)
    await input.fill('한 문장으로 인사해줘')
    await page.getByRole('button', { name: /전송|send/i }).click()
    await expect(input).toBeDisabled({ timeout: 15_000 })

    const actions = page.locator(ASSISTANT).last().getByTestId('message-actions')
    const streaming = await actions.evaluate((el) => ({ height: el.getBoundingClientRect().height, buttons: el.querySelectorAll('button').length }))
    expect(streaming.buttons).toBe(0) // no Copy before the answer is complete
    expect(streaming.height).toBe(28)

    await expect(input).toBeEnabled({ timeout: 120_000 })
    const done = page.locator(ASSISTANT).last().getByTestId('message-actions')
    await expect(done.getByRole('button', { name: /^copy$|^복사$/i })).toBeVisible()
    expect(await done.evaluate((el) => el.getBoundingClientRect().height)).toBe(streaming.height)
  })
})
