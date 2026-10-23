import { test, expect, type Locator } from '@playwright/test'

// Inline code in AI-written markdown is a chip without the backticks the typography plugin adds around `code`
// (code::before/after); a fenced block stays as it was. The chat answer is a stored conversation and the floating
// chat's answer a stubbed stream, so no model is called.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const ANSWER = ['Run `kubectl get pods -n shop` and look at `checkout-api`.', '', '```', 'kubectl get pods -n shop', '```'].join('\n')

async function inlineCode(code: Locator) {
  return code.evaluate((el) => ({
    before: getComputedStyle(el, '::before').content,
    after: getComputedStyle(el, '::after').content,
    background: getComputedStyle(el).backgroundColor,
    radius: getComputedStyle(el).borderTopLeftRadius,
  }))
}

test.describe('inline code in chat answers', () => {
  test('AI Chat: no backticks around inline code, a chip behind it; the code block is unchanged', async ({ page }) => {
    const title = `e2e-inline-code-${Date.now().toString(36)}`
    const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
    expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=self`, {
        headers: XRW,
        data: { messages: [{ role: 'user', content: 'how do I see the shop pods?' }, { role: 'assistant', content: ANSWER }] },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await page.goto('/ai-chat?cluster=self')
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click()

      const bubble = page.locator(ASSISTANT).last()
      const code = bubble.locator('p code').filter({ hasText: 'checkout-api' })
      await expect(code).toHaveText('checkout-api')
      const style = await inlineCode(code)
      expect(style.before).toBe('none')
      expect(style.after).toBe('none')
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(style.radius).not.toBe('0px')
      // what the reader sees has no backtick at all
      expect(await bubble.locator('p').first().innerText()).toBe('Run kubectl get pods -n shop and look at checkout-api.')

      const block = await bubble.locator('pre code').evaluate((el) => ({
        before: getComputedStyle(el, '::before').content,
        background: getComputedStyle(el).backgroundColor,
      }))
      expect(block).toEqual({ before: 'none', background: 'rgba(0, 0, 0, 0)' })
    } finally {
      await page.request.delete(`/api/v1/sessions/${sessionId}?cluster=self`, { headers: XRW, failOnStatusCode: false })
    }
  })

  test('the floating chat: no backticks around inline code', async ({ page }) => {
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-inline-code', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback(),
    )
    await page.route(/\/api\/v1\/sessions\/e2e-inline-code(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-inline-code', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }),
    )
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-inline-code\/floating-chat/, (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ content: ANSWER })}\n\ndata: [DONE]\n\n` }),
    )
    await page.goto('/?cluster=self')
    await page.getByTestId('floating-chat-toggle').click()
    const input = page.getByTestId('floating-chat-input')
    await input.fill('how do I see the shop pods?')
    await input.press('Enter')

    const code = page.getByTestId('floating-chat-panel').locator('p code').filter({ hasText: 'checkout-api' })
    await expect(code).toHaveText('checkout-api')
    const style = await inlineCode(code)
    expect(style.before).toBe('none')
    expect(style.after).toBe('none')
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
  })
})
