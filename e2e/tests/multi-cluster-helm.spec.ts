import { test, expect, type Page } from '@playwright/test'

// Helm releases must follow the selected cluster. The release list is fed by an
// SSE watch that was pinned to cluster 'default' in the frontend, so switching
// clusters left the previous cluster's releases on screen (and clicking one
// 404'd, since it doesn't exist on the new cluster). The watch + list query are
// now keyed to the current cluster.
//
// The test needs one registered cluster with at least one release and one with
// none; which is which comes from the API.

async function releaseNames(page: Page, cluster: string): Promise<string[] | null> {
  const res = await page.request.get(`/api/v1/cluster/helm/releases?cluster=${cluster}`)
  if (!res.ok()) return null
  const body = await res.json()
  const items = Array.isArray(body) ? body : body.items ?? []
  return items.map((r: { name: string }) => r.name)
}

async function pageMentions(page: Page, text: string): Promise<boolean> {
  return (await page.content()).includes(text)
}

test.describe('multi-cluster helm releases', () => {
  test('the release list follows the selected cluster', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const clusters = ['default', 'self']
    const names = await Promise.all(clusters.map((c) => releaseNames(page, c)))
    test.skip(names.some((n) => n === null), 'clusters default and self are not both registered')
    const withReleases = clusters.find((_, i) => names[i]!.length > 0)
    const without = clusters.find((_, i) => names[i]!.length === 0)
    test.skip(!withReleases || !without, `both clusters have releases or neither does (${names.map((n) => n!.length).join('/')})`)
    const marker = names[clusters.indexOf(withReleases!)]![0]

    // The helm page holds a long-lived SSE stream, so it never reaches
    // 'networkidle' — wait for the DOM only.
    await page.goto(`/helm/releases?cluster=${withReleases}`)
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => pageMentions(page, marker), { timeout: 20000 }).toBe(true)

    // switch to the cluster without releases → the prior cluster's releases must clear
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId(`cluster-option-${without}`).click()
    await expect.poll(() => pageMentions(page, marker), { timeout: 20000 }).toBe(false)
  })
})
