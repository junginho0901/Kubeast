import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'

// A list row opened its drawer on a click only, and the drawer left the focus behind it as it opened and dropped it
// to the page as it closed (WCAG 2.2 2.1.1, 2.4.3). With the keyboard only, no mouse: Tab reaches a ConfigMaps row,
// Enter or Space opens its drawer with the focus on the title, Escape or Close gives the focus back to the row, and a
// delete or a drawer opened from the address leaves it on the list. Runs on `self` in a namespace of its run.

const CLUSTER = 'self'
const NS = `e2e-kbd-${Date.now().toString(36)}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-keyboard-rows-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const gone = (what: string) => () => {
  try { kubectl(`-n ${NS} get ${what} -o name`); return false } catch { return true }
}

const rowOf = (page: Page, name: string) => page.locator('tbody tr[data-open-row]').filter({ has: page.getByRole('cell', { name, exact: true }) })
const listOf = (page: Page) => page.locator('table').filter({ has: page.locator('tbody tr[data-open-row]') })
const drawer = (page: Page) => page.locator('[data-testid="resource-drawer"]')
const titleOf = (page: Page, name: string) => drawer(page).locator('h2').filter({ hasText: name })
const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement).catch(() => false)

// presses Tab until `target` has the focus: how many it took, or -1
async function tabTo(page: Page, target: Locator, max: number): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab')
    if (await isFocused(target)) return i
  }
  return -1
}

test.describe('list rows and the drawer with the keyboard only', () => {
  test.beforeAll(() => {
    kubectl(`create namespace ${NS}`)
    kubectl(`-n ${NS} create configmap e2e-kbd-a --from-literal=k=a`)
    kubectl(`-n ${NS} create configmap e2e-kbd-b --from-literal=k=b`)
  })
  test.afterAll(() => { kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`) })

  test('Tab reaches a row, Enter opens it with the focus on the title, Escape gives the focus back to the row', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    const rowA = rowOf(page, 'e2e-kbd-a')
    await expect(rowA).toHaveCount(1, { timeout: 30_000 })

    // the sidebar comes first (no skip link yet), so the count is generous; the keyboard-flows table writes it down
    const presses = await tabTo(page, rowA, 250)
    expect(presses, 'Tab reaches the first row').toBeGreaterThan(0)
    expect(await rowA.evaluate((el) => getComputedStyle(el).boxShadow), 'the row shows its focus ring').not.toBe('none')

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`detail=ConfigMap(%2F|/)${NS}(%2F|/)e2e-kbd-a`))
    await expect(titleOf(page, 'e2e-kbd-a'), 'the title takes the focus as the drawer opens').toBeFocused()

    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/detail=/)
    await expect(rowA, 'the row that opened the drawer has the focus back').toBeFocused()
  })

  test('Space opens the next row, and Close pressed with Enter gives the focus back to it', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    const rowA = rowOf(page, 'e2e-kbd-a')
    const rowB = rowOf(page, 'e2e-kbd-b')
    await expect(rowB).toHaveCount(1, { timeout: 30_000 })
    expect(await tabTo(page, rowA, 250)).toBeGreaterThan(0)
    expect(await tabTo(page, rowB, 3), 'the next row is the next Tab stop').toBe(1)

    const before = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Space')
    await expect(page).toHaveURL(new RegExp(`detail=ConfigMap(%2F|/)${NS}(%2F|/)e2e-kbd-b`))
    await expect(titleOf(page, 'e2e-kbd-b')).toBeFocused()
    expect(await page.evaluate(() => window.scrollY), 'Space opened the row, it did not scroll the page').toBe(before)

    // the header's next stop after the title is Close (no Back: nothing was opened before it)
    const close = drawer(page).getByRole('button', { name: 'Close', exact: true })
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(drawer(page)).toHaveCount(0)
    await expect(rowB).toBeFocused()
    await expect(page).not.toHaveURL(/detail=/)
  })

  test('a row deleted from its drawer leaves the focus on its list, which leaves the Tab order once left', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    const rowB = rowOf(page, 'e2e-kbd-b')
    await expect(rowB).toHaveCount(1, { timeout: 30_000 })
    expect(await tabTo(page, rowB, 250)).toBeGreaterThan(0)
    await page.keyboard.press('Enter')
    await expect(titleOf(page, 'e2e-kbd-b')).toBeFocused()

    const del = drawer(page).getByRole('button', { name: 'Delete ConfigMap', exact: true })
    expect(await tabTo(page, del, 10), 'Delete is reached from the title').toBeGreaterThan(0)
    await page.keyboard.press('Enter')
    const confirm = page.getByTestId('delete-dialog-confirm')
    expect(await tabTo(page, confirm, 10), 'the window\'s Delete is reached').toBeGreaterThan(0)
    await page.keyboard.press('Enter')
    await expect.poll(gone('configmap/e2e-kbd-b'), { timeout: 20_000 }).toBe(true)

    const list = listOf(page)
    await expect(list, 'the focus lands on the list the row was in').toBeFocused()
    await expect(list).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('Tab')
    await expect(list).not.toHaveAttribute('tabindex', '-1')
  })

  test('a drawer opened from the address starts on its title and, closed, leaves the focus on the page\'s list', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}&detail=ConfigMap%2F${NS}%2Fe2e-kbd-a`)
    await expect(titleOf(page, 'e2e-kbd-a')).toBeFocused({ timeout: 30_000 })
    await expect(rowOf(page, 'e2e-kbd-a')).toHaveCount(1, { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/detail=/)
    await expect(listOf(page)).toBeFocused()
  })
})
