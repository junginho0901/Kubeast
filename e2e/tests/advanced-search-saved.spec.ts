import { test, expect, type Page } from '@playwright/test'

// Advanced Search's saved searches: save the current expression with its resource types and namespace, find it
// after a reload, load it back into the editor, rename it, delete it through the confirm window. Kept in the
// browser's localStorage under advanced-search-saved, which the test reads to compare with the screen.

const KEY = 'advanced-search-saved'
type Saved = { id: string; name: string; query: string; resources: string[]; namespace: string }

const stored = async (page: Page): Promise<Saved[]> => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY)) ?? '[]')
// Monaco draws spaces as no-break spaces
const editorText = (page: Page) => page.locator('.monaco-editor .view-lines').first().evaluate((el) => (el as HTMLElement).innerText.replace(/ /g, ' ').trim())

test.describe('Advanced Search saved searches', () => {
  test('save, find after a reload, load back, rename and delete', async ({ page }) => {
    await page.goto('/cluster/search')
    await page.evaluate((k) => localStorage.removeItem(k), KEY)
    await page.reload()
    await expect(page.getByTestId('saved-search-count')).toHaveText('0')
    await expect(page.getByTestId('saved-search-save')).toBeDisabled()

    // an example fills the editor and the resource types
    const example = page.locator('button').filter({ has: page.locator('code') }).first()
    const query = (await example.locator('code').innerText()).trim()
    await example.click()
    await expect.poll(() => editorText(page)).toBe(query)
    const resourcesBefore: string[] = JSON.parse((await page.evaluate(() => localStorage.getItem('advanced-search-resources'))) ?? '[]')

    await page.getByTestId('saved-search-save').click()
    await page.getByTestId('saved-search-name').fill('e2e saved one')
    await page.getByTestId('saved-search-confirm').click()
    await expect(page.getByTestId('saved-search-count')).toHaveText('1')
    const [saved] = await stored(page)
    expect(saved).toMatchObject({ name: 'e2e saved one', query, namespace: '' })
    expect([...saved.resources].sort()).toEqual([...resourcesBefore].sort())

    // a reload starts with an empty editor; the saved search brings the expression back
    await page.reload()
    await expect(page.getByTestId('saved-search-count')).toHaveText('1')
    await page.getByTestId('saved-search-toggle').click()
    await expect(page.getByTestId('saved-search-item')).toHaveCount(1)
    await page.getByTestId('saved-search-load').click()
    await expect.poll(() => editorText(page)).toBe(query)

    await page.getByTestId('saved-search-toggle').click()
    await page.getByTestId('saved-search-rename').click()
    await page.getByTestId('saved-search-name').fill('e2e renamed')
    await page.getByTestId('saved-search-confirm').click()
    expect((await stored(page)).map((s) => s.name)).toEqual(['e2e renamed'])

    await page.getByTestId('saved-search-toggle').click()
    await page.getByTestId('saved-search-delete').click()
    await page.getByTestId('confirm-dialog-ok').click()
    await expect(page.getByTestId('saved-search-count')).toHaveText('0')
    expect(await stored(page)).toEqual([])
  })
})
