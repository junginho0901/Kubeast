import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A delete that went through says so where the page says what a Create from YAML made (Codex QA Q12): the drawer
// closes, the line under the list's header names the object as deleted and no longer as created, and it stays until
// closed or another page opens. Cluster View, which has no such line under its header, gets it at the top of the page
// for a pod deleted from its menu, and a list page draws it once. Runs on `self` in a namespace of its run.

const CLUSTER = 'self'
const NS = `e2e-ds-${Date.now().toString(36)}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-delete-says-so-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const gone = (what: string) => () => {
  try { kubectl(`-n ${NS} get ${what} -o name`); return false } catch { return true }
}

async function createFromYaml(page: Page, yaml: string): Promise<void> {
  const dialog = page.getByTestId('yaml-create-dialog')
  await page.getByRole('button', { name: 'Create ConfigMap', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.locator('.monaco-editor').first().click()
  // Monaco reads its keys from the page's user agent (the chromium project's is Windows), not the machine as ControlOrMeta does
  const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(yaml)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })
}

test.describe('A delete says what it deleted', () => {
  test.beforeAll(() => { kubectl(`create namespace ${NS}`) })
  test.afterAll(() => { kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`) })

  test('a ConfigMap made and deleted on its list: the line names it deleted, not created, and stays', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    await createFromYaml(page, `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-ds-a, namespace: ${NS}}\ndata: {k: v}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-ds-b, namespace: ${NS}}\ndata: {k: v}`)
    const notice = page.getByTestId('yaml-created')
    await expect(notice).toHaveText(new RegExp(`^Created: ConfigMap/e2e-ds-a \\(${NS}\\), ConfigMap/e2e-ds-b \\(${NS}\\)`))

    await page.getByRole('cell', { name: 'e2e-ds-a', exact: true }).first().click()
    await page.getByRole('button', { name: 'Delete ConfigMap', exact: true }).click()
    await page.getByTestId('delete-dialog-confirm').click()
    await expect.poll(gone('configmap/e2e-ds-a'), { timeout: 20_000 }).toBe(true)
    expect(kubectl(`-n ${NS} get configmap e2e-ds-b -o name`)).toBe('configmap/e2e-ds-b')

    // one line, the page's own: what is still there as made, what went as deleted
    await expect(notice).toHaveCount(1)
    await expect(notice.locator('p')).toHaveText([`Created: ConfigMap/e2e-ds-b (${NS})`, `Deleted: ConfigMap/e2e-ds-a (${NS})`])
    await page.waitForTimeout(5_000)
    await expect(notice.locator('p')).toHaveText([`Created: ConfigMap/e2e-ds-b (${NS})`, `Deleted: ConfigMap/e2e-ds-a (${NS})`])

    // the other one deleted too: no line names it as made any more
    await page.getByRole('cell', { name: 'e2e-ds-b', exact: true }).first().click()
    await page.getByRole('button', { name: 'Delete ConfigMap', exact: true }).click()
    await page.getByTestId('delete-dialog-confirm').click()
    await expect.poll(gone('configmap/e2e-ds-b'), { timeout: 20_000 }).toBe(true)
    await expect(notice.locator('p')).toHaveText([`Deleted: ConfigMap/e2e-ds-a (${NS}), ConfigMap/e2e-ds-b (${NS})`])

    await page.getByTestId('yaml-created-close').click()
    await expect(notice).toHaveCount(0)
  })

  // The delete's answer is held until the drawer has moved to another ConfigMap (as back, forward or a link move it): the
  // answer names the one deleted, and the drawer of the other stays open with no Delete window of the first.
  test('a delete that answers after the drawer moved names the ConfigMap deleted and leaves the other one\'s drawer open', async ({ page }) => {
    kubectl(`-n ${NS} create configmap e2e-ds-c --from-literal=k=v`)
    kubectl(`-n ${NS} create configmap e2e-ds-d --from-literal=k=v`)
    const at = (name: string) => `/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`ConfigMap/${NS}/${name}`)}`
    let answer!: () => void
    const held = new Promise<void>((resolve) => { answer = resolve })
    await page.route(`**/namespaces/${NS}/configmaps/e2e-ds-c**`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback()
      await held
      await route.continue()
    })

    await page.goto(at('e2e-ds-c'))
    const asked = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes(`/configmaps/e2e-ds-c`))
    await page.getByRole('button', { name: 'Delete ConfigMap', exact: true }).click()
    await page.getByTestId('delete-dialog-confirm').click()
    await asked

    await page.evaluate((next) => {
      window.history.pushState({}, '', next)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, at('e2e-ds-d'))
    await expect(page.getByTestId('delete-dialog-confirm'), 'the Delete window was for the first ConfigMap').toHaveCount(0)
    answer()
    await expect.poll(gone('configmap/e2e-ds-c'), { timeout: 20_000 }).toBe(true)

    const notice = page.getByTestId('yaml-created')
    await expect(notice.locator('p')).toHaveText([`Deleted: ConfigMap/e2e-ds-c (${NS})`])
    await expect(page, 'the drawer stays on the other ConfigMap').toHaveURL(new RegExp(`detail=ConfigMap(%2F|/)${NS}(%2F|/)e2e-ds-d`))
    await expect(page.getByRole('button', { name: 'Delete ConfigMap', exact: true })).toHaveCount(1)
    expect(kubectl(`-n ${NS} get configmap e2e-ds-d -o name`)).toBe('configmap/e2e-ds-d')
  })

  test('a pod deleted from Cluster View\'s menu is named deleted at the top of the page, until another page opens', async ({ page }) => {
    // sleep ignores SIGTERM: no grace period, so the pod goes within the test's time
    kubectl(`-n ${NS} run e2e-ds-pod --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --overrides='{"spec":{"terminationGracePeriodSeconds":0}}' -- sleep 3600`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/e2e-ds-pod --timeout=120s`)
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    await page.getByRole('button', { name: /All namespaces|전체 네임스페이스/ }).first().click()
    await page.getByRole('button', { name: NS, exact: true }).click()
    const card = page.getByTestId('cluster-view-node').locator('button').filter({ hasText: 'e2e-ds-pod' })
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await page.getByTestId('pod-delete-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByTestId('pod-delete-dialog')).toHaveCount(0, { timeout: 20_000 })

    const notice = page.getByTestId('yaml-created')
    await expect(notice).toHaveCount(1)
    await expect(notice.locator('p')).toHaveText([`Deleted: Pod/e2e-ds-pod (${NS})`])
    await expect.poll(gone('pod/e2e-ds-pod'), { timeout: 20_000 }).toBe(true)
    await expect(notice.locator('p')).toHaveText([`Deleted: Pod/e2e-ds-pod (${NS})`])

    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click()
    await expect(page).toHaveURL(/\/(\?|$)/)
    await expect(notice).toHaveCount(0)
  })
})
