import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Locator } from '@playwright/test'

// Codex QA Q10: a list opened from a picker stayed open on Escape. Escape closes the list and goes no further, so the
// window around it, which closes on Escape too (ModalOverlay), stays until the next one. On `self`.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))

// the open list is the box beside the picker's button, inside the same `relative` wrapper
const openList = (trigger: Locator) => trigger.locator('xpath=..').locator('div.absolute')

test.describe('Escape closes an open list', () => {
  test('ConfigMaps: the namespace list and the rows-per-page list', async ({ page }) => {
    await page.goto('/configuration/configmaps?cluster=self')
    const namespaces = page.locator('button').filter({ hasText: EN.configMapsPage.allNamespaces }).first()
    await namespaces.click()
    await expect(openList(namespaces).locator('button').filter({ hasText: /^kube-system$/ })).toHaveCount(1, { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(openList(namespaces)).toHaveCount(0)

    const rows = page.getByTestId('page-size-select')
    await rows.click()
    await expect(openList(rows).locator('button').filter({ hasText: /^100$/ })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(openList(rows)).toHaveCount(0)
    await expect(page).toHaveURL(/\/configuration\/configmaps/)
  })

  test('the Storage window: the first Escape closes its namespace list, the second the window', async ({ page }) => {
    await page.goto('/?cluster=self')
    await page.locator('button').filter({ hasText: /Storage analysis|스토리지 분석/ }).first().click()
    const title = page.locator('h2').filter({ hasText: /Storage analysis|스토리지 분석/ })
    await expect(title).toHaveCount(1, { timeout: 30_000 })
    const namespaces = page.getByTitle(EN.dashboard.storage.namespaceFilter, { exact: true })
    await namespaces.click()
    await expect(openList(namespaces)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(openList(namespaces)).toHaveCount(0)
    await expect(title).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(title).toHaveCount(0)
  })
})
