import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Usability and routes from the 2026-10 re-QA (PR-9c): old routes open the current screens, the sidebar groups by
// scope, Resource Graph opens on a namespace, a list keeps its footer and says why it is empty, the open drawer is
// in the URL, and the small fixes on User Management, Change History, Helm history, the PV drawer, the YAML status
// line and the Audit target column. Runs against `self` (the kind cluster itself).

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-usability-routes-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

async function search(page: Page, text: string) {
  await page.getByPlaceholder(/search|검색/i).first().fill(text)
}

test.describe('Usability and routes', () => {
  test('old routes open the current screens', async ({ page }) => {
    await page.goto('/namespaces')
    await expect(page).toHaveURL(/\/cluster\/namespaces$/)
    await expect(page.locator('nav a[href="/cluster/namespaces"]')).toHaveClass(/bg-primary-600/)
    await page.goto('/resources/default')
    await expect(page).toHaveURL(/\/workloads\/pods$/)
    await page.goto('/network/default')
    await expect(page).toHaveURL(/\/network\/services$/)
    await page.goto('/topology/default')
    await expect(page).toHaveURL(/\/cluster\/resource-graph\?namespace=default$/)
  })

  test('the sidebar groups by scope', async ({ page }) => {
    await page.goto('/')
    const groupOf = (href: string) => page.locator(`nav a[href="${href}"]`).evaluate((a) =>
      a.closest('div.space-y-0\\.5')?.querySelector(':scope > button')?.textContent?.trim().toLowerCase())
    for (const href of ['/cluster/resourcequotas', '/cluster/limitranges', '/cluster/leases']) expect(await groupOf(href)).toBe('configuration')
    for (const href of ['/cluster/priorityclasses', '/cluster/runtimeclasses', '/cluster/mutatingwebhookconfigurations']) expect(await groupOf(href)).toBe('cluster')
    expect(await groupOf('/cluster/search')).toBe('core')
  })

  test('Resource Graph opens on a namespace instead of an empty screen', async ({ page }) => {
    await page.goto('/cluster/resource-graph?cluster=self')
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Select a namespace from the dropdown|드롭다운에서 Namespace를 선택하세요/)).toHaveCount(0)
  })

  test('a list keeps its footer with no rows and says why it is empty', async ({ page }) => {
    await page.goto('/configuration/configmaps?cluster=self')
    const pager = page.getByTestId('list-pager')
    await expect(pager).toContainText(/Showing 1-|개 중 1-/, { timeout: 15_000 })
    await search(page, 'zz-no-such-configmap-9c')
    await expect(page.locator('main tbody td').first()).toHaveText(/No results found\.|검색 결과가 없습니다\./)
    await expect(pager).toContainText(/Showing 0 of 0|0개 중 0 표시/)
  })

  test('the open drawer is in the URL: a reload opens it again, closing removes it', async ({ page }) => {
    await page.goto('/configuration/configmaps?cluster=self')
    await search(page, 'kube-root-ca.crt')
    await page.getByRole('cell', { name: 'kube-root-ca.crt', exact: true }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText('kube-root-ca.crt', { timeout: 15_000 })
    await expect(page).toHaveURL(/[?&]detail=ConfigMap%2F[^&%]+%2Fkube-root-ca\.crt/)
    await page.reload()
    await expect(page.locator(DRAWER).last()).toContainText('kube-root-ca.crt', { timeout: 15_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator(DRAWER)).toHaveCount(0)
    expect(page.url()).not.toContain('detail=')
    expect(page.url()).toContain('cluster=self')
  })

  test('a shared drawer link opens it; a PV node affinity reads as kubectl describe prints it', async ({ page }) => {
    const pv = kubectl(`get pv -o jsonpath='{range .items[?(@.spec.nodeAffinity)]}{.metadata.name}{"\\n"}{end}'`).split('\n')[0]
    test.skip(!pv, 'no PersistentVolume with a node affinity on self')
    await page.goto(`/storage?tab=pvs&cluster=self&detail=PersistentVolume/${pv}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText(pv, { timeout: 15_000 })
    await expect(drawer).toContainText(/Term 0: kubernetes\.io\/hostname in \[/)
  })

  test('an Idle workload is neutral, not a warning', async ({ page }) => {
    const idle = kubectl(`get rs -A --no-headers`).split('\n').map((l) => l.split(/\s+/)).find((c) => c[2] === '0')
    test.skip(!idle, 'no ReplicaSet scaled to zero on self')
    await page.goto('/workloads/replicasets?cluster=self')
    await search(page, idle![1])
    const badge = page.locator('main tbody tr').filter({ hasText: idle![1] }).first().locator('.badge')
    await expect(badge).toHaveText(/^(Idle|유휴)$/, { timeout: 15_000 })
    await expect(badge).toHaveClass(/badge-neutral/)
  })

  test('User Management: search, a footer, and the own account without a delete button', async ({ page }) => {
    await page.goto('/admin/users')
    await expect(page.getByTestId('admin-users-pager')).toBeVisible({ timeout: 15_000 })
    const self = page.getByTestId('admin-users-self')
    await expect(self).toHaveCount(1)
    expect(await self.getAttribute('title')).toMatch(/own account|자기 자신/)
    await page.getByTestId('admin-users-search').fill('zz-nobody-9c')
    await expect(page.locator('main tbody td').first()).toHaveText(/No results found\.|검색 결과가 없습니다\./)
  })

  test('Change History counts what it lists: events and rollouts', async ({ page }) => {
    await page.goto('/timeline?cluster=self')
    const count = page.getByTestId('timeline-count')
    await expect(count).toBeVisible({ timeout: 20_000 })
    const [rows, events, rollouts] = ((await count.innerText()).match(/\d+/g) ?? []).map(Number)
    expect(rows).toBe(events + rollouts)
  })

  test('Helm history lists the newest revision first', async ({ page }) => {
    await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
    await page.getByRole('button', { name: /^(History|이력)$/ }).first().click()
    const first = page.locator('main table tbody tr td:first-child')
    await expect(first.nth(1)).toBeVisible({ timeout: 15_000 })
    const revisions = (await first.allInnerTexts()).map((s) => Number(s.replace(/\D/g, '')))
    expect(revisions).toEqual([...revisions].sort((a, b) => b - a))
  })

  test('the YAML status line says read-only until Edit', async ({ page }) => {
    await page.goto('/configuration/configmaps?cluster=self')
    await search(page, 'kube-root-ca.crt')
    await page.getByRole('cell', { name: 'kube-root-ca.crt', exact: true }).first().click()
    const drawer = page.locator(DRAWER).last()
    await drawer.getByRole('button', { name: /^YAML$/ }).first().click()
    const status = drawer.locator('p').filter({ hasText: /^(Read-only|읽기 전용|Edit YAML|YAML 편집)$/ })
    await expect(status).toHaveText(/^(Read-only|읽기 전용)$/, { timeout: 15_000 })
    await drawer.getByRole('button', { name: /^(Edit|편집)$/ }).first().click()
    await expect(status).toHaveText(/^(Edit YAML|YAML 편집)$/)
    await drawer.getByRole('button', { name: /^(Cancel|취소)$/ }).first().click()
  })

  test('the Audit target column names the kind with a bare ID', async ({ page }) => {
    await page.goto('/admin/audit')
    await page.getByPlaceholder('k8s.pod.delete').fill('admin.roles.create')
    await page.getByRole('button', { name: /^(Search|조회)$/ }).first().click()
    const firstRow = page.locator('main tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 15_000 })
    test.skip((await page.locator('main tbody tr').count()) < 1 || /No results|검색 결과/.test(await firstRow.innerText()), 'no admin.roles.create rows yet')
    const targets = await page.locator('main tbody tr').evaluateAll((rows) => rows.map((r) => (r as HTMLTableRowElement).cells[4]?.innerText.trim()))
    expect(targets.filter((t) => /^\d+$/.test(t ?? ''))).toEqual([])
    expect(targets.some((t) => /^role\/\d+$/.test(t ?? ''))).toBe(true)
  })
})
