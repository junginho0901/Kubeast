import { test, expect } from '@playwright/test'

// With the UI in Korean, a resource drawer's Info tab shows descriptive labels in
// Korean while Kubernetes field names stay English (the detail label catalog).
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

test.describe('drawer labels in Korean', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('i18nextLng', 'ko') } catch { /* private mode */ }
    })
  })

  test('role drawer: Korean descriptive labels, English field names', async ({ page }) => {
    // Roles: every cluster has kube-system roles, and the drawer's Basic Info
    // lists Name / Namespace / Created next to UID / Resource Version.
    await page.goto('/security/roles?cluster=self')
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 20000 })
    await firstRow.click()

    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toBeVisible({ timeout: 15000 })
    await drawer.getByRole('button', { name: /^(정보|Info)$/ }).first().click().catch(() => {})

    // descriptive labels → Korean (a Kubernetes kind such as Namespace stays English)
    await expect(drawer.getByText('이름', { exact: true }).first()).toBeVisible()
    await expect(drawer.getByText('Namespace', { exact: true }).first()).toBeVisible()
    await expect(drawer.getByText('생성 시각', { exact: true }).first()).toBeVisible()
    // Kubernetes field names → still English
    await expect(drawer.getByText('UID', { exact: true }).first()).toBeVisible()
    await expect(drawer.getByText('Resource Version', { exact: true }).first()).toBeVisible()
    await expect(drawer.getByText('Created', { exact: true })).toHaveCount(0)
  })

  test('node drawer: section titles with a count, sub-section table heads and placeholders in Korean', async ({ page }) => {
    await page.goto('/cluster/nodes?cluster=self')
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 20000 })
    await firstRow.click()

    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toBeVisible({ timeout: 15000 })
    await drawer.getByRole('button', { name: /^(정보|Info)$/ }).first().click().catch(() => {})

    // "Images ({{n}})": one catalog key whatever the count
    await expect(drawer.getByText(/^이미지 \(\d+\)$/).first()).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByText(/^Images \(\d+\)$/)).toHaveCount(0)
    // capacity table head and the pods list (node-info/) through the same catalog
    await expect(drawer.locator('th', { hasText: /^용량$/ }).first()).toBeVisible()
    await expect(drawer.locator('th', { hasText: /^재시작$/ }).first()).toBeVisible()
    await expect(drawer.getByPlaceholder('필터...')).toBeVisible()
  })
})
