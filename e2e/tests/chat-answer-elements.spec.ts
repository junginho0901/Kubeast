import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

// What a chat answer may draw, in a real browser: what it writes stays inside the answer, the approval card next to it
// stays whole and takes its own clicks, and a tool result with lines of backticks stays in its code block, while the
// answer comes and once it is saved. The answers are stored through the session API and the chat request is answered
// in the browser with a fixed stream (no model); the page clock is paused once the question is sent, so the last
// sentence waits in the typewriter and the screen can be read mid-answer. Nothing on the cluster changes: the approval
// is answered in the browser too.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const ASSISTANT = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const MARK = 'e2e-answer-elements'

const FLOATS = 'position:fixed;inset:0;z-index:2147483647;display:block;background:#000'
const ANSWER = [
  'Before the elements.',
  `<style>[data-testid="tool-approval-card"] pre{visibility:hidden} [data-testid="tool-approval-card"] button{display:none} body{--${MARK}:1}</style>`,
  `<meta http-equiv="refresh" content="0;url=/?${MARK}=moved">`,
  `<base href="https://example.test/${MARK}/">`,
  `<link rel="stylesheet" href="/${MARK}.css">`,
  `<iframe src="/?${MARK}=frame" title="frame"></iframe>`,
  `<form action="/?${MARK}=form"><p>Inside the form.</p></form>`,
  `<div style="${FLOATS}" class="fixed inset-0 z-50">Written cover.</div>`,
  `<a href="https://example.test/${MARK}" style="${FLOATS}" class="fixed inset-0 z-50" target="_self">Written link.</a>`,
  'After the elements.',
].join('\n\n')

const APPROVAL = {
  id: `${MARK}-approval`, session_id: '', cluster: 'self', tool: 'k8s_scale', args: { resource_name: 'web', replicas: 2 },
  status: 'pending', result: null, created_at: null, expires_at: null, decided_at: null,
}

// the page's elements the answer's words would have added, and whether the page is still the one it was
async function added(page: Page) {
  return page.evaluate((mark) => ({
    stayed: (window as unknown as { stayed?: boolean }).stayed === true,
    moved: location.search.includes(mark),
    refresh: document.querySelectorAll('meta[http-equiv="refresh"]').length,
    base: document.querySelectorAll('base').length,
    stylesheet: document.querySelectorAll(`link[href*="${mark}"]`).length,
    frame: document.querySelectorAll(`iframe[src*="${mark}"]`).length,
    form: document.querySelectorAll(`form[action*="${mark}"]`).length,
    rules: [...document.querySelectorAll('style')].filter((s) => s.textContent?.includes(mark)).length,
    bodyVariable: getComputedStyle(document.body).getPropertyValue(`--${mark}`),
  }), MARK)
}

const NOTHING_ADDED = { stayed: true, moved: false, refresh: 0, base: 0, stylesheet: 0, frame: 0, form: 0, rules: 0, bodyVariable: '' }

function markPage(page: Page) {
  return page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true
  })
}

const position = (element: Locator) => element.evaluate((el) => getComputedStyle(el).position)

const RESULT = ['line 1', '```', `<style>body{--${MARK}:1}</style>`, `<div id="${MARK}-outside">outside</div>`, '```', 'line 2'].join('\n')
const WRITTEN = `<span style="${FLOATS}" class="fixed inset-0 z-50">Written cover.</span>`
const DOCS = 'https://example.test/docs'
const FIRST = 'First the logs.'
const LAST = `All good, see [nginx-abc](kubest://pod?ns=default&name=nginx-abc) and [the docs](${DOCS}). ${WRITTEN}`

const STREAM = [
  { content: FIRST },
  { function: 'k8s_pod_logs', args: {}, call_id: 0 },
  { function_result: 'k8s_pod_logs', result: RESULT, call_id: 0 },
  { content: `\n\n${LAST}` },
]

// the saved answer as ai-service writes it (streaming.answer_markdown): the block is longer than the result's backticks
const SAVED = `${FIRST}\n\n<details>\n<summary>🔧 <strong>k8s_pod_logs</strong></summary>\n\n<p><strong>📋 Arguments:</strong> No arguments</p>\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n\`\`\`\`\n${RESULT}\n\`\`\`\`\n\n</details>\n\n</details>\n\n${LAST}`

