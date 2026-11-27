import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Keyboard only, on `self` (D5 keyboard flows 1 and 3, WCAG 2.2 2.1.2 and 2.4.3): a pod's terminal keeps Tab and Escape
// for the shell and lets Tab leave it after Ctrl+M (Ctrl+Shift+M on a Mac), which the line under it names; the YAML
// window's Edit focuses the editor and a saved Apply focuses Edit again; a picked namespace gives the focus back to its
// button. The namespace, its ConfigMap and pod are of this run and removed after.

const CLUSTER = 'self'
const STAMP = Date.now().toString(36)
const NS = `e2e-kbd-${STAMP}`
const POD = 'kbd-pod'
const CM = 'kbd-cm'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string, vars: Record<string, string> = {}): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-kbd-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

type Focus = { body: boolean; inTerminal: boolean; inEditor: boolean; inWindow: boolean; label: string | null; title: string | null; text: string }
const focused = (page: Page): Promise<Focus> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  return {
    body: !a || a === document.body,
    inTerminal: !!a?.closest('.xterm'),
    inEditor: !!a?.closest('.monaco-editor'),
    inWindow: !!a?.closest('[class*="fixed"][class*="inset-0"]'),
    label: a?.getAttribute('aria-label') ?? null,
    title: a?.getAttribute('title') ?? null,
    text: (a?.textContent || '').trim(),
  }
})

// The switch as the console names it on this browser's platform (utils/terminalTabFocus, Monaco's keybinding).
async function tabSwitch(page: Page): Promise<{ press: string; label: string }> {
  const mac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform))
  return mac ? { press: 'Control+Shift+KeyM', label: 'Ctrl+Shift+M' } : { press: 'Control+KeyM', label: 'Ctrl+M' }
}

test.describe('keyboard: terminal, YAML editor and pickers', () => {
  test.beforeAll(() => {
    kubectl(`create namespace ${NS}`)
    kubectl(`-n ${NS} create configmap ${CM} --from-literal=k=kbd-before`)
    kubectl(`-n ${NS} run ${POD} --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --command -- sleep 3600`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
  })

  test('a terminal keeps Tab and Escape for the shell, and Tab leaves it after the switch the line under it names', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${POD}`)}`)
    const drawer = page.locator(DRAWER).last()
    const exec = drawer.getByTitle(tr('pods.exec.openExec')).first()
    await exec.focus({ timeout: 20_000 })
    await page.keyboard.press('Enter')
    const rows = page.locator('.xterm-rows').last()
    await expect(rows).toContainText(tr('pods.exec.connected'), { timeout: 20_000 })
    expect((await focused(page)).inTerminal).toBe(true)

    await page.keyboard.type(`echo kbd-$((40+2))`)
    await page.keyboard.press('Enter')
    await expect(rows).toContainText('kbd-42', { timeout: 10_000 })

    const key = await tabSwitch(page)
    const hint = page.getByTestId('terminal-key-hint')
    await expect(hint).toHaveText(tr('keyboardHelp.terminalTab', { key: key.label }))
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    expect((await focused(page)).inTerminal).toBe(true)
    await expect(page.locator('.xterm')).toHaveCount(1)

    await page.keyboard.press(key.press)
    await expect(hint).toHaveAttribute('data-tab-moves-focus', 'true')
    await expect(hint).toHaveText(tr('keyboardHelp.terminalTabMovesFocus', { key: key.label }))
    await page.keyboard.press('Tab')
    const out = await focused(page)
    expect(out.inTerminal).toBe(false)
    expect(out.inWindow).toBe(true)
    expect(out.label).toBe(tr('common.close'))

    await page.keyboard.press('Escape')
    await expect(page.locator('.xterm')).toHaveCount(0)
    expect((await focused(page)).title).toBe(tr('pods.exec.openExec'))
  })

  test('Edit focuses the editor, the hint names Monaco’s Tab switch, and a saved Apply focuses Edit', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`ConfigMap/${NS}/${CM}`)}`)
    const drawer = page.locator(DRAWER).last()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).focus({ timeout: 20_000 })
    await page.keyboard.press('Enter')
    await expect(drawer.locator('.monaco-editor .view-lines').first()).toContainText('kbd-before', { timeout: 30_000 })

    await drawer.getByRole('button', { name: tr('common.edit'), exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await focused(page)).inEditor, { timeout: 10_000 }).toBe(true)

    const key = await tabSwitch(page)
    const hint = drawer.getByTestId('yaml-editor-tab-hint')
    await expect(hint).toHaveText(tr('keyboardHelp.editorTab', { key: key.label }))
    await page.keyboard.press(key.press)
    await expect(hint).toHaveText(tr('keyboardHelp.editorTabMovesFocus', { key: key.label }))
    await page.keyboard.press('Shift+Tab')
    expect((await focused(page)).text).toBe(tr('common.cancel'))
    await page.keyboard.press('Shift+Tab')
    expect((await focused(page)).text).toBe(tr('common.apply'))

    await page.keyboard.press('Enter')
    await expect(drawer.getByRole('button', { name: tr('common.edit'), exact: true })).toHaveCount(1, { timeout: 20_000 })
    await expect.poll(async () => (await focused(page)).text, { timeout: 5_000 }).toBe(tr('common.edit'))
    expect(kubectl(`-n ${NS} get configmap ${CM} -o jsonpath={.data.k}`)).toBe('kbd-before')
  })

  test('a namespace picked or a list closed with Escape gives the focus back to its button', async ({ page }) => {
    await page.goto(`/configuration/configmaps?cluster=${CLUSTER}`)
    const button = page.getByRole('button', { name: tr('configMapsPage.allNamespaces'), exact: true })
    await button.focus({ timeout: 20_000 })
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    expect((await focused(page)).text).toBe(tr('configMapsPage.allNamespaces'))

    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: NS, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await focused(page)).text, { timeout: 5_000 }).toBe(NS)
    expect((await focused(page)).body).toBe(false)
    expect(new URL(page.url()).searchParams.get('namespace')).toBe(NS)
  })
})
