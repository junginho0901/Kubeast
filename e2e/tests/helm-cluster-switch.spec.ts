import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// A Helm release page stays on its address when the cluster changes. On a cluster without that release it names the
// cluster, the namespace and the release and links to that cluster's release list (it was a bare "Release not found."
// with no way back); switching back shows the release again. `default` keeps no Helm release (CLAUDE.md, e2e setup).

const MODES = ['default', 'dark', 'light'] as const
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }

type Release = { name: string; namespace: string }

async function releases(page: Page, cluster: string): Promise<Release[]> {
  const res = await page.request.get(`/api/v1/helm/releases?cluster=${cluster}`, { headers: XRW })
  expect(res.ok(), `releases of ${cluster}`).toBeTruthy()
  return ((await res.json()).items ?? []) as Release[]
}

async function pick(page: Page, cluster: string) {
  await page.getByTestId('cluster-picker').click()
  await page.getByTestId(`cluster-option-${cluster}`).click()
  await expect(page).toHaveURL(new RegExp(`[?&]cluster=${cluster}(&|$)`))
}

test.describe('Helm release page across a cluster switch', () => {
  test('a cluster without the release says so, links to its list, and switching back shows the release', async ({ page }) => {
    await page.goto('/?cluster=self')
    const own = await releases(page, 'self')
    test.skip(own.length === 0, 'self has no Helm release')
    const rel = own[0]
    const other = await releases(page, 'default')
    test.skip(other.some((r) => r.name === rel.name && r.namespace === rel.namespace), 'default has the same release')

    await page.goto(`/helm/releases/${rel.namespace}/${rel.name}?cluster=self`)
    await expect(page.locator('main h1').first()).toHaveText(rel.name)

    await pick(page, 'default')
    const box = page.getByTestId('helm-release-notFound')
    await expect(box).toContainText(`Cluster default has no release ${rel.name} in namespace ${rel.namespace}.`, { timeout: 15000 })
    await expect(page).toHaveURL(new RegExp(`/helm/releases/${rel.namespace}/${rel.name}\\?`))
    await expect(page.getByRole('link', { name: 'Helm Releases' })).toHaveAttribute('href', '/helm/releases')

    await pick(page, 'self')
    await expect(page.locator('main h1').first()).toHaveText(rel.name, { timeout: 15000 })

    await pick(page, 'default')
    await page.getByTestId('helm-release-notFound-list').click()
    await expect(page).toHaveURL(/\/helm\/releases(\?|$)/)
    await expect(page.getByTestId('cluster-picker')).toContainText('default')
    if (other.length === 0) {
      await expect(page.getByText('No Helm releases')).toBeVisible()
    } else {
      for (const r of other.slice(0, 5)) await expect(page.getByRole('cell', { name: r.name }).first()).toBeVisible()
    }
  })

  test('the not-found box is readable in every colour mode', async ({ page }) => {
    await page.goto('/?cluster=self')
    const own = await releases(page, 'self')
    test.skip(own.length === 0, 'self has no Helm release')
    const rel = own[0]
    const other = await releases(page, 'default')
    test.skip(other.some((r) => r.name === rel.name && r.namespace === rel.namespace), 'default has the same release')

    const low: string[] = []
    for (const mode of MODES) {
      await page.evaluate((m) => (m === 'default' ? localStorage.removeItem('kubeast.colorMode') : localStorage.setItem('kubeast.colorMode', m)), mode)
      await page.goto(`/helm/releases/${rel.namespace}/${rel.name}?cluster=default`)
      await expect(page.getByTestId('helm-release-notFound-list')).toBeVisible({ timeout: 15000 })
      expect(await page.evaluate(() => document.documentElement.dataset.colorMode ?? 'default')).toBe(mode)
      const result = await new AxeBuilder({ page }).withRules(['color-contrast']).include('main').analyze()
      low.push(...result.violations.flatMap((v) => v.nodes.map((n) => `${mode}: ${n.target.join(' ')}`)))
    }
    await page.evaluate(() => localStorage.removeItem('kubeast.colorMode'))
    expect(low).toEqual([])
  })
})
