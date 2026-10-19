import { test, expect, type Page } from '@playwright/test'

// Graphs under an AI answer (prometheus_query with chart=true): the saved answer keeps them in its tool calls, so a
// conversation opened later draws the same graphs. AI Chat draws them wide with the whole legend; the floating chat
// draws the same data low and narrow with a short legend; "View larger" opens one in a window, above the floating
// chat too. Seeded through the messages API (the path a stopped answer is saved by), so no model is needed.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const T0 = Math.floor(Date.now() / 1000) - 3600
const pts = (base: number) => Array.from({ length: 30 }, (_, i) => [T0 + i * 120, base + i * 1024 * 1024 * (i % 5)])

const MEMORY = {
  title: 'Pod memory, last hour',
  unit: 'bytes',
  promql: 'topk(5, sum by (pod) (container_memory_working_set_bytes{namespace="kube-system"}))',
  step_seconds: 120,
  common_labels: { namespace: 'kube-system' },
  series: [
    { label: 'pod=kube-apiserver', points: pts(800 * 1024 * 1024) },
    { label: 'pod=etcd', points: pts(300 * 1024 * 1024) },
    { label: 'pod=coredns-a', points: pts(40 * 1024 * 1024) },
    { label: 'pod=coredns-b', points: pts(38 * 1024 * 1024) },
    { label: 'pod=kindnet', points: pts(20 * 1024 * 1024) },
  ],
  hidden_series: 2,
}
const CPU = {
  title: 'Node CPU',
  unit: 'percent',
  promql: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  series: [{ label: 'node CPU', points: Array.from({ length: 30 }, (_, i) => [T0 + i * 120, 10 + (i % 7)]) }],
}
const ANSWER = [
  '<details>', '<summary>🔧 <strong>prometheus_query</strong></summary>', '', 'done', '', '</details>', '',
  'kube-apiserver uses 824~864 MiB and etcd 289~303 MiB; the graphs below show the last hour.',
].join('\n')

async function seed(page: Page, title: string): Promise<string> {
  const created = await page.request.post('/api/v1/sessions?cluster=self', { headers: XRW, data: { title } })
  expect(created.ok(), `create session: ${created.status()}`).toBeTruthy()
  const id = (await created.json()).id as string
  const toolCalls = [
    { function: 'prometheus_query', args: { promql: MEMORY.promql, chart: true }, result: '{}', call_id: 0, chart: MEMORY },
    { function: 'prometheus_metrics', args: { pattern: 'cpu' }, result: '{}', call_id: 1 },
    { function: 'prometheus_query', args: { promql: CPU.promql, chart: true }, result: '{}', call_id: 2, chart: CPU },
  ]
  const saved = await page.request.post(`/api/v1/sessions/${id}/messages?cluster=self`, {
    headers: XRW,
    data: { messages: [{ role: 'user', content: 'which pods use the most memory?' }, { role: 'assistant', content: ANSWER, tool_calls: toolCalls }] },
  })
  expect(saved.ok(), `save messages: ${saved.status()}`).toBeTruthy()
  return id
}

