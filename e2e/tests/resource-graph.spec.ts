import { test, expect, type Locator, type Page } from '@playwright/test'

// Cluster → Resource Graph (React Flow + ELK layout) on the dev cluster itself:
// the graph renders with its minimap and controls, namespace grouping keeps every
// resource inside a group container, and a node click opens the resource drawer.
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const NODES = '.react-flow__node'

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

// The graph draws only the picked namespaces (?namespace= picks them, the old topology
// links use it); both of these always exist on the dev cluster.
async function openGraph(page: Page) {
  await page.goto('/cluster/resource-graph?cluster=self&namespace=kube-system,kubeast')
  await expect(page.getByRole('button', { name: 'kube-system, kubeast' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator(NODES).first()).toBeVisible({ timeout: 30000 })
}

test.describe('resource graph', () => {
  test('renders nodes with the minimap and controls', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openGraph(page)

    expect(await page.locator(NODES).count()).toBeGreaterThan(0)
    await expect(page.locator('.react-flow__minimap')).toBeVisible()
    await expect(page.locator('.react-flow__controls')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('grouping by namespace keeps every resource inside a group container', async ({ page }) => {
    await openGraph(page)

    await page.getByRole('button', { name: 'Namespace', exact: true }).click()
    const groups = page.locator(`${NODES}[data-id^="group-"]`)
    await expect(groups.first()).toBeVisible({ timeout: 30000 })

    const groupBoxes = await Promise.all((await groups.all()).map(box))
    const members = await page.locator(`${NODES}:not([data-id^="group-"])`).all()
    expect(members.length).toBeGreaterThan(0)
    for (const m of members) {
      const b = await box(m)
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const inside = groupBoxes.some((g) => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height)
      expect(inside, `${await m.getAttribute('data-id')} sits inside a group`).toBe(true)
    }
  })

  test('clicking a resource opens its detail drawer', async ({ page }) => {
    await openGraph(page)
    const node = page.locator(`${NODES} [title]`).first()
    await expect(node).toBeVisible({ timeout: 30000 })
    const name = await node.getAttribute('title')
    expect(name).toBeTruthy()

    await node.click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByText(name!, { exact: true }).first()).toBeVisible()
  })
})