// answers the chat request with STREAM and stores the turn as the server would; resolves once both are done
function answerWithStream(page: Page, path: RegExp) {
  let sessionId = ''
  let done!: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))
  const handler = async (route: Route) => {
    sessionId = /sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? ''
    const saved = await page.request.post(`/api/v1/sessions/${sessionId}/messages?cluster=self`, {
      headers: XRW, data: { messages: [{ role: 'user', content: route.request().postDataJSON().message }, { role: 'assistant', content: SAVED }] },
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

async function expectResultInItsBlock(page: Page, answer: Locator) {
  const code = answer.locator('pre code').filter({ hasText: 'line 1' })
  await expect(code).toHaveCount(1)
  expect(await code.textContent()).toBe(`${RESULT}\n`)
  await expect(page.locator(`[id="${MARK}-outside"]`)).toHaveCount(0)
  expect(await added(page)).toEqual(NOTHING_ADDED)
}

async function expectToolBlockOpens(answer: Locator) {
  const tool = answer.getByRole('button', { name: /🔧 k8s_pod_logs/ })
  await expect(tool).toHaveAttribute('aria-expanded', 'false')
  await tool.click()
  await expect(tool).toHaveAttribute('aria-expanded', 'true')
  const results = answer.getByRole('button', { name: /📊 Results/ })
  await results.click()
  await expect(results).toHaveAttribute('aria-expanded', 'true')
  await expect(answer.locator('pre code').filter({ hasText: 'line 2' })).toBeVisible()
}

async function expectLinksWork(page: Page, answer: Locator) {
  const docs = answer.getByRole('link', { name: 'the docs' })
  await expect(docs).toHaveAttribute('href', DOCS)
  await expect(docs).toHaveAttribute('target', '_blank')
  await expect(docs).toHaveAttribute('rel', 'noopener noreferrer')
  await answer.getByRole('link', { name: 'nginx-abc' }).click()
  await expect(page).toHaveURL(/detail=Pod(%2F|\/)default(%2F|\/)nginx-abc/)
}

test.describe('What a chat answer may draw', () => {
  test('AI Chat: what an answer writes stays in it, and the approval card stays whole and takes its clicks', async ({ page }) => {
    const title = `${MARK}-${Date.now().toString(36)}`
    const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
    expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
    const id = (await created.json()).id as string
    let approved = 0
    await page.route(new RegExp(`/api/v1/ai/tool-approvals/${APPROVAL.id}`), (route) => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { ...APPROVAL, session_id: id } })
      approved += 1
      return route.fulfill({ json: { ...APPROVAL, session_id: id, status: 'executed', result: 'scaled' } })
    })
    try {
      const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, {
        headers: XRW,
        data: {
          messages: [
            { role: 'user', content: 'scale web to 2' },
            { role: 'assistant', content: ANSWER, tool_calls: [{ approval_id: APPROVAL.id, function: APPROVAL.tool, args: APPROVAL.args, cluster: APPROVAL.cluster, approval_status: 'pending' }] },
          ],
        },
      })
      expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
      await page.goto('/ai-chat?cluster=self')
      await page.waitForLoadState('networkidle')
      await markPage(page)
      await page.getByText(title, { exact: true }).first().click()

      const bubble = page.locator(ASSISTANT).last()
      await expect(bubble).toContainText('After the elements.')
      // long enough for a refresh of 0 seconds to have happened
      await page.waitForTimeout(1500)
      expect(await added(page)).toEqual(NOTHING_ADDED)
      await expect(bubble).toContainText('Inside the form.')

      expect(await position(bubble.getByText('Written cover.'))).toBe('static')
      const link = bubble.getByRole('link', { name: 'Written link.' })
      expect(await position(link)).toBe('static')
      await expect(link).toHaveAttribute('target', '_blank')
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

      const card = bubble.getByTestId('tool-approval-card')
      await expect(card).toHaveAttribute('data-approval-status', 'pending')
      await expect(card.locator('pre')).toContainText('"replicas": 2')
      expect(await card.locator('pre').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible')
      const approve = card.getByRole('button', { name: /승인|approve/i })
      expect(await approve.evaluate((el) => getComputedStyle(el).display)).not.toBe('none')
      await approve.scrollIntoViewIfNeeded()
      const onTop = await approve.evaluate((button) => {
        const box = button.getBoundingClientRect()
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })
      expect(onTop).toBe(true)
      await approve.click()
      await expect(card).toHaveAttribute('data-approval-status', 'executed')
      expect(approved).toBe(1)
    } finally {
      await dropSession(page, id)
    }
  })

  test('AI Chat: a tool result with lines of backticks stays in its code block, while the answer comes and once saved', async ({ page }) => {
    await page.clock.install()
    const title = `${MARK}-${Date.now().toString(36)}`
    const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
    expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
    const id = (await created.json()).id as string
    const chat = answerWithStream(page, new RegExp(`/api/v1/ai/sessions/${id}/chat`))
    await chat.ready
    try {
      await page.goto('/ai-chat?cluster=self')
      await page.waitForLoadState('networkidle')
      await markPage(page)
      await page.getByText(title, { exact: true }).first().click()

      await page.clock.pauseAt(Date.now() + 1000)
      await page.getByTestId('chat-input').fill('show the logs')
      await page.getByRole('button', { name: /전송|send/i }).click()
      await chat.finished
      const coming = page.locator(ASSISTANT).last()
      await expect(coming.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toBeVisible()
      await expectResultInItsBlock(page, coming)

      await page.clock.resume()
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 15_000 })
      const saved = page.locator(ASSISTANT).last()
      await expect(saved).toContainText('All good')
      await expectResultInItsBlock(page, saved)
      expect(await position(saved.getByText('Written cover.'))).toBe('static')
      await expectToolBlockOpens(saved)
      await expectLinksWork(page, saved)
    } finally {
      await dropSession(page, id)
    }
  })

  test('the floating chat: a tool result with lines of backticks stays in its code block, while the answer comes and once saved', async ({ page }) => {
    await page.clock.install()
    const chat = answerWithStream(page, /\/api\/v1\/ai\/sessions\/[^/]+\/floating-chat/)
    await chat.ready
    try {
      await page.goto('/?cluster=self')
      await markPage(page)
      await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()

      await page.clock.pauseAt(Date.now() + 1000)
      await input.fill('show the logs')
      await input.press('Enter')
      await chat.finished
      const coming = page.getByTestId('floating-answer').last()
      await expect(coming.getByRole('button', { name: /🔧 k8s_pod_logs/ })).toBeVisible()
      await expectResultInItsBlock(page, coming)

      await page.clock.resume()
      const saved = page.getByTestId('floating-answer').last()
      await expect(saved.getByTestId('floating-copy')).toBeVisible({ timeout: 15_000 })
      await expect(saved).toContainText('All good')
      await expectResultInItsBlock(page, saved)
      expect(await position(saved.getByText('Written cover.'))).toBe('static')
      await expectToolBlockOpens(saved)
      await expectLinksWork(page, saved)
    } finally {
      await dropSession(page, chat.session())
    }
  })
})
