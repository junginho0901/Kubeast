import { expect, test } from '@playwright/test'

import { beat, clip, kubectl } from './clip'

// The assistant in the corner, opened over the crashing API's pod and asked what is wrong: it answers from what
// the screen shows.
test('floating-chat', async ({ page }) => {
  const pod = kubectl('kubeast-b', ['-n', 'shop', 'get', 'pod', '-l', 'app=checkout-api', '-o', 'jsonpath={.items[0].metadata.name}'])
  const c = clip(page, 'floating-chat')
  await page.goto(`/workloads/pods?cluster=default&detail=Pod/shop/${pod}`)
  await expect(page.locator('[class*="max-w-[740px]"]')).toContainText(pod, { timeout: 20_000 })
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('screen')
  await beat(page, 2500)
  await page.getByTestId('floating-chat-toggle').click()
  const panel = page.getByTestId('floating-chat-panel')
  const input = page.getByTestId('floating-chat-input')
  await expect(input).toBeVisible()
  c.step('ask')
  await beat(page, 1000)
  await input.pressSequentially('What is wrong with this pod?', { delay: 40 })
  await beat(page, 500)
  await input.press('Enter')
  const send = panel.getByRole('button', { name: 'Send' })
  await expect(send).toHaveCount(0, { timeout: 10_000 })
  // The answer's own text (tool blocks left out) has started.
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-testid="floating-chat-panel"]')?.cloneNode(true) as HTMLElement | undefined
    box?.querySelectorAll('.md-details, textarea, button').forEach((d) => d.remove())
    return (box?.textContent ?? '').includes('PAYMENT_GATEWAY_URL')
  }, undefined, { timeout: 180_000 })
  c.step('answer')
  await expect(send).toBeVisible({ timeout: 180_000 })
  await beat(page, 1500)
  // The list followed the answer to its end: back to its start, where the cause is, then down through it.
  const scrollTo = (where: 'top' | 'middle' | 'bottom') => panel.evaluate((el, at) => {
    const list = [...el.querySelectorAll<HTMLElement>('*')].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY))
    if (list) list.scrollTo({ top: at === 'top' ? 0 : at === 'middle' ? list.scrollHeight / 2 - list.clientHeight / 2 : list.scrollHeight, behavior: 'smooth' })
  }, where)
  await scrollTo('top')
  await beat(page, 4500)
  await scrollTo('middle')
  await beat(page, 3000)
  await scrollTo('bottom')
  await beat(page, 2500)
  await c.save()
})
