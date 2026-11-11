import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test, expect } from '@playwright/test'

// Helm Releases page — streams release updates over a long-lived SSE
// connection (helm/releases/stream). Since step 04b made that stream
// cluster-aware and actually long-lived, the page never reaches
// 'networkidle' — wait on DOM mount + the heading instead (same pattern as
// sse-migration.spec.ts). Captures the list view and holds the detail of this
// install's own release to Helm's record.

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-helm-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
}
const kubectl = kubectlFor('kubeast')

test.describe('Helm Releases', () => {
  test('list — initial render', async ({ page }) => {
    await page.goto('/helm/releases')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1.text-3xl').first()).toContainText(/helm/i)

    await expect(page).toHaveScreenshot('helm-releases-list.png', {
      fullPage: true,
      animations: 'disabled',
    })
  })

  // The release is this install itself (kubeast in namespace kubeast on cluster self): the line under its name is the
  // chart, its version and the revision of the release Helm has deployed, read from Helm's own record (the release
  // Secret, base64 of gzipped JSON)
  test('detail — the kubeast release says the chart and revision Helm deployed', async ({ page }) => {
    const detail = await page.request.get('/api/v1/helm/releases/kubeast/kubeast?cluster=self', { failOnStatusCode: false })
    test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
    const deployed = JSON.parse(kubectl('-n kubeast get secrets -l owner=helm,name=kubeast,status=deployed -o json')).items
    expect(deployed, 'one deployed revision').toHaveLength(1)
    const release = JSON.parse(zlib.gunzipSync(Buffer.from(Buffer.from(deployed[0].data.release, 'base64').toString(), 'base64')).toString())
    await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
    const title = page.locator('h1.text-3xl').first()
    await expect(title).toHaveText('kubeast', { timeout: 30_000 })
    await expect(title.locator('xpath=following-sibling::p[1]'))
      .toHaveText(`kubeast · ${release.chart.metadata.name}@${release.chart.metadata.version} · rev ${release.version}`)
  })

  // The release is this install itself (kubeast in namespace kubeast on cluster self) and the failure is the browser's
  // own answer: no test pod runs.
  test('a failed test run shows the reason, not that the chart has no hooks', async ({ page }) => {
    const detail = await page.request.get('/api/v1/helm/releases/kubeast/kubeast?cluster=self', { failOnStatusCode: false })
    test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
    await page.route('**/api/v1/helm/releases/kubeast/kubeast/test*', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'pod kubeast-test failed' }),
    }))
    await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
    await page.getByRole('button', { name: /^(run tests|테스트 실행)$/i }).click()
    await expect(page.getByText('pod kubeast-test failed')).toHaveText('pod kubeast-test failed')
    await expect(page.getByText(/This chart defines no test hooks|test hook 이 정의되어 있지 않습니다/)).toHaveCount(0)
  })
})
