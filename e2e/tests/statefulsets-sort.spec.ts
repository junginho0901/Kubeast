import { test, expect } from '@playwright/test'
import * as path from 'path'

const STORAGE_STATE = path.resolve(__dirname, '../.auth/user.json')
test.use({ storageState: STORAGE_STATE })

test('StatefulSets sort columns work', async ({ page }) => {
  await page.goto('/workloads/statefulsets')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)

  const sortable = page.locator('table thead th.cursor-pointer')
  const count = await sortable.count()
  console.log(`sortable headers: ${count}`)
  expect(count).toBeGreaterThan(0)

  for (let i = 0; i < count; i++) {
    const h = sortable.nth(i)
    const text = (await h.innerText()).trim().slice(0, 20)
    await h.click()
    await page.waitForTimeout(200)
    const iconCount = await h.locator('svg').count()
    console.log(`  [${i}] ${text}: icon=${iconCount}`)
    expect(iconCount, `${text} icon after click`).toBeGreaterThan(0)
  }
})
