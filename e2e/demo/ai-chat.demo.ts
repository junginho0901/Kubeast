import { expect, test } from '@playwright/test'

import { XRW, beat, clip, demoUser } from './clip'

// The chat on the second cluster, asked about the shop's failing pods — by a user made for the clip, so the
// conversation list holds only this one.
test('ai-chat', async ({ page, playwright, baseURL }) => {
  const c = clip(page, 'ai-chat')
  await page.goto('/')
  const admin = await playwright.request.newContext({ baseURL, storageState: '.auth/user.json', extraHTTPHeaders: XRW })
  const sam = await demoUser(admin, 'Sam Park', 'sam@example.com', 'Write')
  try {
    await sam.signIn(page)
    await page.goto('/ai-chat?cluster=default')
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(/message/i)
    c.show()
    c.step('ask')
    await beat(page, 1000)
    await input.pressSequentially('Some pods in the shop namespace are not running. What is wrong?', { delay: 35 })
    await beat(page, 500)
    await page.getByRole('button', { name: /^send$/i }).click()
    await expect(input).toBeDisabled({ timeout: 10_000 })
    c.step('tools')
    // The answer's own text (tool blocks left out) has started.
    await page.waitForFunction(() => {
      const bubbles = document.querySelectorAll('div.flex.gap-3.p-6:not(.flex-row-reverse)')
      const last = bubbles[bubbles.length - 1]?.cloneNode(true) as HTMLElement | undefined
      last?.querySelectorAll('.md-details').forEach((d) => d.remove())
      return (last?.textContent ?? '').trim().length > 60
    }, undefined, { timeout: 180_000 })
    c.step('answer')
    await expect(input).toBeEnabled({ timeout: 180_000 })
    await beat(page, 4000)
    await c.save()
  } finally {
    await sam.done()
    await admin.dispose()
  }
})
