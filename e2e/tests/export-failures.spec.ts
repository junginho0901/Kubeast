import fs from 'node:fs'

import { test, expect, type Page } from '@playwright/test'

// The exports of the admin pages are files the page takes itself (hooks/useDownload, QA #34): while one comes its
// button says so, it is saved under the server's name, and a refusal says why under the header — the page stays,
// where a link left the refusal to the browser's download bar. The refusal is stood in on the export's address; the
// file afterwards is the server's own. Session recordings' .cast and text: session-recording.spec.ts.

type Export = { name: string; page: string; button: string; failed: string; address: (u: URL) => boolean; file: RegExp; ready?: (page: Page) => Promise<void> }

const EXPORTS: Export[] = [
  {
    name: 'Audit logs CSV', page: '/admin/audit', button: 'audit-export-csv', failed: 'audit-export-failed',
    address: (u) => u.pathname === '/api/v1/auth/admin/audit-logs/export', file: /^audit-logs-\d{8}-\d{6}\.csv$/,
  },
  {
    name: 'Access review CSV', page: '/admin/access-review', button: 'access-review-export', failed: 'access-review-export-failed',
    address: (u) => u.pathname === '/api/v1/auth/admin/access-review/export', file: /^access-review-[a-z_]+-.*\.csv$/,
    ready: async (page) => { await expect(page.getByTestId('access-review-export')).toBeEnabled({ timeout: 15_000 }) },
  },
  {
    name: 'Cluster hygiene JSON', page: '/cluster/hygiene?cluster=self', button: 'hygiene-export-json', failed: 'hygiene-export-failed',
    address: (u) => u.pathname === '/api/v1/cluster/hygiene' && u.searchParams.get('format') === 'json', file: /\.json$/,
    ready: async (page) => {
      const button = page.getByTestId('hygiene-export-json')
      if (!(await button.count())) test.skip(true, 'Cluster hygiene is off on this installation')
      await expect(button).toBeEnabled({ timeout: 30_000 })
    },
  },
]

for (const e of EXPORTS) {
  test(`${e.name}: a refusal says why on the page, the file comes under the server's name`, async ({ page }) => {
    await page.goto(e.page)
    await expect(page.getByTestId(e.button)).toBeVisible({ timeout: 15_000 })
    await e.ready?.(page)

    await page.route(e.address, (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: `e2e: ${e.name} is refused` }) }))
    const before = page.url()
    await page.getByTestId(e.button).click()
    await expect(page.getByTestId(e.failed)).toHaveText(`Not downloaded: e2e: ${e.name} is refused`)
    await page.waitForTimeout(1_500)
    expect(page.url(), 'the page stays').toBe(before)
    await expect(page.getByTestId(e.failed), 'the reason stays').toHaveText(`Not downloaded: e2e: ${e.name} is refused`)
    await page.unroute(e.address)

    // the server's answer, held back a moment: the button says it is coming, then the file is saved
    await page.route(e.address, async (r) => { await new Promise((ok) => setTimeout(ok, 1_500)); await r.continue() })
    const downloaded = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByTestId(e.button).click()
    await expect(page.getByTestId(e.button)).toContainText('Downloading...')
    const file = await downloaded
    expect(file.suggestedFilename()).toMatch(e.file)
    expect(fs.readFileSync((await file.path()) as string, 'utf8').length).toBeGreaterThan(0)
    await expect(page.getByTestId(e.failed), 'a download that worked clears the reason').toHaveCount(0)
    await expect(page.getByTestId(e.button)).not.toContainText('Downloading...')
    await page.unroute(e.address)
  })
}
