import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

// How a chat answer ends, in the AI chat and the floating chat: only [DONE] finishes one. A refused request, a stream
// that closes early and an empty 200 show as errors with the question and the letters that came still on screen. Tags and
// tool names in a tool result stay the result's words: Copy, the 🔐 line and what is drawn after them are not moved by
// them, nor by HTML an answer leaves open. The chat request is answered in the browser (no model); nothing on the cluster changes.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const QUESTION = 'are my clusters healthy?'
const PARTIAL = 'Two clusters so far'

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

const ENDINGS = [
  {
    name: 'a refused request',
    answer: (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"audit unavailable"}' }),
    error: /\(HTTP 503\): audit unavailable/,
    letters: false,
  },
  {
    name: 'a stream that closes without [DONE]',
    answer: (route: Route) => route.fulfill({ contentType: 'text/event-stream', body: sse({ content: PARTIAL }) }),
    error: /before the answer finished|답변이 끝나기 전에/,
    letters: true,
  },
  {
    name: 'an empty 200',
    answer: (route: Route) => route.fulfill({ contentType: 'text/event-stream', body: '' }),
    error: /without an answer|답변 없이/,
    letters: false,
  },
]

async function dropSession(page: Page, id: string) {
  if (id) await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW, failOnStatusCode: false })
}

function answering(page: Page, path: RegExp, answer: (route: Route) => Promise<void>) {
  let sessionId = ''
  let done!: () => void
  const answered = new Promise<void>((resolve) => (done = resolve))
  const ready = page.route(path, async (route) => {
    sessionId = /sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? ''
    await answer(route)
    done()
  })
  return { ready, answered, session: () => sessionId }
}

async function openAIChat(page: Page) {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
}

async function ask(page: Page, question = QUESTION) {
  await page.getByTestId('chat-input').fill(question)
  await page.getByRole('button', { name: /전송|send/i }).click()
}

async function sendInAIChat(page: Page) {
  await openAIChat(page)
  await ask(page)
}

async function openFloating(page: Page) {
  await page.goto('/?cluster=self')
  await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click()
  const input = page.getByTestId('floating-chat-input')
  await expect(input).toBeVisible()
  return input
}

async function storedSession(page: Page, content: string) {
  const title = `e2e-stream-end-${Date.now().toString(36)}`
  const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
  expect(created.ok()).toBeTruthy()
  const { id } = await created.json() as { id: string }
  const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, {
    headers: XRW, data: { messages: [{ role: 'user', content: QUESTION }, { role: 'assistant', content }] },
  })
  expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
  return { id, title }
}

async function openStored(page: Page, title: string) {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  await page.getByText(title, { exact: true }).first().click()
  return page.locator(ASSISTANT).last()
}

const toolBlock = (result: string, fence = '````') =>
  `<details>\n<summary>🔧 <strong>k8s_pod_logs</strong></summary>\n\n<p><strong>📋 Arguments:</strong> No arguments</p>\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n${fence}\n${result}\n${fence}\n\n</details>\n\n</details>\n\n`

async function resultCode(answer: Locator, name: RegExp) {
  await answer.getByRole('button', { name }).first().click()
  const results = answer.getByRole('button', { name: /📊 Results/ }).last()
  await results.click()
  await expect(results).toHaveAttribute('aria-expanded', 'true')
  return answer.locator('pre code').last()
}

