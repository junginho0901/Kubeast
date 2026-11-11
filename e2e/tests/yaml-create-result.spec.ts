import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Create from YAML says what it made (QA #36). On success the window closes and the line under the list's header
// names each object with its namespace — one made in another namespace than the list shows too — until it is closed
// or another page opens. A YAML whose second object the cluster refuses keeps the window open with the refusal and
// names the object made before it stopped, which the cluster has. Runs on `self` in a namespace of its run.

const CLUSTER = 'self'
const NS = `e2e-yc-${Date.now().toString(36)}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-yaml-create-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

const configMap = (name: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: ${name}, namespace: ${NS}}\ndata: {k: v}`

async function createFromYaml(page: Page, yaml: string): Promise<void> {
  const dialog = page.getByTestId('yaml-create-dialog')
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Create ConfigMap', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.locator('.monaco-editor').first().click()
  // Monaco reads its keys from the page's user agent (the chromium project's is Windows), not the machine as ControlOrMeta does
  const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(yaml)
  const lines = await dialog.locator('.monaco-editor .view-lines').first().evaluate((el) => (el as HTMLElement).innerText.replace(/ /g, ' ').trim())
  expect(lines, 'the editor holds the YAML typed, nothing of the template').toBe(yaml)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
}

test.describe('Create from YAML says what it made', () => {
  test.beforeAll(() => { kubectl(`create namespace ${NS}`) })
  test.afterAll(() => { kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`) })

  test('a create names what it made under the header, until closed or another page opens', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=default`)
    await createFromYaml(page, configMap('e2e-yc-a'))
    await expect(page.getByTestId('yaml-create-dialog')).toHaveCount(0, { timeout: 15_000 })
    const line = page.getByTestId('yaml-created').locator('p')
    await expect(line).toHaveText(`Created: ConfigMap/e2e-yc-a (${NS})`)
    expect(kubectl(`-n ${NS} get configmap e2e-yc-a -o name`)).toBe('configmap/e2e-yc-a')
    // the list shows default: the object is not in it, the line is what says it was made — and it stays
    await expect(page.locator('tbody:not([aria-hidden="true"])')).not.toContainText('e2e-yc-a')
    await page.waitForTimeout(8_000)
    await expect(line).toHaveText(`Created: ConfigMap/e2e-yc-a (${NS})`)
    await page.getByTestId('yaml-created-close').click()
    await expect(page.getByTestId('yaml-created')).toHaveCount(0)

    await createFromYaml(page, configMap('e2e-yc-c'))
    await expect(line).toHaveText(`Created: ConfigMap/e2e-yc-c (${NS})`, { timeout: 15_000 })
    await page.goto(`/configuration/secrets?cluster=${CLUSTER}&namespace=default`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByTestId('yaml-created')).toHaveCount(0)
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=default`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByTestId('yaml-created')).toHaveCount(0)
  })

  test('a YAML stopped at its second object keeps the window open and names what it made before', async ({ page }) => {
    kubectl(`-n ${NS} create configmap e2e-yc-taken --from-literal=k=v`)
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    await createFromYaml(page, `${configMap('e2e-yc-b')}\n---\n${configMap('e2e-yc-taken')}`)
    const dialog = page.getByTestId('yaml-create-dialog')
    await expect(dialog.getByTestId('yaml-create-error')).toContainText('create ConfigMap e2e-yc-taken', { timeout: 15_000 })
    await expect(dialog.getByTestId('yaml-create-error')).toContainText('already exists')
    await expect(dialog.getByTestId('yaml-create-made-before')).toHaveText(`Created before it stopped: ConfigMap/e2e-yc-b (${NS})`)
    expect(kubectl(`-n ${NS} get configmap e2e-yc-b -o name`)).toBe('configmap/e2e-yc-b')
    // the list behind the window reads what was made
    await expect(page.locator('tbody:not([aria-hidden="true"])')).toContainText('e2e-yc-b', { timeout: 15_000 })

    // the same YAML again stops at its first object: nothing made, nothing named
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog.getByTestId('yaml-create-error')).toContainText('create ConfigMap e2e-yc-b', { timeout: 15_000 })
    await expect(dialog.getByTestId('yaml-create-made-before')).toHaveCount(0)
  })

  // What was typed wrong is the caller's to fix: the window stays with kubectl's words for it (a 400, not the decoder's
  // text in a server error), a Korean line reads whole, and a YAML of comments only does not close as a create.
  test('a YAML that holds no object stays open with the reason and makes nothing', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}`)
    const dialog = page.getByTestId('yaml-create-dialog')
    const before = kubectl(`-n ${NS} get configmaps -o name`)
    const answers: number[] = []
    page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/v1/cluster/resources/yaml/create') answers.push(r.status()) })
    for (const [yaml, reason] of [
      ['한국어로 쓴 글', 'document 1 (line 1) is text, not an object with apiVersion, kind and metadata'],
      ['# 메모만 있음\n---', 'no objects passed to create: the YAML holds only comments or empty documents'],
      [`apiVersion: v1\nmetadata: {name: e2e-yc-nokind, namespace: ${NS}}`, 'document 1: kind not set'],
      [`apiVersion: v1\nkind: NoSuchKind\nmetadata: {name: e2e-yc-x, namespace: ${NS}}`, 'document 1: no matches for kind "NoSuchKind" in version "v1" on this cluster (ensure CRDs are installed first)'],
    ]) {
      await createFromYaml(page, yaml)
      await expect(dialog.getByTestId('yaml-create-error'), yaml).toHaveText(reason, { timeout: 15_000 })
    }
    expect(answers).toEqual([400, 400, 400, 400])
    await expect(page.getByTestId('yaml-created')).toHaveCount(0)
    expect(kubectl(`-n ${NS} get configmaps -o name`), 'nothing was made').toBe(before)
  })
})
