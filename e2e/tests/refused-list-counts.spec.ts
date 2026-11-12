import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Codex QA Q09 and Q11 on ConfigMaps: a namespace the cluster refuses shows the refusal and cards of "-" (a list not
// read counts nothing), and choosing a namespace the page may read takes the refusal away and the cards count that
// list. The refusal is the browser's own answer for one made-up namespace — the 403 a grant limited to other
// namespaces gets — and the rest is `self` as the admin reads it.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REFUSED = 'e2e-refused-namespace'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-refused-counts-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const k = kubectlFor('kubeast')

// the value under a summary card's label
const card = (page: Page, label: string) =>
  page.locator('div.grid p').filter({ hasText: new RegExp(`^${label}$`) }).first().locator('xpath=following-sibling::p[1]')

test('a refused namespace shows "-" cards and the refusal; one the page reads, its counts and no refusal', async ({ page }) => {
  await page.route(`**/api/v1/cluster/namespaces/${REFUSED}/configmaps**`, (route) => route.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'configmaps is forbidden' }),
  }))
  await page.goto(`/configuration/configmaps?cluster=self&namespace=${REFUSED}`)
  const banner = page.getByTestId('forbidden-banner')
  await expect(banner).toContainText('ConfigMap', { timeout: 30_000 })
  await expect(card(page, EN.configMapsPage.stats.total)).toHaveText('-')
  await expect(card(page, EN.configMapsPage.stats.totalKeys)).toHaveText('-')

  const count = k('-n kube-system get configmaps -o name').split('\n').filter(Boolean).length
  await page.locator('button').filter({ hasText: REFUSED }).first().click()
  await page.locator('button').filter({ hasText: /^kube-system$/ }).first().click()
  await expect(page).toHaveURL(/namespace=kube-system/)
  await expect(card(page, EN.configMapsPage.stats.total)).toHaveText(String(count), { timeout: 30_000 })
  await expect(card(page, EN.configMapsPage.stats.totalKeys)).toHaveText(/^\d+$/)
  await expect(banner).toHaveCount(0)
})
