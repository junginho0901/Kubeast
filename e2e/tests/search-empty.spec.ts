import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A search that keeps none of the rows says "No results found." — the shared text — not what a list with nothing in
// it says: Helm releases' "No Helm releases" with its install and kubeconfig hint, the Issues window's green
// "No issues detected", Access Review's "Nothing to show.". On `self`, which has the dev install's own release, the
// fixtures' broken objects as issues and the admin account in the review.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const NONE = 'zz-e2e-no-such-thing'
const NO_RESULTS = EN.common.noSearchResults

test.describe('a search that finds nothing says so', () => {
  test('Helm releases: No results found, not "No Helm releases"', async ({ page }) => {
    await page.goto('/helm/releases?cluster=self')
    await expect(page.locator('tbody:not([aria-hidden="true"]) tr').first()).toContainText('kubeast', { timeout: 30_000 })
    await page.getByPlaceholder(EN.helmReleases.searchPlaceholder).fill(NONE)
    await expect(page.getByTestId('helm-no-search-results')).toHaveText(NO_RESULTS)
    await expect(page.getByText(EN.helmReleases.empty.title, { exact: true })).toHaveCount(0)
  })

  test('Dashboard → Issues: No results found with a way back, not a green "No issues detected"', async ({ page }) => {
    await page.goto('/?cluster=self')
    await page.locator('button').filter({ hasText: /Check issues|이슈 확인/ }).first().click()
    const total = page.getByTestId('issues-total')
    await expect(total).toHaveText(/^[1-9]\d*$/, { timeout: 30_000 })
    const search = page.getByPlaceholder(/Search issues|이슈 검색/)
    await search.fill(NONE)
    const none = page.getByTestId('issues-no-search-results')
    await expect(none).toContainText(NO_RESULTS)
    await expect(page.getByText(EN.dashboard.issues.none, { exact: true })).toHaveCount(0)
    await none.getByRole('button', { name: EN.common.clearSearch }).click()
    await expect(search).toHaveValue('')
    await expect(none).toHaveCount(0)
  })

  test('Access Review: No results found, not "Nothing to show."', async ({ page }) => {
    await page.goto('/admin/access-review')
    await expect(page.getByTestId('access-review-row').first()).toBeVisible({ timeout: 30_000 })
    await page.getByPlaceholder(EN.accessReview.search).fill(NONE)
    await expect(page.locator('tbody:not([aria-hidden="true"]) td').first()).toHaveText(NO_RESULTS)
    await expect(page.getByText(EN.accessReview.empty, { exact: true })).toHaveCount(0)
  })
})
