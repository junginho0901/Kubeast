import { test, expect, type Page, type Route } from '@playwright/test'

// An answer that uses tools part way shows in the order it came, in the AI chat and the floating chat: the sentence
// written before a tool call stays above that call's block, each result fills its own block, and the text after the
// last call comes last — while the answer comes, once it has ended and after a reload. Copy takes the text only.
// The chat request is answered in the browser with a fixed stream (no model); the answer the server would save is
// stored through the session API. The page clock is paused once the question is sent, so the last sentence waits in
// the typewriter and the screen can be read mid-answer.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const FIRST = 'First I will find the clusters.'
const SECOND = 'Now the pods in default.'
const LAST = 'Both clusters are up and every pod is running.'
const IN_ORDER = [FIRST, 'list_clusters', SECOND, 'k8s_get_resources', LAST]

const STREAM = [
  { content: 'First I will ' }, { content: 'find the clusters.' },
  { function: 'list_clusters', args: {}, call_id: 0 },
  { function_result: 'list_clusters', result: '["self","default"]', is_json: true, call_id: 0 },
  { content: SECOND },
  { function: 'k8s_get_resources', args: { kind: 'pods', namespace: 'default' }, call_id: 1 },
  { content: `\n\n${LAST}` },
  { function_result: 'k8s_get_resources', result: 'pod-a   Running', call_id: 1 },
]

// the saved answer as the server writes it (ai-service streaming.answer_markdown)
function block(name: string, args: string, result: string, fence: string) {
  return `<details>\n<summary>🔧 <strong>${name}</strong></summary>\n\n${args}\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n${fence}\n${result}\n\`\`\`\n\n</details>\n\n</details>\n\n`
}
const SAVED = FIRST + '\n\n'
  + block('list_clusters', '<p><strong>📋 Arguments:</strong> No arguments</p>', '["self","default"]', '```json')
  + SECOND + '\n\n'
  + block('k8s_get_resources', '<details>\n<summary><strong>📋 Arguments</strong></summary>\n\n```json\n{\n  "kind": "pods",\n  "namespace": "default"\n}\n```\n\n</details>', 'pod-a   Running', '```')
  + LAST

function positions(text: string, parts: string[]) {
  return parts.map((p) => text.indexOf(p))
}

function expectInOrder(text: string, parts: string[]) {
  const at = positions(text, parts)
  expect(at, `${parts.join(' → ')}\n---\n${text}`).not.toContain(-1)
  expect(at).toEqual([...at].sort((a, b) => a - b))
}

// answers the chat request with STREAM and stores the turn as the server would; resolves once both are done
function answerWithStream(page: Page, path: RegExp) {
  let sessionId = ''
  let done!: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))
  const handler = async (route: Route) => {
    sessionId = /sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? ''
    const question = route.request().postDataJSON().message as string
    const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=self`, {
      headers: XRW, data: { messages: [{ role: 'user', content: question }, { role: 'assistant', content: SAVED }] },
    })
    expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
    const body = STREAM.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
    await route.fulfill({ contentType: 'text/event-stream', body })
    done()
  }
  return { ready: page.route(path, handler), finished, session: () => sessionId }
}

async function dropSession(page: Page, id: string) {
  if (id) await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW, failOnStatusCode: false })
}

test.describe('Answers that use tools part way', () => {
  test('the AI chat keeps text and tool blocks in the order they came', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.clock.install()
    const title = `e2e-interleaved-${Date.now().toString(36)}`
    const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
    expect(created.ok()).toBeTruthy()
    const id = (await created.json()).id as string
    const chat = answerWithStream(page, new RegExp(`/api/v1/ai/sessions/${id}/chat`))
    await chat.ready
    try {
      await page.goto('/ai-chat?cluster=self')
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click()

      await page.clock.pauseAt(Date.now() + 1000)
      await page.getByTestId('chat-input').fill('are my clusters healthy?')
      await page.getByRole('button', { name: /전송|send/i }).click()
      await chat.finished

      // mid-answer: both blocks with their results, each under the sentence written before it; the last sentence waits
      const bubble = page.locator(ASSISTANT).last()
      await expect(bubble.getByRole('button', { name: /k8s_get_resources/ })).toBeVisible()
      expectInOrder(await bubble.innerText(), IN_ORDER.slice(0, 4))
      expect(await bubble.innerText()).not.toContain(LAST)
      const raw = (await bubble.textContent()) ?? ''
      expect(raw).toContain('pod-a   Running')
      expect(raw).not.toContain('Executing...')

      await page.clock.resume()
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 15_000 })
      await expect(bubble).toContainText(LAST)
      expectInOrder(await bubble.innerText(), IN_ORDER)

      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click()
      const saved = page.locator(ASSISTANT).last()
      await expect(saved).toContainText(LAST)
      expectInOrder(await saved.innerText(), IN_ORDER)

      await saved.getByRole('button', { name: /Copy|복사/ }).click()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expectInOrder(copied, [FIRST, SECOND, LAST])
      expect(copied).not.toContain('list_clusters')
      expect(copied).not.toContain('pod-a')
    } finally {
      await dropSession(page, id)
    }
  })

  test('the floating chat shows the tool blocks in place while the answer comes', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.clock.install()
    const chat = answerWithStream(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/)
    await chat.ready
    try {
      await page.goto('/?cluster=self')
      await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()

      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill('are my clusters healthy?')
      await input.press('Enter')
      await chat.finished

      const answer = page.getByTestId('floating-answer').last()
      await expect(answer.getByRole('button', { name: /k8s_get_resources/ })).toBeVisible()
      expectInOrder(await answer.innerText(), IN_ORDER.slice(0, 4))
      expect(await answer.innerText()).not.toContain(LAST)

      await page.clock.resume()
      const copy = answer.getByTestId('floating-copy')
      await expect(copy).toBeVisible({ timeout: 15_000 })
      expectInOrder(await answer.innerText(), IN_ORDER)
      await copy.click()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expectInOrder(copied, [FIRST, SECOND, LAST])
      expect(copied).not.toContain('list_clusters')
    } finally {
      await dropSession(page, chat.session())
    }
  })
})
