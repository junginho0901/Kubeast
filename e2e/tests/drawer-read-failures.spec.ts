import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A drawer whose own read (describe) failed says so where its fields would be, with the server's reason, instead of a
// fixed sentence ("Failed to load describe data", "Some detailed fields are unavailable"), "No data" or a value it
// never read: a Role's Rules Count is "—", not 0. Every describe read is answered 503 in the browser with a reason of
// its own, so nothing on the cluster changes; the objects are ones a kind dev cluster always has on `self`.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the API server did not answer'
const SAID = EN.common.describeFailed.replace('{{reason}}', REASON)
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const DRAWERS: { what: string; detail: string; notShown?: string }[] = [
  { what: 'Role', detail: 'Role/kube-system/extension-apiserver-authentication-reader' },
  { what: 'ClusterRole', detail: 'ClusterRole/view' },
  { what: 'HorizontalPodAutoscaler', detail: 'HorizontalPodAutoscaler/default/e2e-fixture', notShown: 'No data' },
  { what: 'Deployment', detail: 'Deployment/kube-system/coredns', notShown: 'Some detailed fields are unavailable right now.' },
  { what: 'Service', detail: 'Service/default/kubernetes', notShown: 'Failed to load describe data. Showing summary from list.' },
  { what: 'StorageClass', detail: 'StorageClass/standard', notShown: 'Some detailed StorageClass fields are unavailable right now.' },
  { what: 'Node', detail: 'Node/kubeast-control-plane', notShown: 'Failed to load node details.' },
  { what: 'Namespace', detail: 'Namespace/default', notShown: 'Failed to load.' },
]

test.describe("a drawer whose own read failed says why", () => {
  for (const d of DRAWERS) {
    test(`${d.what}: the reason where its fields would be`, async ({ page }) => {
      await page.route((u) => u.pathname.startsWith('/api/v1/cluster/') && u.pathname.endsWith('/describe'), (route) =>
        route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { detail: REASON } }) : route.fallback())
      await page.goto(`/?cluster=self&detail=${encodeURIComponent(d.detail)}`)
      const drawer = page.locator(DRAWER).last()
      const line = drawer.getByTestId('describe-failed')
      await expect(line).toContainText(SAID, { timeout: 30_000 })
      await expect(line).toHaveAttribute('role', 'alert')
      if (d.notShown) await expect(drawer.getByText(d.notShown, { exact: true }), 'the fixed sentence is gone').toHaveCount(0)
      if (d.what === 'Role' || d.what === 'ClusterRole') {
        const count = drawer.getByText('Rules Count', { exact: true }).locator('xpath=..')
        await expect(count, 'rules not read are not 0 rules').toContainText('—')
        await expect(count).not.toContainText(/\b0\b/)
      }
    })
  }
})
