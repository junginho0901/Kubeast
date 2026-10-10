// UI helpers shared by the action drivers. Selectors come from the i18n strings and
// data-testids of the frontend; Kubeast's modals are a custom overlay without role=dialog.
import type { Locator, Page } from '@playwright/test'
import { TARGET_CLUSTER, sleep } from './env'

// Per-action scratch state shared between ui() and verify() (resolved names, uids, notes).
export type Ctx = { [k: string]: any; note?: string }
export type Verify = { ok: boolean; detail: string }

export async function pickCluster(page: Page, id: string): Promise<string> {
  const picker = page.getByTestId('cluster-picker')
  if (!(await picker.count())) return 'no-picker'
  // disabled while the cluster list loads
  await page
    .waitForFunction(() => {
      const b = document.querySelector('[data-testid="cluster-picker"]') as HTMLButtonElement | null
      return b && !b.disabled
    }, null, { timeout: 8000 })
    .catch(() => {})
  if (await picker.isDisabled()) return 'picker-disabled (single accessible cluster)'
  await picker.click()
  const opt = page.getByTestId(`cluster-option-${id}`)
  if (!(await opt.count())) {
    await page.keyboard.press('Escape')
    return `no-option-${id}`
  }
  await opt.click()
  await settle(page)
  return 'ok'
}

/** Wait for the page's requests to go quiet, briefly: pages that poll never reach network-idle. */
export async function settle(page: Page, ms = 8000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {})
}

/** Open a route on the target cluster (?cluster= is the source of truth; the picker is re-checked). */
export async function goto(page: Page, route: string): Promise<void> {
  const clean = route.replace(/^\//, '')
  const sep = clean.includes('?') ? '&' : '?'
  await page.goto(`/${clean}${sep}cluster=${encodeURIComponent(TARGET_CLUSTER)}`)
  await settle(page)
  const picker = page.getByTestId('cluster-picker')
  if ((await picker.count()) && !(await picker.isDisabled())) {
    const label = (await picker.innerText().catch(() => '')).trim().split(/\s+/)[0]
    if (label !== TARGET_CLUSTER) {
      await pickCluster(page, TARGET_CLUSTER)
      await settle(page)
      await sleep(800)
    }
  }
}

export async function searchRow(page: Page, name: string): Promise<void> {
  const box = page.getByPlaceholder(/search/i).first()
  if (await box.count()) {
    await box.fill(name)
    await sleep(400)
  }
}

export async function openRow(page: Page, name: string): Promise<void> {
  await searchRow(page, name)
  const cell = page.getByRole('cell', { name, exact: true }).first()
  if (await cell.count()) await cell.click()
  else await page.getByText(name, { exact: true }).first().click()
  await settle(page)
}

export async function clickButton(page: Page, re: RegExp, scope?: Locator): Promise<void> {
  const root = scope || page
  const b = root.getByRole('button', { name: re }).first()
  await b.waitFor({ state: 'visible', timeout: 10000 })
  await b.click()
}

/** The open modal: a role=dialog when there is one, otherwise the last fixed full-screen overlay with buttons. */
export function dialog(page: Page): Locator {
  return page
    .locator('[role="dialog"], [role="alertdialog"], div.fixed.inset-0:has(button), div[class*="fixed"][class*="inset-0"]:has(button)')
    .last()
}

/** OK on the in-app confirm window (ConfirmProvider) that admin deletes and resets open. */
export async function acceptConfirm(page: Page): Promise<void> {
  await page.getByTestId('confirm-dialog-ok').click({ timeout: 10000 })
}

// A system object's delete window (CRD, Node, kube-system objects …) asks for the name before Delete turns on.
export async function confirmDialog(page: Page, re: RegExp, name?: string): Promise<void> {
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const typed = d.getByTestId('type-to-confirm')
  if (name && (await typed.count())) await typed.fill(name)
  await d.getByRole('button', { name: re }).last().click()
}

export async function clickTab(page: Page, re: RegExp): Promise<void> {
  const t = page.getByRole('tab', { name: re }).first()
  if (await t.count()) {
    await t.click()
    return
  }
  await page.getByRole('button', { name: re }).first().click()
}

/** Dialog / toast / alert texts currently on screen (what the user was told). */
export async function uiText(page: Page): Promise<string[]> {
  const parts = await page
    .locator('[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [data-sonner-toast], .toast')
    .allInnerTexts()
    .catch(() => [] as string[])
  return parts.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6)
}

/** App API with the page's session cookie (page.request shares it); cookie-authenticated writes need the CSRF header. */
export async function api(page: Page, method: string, p: string, data?: unknown): Promise<{ status: number; body: any }> {
  const r = await page.request.fetch(p, { method, data, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
  let body: any = null
  try {
    body = await r.json()
  } catch {
    /* non-JSON body */
  }
  return { status: r.status(), body }
}

export const list = (b: any): any[] =>
  Array.isArray(b) ? b : b?.items || b?.users || b?.roles || b?.organizations || b?.clusters || []

/**
 * Replace a Monaco editor's content through the clipboard: select all, paste. Typing (`keyboard.type`)
 * and `keyboard.insertText` both go through Monaco's auto-indent and shift every line after an indented
 * one; a paste does not. Two different modifiers are involved: select-all is Monaco's own keybinding and
 * follows the page's user agent (Cmd on a "Macintosh" UA, Ctrl otherwise — the `Desktop Chrome` device
 * is a Windows UA), while paste is the browser's native accelerator and follows the host OS.
 * Needs the clipboard-read/clipboard-write permissions the actions project grants.
 */
export async function pasteInto(page: Page, locator: Locator, text: string, ctx?: Ctx): Promise<void> {
  const uaMac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
  const selectMod = uaMac ? 'Meta' : 'Control'
  const pasteMod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.evaluate((t) => navigator.clipboard.writeText(t), text)
  await locator.click()
  await page.keyboard.press(`${selectMod}+A`)
  await page.keyboard.press(`${pasteMod}+V`)
  await sleep(500)
  if (ctx) ctx.note = (ctx.note ? ctx.note + '; ' : '') + `select ${selectMod}+A, paste ${pasteMod}+V`
}

export async function currentYaml(page: Page, resourceType: string, ns: string, name: string): Promise<string> {
  const r = await api(
    page,
    'GET',
    `/api/v1/cluster/resources/yaml?cluster=${TARGET_CLUSTER}&resource_type=${resourceType}&namespace=${ns || ''}&resource_name=${name}`,
  )
  return r.body?.yaml || ''
}

/** Sign in on a fresh page (used by the drivers that need their own session: a temporary user). */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"], input[type="email"], input[name="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 20000 })
}

export async function changePassword(page: Page, from: string, to: string): Promise<void> {
  await clickButton(page, /change password|비밀번호 변경/i) // opens the form section
  const pw = page.locator('input[type="password"]')
  await pw.nth(0).waitFor({ state: 'visible', timeout: 10000 })
  await pw.nth(0).fill(from)
  await pw.nth(1).fill(to)
  await pw.nth(2).fill(to)
  await page.getByRole('button', { name: /update password|^update$|^save$|변경|저장/i }).last().click()
  await sleep(1500)
}
