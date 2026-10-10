import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Dates and pages from the 2026-10 re-QA (PR-9b): ages read as kubectl prints AGE, absolute times as
// YYYY-MM-DD HH:mm:ss with the UTC value on hover, date fields typed as YYYY-MM-DD and checked, the rows-per-page
// choice kept for every list, and a CronJob's next run. Runs against `self` (fixtures.yaml: the e2e-fixture
// CronJob and StatefulSet).

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dates-pages-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

async function columnIndex(page: Page, header: RegExp): Promise<number> {
  const headers = (await page.locator('main thead th').allInnerTexts()).map((s) => s.trim())
  const i = headers.findIndex((h) => header.test(h))
  expect(i, `column ${header} in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0)
  return i
}

test.describe('Dates and pages', () => {
  test('a list age is what kubectl prints as AGE', async ({ page }) => {
    const pod = 'e2e-fixture-0'
    test.skip(!kubectl(`-n default get pod ${pod} -o name --ignore-not-found`), 'fixture pod e2e-fixture-0 missing')
    const ageColumn = (when: string) => kubectl(`-n default get pod ${pod} --no-headers`).split(/\s+/).pop() + when
    const before = ageColumn('')
    await page.goto('/workloads/pods?cluster=self')
    await page.getByPlaceholder(/search|검색/i).first().fill(pod)
    const row = page.locator('main tbody tr').filter({ hasText: pod }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const cells = (await row.locator('td').allInnerTexts()).map((s) => s.trim())
    const shown = cells[await columnIndex(page, /^(Age|경과 시간)$/)]
    const after = ageColumn('')
    // read between two kubectl calls: equal to one of them (a unit boundary can fall in between)
    expect([before, after]).toContain(shown)
  })

  test('an absolute time is local YYYY-MM-DD HH:mm:ss with the UTC value on hover', async ({ page }) => {
    await page.goto('/admin/audit')
    const cell = page.locator('main tbody tr td').first()
    await expect(cell).toHaveText(LOCAL_TIME, { timeout: 15_000 })
    expect(await cell.getAttribute('title')).toMatch(UTC_TIME)
  })

  test('date fields are typed as YYYY-MM-DD and a wrong one is not applied', async ({ page }) => {
    await page.goto('/admin/ai-usage')
    const since = page.getByTestId('ai-usage-since')
    await expect(since).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
    await since.fill('2026-02-31')
    await expect(since).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText(/YYYY-MM-DD/).last()).toBeVisible()
    await since.fill('2026-01-01')
    await expect(since).not.toHaveAttribute('aria-invalid', 'true')

    await page.goto('/admin/audit')
    const auditSince = page.getByTestId('audit-filter-since')
    await auditSince.fill('2026-10-01')
    await expect(page.getByRole('button', { name: /^(조회|Search|Apply)$/ })).toBeDisabled()
    await auditSince.fill('2026-10-01 09:30')
    await expect(page.getByRole('button', { name: /^(조회|Search|Apply)$/ })).toBeEnabled()
  })

  test('the rows-per-page choice is kept for every list', async ({ page }) => {
    try {
      await page.goto('/workloads/replicasets?cluster=self')
      const rows = page.locator('main tbody').first().locator('tr')
      await expect(rows.first()).toBeVisible({ timeout: 15_000 })
      await page.getByTestId('page-size-select').click()
      await page.getByRole('button', { name: /^25$/ }).click()
      const total = Number(kubectl('get replicasets -A --no-headers | wc -l'))
      await expect(rows).toHaveCount(Math.min(25, total))
      // another list, after a reload: the same choice
      await page.goto('/workloads/pods?cluster=self')
      await expect(page.getByTestId('page-size-select')).toContainText('25')
    } finally {
      await page.evaluate(() => localStorage.removeItem('kubeast.listPageSize'))
    }
  })

  test('a CronJob shows its next run in the zone it is read in, none while suspended', async ({ page }) => {
    // 0 3 * * * in Asia/Seoul (UTC+9) is 18:00 UTC, whatever zone the browser runs in
    const name = `e2e-next-run-${Date.now().toString(36)}`
    kubectl(`-n default create cronjob ${name} --image=busybox:1.36 --schedule="0 3 * * *" -- /bin/true`)
    try {
      kubectl(`-n default patch cronjob ${name} --type=merge -p '{"spec":{"timeZone":"Asia/Seoul"}}'`)
      await page.goto('/workloads/cronjobs?cluster=self')
      await page.getByPlaceholder(/search|검색/i).first().fill(name)
      const row = page.locator('main tbody tr').filter({ hasText: name }).first()
      await expect(row).toBeVisible({ timeout: 15_000 })
      const nextColumn = await columnIndex(page, /^(Next Run|다음 실행)$/)
      const next = row.locator('td').nth(nextColumn)
      await expect(next).toHaveText(LOCAL_TIME)
      await expect(next).toHaveAttribute('title', /^UTC \d{4}-\d{2}-\d{2}T18:00:00Z · Asia\/Seoul$/)

      await row.click()
      await expect(page.getByText(/^(Next Run|다음 실행)$/)).toBeVisible({ timeout: 15_000 })
      await expect(page.getByText('Asia/Seoul', { exact: true })).toBeVisible()
    } finally {
      kubectl(`-n default delete cronjob ${name} --ignore-not-found`)
    }

    // the fixture CronJob is suspended: no next run, the tooltip says why
    test.skip(!kubectl('-n default get cronjob e2e-fixture -o name --ignore-not-found'), 'fixture CronJob e2e-fixture missing')
    await page.goto('/workloads/cronjobs?cluster=self')
    await page.getByPlaceholder(/search|검색/i).first().fill('e2e-fixture')
    const fixture = page.locator('main tbody tr').filter({ hasText: 'e2e-fixture' }).first()
    const fixtureNext = fixture.locator('td').nth(await columnIndex(page, /^(Next Run|다음 실행)$/))
    await expect(fixtureNext).toHaveText('-')
    await expect(fixtureNext).toHaveAttribute('title', /Suspended|중지됨/)
  })
})
