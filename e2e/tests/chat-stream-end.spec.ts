import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

// How a chat answer ends, in the AI chat and the floating chat: only [DONE] finishes one. A refused request, a stream
// that closes early and an empty 200 show as errors with the question and the letters that came still on screen. Tags and
// tool names in a tool result stay the result's words: Copy, the 🔐 line and what is drawn after them are not moved by
// them, nor by HTML an answer leaves open, and a tool block below a code block the answer left open is a tool block. A
// stopped answer shows what is saved, a cut one is saved as it showed under its question, once, and the floating chat keeps
// a turn on screen as AI Chat does: a failed one above the next question, one that ended until the saved messages have it.
// The chat request is answered in the browser (no model); nothing on the cluster changes.

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
  // The panel takes clicks two animation frames after it mounts, and a test may pause the clock right after this.
  await expect(page.getByTestId('floating-chat-panel')).toHaveCSS('pointer-events', 'auto')
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

// ai-service saves the question before it calls the model and the answer only when it sees the turn end: these routes do
// the same, so what the page saves of a cut stream goes where it would.
async function saveAsAIService(page: Page, route: Route, messages: { role: string; content: string }[]) {
  const id = /sessions\/([^/]+)\//.exec(route.request().url())?.[1]
  const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, { headers: XRW, data: { messages } })
  expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
}

async function savedMessages(page: Page, id: string) {
  const read = await page.request.get(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW })
  expect(read.ok(), `read the conversation: ${read.status()}`).toBeTruthy()
  return ((await read.json()) as { messages: { role: string; content: string; usage?: Record<string, unknown> | null }[] }).messages
}

const pageSave = (page: Page) => page.waitForResponse((r) => /\/api\/v1\/sessions\/[^/]+\/messages/.test(r.url()) && r.request().method() === 'POST')

