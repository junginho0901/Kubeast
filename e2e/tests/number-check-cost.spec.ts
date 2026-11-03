import { test, expect, type Page } from '@playwright/test'

// Number check of the Cost page on default (OpenCost): Refresh reads OpenCost again instead of the server's answer
// of the last minute, the cards are the answer's totals, and what the total holds besides the cards (GPU, load
// balancers) is said under them, so the shown amounts add up to the total within OpenCost's rounding.

const COST = { path: '/cost', cluster: 'default' }

type Totals = { cpu_cost: number; ram_cost: number; pv_cost: number; network_cost: number; gpu_cost: number; load_balancer_cost: number; total_cost: number }
type CostResponse = { generated_at: string; currency: string; totals: Totals; rows: unknown[] }

// The same digits rule as frontend/src/utils/money.ts, so the screen can be compared with the API.
function money(amount: number): string {
  const abs = Math.abs(amount)
  const digits = abs === 0 ? 0 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
}

const costAnswer = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/api/v1/cluster/cost?') && r.url().includes('aggregate=namespace') && r.ok())

test.describe('Number check — Cost', () => {
  test('Refresh reads OpenCost again within the minute the server keeps an answer', async ({ page }) => {
    test.setTimeout(120_000)
    const first = costAnswer(page)
    await page.goto(`${COST.path}?cluster=${COST.cluster}`)
    const before = (await (await first).json()) as CostResponse
    await expect(page.getByTestId('cost-table')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1_200) // generated_at is to the second
    const again = costAnswer(page)
    await page.getByRole('button', { name: /^Refresh$|^새로고침$/ }).click()
    const res = await again
    const after = (await res.json()) as CostResponse
    expect(Date.parse(after.generated_at), `Refresh at ${after.generated_at}, the page's answer was ${before.generated_at}`).toBeGreaterThan(Date.parse(before.generated_at))
    await expect(page.getByTestId('cost-total')).toHaveText(money(after.totals.total_cost))
  })

  test('the cards are the totals, GPU and load balancers are said under them, and they make the total', async ({ page }) => {
    test.setTimeout(120_000)
    const loaded = costAnswer(page)
    await page.goto(`${COST.path}?cluster=${COST.cluster}`)
    const body = (await (await loaded).json()) as CostResponse
    const t = body.totals
    const cards: [string, number][] = [['total', t.total_cost], ['cpu', t.cpu_cost], ['ram', t.ram_cost], ['pv', t.pv_cost], ['network', t.network_cost]]
    for (const [key, value] of cards) await expect.soft(page.getByTestId(`cost-${key}`), `the ${key} card`).toHaveText(money(value))
    // the cards' parts, GPU and load balancers make the total, within OpenCost's rounding (each amount to five decimals:
    // seven numbers a row, ±0.000005 each)
    const parts = t.cpu_cost + t.ram_cost + t.pv_cost + t.network_cost + t.gpu_cost + t.load_balancer_cost
    expect(Math.abs(t.total_cost - parts), `the parts ${parts} and the total ${t.total_cost} over ${body.rows.length} rows`).toBeLessThanOrEqual(body.rows.length * 3.5e-5 + 1e-9)
    const outside = [t.gpu_cost, t.load_balancer_cost].filter((v) => v !== 0)
    const note = page.getByTestId('cost-outside-cards')
    if (outside.length === 0) {
      await expect(note, 'the cards make the total: no note').toHaveCount(0)
    } else {
      for (const v of outside) await expect.soft(note, 'the note names each part').toContainText(money(v))
    }
  })
})
