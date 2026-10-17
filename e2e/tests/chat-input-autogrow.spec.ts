import { test, expect, type Locator } from '@playwright/test'

// The chat inputs grow with Shift+Enter lines up to a cap (AI chat 240 px, floating assistant 128 px), scroll
// beyond it, and go back to one line when cleared. Shift+Enter adds a line instead of sending — also when it is
// pressed while an input method is still composing a syllable, in the event orders browsers use (Chrome on macOS
// fires keydown composing then again not composing, Safari ends the composition first, Windows sends "Process").

const height = (el: Locator) => el.evaluate((e) => e.getBoundingClientRect().height)

async function checkGrowth(input: Locator, cap: number) {
  const oneLine = await height(input)
  await input.click()
  await input.pressSequentially('line one')
  await input.press('Shift+Enter')
  await input.pressSequentially('line two')
  await input.press('Shift+Enter')
  await input.pressSequentially('line three')
  await expect(input).toHaveValue('line one\nline two\nline three') // not sent
  const threeLines = await height(input)
  expect(threeLines).toBeGreaterThan(oneLine + 30)
  expect(await input.evaluate((e) => getComputedStyle(e).overflowY)).toBe('hidden')

  await input.fill(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
  expect(await height(input)).toBe(cap)
  expect(await input.evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto')

  await input.fill('')
  expect(await height(input)).toBe(oneLine)
}

test.describe('Chat input grows with its lines', () => {
  test('AI chat: up to 240 px, the Send button stays at the bottom', async ({ page }) => {
    await page.goto('/ai-chat')
    const input = page.getByTestId('chat-input')
    await expect(input).toBeVisible()
    await checkGrowth(input, 240)
    await input.fill('a\nb\nc\nd')
    const [box, send] = [await input.boundingBox(), await page.getByRole('button', { name: /전송|send/i }).boundingBox()]
    expect(Math.abs(box!.y + box!.height - (send!.y + send!.height))).toBeLessThan(1)
  })

  test('floating assistant: up to 128 px', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click()
    const input = page.getByTestId('floating-chat-input')
    await expect(input).toBeVisible()
    await checkGrowth(input, 128)
  })
})

type Order = 'chrome-mac' | 'safari' | 'windows'

async function shiftEnterWhileComposing(input: Locator, order: Order) {
  await input.evaluate((el, order) => {
    const ta = el as HTMLTextAreaElement
    ta.setSelectionRange(ta.value.length, ta.value.length)
    const key = (init: KeyboardEventInit) =>
      ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, shiftKey: true, code: 'Enter', ...init }))
    const end = () => ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '줘' }))
    if (order === 'chrome-mac') {
      key({ key: 'Enter', isComposing: true })
      end()
      key({ key: 'Enter' })
    } else if (order === 'safari') {
      end()
      key({ key: 'Enter' })
    } else {
      key({ key: 'Process', isComposing: true })
      end()
    }
  }, order)
}

test('Shift+Enter while a Korean syllable is being composed adds exactly one line', async ({ page }) => {
  await page.goto('/ai-chat')
  const input = page.getByTestId('chat-input')
  for (const order of ['chrome-mac', 'safari', 'windows'] as Order[]) {
    await input.fill('확인해줘')
    await shiftEnterWhileComposing(input, order)
    await expect(input, order).toHaveValue('확인해줘\n')
    await page.waitForTimeout(150) // a late duplicate would land here
    await expect(input, order).toHaveValue('확인해줘\n')
  }
  // an ordinary Shift+Enter still adds one line at the caret, and Enter is not taken as Shift+Enter
  await input.fill('ab')
  await input.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(1, 1))
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('a\nb')
})

test('Enter sends; an Enter that only ends a composition does not', async ({ page }) => {
  const chat = /\/api\/v1\/ai\/sessions\/[^/]+\/chat/
  let posts = 0
  await page.route(chat, (r) => {
    posts++
    return r.abort() // no model call; the request is what is checked
  })
  await page.goto('/ai-chat')
  const input = page.getByTestId('chat-input')
  await input.fill('확인')
  await input.evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', isComposing: true })),
  )
  await page.waitForTimeout(300)
  expect(posts).toBe(0)
  await expect(input).toHaveValue('확인')

  const created = page.waitForResponse((r) => /\/api\/v1\/sessions(\?|$)/.test(r.url()) && r.request().method() === 'POST')
  const sent = page.waitForRequest(chat)
  await input.press('Enter')
  const sessionId = (await (await created).json()).id as string
  try {
    await sent
    expect(posts).toBe(1)
  } finally {
    await page.request.delete(`/api/v1/sessions/${sessionId}?cluster=default`, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false })
  }
})

