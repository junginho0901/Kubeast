import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Route } from '@playwright/test'

// The alert store refusing a read at the user's request limit (429, the answer's Retry-After): the Alerts page says so
// with the seconds, reads again when the server said rather than at the next minute, the notice goes with the first
// read that answers, and the floating chat is told. The refusal is stood in: spending a user's real budget would make
// every other spec's reads of the store fail for its seconds. The real header is held by the k8s-service handler test.

const CLUSTER = 'default'
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const WAIT_S = 4
const STORE = /\/api\/v1\/alertstore\/alerts(\?|$)/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

test.describe('number check — the alert store refusing a read', () => {
  test('the page says the request limit and the seconds, and reads again then', async ({ page, request }) => {
    test.setTimeout(90_000)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`)).json()
    test.skip(!features.alertStore?.clusters?.includes(CLUSTER), `no alert store for cluster ${CLUSTER}`)

    const asked: number[] = []
    let refusing = true
    await page.route(STORE, (route: Route) => {
      asked.push(Date.now())
      if (!refusing) return route.fallback()
      return route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(WAIT_S) }, body: JSON.stringify({ detail: 'too many alert reads: 30 per minute' }) })
    })
    const notice = page.getByTestId('alert-store-limited')
    const says = new RegExp(`^${EN.alertInbox.storeLimited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{\\{seconds\\}\\}', '([1-9])')}$`)

    await page.goto(`/alerts?cluster=${CLUSTER}`)
    await expect(notice, 'the notice names the wait').toHaveText(says, { timeout: 20_000 })

    await test.step('it reads again after the seconds the server named, not at the next minute', async () => {
      await expect.poll(() => asked.length, { timeout: (WAIT_S + 5) * 1000 }).toBeGreaterThanOrEqual(2)
      const gap = asked[1] - asked[0]
      expect(gap, `${gap} ms between the two reads`).toBeLessThan((WAIT_S + 4) * 1000)
      expect(gap, `${gap} ms between the two reads`).toBeGreaterThanOrEqual((WAIT_S - 1) * 1000)
      await expect(notice, 'still refused: the notice stays').toHaveText(says)
    })

    await test.step('the floating chat is told when it is read again', async () => {
      const sent: Obj[] = []
      const fulfil = async (route: Route, answer: Parameters<Route['fulfill']>[0]) => {
        try {
          await route.fulfill(answer)
        } catch { /* the page went on */ }
      }
      await page.route(/\/api\/v1\/sessions(\?|$)/, (route) => (route.request().method() === 'POST'
        ? fulfil(route, { json: { id: 'e2e-limit-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback()))
      await page.route(/\/api\/v1\/sessions\/e2e-limit-ctx-\d+(\?|$)/, (route) => fulfil(route, { json: { id: 'e2e-limit-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [], messages_before: 0 } }))
      await page.route(/\/api\/v1\/ai\/sessions\/e2e-limit-ctx-\d+\/floating-chat/, (route) => {
        sent.push(route.request().postDataJSON().page_context)
        return fulfil(route, { contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
      })
      await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
      const layers = [sent[0].base, ...(sent[0].overlays ?? [])].filter(Boolean)
      const page_ = layers.find((l: Obj) => l?.data && 'counts' in l.data && 'items' in l.data)
      expect(Date.parse(page_?.data?.alert_store_limited?.read_again_at ?? ''), 'alert_store_limited.read_again_at').toBeGreaterThan(0)
    })

    await test.step('the first read that answers takes the notice away', async () => {
      refusing = false
      await expect(notice).toHaveCount(0, { timeout: (WAIT_S + 5) * 1000 })
    })
  })
})