test.describe('A cut answer is saved as it showed', () => {
  test('AI chat: a stream that closes without [DONE] leaves its letters saved under the question, marked ended by an error', async ({ page }) => {
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, async (route) => {
      await saveAsAIService(page, route, [{ role: 'user', content: QUESTION }])
      await route.fulfill({ contentType: 'text/event-stream', body: sse({ content: PARTIAL }) })
    })
    await chat.ready
    try {
      const saved = pageSave(page)
      await sendInAIChat(page)
      await chat.answered
      const response = await saved
      expect(response.request().postDataJSON()).toEqual({ messages: [{ role: 'assistant', content: PARTIAL, failed: true, answers: QUESTION }] })
      expect(await response.json()).toMatchObject({ saved: 1 })
      await expect(page.locator(ASSISTANT).last()).toContainText(ENDINGS[1].error)
      const messages = await savedMessages(page, chat.session())
      expect(messages.map((m) => [m.role, m.content])).toEqual([['user', QUESTION], ['assistant', PARTIAL]])
      expect(messages[1].usage).toEqual({ failed: true })
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('AI chat: a stream that lost only its end keeps the one answer ai-service saved', async ({ page }) => {
    const whole = `${PARTIAL}, both healthy.`
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, async (route) => {
      await saveAsAIService(page, route, [{ role: 'user', content: QUESTION }, { role: 'assistant', content: whole }])
      await route.fulfill({ contentType: 'text/event-stream', body: sse({ content: whole }) })
    })
    await chat.ready
    try {
      const saved = pageSave(page)
      await sendInAIChat(page)
      await chat.answered
      expect(await (await saved).json()).toMatchObject({ saved: 0 })
      const messages = await savedMessages(page, chat.session())
      expect(messages.map((m) => [m.role, m.content])).toEqual([['user', QUESTION], ['assistant', whole]])
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('floating chat: the cut answer is saved once, and stays above the next question and its answer', async ({ page }) => {
    let answers = 0
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, async (route) => {
      answers++
      if (answers === 1) {
        await saveAsAIService(page, route, [{ role: 'user', content: QUESTION }])
        return route.fulfill({ contentType: 'text/event-stream', body: sse({ content: PARTIAL }) })
      }
      await saveAsAIService(page, route, [{ role: 'user', content: 'and now?' }, { role: 'assistant', content: 'Now it works.' }])
      await route.fulfill({ contentType: 'text/event-stream', body: sse({ content: 'Now it works.' }, '[DONE]') })
    })
    await chat.ready
    try {
      const input = await openFloating(page)
      const saved = pageSave(page)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      expect(await (await saved).json()).toMatchObject({ saved: 1 })
      const list = page.getByTestId('floating-messages')
      await expect(list).toContainText(ENDINGS[1].error)

      await input.fill('and now?')
      await input.press('Enter')
      await expect(page.getByTestId('floating-answer').last()).toContainText('Now it works.')
      // the read of the saved messages after the answer has come
      await page.waitForTimeout(500)

      const text = await list.innerText()
      const places = [QUESTION, PARTIAL, 'and now?', 'Now it works.'].map((words) => text.indexOf(words))
      expect(places.every((at) => at !== -1), text).toBe(true)
      expect([...places].sort((a, b) => a - b)).toEqual(places)
      expect(text.split(PARTIAL).length - 1, 'the saved answer and the one on screen are one').toBe(1)
      expect(text.search(ENDINGS[1].error)).toBeGreaterThan(places[1])
      expect(text.search(ENDINGS[1].error)).toBeLessThan(places[2])
      const messages = await savedMessages(page, chat.session())
      expect(messages.map((m) => [m.role, m.content])).toEqual([['user', QUESTION], ['assistant', PARTIAL], ['user', 'and now?'], ['assistant', 'Now it works.']])
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

const OPEN_CODE_STREAM = sse(
  { content: 'Try:\n\n```bash\nkubectl get pods' },
  { function: 'k8s_pod_logs', args: { q: 'Executing...' }, call_id: 0 },
  { function_result: 'k8s_pod_logs', result: 'the result', call_id: 0 },
  { content: 'The last sentence.' },
  '[DONE]',
)

async function expectToolBlockBelowOpenCode(answer: Locator) {
  await expect(answer).toContainText('The last sentence.')
  await expect(answer.locator('pre code').first()).toHaveText('kubectl get pods\n')
  await expect(answer.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toHaveText(/k8s_pod_logs/)
  await expect(answer.getByText('<details>')).toHaveCount(0)
  const code = await resultCode(answer, /🔧 k8s_pod_logs/)
  expect(await code.textContent()).toBe('the result\n')
  await answer.getByRole('button', { name: /📋 Arguments/ }).click()
  await expect(answer.locator('pre code').nth(1)).toContainText('"q": "Executing..."')
}

const LONG_ANSWER = `Stopped part way, ${'with every letter that came '.repeat(8)}on screen.`

// The chat answered in one piece. With the page clock paused the tool block shows and the letters after it wait in the typewriter.
function typewriterWaits(page: Page, path: RegExp) {
  const body = sse(
    { function: 'list_clusters', args: {}, call_id: 0 },
    { function_result: 'list_clusters', result: '["self"]', call_id: 0 },
    { content: LONG_ANSWER },
    '[DONE]',
  )
  return answering(page, path, (route) => route.fulfill({ contentType: 'text/event-stream', body }))
}

const savedStop = (page: Page) => page.waitForRequest((r) => /\/sessions\/[^/]+\/messages/.test(r.url()) && r.method() === 'POST')

test.describe('A code block the answer left open, and a stopped answer', () => {
  test('AI chat: the tool block below it is a tool block with its arguments and result, and Copy takes the text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/, (route) => route.fulfill({ contentType: 'text/event-stream', body: OPEN_CODE_STREAM }))
    await chat.ready
    try {
      await sendInAIChat(page)
      await chat.answered
      const answer = page.locator(ASSISTANT).last()
      await expectToolBlockBelowOpenCode(answer)
      await answer.getByRole('button', { name: /Copy|복사/ }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Try:\n\n```bash\nkubectl get pods\n```\n\nThe last sentence.')
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('floating chat: the same', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, (route) => route.fulfill({ contentType: 'text/event-stream', body: OPEN_CODE_STREAM }))
    await chat.ready
    try {
      const input = await openFloating(page)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      const answer = page.getByTestId('floating-answer').last()
      await expectToolBlockBelowOpenCode(answer)
      await answer.getByTestId('floating-copy').click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Try:\n\n```bash\nkubectl get pods\n```\n\nThe last sentence.')
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('AI chat: a stopped answer shows every letter that is saved', async ({ page }) => {
    await page.clock.install()
    const chat = typewriterWaits(page, /\/api\/v1\/ai\/sessions\/[^/]+\/chat/)
    await chat.ready
    try {
      await openAIChat(page)
      await page.clock.pauseAt(Date.now() + 1000)
      await ask(page)
      await chat.answered
      const answer = page.locator(ASSISTANT).last()
      await expect(answer.getByRole('button', { name: /🔧 list_clusters/ })).toHaveText(/list_clusters/)
      await expect(answer).not.toContainText(LONG_ANSWER)
      const saved = savedStop(page)
      await page.getByRole('button', { name: /^중단$|^stop$/i }).click()
      const posted = (await saved).postDataJSON() as { messages: { content: string; stopped: boolean; answers: string }[] }
      expect(posted.messages).toHaveLength(1)
      expect(posted.messages[0].stopped).toBe(true)
      expect(posted.messages[0].answers, 'saved only while its question is the newest message').toBe(QUESTION)
      expect(posted.messages[0].content.endsWith(LONG_ANSWER)).toBe(true)
      await page.clock.resume()
      await expect(page.locator(ASSISTANT).last()).toContainText(LONG_ANSWER)
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('floating chat: a stopped answer shows every letter that is saved, and its question', async ({ page }) => {
    await page.clock.install()
    const chat = typewriterWaits(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/)
    await chat.ready
    try {
      const input = await openFloating(page)
      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      const answer = page.getByTestId('floating-answer').last()
      await expect(answer.getByRole('button', { name: /🔧 list_clusters/ })).toHaveText(/list_clusters/)
      await expect(answer).not.toContainText(LONG_ANSWER)
      const saved = savedStop(page)
      await page.getByTestId('floating-chat-panel').getByRole('button', { name: /^중지$|^stop$/i }).click()
      const posted = (await saved).postDataJSON() as { messages: { content: string; answers: string }[] }
      expect(posted.messages).toHaveLength(1)
      expect(posted.messages[0].answers, 'saved only while its question is the newest message').toBe(QUESTION)
      expect(posted.messages[0].content.endsWith(LONG_ANSWER)).toBe(true)
      await page.clock.resume()
      await expect(page.getByTestId('floating-answer').last()).toContainText(LONG_ANSWER)
      await expect(page.getByTestId('floating-messages')).toContainText(QUESTION)
      await expect(page.getByTestId('floating-waiting')).toHaveCount(0)
    } finally {
      await dropSession(page, chat.session())
    }
  })
})

test.describe('The floating chat keeps each turn on screen', () => {
  test('a stopped answer whose save failed stays above the next question and its answer', async ({ page }) => {
    await page.clock.install()
    let answers = 0
    const first = sse(
      { function: 'list_clusters', args: {}, call_id: 0 },
      { function_result: 'list_clusters', result: '["self"]', call_id: 0 },
      { content: LONG_ANSWER },
      '[DONE]',
    )
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, (route) => {
      answers++
      return route.fulfill({ contentType: 'text/event-stream', body: answers === 1 ? first : sse({ content: 'Now it works.' }, '[DONE]') })
    })
    await chat.ready
    await page.route(/\/api\/v1\/sessions\/[^/]+\/messages/, (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"the save failed"}' }) : route.fallback())
    try {
      const input = await openFloating(page)
      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      await expect(page.getByTestId('floating-answer').last().getByRole('button', { name: /🔧 list_clusters/ })).toHaveText(/list_clusters/)
      const refused = page.waitForResponse((r) => /\/sessions\/[^/]+\/messages/.test(r.url()) && r.request().method() === 'POST')
      await page.getByTestId('floating-chat-panel').getByRole('button', { name: /^중지$|^stop$/i }).click()
      expect((await refused).status(), 'the save is refused').toBe(500)
      await page.clock.resume()
      const list = page.getByTestId('floating-messages')
      await expect(list).toContainText(LONG_ANSWER)

      await input.fill('and now?')
      await input.press('Enter')
      await expect(page.getByTestId('floating-answer').last()).toContainText('Now it works.')
      // the read of the saved messages after the answer has come
      await page.waitForTimeout(500)

      const text = await list.innerText()
      const places = [QUESTION, LONG_ANSWER, 'and now?', 'Now it works.'].map((words) => text.indexOf(words))
      expect(places.every((at) => at !== -1), text).toBe(true)
      expect([...places].sort((a, b) => a - b)).toEqual(places)
      expect(text.split(LONG_ANSWER).length - 1, 'once').toBe(1)
      expect(text, 'a stop is no error').not.toMatch(ENDINGS[1].error)
      expect(await page.getByTestId('floating-answer').count(), 'each with its bubble').toBe(2)
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('a failed turn stays above the next question and its answer, also once that answer is saved', async ({ page }) => {
    let answers = 0
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, async (route) => {
      answers++
      if (answers === 1) return ENDINGS[1].answer(route)
      const id = /sessions\/([^/]+)\//.exec(route.request().url())?.[1]
      const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, {
        headers: XRW, data: { messages: [{ role: 'user', content: 'and now?' }, { role: 'assistant', content: 'Now it works.' }] },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await route.fulfill({ contentType: 'text/event-stream', body: sse({ content: 'Now it works.' }, '[DONE]') })
    })
    await chat.ready
    try {
      const input = await openFloating(page)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      const list = page.getByTestId('floating-messages')
      await expect(list).toContainText(ENDINGS[1].error)

      const saved = page.waitForResponse((r) => /\/api\/v1\/sessions\/[^/?]+(?:\?.*)?$/.test(r.url()) && r.request().method() === 'GET' && answers === 2)
      await input.fill('and now?')
      await input.press('Enter')
      await expect(page.getByTestId('floating-answer').last()).toContainText('Now it works.')
      expect((await saved).ok()).toBeTruthy()
      // the read's answer reaches the list after the response
      await page.waitForTimeout(500)

      const text = await list.innerText()
      const places = [QUESTION, PARTIAL, 'and now?', 'Now it works.'].map((words) => text.indexOf(words))
      expect(places.every((at) => at !== -1), text).toBe(true)
      expect([...places].sort((a, b) => a - b)).toEqual(places)
      expect(text.search(ENDINGS[1].error)).toBeGreaterThan(places[1])
      expect(text.search(ENDINGS[1].error)).toBeLessThan(places[2])
      expect(text.split('and now?').length - 1).toBe(1)
      expect(text.split('Now it works.').length - 1).toBe(1)
    } finally {
      await dropSession(page, chat.session())
    }
  })

  test('a conversation that is gone keeps the turn that found out, and the next question starts a new one', async ({ page }) => {
    const sessions: string[] = []
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, async (route) => {
      const id = /sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? ''
      sessions.push(id)
      if (sessions.length > 1) return route.fulfill({ contentType: 'text/event-stream', body: sse({ content: 'A new one.' }, '[DONE]') })
      await dropSession(page, id)
      return route.fulfill({ contentType: 'text/event-stream', body: sse({ error: 'Session not found', error_key: 'sessionNotFound' }) })
    })
    await chat.ready
    try {
      const input = await openFloating(page)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered
      const list = page.getByTestId('floating-messages')
      const gone = /no longer exists|더 이상 없습니다/
      await expect(list).toContainText(gone)
      const read = page.waitForResponse((r) => /\/api\/v1\/sessions\/[^/?]+(?:\?.*)?$/.test(r.url()) && r.request().method() === 'GET' && r.status() === 404, { timeout: 10_000 }).catch(() => null)
      await read
      // the read's answer reaches the panel after the response
      await page.waitForTimeout(500)
      await expect(list, 'the question stays after the read says the conversation is gone').toContainText(QUESTION)
      await expect(list).toContainText(gone)

      await input.fill('and now?')
      await input.press('Enter')
      await expect(page.getByTestId('floating-answer').last()).toContainText('A new one.')
      expect(sessions).toHaveLength(2)
      expect(sessions[1]).not.toBe(sessions[0])
      await expect(list).not.toContainText(QUESTION)
    } finally {
      for (const id of sessions) await dropSession(page, id)
    }
  })

  test('AI chat: a saved answer an error ended says so under it', async ({ page }) => {
    const { id, title } = await storedSession(page, PARTIAL)
    await page.route(new RegExp(`/api/v1/sessions/${id}(?:\\?.*)?$`), async (route) => {
      const response = await route.fetch()
      const detail = await response.json() as { messages: { role: string; usage?: unknown }[] }
      for (const message of detail.messages) if (message.role === 'assistant') message.usage = { failed: true, prompt_tokens: 100, completion_tokens: 7 }
      await route.fulfill({ response, json: detail })
    })
    try {
      const answer = await openStored(page, title)
      await expect(answer).toContainText(PARTIAL)
      await expect(answer.getByTestId('turn-usage')).toHaveText(/^(Ended by an error · In 100 · out 7 tokens|오류로 끝남 · 입력 100 · 출력 7 토큰)$/)
    } finally {
      await dropSession(page, id)
    }
  })

  test('an answer does not leave the screen while the saved messages are on their way, and an open tool block stays open', async ({ page }) => {
    await page.clock.install()
    const chat = answering(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/, async (route) => {
      const id = /sessions\/([^/]+)\//.exec(route.request().url())?.[1]
      const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, {
        headers: XRW,
        data: { messages: [{ role: 'user', content: QUESTION }, { role: 'assistant', content: toolBlock('the result', '```') + 'The last sentence.' }] },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await route.fulfill({
        contentType: 'text/event-stream',
        body: sse(
          { function: 'k8s_pod_logs', args: {}, call_id: 0 },
          { function_result: 'k8s_pod_logs', result: 'the result', call_id: 0 },
          { content: 'The last sentence.' },
          '[DONE]',
        ),
      })
    })
    await chat.ready
    try {
      const input = await openFloating(page)
      // a slow read, so a gap between the answer ending and the saved list would be on screen
      let reads = 0
      await page.route(/\/api\/v1\/sessions\/[^/?]+(?:\?.*)?$/, async (route) => {
        if (route.request().method() === 'GET') {
          reads++
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
        await route.continue()
      })
      await page.evaluate(() => {
        const list = document.querySelector('[data-testid="floating-messages"]')!
        const seen = { had: false, fell: false }
        ;(window as unknown as { answerWatch: typeof seen }).answerWatch = seen
        new MutationObserver(() => {
          if (list.querySelector('[data-testid="floating-answer"]')) seen.had = true
          else if (seen.had) seen.fell = true
        }).observe(list, { childList: true, subtree: true })
      })
      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill(QUESTION)
      await input.press('Enter')
      await chat.answered

      const answer = page.getByTestId('floating-answer').last()
      const tool = answer.getByRole('button', { name: /🔧 k8s_pod_logs/ })
      await tool.click()
      await expect(tool).toHaveAttribute('aria-expanded', 'true')

      await page.clock.resume()
      await expect(answer.getByTestId('floating-copy')).toHaveCount(1, { timeout: 15_000 })
      // The read that brings the saved messages may have started before the clock did.
      await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(1500)

      await expect(answer).toContainText('The last sentence.')
      await expect(answer.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('floating-answer')).toHaveCount(1)
      expect(await page.evaluate(() => (window as unknown as { answerWatch: unknown }).answerWatch)).toEqual({ had: true, fell: false })
    } finally {
      await dropSession(page, chat.session())
    }
  })
})
