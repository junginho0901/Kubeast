import { test, expect } from '@playwright/test'

// Two small layout fixes: the AI chat conversation list's cards are as high as their title and message count, with
// even padding and a 4 px gap (they kept a fixed 76 px slot with 12 px left under the text), and the AI model form's
// half-width model field shows the whole model name — a note such as "recommended" stays in the open list.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }

test.describe('Chat list and model field', () => {
  test('conversation cards fit their text with even padding and a 4 px gap', async ({ page }) => {
    const ids: string[] = []
    const titles: string[] = []
    try {
      for (const n of [1, 2]) {
        const title = `e2e-card-${n}-${Date.now().toString(36)}`
        const res = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
        ids.push((await res.json()).id)
        titles.push(title)
      }
      await page.goto('/ai-chat?cluster=self')
      // the two newest conversations, next to each other at the top of the list
      const cards = titles.map((title) => page.locator('div.group.relative.rounded-lg.cursor-pointer').filter({ hasText: title }))
      for (const card of cards) await expect(card).toBeVisible()
      const box = (card: typeof cards[number]) => card.evaluate((c) => {
        const r = c.getBoundingClientRect()
        const text = c.querySelector('.flex-1.min-w-0')!.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height, padTop: text.top - r.top, padBottom: r.bottom - text.bottom }
      })
      const [newer, older] = [await box(cards[1]), await box(cards[0])]
      expect([Math.round(newer.height), Math.round(older.height)]).toEqual([64, 64])
      expect(Math.round(older.top - newer.bottom)).toBe(4)
      expect(Math.abs(newer.padTop - newer.padBottom)).toBeLessThanOrEqual(1)
    } finally {
      for (const id of ids) await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW, failOnStatusCode: false })
    }
  })

  test('the model field shows the whole name; the note is in the open list', async ({ page }) => {
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: /Add Model|모델 추가/ }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-claude-code').click()
    const field = page.getByTestId('model-select')
    await expect(field).toHaveText(/^Claude Sonnet 5\.5$/)
    const label = field.locator('span.truncate').last()
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true) // not cut
    await field.click()
    const withNote = page.getByTestId('model-option-claude-sonnet-5-5')
    await expect(withNote).toContainText('recommended')
    // one line each: the entry with a note is as high as the one without
    const height = (testId: string) => page.getByTestId(testId).evaluate((el) => Math.round(el.getBoundingClientRect().height))
    expect(await height('model-option-claude-sonnet-5-5')).toBe(await height('model-option-claude-opus-5-5'))
  })
})
