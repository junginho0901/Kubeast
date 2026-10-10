import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Prometheus-backed drawer and dashboard sections, the events-based image pull history, and the Audit page's
// dropdowns and wide table. On the dev clusters `default` (kubeast-b) runs a Prometheus and `self` does not
// (deploy/kind/second-cluster.yaml), so a Prometheus section must show with values on `default` and stay out on
// `self` — a PrometheusSection renders nothing while its query is unavailable.

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prometheus-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const kubectlB = kubectlFor('kubeast-b')

const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

async function openDrawer(page: Page, route: string, name: string) {
  await page.goto(route)
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 30000 })
  const search = page.getByPlaceholder(/search|검색/i).first()
  if (await search.count()) await search.fill(name)
  await page.getByRole('cell', { name, exact: true }).first().click({ timeout: 20000 })
  const drawer = page.locator(DRAWER).last()
  await expect(drawer).toContainText(name, { timeout: 20000 })
  return drawer
}

const hasPrometheus = (k: (args: string) => string) => k('get svc -A --no-headers').split('\n').some((l) => /\bprometheus\b/.test(l))

test.describe('Prometheus features — toggle + 4 detail modal sections + #5 events', () => {

  test('Cluster features API — /api/v1/cluster/features 응답 + prometheus enabled flag', async ({ page }) => {
    const res = await page.request.get('/api/v1/cluster/features')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    // 응답 schema: { prometheus: { enabled: boolean } }
    expect(body).toHaveProperty('prometheus')
    expect(typeof body.prometheus?.enabled).toBe('boolean')
  })

  test('Feature #1 — HPA Scaling History 섹션 (HPA 모달, 있으면)', async ({ page }) => {
    test.skip(hasPrometheus(kubectl), 'self runs a Prometheus here — this checks the section stays out without one')
    const drawer = await openDrawer(page, '/workloads/hpas?cluster=self', 'e2e-fixture')
    await expect(drawer).toContainText('80%')
    // no Prometheus on self: the section is not drawn
    await expect(drawer.getByText(/Scaling History/)).toHaveCount(0)
  })

  test('Feature #2 — Ingress Response Time P50/P95/P99 (있으면)', async ({ page }) => {
    test.skip(hasPrometheus(kubectl), 'self runs a Prometheus here — this checks the section stays out without one')
    const drawer = await openDrawer(page, '/network/ingresses?cluster=self', 'e2e-fixture')
    await expect(drawer.locator('text=/^Ingress Info$/').first()).toBeVisible()
    await expect(drawer).toContainText('e2e-fixture-tls')
    await expect(drawer.getByText(/^Response Time$/i)).toHaveCount(0)
  })

  test('Feature #3 — Node 24h Resource Trend (있으면)', async ({ page }) => {
    test.skip(!hasPrometheus(kubectlB), 'no Prometheus on default (deploy/kind/second-cluster.yaml)')
    const node = kubectlB(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    const drawer = await openDrawer(page, '/cluster/nodes?cluster=default', node)
    const section = drawer.locator('div.rounded-lg').filter({ has: page.getByText(/Real-time Metrics|실시간/i) }).first()
    await expect(section).toBeVisible({ timeout: 20000 })
    await expect(section).toContainText(/\d+(\.\d+)?\s*%/)
  })

  test('Feature #5 — Pod Image Pull History 섹션 (events 기반, 있으면)', async ({ page }) => {
    // a pod whose image the node already has: the kubelet records "Pulled" right away
    const image = kubectl(`-n default get cronjob e2e-fixture -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}'`)
    test.skip(!image, 'e2e-fixture CronJob missing (fixtures.yaml)')
    const name = `e2e-pull-history-${Date.now().toString(36)}`
    kubectl(`-n default run ${name} --image=${image} --image-pull-policy=IfNotPresent --restart=Never -- sleep 300`)
    try {
      await expect.poll(() => kubectl(`-n default get events --field-selector involvedObject.name=${name},reason=Pulled -o name`), { timeout: 60000 }).not.toBe('')
      const drawer = await openDrawer(page, '/workloads/pods?cluster=self', name)
      await expect(drawer.getByText(/Image Pull History \(\d+, last 1h\)/)).toHaveText(/Image Pull History \([1-9]\d*, last 1h\)/, { timeout: 20000 })
      await expect(drawer).toContainText('Pulled')
    } finally {
      kubectl(`-n default delete pod ${name} --ignore-not-found --wait=false`)
    }
  })

  test('Feature #4 — Pod exec terminal 로그 보존 (스텁만 — 인프라 작업 OOS)', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/cluster-view')
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveTitle(/^Cluster View · Kubeast$/)
    expect(errors).toEqual([])
  })
})

test.describe('AdminAudit — custom dropdown + 가로 스크롤', () => {

  test('AdminAudit 페이지 mount + 3 custom dropdown 보임', async ({ page }) => {
    await page.goto('/admin/audit')
    const filters = page.locator('main label').filter({ has: page.locator('button:has(svg.lucide-chevron-down)') })
    await expect(filters.first()).toBeVisible({ timeout: 15000 })
    expect(await filters.count()).toBeGreaterThanOrEqual(3)
    // the first one opens its options and closes on Escape
    const buttons = page.locator('main button')
    const closed = await buttons.count()
    await filters.first().locator('button').first().click()
    await expect.poll(() => buttons.count()).toBeGreaterThan(closed)
    await page.keyboard.press('Escape')
    await expect.poll(() => buttons.count()).toBe(closed)
  })

  test('AdminAudit table — overflow-x-auto + min-width', async ({ page }) => {
    // 좁은 viewport (세로 모니터 모방) — 가로 스크롤 가능해야
    await page.setViewportSize({ width: 600, height: 1024 })
    await page.goto('/admin/audit')
    const table = page.locator('main table').first()
    await expect(table).toBeVisible({ timeout: 15000 })
    const box = await table.evaluate((t) => {
      const parent = t.parentElement as HTMLElement
      return { overflowX: getComputedStyle(parent).overflowX, scrolls: parent.scrollWidth > parent.clientWidth, pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
    })
    // the table scrolls inside its box, not the page
    expect(box).toEqual({ overflowX: 'auto', scrolls: true, pageScrolls: false })
  })
})

test.describe('Prometheus toggle smoke — page error 0', () => {

  test('Dashboard 진입 + Prometheus Cluster Resource Utilization', async ({ page }) => {
    test.skip(!hasPrometheus(kubectlB), 'no Prometheus on default (deploy/kind/second-cluster.yaml)')
    await page.goto('/?cluster=default')
    const card = page.locator('h2').filter({ hasText: /Cluster Resource Utilization/i }).first()
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(page.locator('span.font-mono').filter({ hasText: /%/ }).first()).toHaveText(/\d+(\.\d+)?\s*%/)
  })

  test('Namespace detail — Real-time Resource Usage (Prometheus dependent)', async ({ page }) => {
    test.skip(!hasPrometheus(kubectlB), 'no Prometheus on default (deploy/kind/second-cluster.yaml)')
    const drawer = await openDrawer(page, '/cluster/namespaces?cluster=default', 'kube-system')
    await expect(drawer.locator('text=/Resource Summary/').first()).toBeVisible({ timeout: 15000 })
    const usage = drawer.locator('div.rounded-lg').filter({ has: page.getByText(/^Real-time Resource Usage$/i) }).first()
    await expect(usage).toBeVisible({ timeout: 20000 })
    await expect(usage).toContainText(/\d/)
  })
})
