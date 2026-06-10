import { test, expect, type Page } from '@playwright/test'

// Multi-cluster AI tool routing (step 14).
//
// A chat tool call must run against the SELECTED cluster, not a fixed one. The
// chain: frontend sends X-Cluster-Name → ai-service threads it into every tool
// call → tool-server fetches THAT cluster's kubeconfig from k8s-service at
// runtime and runs kubectl against it.
//
// The cache-independent, user-facing signal is the chat RESULT. The two test
// clusters differ observably: the in-cluster 'self' IS this kind cluster, so its
// `kubeast` namespace holds our own pods (ai-service, tool-server, …); the
// external 'default' cluster has no such namespace. The exact same prompt must
// therefore yield cluster-specific answers — listing our pods on self, and not
// listing them on default. (LLM phrasing is non-deterministic; we assert only on
// the presence/absence of stable pod-name prefixes.)

const PLACEHOLDER_RE = /메시지|message/i
const SEND_RE = /^전송$|^send$/i
const ASSISTANT_MSG = 'div.flex.gap-3.p-6:not(.flex-row-reverse)'

// Stable name prefixes of pods that exist ONLY in this kind cluster's `kubeast`
// namespace — never in the external 'default' cluster.
const OUR_PODS = /ai-service|tool-server|k8s-service|auth-service|session-service/i

const LIST_PODS_QUERY = 'kubeast 네임스페이스에 있는 모든 파드의 이름을 나열해줘'

// Send one chat on a specific cluster and return the assistant's reply text.
// ?cluster= sets the cluster ref that clusterHeaders() reads, so the request
// carries X-Cluster-Name.
async function chatReply(page: Page, cluster: string): Promise<string> {
  await page.goto(`/ai-chat?cluster=${cluster}`)
  await page.waitForLoadState('networkidle')

  const input = page.getByPlaceholder(PLACEHOLDER_RE)
  await input.fill(LIST_PODS_QUERY)
  await page.getByRole('button', { name: SEND_RE }).click()

  // streaming begins (input disabled) then ends (re-enabled). A tool call makes
  // the round-trip longer than a plain reply, so allow a generous budget.
  await expect(input).toBeDisabled({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 120_000 })

  return (await page.locator(ASSISTANT_MSG).last().innerText()).trim()
}

// Whether the model issues a tool call (and actually lists names) is
// non-deterministic, so re-prompt a few times until the reply names our pods.
async function chatUntilListsOurPods(page: Page, cluster: string): Promise<string> {
  let reply = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    reply = await chatReply(page, cluster)
    if (OUR_PODS.test(reply)) return reply
  }
  return reply
}

test.describe('multi-cluster AI chat — tool routing (step 14)', () => {
  // Multiple LLM round-trips with retries — give the test room.
  test.setTimeout(15 * 60 * 1000)

  test('a pod-list chat reflects the SELECTED cluster', async ({ page }) => {
    // self IS this kind cluster → its kubeast namespace lists our own pods.
    const selfReply = await chatUntilListsOurPods(page, 'self')
    expect(
      selfReply,
      'self-cluster chat did not list this cluster\'s kubeast pods — tool call was not routed to self',
    ).toMatch(OUR_PODS)

    // Same prompt on the external default cluster, which has no kubeast pods.
    // If routing leaked to self, our pod names would appear here too.
    const defaultReply = await chatReply(page, 'default')
    expect(
      defaultReply,
      'default-cluster chat listed self-cluster pods — the tool call leaked to the wrong cluster',
    ).not.toMatch(OUR_PODS)
  })
})