test.describe('AI answer graphs', () => {
  test('a saved answer draws its graphs wide in AI Chat, with values on hover and a larger window', async ({ page }) => {
    const title = `e2e-charts-${Date.now().toString(36)}`
    const id = await seed(page, title)
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/ai-chat?cluster=self')
      await page.getByText(title, { exact: true }).first().click()
      const charts = page.getByTestId('chat-chart')
      await expect(charts).toHaveCount(2)
      // ranges written with one tilde stay text, not struck out
      await expect(page.getByText('824~864 MiB and etcd 289~303 MiB')).toBeVisible()
      await expect(page.locator('del')).toHaveCount(0)
      const memory = charts.first()
      await expect(memory).toHaveAttribute('data-narrow', 'false')
      await expect(memory).toContainText(MEMORY.title)
      await expect(memory.getByTestId('chat-chart-plot').locator('polyline')).toHaveCount(5)
      // the whole legend, and the two series the server left out counted
      const legend = memory.getByTestId('chat-chart-legend')
      for (const s of MEMORY.series) await expect(legend).toContainText(s.label)
      await expect(legend).toContainText('+2')
      // values in the unit the AI gave: the axis and the hover read MiB
      await expect(memory.getByTestId('chat-chart-plot').locator('text').filter({ hasText: /MiB$/ }).first()).toBeAttached()
      const box = (await memory.getByTestId('chat-chart-plot').boundingBox())!
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2)
      const tip = memory.getByTestId('chat-chart-tooltip')
      await expect(tip).toContainText('pod=kube-apiserver')
      await expect(tip).toContainText(/\d+ MiB/)
      expect((await memory.getByTestId('chat-chart-plot').boundingBox())!.height).toBe(220)
      await expect(charts.nth(1).getByTestId('chat-chart-plot').locator('text').filter({ hasText: /%$/ }).first()).toBeAttached()

      await memory.getByTestId('chat-chart-enlarge').click()
      const large = page.getByTestId('chat-chart-large')
      await expect(large).toContainText(MEMORY.title)
      await expect(large).toContainText(MEMORY.promql)
      await expect(large).toContainText('namespace=kube-system')
      expect((await large.getByTestId('chat-chart-plot').boundingBox())!.height).toBe(360)
      await page.keyboard.press('Escape')
      await expect(large).toHaveCount(0)
    } finally {
      await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW })
    }
  })

  test('the floating chat draws the same graphs low with a short legend, and its larger window opens above it', async ({ page }) => {
    const id = await seed(page, `e2e-charts-floating-${Date.now().toString(36)}`)
    try {
      await page.addInitScript((sid) => sessionStorage.setItem('kubest.floatingChat.sessionId', sid), id)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/?cluster=self')
      await page.getByTestId('floating-chat-toggle').click()
      const panel = page.getByTestId('floating-chat-panel')
      const charts = panel.getByTestId('chat-chart')
      await expect(charts).toHaveCount(2)
      await expect(panel.getByText('824~864 MiB and etcd 289~303 MiB')).toBeVisible()
      await expect(panel.locator('del')).toHaveCount(0)
      const memory = charts.first()
      await expect(memory).toHaveAttribute('data-narrow', 'true')
      expect((await memory.getByTestId('chat-chart-plot').boundingBox())!.height).toBe(140)
      const legend = memory.getByTestId('chat-chart-legend')
      await expect(legend).toContainText('pod=kube-apiserver')
      await expect(legend).not.toContainText('pod=kindnet')
      await expect(legend).toContainText('+4') // two more drawn, two the server left out
      // nothing in the answer is wider than the panel
      const overflow = await panel.evaluate((el) => [...el.querySelectorAll('[data-testid="chat-chart"]')].some((c) => c.scrollWidth > c.clientWidth + 1))
      expect(overflow).toBe(false)

      await memory.getByTestId('chat-chart-enlarge').click()
      const large = page.getByTestId('chat-chart-large')
      await expect(large).toBeVisible()
      const z = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="chat-chart-large"]')!.parentElement as HTMLElement
        const panel = document.querySelector('[data-testid="floating-chat-panel"]') as HTMLElement
        const zOf = (el: HTMLElement | null): number => {
          for (let e = el; e; e = e.parentElement) {
            const z = parseInt(getComputedStyle(e).zIndex, 10)
            if (!Number.isNaN(z)) return z
          }
          return 0
        }
        return { overlay: zOf(overlay), panel: zOf(panel) }
      })
      expect(z.overlay).toBeGreaterThan(z.panel)
      await large.getByRole('button', { name: /Close|닫기/ }).last().click()
      await expect(large).toHaveCount(0)
      await expect(panel).toBeVisible()
    } finally {
      await page.request.delete(`/api/v1/sessions/${id}?cluster=self`, { headers: XRW })
    }
  })
})
