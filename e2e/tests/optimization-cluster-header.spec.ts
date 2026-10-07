import { test, expect } from '@playwright/test'

// The dashboard's optimization-suggestion stream carries X-Cluster-Name, so
// ai-service gathers its observations from the selected cluster rather than the
// default one. The stream is answered here — no LLM round-trip.
test('optimization suggestion stream carries the selected cluster', async ({ page }) => {
  let header: string | undefined
  await page.route('**/api/v1/ai/suggest-optimization/stream*', async (route) => {
    header = route.request().headers()['x-cluster-name']
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'event: done\ndata: {}\n\n',
    })
  })

  await page.goto('/?cluster=self')
  const open = page.getByRole('button', { name: /Optimization suggestions|최적화 제안/ }).first()
  await expect(open).toBeVisible({ timeout: 15000 })
  await open.click()

  // The button waits for the deterministic table, then streams the explanation.
  const explain = page.getByRole('button', { name: /^Explain with AI$|^AI 설명$/ })
  await expect(explain).toBeEnabled({ timeout: 20000 })
  await explain.click()

  await expect.poll(() => header, { timeout: 15000 }).toBe('self')
})
