import { test, expect, type Page } from '@playwright/test'

// A pod that does not exist: the chat used to try the name in other namespaces and with other tools until
// it gave up. Now the first miss comes back as not_found with similar names and the prompt says to search
// once (k8s_find_resource) and then stop and ask — so the turn ends within a few tool calls and the reply
// says the object was not found rather than inventing one. The model is non-deterministic, so the checks
// are bounds, re-prompted once if the first reply names no tool call at all.

const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /^전송$|^send$/i
const ASSISTANT_MSG = '[data-testid="chat-message"][data-message-role="assistant"]'
const MISSING = 'zz-no-such-pod-zz'
const QUERY = `kubeast 네임스페이스의 ${MISSING} 파드 로그를 보여줘`
const NOT_FOUND_RE = /없|찾을 수|찾지 못|존재하지|not found|could not find|doesn't exist|does not exist|no pod/i

// The chat screen makes a conversation for the first question on a page just opened, one per ask; they are removed
// after the test, passed or not.
const conversationMade = (page: Page) =>
  page.waitForResponse((r) => /\/api\/v1\/sessions(\?|$)/.test(r.url()) && r.request().method() === 'POST', { timeout: 15_000 })
async function deleteConversations(page: Page, ids: string[]) {
  for (const id of ids) await page.request.delete(`/api/v1/sessions/${id}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false })
}

async function ask(page: Page, made: string[]): Promise<{ reply: string; toolCalls: number }> {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(QUERY)
  const created = conversationMade(page)
  await page.getByRole('button', { name: SEND_RE }).click()
  made.push((await (await created).json()).id as string)
  await expect(input).toBeDisabled({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 180_000 })
  const last = page.locator(ASSISTANT_MSG).last()
  const reply = (await last.innerText()).trim()
  // Every tool call the turn made is rendered as an "📋 Arguments" disclosure in the saved message.
  const toolCalls = (reply.match(/Arguments/g) ?? []).length
  return { reply, toolCalls }
}

test.describe('AI chat on a pod that does not exist', () => {
  test.setTimeout(8 * 60 * 1000)

  test('stops after a few tool calls and says the pod was not found', async ({ page }) => {
    const made = withUndo<string[]>([], (ids) => deleteConversations(page, ids))
    try {
      let result = await ask(page, made)
      if (result.toolCalls === 0) result = await ask(page, made)
      expect(result.toolCalls, `tool calls: ${result.toolCalls}\n${result.reply}`).toBeGreaterThan(0)
      // The old behaviour ran up to the 10-call cap; one miss plus one find plus at most two follow-ups is the new ceiling.
      expect(result.toolCalls, `the chat kept searching:\n${result.reply}`).toBeLessThanOrEqual(4)
      expect(result.reply, 'the reply must say the pod was not found').toMatch(NOT_FOUND_RE)
      // the chat's own sentences when its last model call wrote nothing either (app/services/ai/chat_steps.py)
      expect(result.reply).not.toMatch(/쓸 수 있는 호출을 모두 쓰고도|used all the calls one answer may make|답 최대 길이에 닿았습니다|reached its answer length|콘텐츠 필터가 답이|content filter stopped the answer|Claude Code가 바쁘거나|Claude Code was busy or did not start/)
    } finally {
      await deleteConversations(page, made)
    }
  })
})

// After a test that did not pass, the undos it registered with withUndo run as well: a test that times out has its
// request context and browser ended before its own finally runs, if it runs at all. Each undo is safe to run twice.
const undos: (() => unknown)[] = []
function withUndo<T>(value: T, undo: (value: T) => unknown): T {
  undos.push(() => undo(value))
  return value
}
test.afterEach(async ({}, testInfo) => {
  const registered = undos.splice(0).reverse()
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
  for (const undo of registered) await (async () => undo())().catch(() => undefined)
})
