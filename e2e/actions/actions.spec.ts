// Action suite (opt-in Playwright project "actions"): every UI action from the catalogue, performed
// through the real UI against the seeded target cluster and verified with kubectl / the app's API.
//
//   E2E_ACTIONS=1 npx playwright test --project=actions            # all (≈ 12 min + seed)
//   E2E_ACTIONS=1 E2E_ACTIONS_ONLY=cm-delete,helm-rollback npx playwright test --project=actions
//
// Not part of the default run: see README.md in this folder.
import { test, expect } from '@playwright/test'
import { sleep } from './support/env'
import { D, ORDER } from './support/drivers'
import { goto, uiText, type Ctx } from './support/ui'

const only = (process.env.E2E_ACTIONS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const keys = only.length ? only : ORDER
for (const k of only) if (!D[k]) throw new Error(`unknown action key in E2E_ACTIONS_ONLY: ${k}`)

const SENSITIVE_GET = /\/secrets\/[^/]+\/(describe|yaml)|\/logs(\/stream)?(\?|$)/
const mask = (s: string) => s.replace(/"(access_token|refresh_token|token|password|temporary_password)":"[^"]*"/g, '"$1":"***"')

for (const key of keys) {
  const d = D[key]
  test(key, async ({ page }, testInfo) => {
    const reason = d.precondition?.()
    test.skip(!!reason, reason || '')

    page.on('dialog', (dlg) => dlg.accept()) // admin pages confirm deletes with window.confirm
    const apis: string[] = []
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('response', async (r) => {
      const u = new URL(r.url())
      if (!/\/api\//.test(u.pathname) || /\/(auth\/me|health)$/.test(u.pathname)) return
      const m = r.request().method()
      // successful GETs are noise, except the sensitive reads the catalogue lists (secret describe/yaml, logs)
      if (m === 'GET' && r.status() < 400 && !SENSITIVE_GET.test(u.pathname)) return
      let body = ''
      if (m !== 'GET' || r.status() >= 400) body = mask((await r.text().catch(() => '')).replace(/\s+/g, ' ')).slice(0, 140)
      apis.push(`${m} ${u.pathname} ${r.status()}${body ? ' ' + body : ''}`)
    })
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160))
    })
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)))

    const ctx: Ctx = {}
    let uiError: string | null = null
    try {
      await goto(page, d.route)
      await d.ui(page, ctx)
      await sleep(1200)
      ctx.ui = await uiText(page)
      await sleep(1500)
    } catch (e) {
      uiError = String((e as Error).message || e).split('\n')[0].slice(0, 300)
      await page.keyboard.press('Escape').catch(() => {})
    }
    // verify always runs (it also restores/cleans up what the action changed)
    const verify = await d.verify(page, ctx)

    await testInfo.attach('action.json', {
      body: JSON.stringify({ key, id: d.id, route: d.route, apis, ui: ctx.ui, note: ctx.note, verify, uiError, consoleErrors, pageErrors }, null, 1),
      contentType: 'application/json',
    })
    await testInfo.attach('after.png', { body: await page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' })

    expect(uiError, 'the driver completed the UI flow').toBeNull()
    expect(pageErrors, 'no uncaught page errors').toEqual([])
    expect(verify.ok, verify.detail).toBeTruthy()
  })
}
