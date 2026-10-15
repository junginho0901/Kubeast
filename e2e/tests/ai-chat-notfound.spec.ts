import { test, expect, type Page } from '@playwright/test'

// A pod that does not exist: the chat used to try the name in other namespaces and with other tools until
// it gave up. Now the first miss comes back as not_found with similar names and the prompt says to search
// once (k8s_find_resource) and then stop and ask — so the turn ends within a few tool calls and the reply
// says the object was not found rather than inventing one. The model is non-deterministic, so the checks
// are bounds, re-prompted once if the first reply names no tool call at all.

const PLACEHOLDER_RE = /메시지|message|질문|ask/i
const SEND_RE = /^전송$|^send$/i
const ASSISTANT_MSG = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'
const MISSING = 'zz-no-such-pod-zz'
const QUERY = `kubeast 네임스페이스의 ${MISSING} 파드 로그를 보여줘`
const NOT_FOUND_RE = /없|찾을 수|찾지 못|존재하지|not found|could not find|doesn't exist|does not exist|no pod/i

async function ask(page: Page): Promise<{ reply: string; toolCalls: number }> {
  await page.goto('/ai-chat?cluster=self')
  await page.waitForLoadState('networkidle')
  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(QUERY)
  await page.getByRole('button', { name: SEND_RE }).click()
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
    let result = await ask(page)
    if (result.toolCalls === 0) result = await ask(page)
    expect(result.toolCalls, `tool calls: ${result.toolCalls}\n${result.reply}`).toBeGreaterThan(0)
    // The old behaviour ran up to the 10-call cap; one miss plus one find plus at most two follow-ups is the new ceiling.
    expect(result.toolCalls, `the chat kept searching:\n${result.reply}`).toBeLessThanOrEqual(4)
    expect(result.reply, 'the reply must say the pod was not found').toMatch(NOT_FOUND_RE)
    expect(result.reply).not.toMatch(/최대 반복 횟수/)
  })
})