test.describe('How a chat answer ends', () => {
  for (const ending of ENDINGS) {
    test(`AI chat: ${ending.name} shows the error under the question`, async ({ page }) => {
      const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, ending.answer)
      await chat.ready
      try {
        await sendInAIChat(page)
        await chat.answered
        const last = page.locator(ASSISTANT).last()
        await expect(last).toContainText(ending.error)
        await expect(page.getByTestId('user-message-text')).toHaveText([QUESTION])
        await expect(page.locator(ASSISTANT)).toHaveCount(ending.letters ? 2 : 1)
        if (ending.letters) await expect(page.locator(ASSISTANT).first()).toContainText(PARTIAL)
        await expect(page.getByTestId('chat-input')).toBeEnabled()
      } finally {
        await dropSession(page, chat.session())
      }
    })

    test(`floating chat: ${ending.name} shows the error under the question`, async ({ page }) => {
      const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, ending.answer)
      await chat.ready
      try {
        const input = await openFloating(page)
        await input.fill(QUESTION)
        await input.press('Enter')
        await chat.answered
        const list = page.getByTestId('floating-messages')
        await expect(list).toContainText(ending.error)
        await expect(list).toContainText(QUESTION)
        await expect(page.getByTestId('floating-answer')).toHaveCount(ending.letters ? 1 : 0)
        if (ending.letters) await expect(page.getByTestId('floating-answer')).toContainText(PARTIAL)
        await expect(page.getByTestId('floating-waiting')).toHaveCount(0)
      } finally {
        await dropSession(page, chat.session())
      }
    })
  }

  test('AI chat: a refusal that comes before the first read of a new conversation stays on screen', async ({ page }) => {
    let refused!: () => void
    const refusedYet = new Promise<void>((resolve) => (refused = resolve))
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, ENDINGS[0].answer)
    await chat.ready
    try {
      await openAIChat(page)
      await page.route(/\/api\/v1\/sessions\/[^/?]+(?:\?.*)?$/, async (route) => {
        if (route.request().method() === 'GET') await refusedYet
        await route.continue()
      })
      const read = page.waitForResponse((r) => /\/api\/v1\/sessions\/[^/?]+(?:\?.*)?$/.test(r.url()) && r.request().method() === 'GET')
      await ask(page)
      await chat.answered
      await expect(page.locator(ASSISTANT).last()).toContainText(ENDINGS[0].error)
      refused()
      expect((await read).ok()).toBeTruthy()
      // the read's answer reaches the page's effect after the response
      await page.waitForTimeout(500)
      await expect(page.getByTestId('user-message-text')).toHaveText([QUESTION])
      await expect(page.locator(ASSISTANT).last()).toContainText(ENDINGS[0].error)
    } finally {
      refused()
      await dropSession(page, chat.session())
    }
  })

  test('a question after a failed one is answered as usual', async ({ page }) => {
    let answers = 0
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, (route) => {
      answers++
      return answers === 1 ? ENDINGS[0].answer(route) : route.fulfill({ contentType: 'text/event-stream', body: sse({ content: 'Now it works.' }, '[DONE]') })
    })
    await chat.ready
    try {
      await sendInAIChat(page)
      await chat.answered
      await expect(page.locator(ASSISTANT).last()).toContainText(ENDINGS[0].error)
      await ask(page, 'and now?')
      await expect(page.locator(ASSISTANT).last()).toContainText('Now it works.')
      expect(answers).toBe(2)
    } finally {
      await dropSession(page, chat.session())
    }
  })
})

test.describe('What a tool result or an answer holds stays its words', () => {
  test('Copy takes the text around a result holding details tags', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const closing = toolBlock('x\n</details>\n</details>\nfrom the first result')
    const opening = toolBlock('y\n<details>\nfrom the second result')
    const { id, title } = await storedSession(page, `Before.\n\n${closing}Between.\n\n${opening}After.`)
    try {
      const answer = await openStored(page, title)
      await answer.getByRole('button', { name: /Copy|복사/ }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Before.\n\nBetween.\n\nAfter.')
    } finally {
      await dropSession(page, id)
    }
  })

  test("a tool's name in an earlier result does not take the next call's 🔐 line", async ({ page }) => {
    const earlier = 'a log line\n<summary>🔧 <strong>written</strong></summary>\nanother line'
    const access = { cluster: 'self', kind: 'person', user: 'e2e@example.test', groups: [], role: 'Read', impersonation: true, mode: 'read' }
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, (route) => route.fulfill({
      contentType: 'text/event-stream',
      body: sse(
        { function: 'first_tool', args: {}, call_id: 0 },
        { function_result: 'first_tool', result: earlier, call_id: 0 },
        { function: 'second_tool', args: {}, call_id: 1 },
        { function_result: 'second_tool', result: 'its result', call_id: 1, access },
        { content: 'Done.' },
        '[DONE]',
      ),
    }))
    await chat.ready
    try {
      await sendInAIChat(page)
      await chat.answered
      const answer = page.locator(ASSISTANT).last()
      await expect(answer.getByRole('button', { name: /second_tool/ })).toBeVisible()
      const ranAs = answer.locator('p').filter({ hasText: '🔐 Ran as:' })
      await expect(ranAs).toHaveCount(1)
      expect((await answer.locator('pre code').first().textContent()) ?? '').toBe(`${earlier}\n`)
      // the line sits right under the second tool's name, before its results
      const parent = answer.getByRole('button', { name: /second_tool/ }).locator('..')
      await expect(parent.locator('p').filter({ hasText: '🔐 Ran as:' })).toHaveCount(1)
    } finally {
      await dropSession(page, chat.session())
    }
  })

  for (const [name, opener, shown] of [
    ['a comment', '<!-- a note', '<!-- a note'],
    ['a template', '<template>', '<template>'],
  ]) {
    test(`${name} left open shows as words, and the answer and tool block after it stay`, async ({ page }) => {
      const { id, title } = await storedSession(page, `Before.\n\n${opener}\n\nThe **next** sentence.\n\n${toolBlock('the <b>result</b>')}The last sentence.`)
      try {
        const answer = await openStored(page, title)
        await expect(answer).toContainText(shown)
        await expect(answer.locator('strong').filter({ hasText: 'next' })).toHaveText('next')
        await expect(answer).toContainText('The last sentence.')
        const code = await resultCode(answer, /🔧 k8s_pod_logs/)
        expect(await code.textContent()).toBe('the <b>result</b>\n')
      } finally {
        await dropSession(page, id)
      }
    })
  }
})
