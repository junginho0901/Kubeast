import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Lists that open the resource drawer from a row and search and page their rows: Monitoring's two tabs, Cost,
// Cluster hygiene, the dashboard's Optimization window, the Nodes page's top-usage cards and the admin Access
// requests. Compared with the API on cluster `default` (the second kind cluster: metrics-server, OpenCost).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const NS = 'kube-system'
const CLUSTER = 'default'
const MIB = 1024 ** 2

type NodeMetric = { name: string }
type PodMetric = { name: string; namespace: string }
type PodInfo = { name: string; namespace: string; containers?: { resources?: { limits?: Record<string, string> } }[] }
type CostRow = { name: string; namespace: string; kind?: string }

async function headers(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// The same rule as frontend/src/pages/monitoring/podUsage.ts: a limit only when every container sets one.
function memoryLimitMiB(pod: PodInfo | undefined): number | null {
  const units: Record<string, number> = { Ki: 1024, Mi: MIB, Gi: 1024 ** 3 }
  if (!pod?.containers?.length) return null
  let total = 0
  for (const c of pod.containers) {
    const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/.exec(c.resources?.limits?.memory ?? '')
    if (!m) return null
    total += Number(m[1]) * (m[2] ? units[m[2]] : 1)
  }
  return Math.round(total / MIB)
}

// the pager's total: "Showing 1-50 of 80" / "80개 중 1-50 표시"
const pagerTotal = (n: number) => new RegExp(`of ${n}(?!\\d)|(?<!\\d)${n}개 중`)
const detailOf = (page: Page) => new URL(page.url()).searchParams.get('detail')

test.describe('Rows that open the drawer, lists that search and page', () => {
  test('nodes: the search narrows by name, the pager counts them and a card opens its Node', async ({ page, request }) => {
    const res = await request.get('/api/v1/cluster/metrics/nodes', { headers: await headers(request), params: { cluster: CLUSTER } })
    test.skip(!res.ok(), `node metrics: ${res.status()}`)
    const nodes: NodeMetric[] = await res.json()
    test.skip(nodes.length === 0, 'no node metrics on cluster default')

    await page.goto(`/monitoring?cluster=${CLUSTER}`)
    await expect(page.getByTestId('monitoring-node')).toHaveCount(Math.min(nodes.length, 20))
    await expect(page.getByTestId('monitoring-node-pager')).toContainText(pagerTotal(nodes.length))

    await page.getByTestId('monitoring-node-search').fill('no-such-node-e2e')
    await expect(page.getByTestId('monitoring-node')).toHaveCount(0)
    await expect(page.getByTestId('monitoring-node-empty')).toHaveText(/No results found|검색 결과가 없습니다/)

    const target = nodes[0].name
    await page.getByTestId('monitoring-node-search').fill(target)
    await expect(page.getByTestId('monitoring-node')).toHaveCount(nodes.filter((n) => n.name.includes(target)).length)
    await page.getByTestId('monitoring-node').first().click()
    await expect.poll(() => detailOf(page)).toBe(`Node/${target}`)
  })

  test('pods: rows of the namespace, the limit as the containers set it, a row opens its Pod', async ({ page, request }) => {
    const h = await headers(request)
    const metricsRes = await request.get('/api/v1/cluster/metrics/pods', { headers: h, params: { cluster: CLUSTER, namespace: NS } })
    test.skip(!metricsRes.ok(), `pod metrics: ${metricsRes.status()}`)
    const metrics: PodMetric[] = await metricsRes.json()
    test.skip(metrics.length === 0, `no pod metrics in ${NS}`)
    const pods: PodInfo[] = await (await request.get('/api/v1/cluster/pods/all', { headers: h, params: { cluster: CLUSTER } })).json()
    const byName = new Map(pods.filter((p) => p.namespace === NS).map((p) => [p.name, p]))

    await page.goto(`/monitoring?cluster=${CLUSTER}`)
    await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
    await page.getByTestId('monitoring-namespace').click()
    await page.getByTestId(`monitoring-namespace-opt-${NS}`).click()
    await expect(page.getByTestId('monitoring-pod-row')).toHaveCount(Math.min(metrics.length, 50))
    await expect(page.getByTestId('monitoring-pod-pager')).toContainText(pagerTotal(metrics.length))

    // A pod whose every container sets a memory limit shows their sum; the CPU column of a pod without one shows "-".
    const limited = metrics.find((m) => memoryLimitMiB(byName.get(m.name)) !== null)
    test.skip(!limited, `no pod in ${NS} with memory limits on every container`)
    const name = limited!.name
    await page.getByTestId('monitoring-pod-search').fill(name)
    const row = page.getByTestId('monitoring-pod-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.locator('td').nth(5)).toHaveText(new RegExp(`^${memoryLimitMiB(byName.get(name))}Mi \\(\\d+%\\)$`))
    const cpuLimited = (byName.get(name)?.containers ?? []).every((c) => !!c.resources?.limits?.cpu)
    if (!cpuLimited) await expect(row.locator('td').nth(3)).toHaveText('-')

    await row.click()
    await expect.poll(() => detailOf(page)).toBe(`Pod/${NS}/${name}`)
  })

  test('cost: a namespace row opens the Namespace, a workload row its workload, a bucket row nothing', async ({ page, request }) => {
    const h = await headers(request)
    const nsRes = await request.get('/api/v1/cluster/cost', { headers: h, params: { cluster: CLUSTER, window: '24h', aggregate: 'namespace' } })
    test.skip(!nsRes.ok(), `cost: ${nsRes.status()}`)
    const nsRows: CostRow[] = (await nsRes.json()).rows
    const ns = nsRows.find((r) => !r.name.startsWith('__'))
    test.skip(!ns, 'no namespace row in the cost table')

    await page.goto(`/cost?cluster=${CLUSTER}`)
    await page.getByTestId('cost-search').fill(ns!.name)
    const nsRow = page.getByTestId('cost-row').filter({ hasText: ns!.name }).first()
    await expect(nsRow).toHaveAttribute('data-openable', 'true')
    await nsRow.click()
    await expect.poll(() => detailOf(page)).toBe(`Namespace/${ns!.name}`)
    await page.goto(`/cost?cluster=${CLUSTER}`) // a fresh page without the drawer

    const wlRows: CostRow[] = (await (await request.get('/api/v1/cluster/cost', { headers: h, params: { cluster: CLUSTER, window: '24h', aggregate: 'controller' } })).json()).rows
    // the workload kinds the drawer opens (frontend/src/pages/Cost.tsx DRAWER_KINDS)
    const deploy = wlRows.find((r) => r.kind && ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod'].includes(r.kind))
    test.skip(!deploy, 'no workload row the drawer opens in the cost table')
    await page.getByRole('tab', { name: /by workload|워크로드별/i }).click()
    await page.getByTestId('cost-search').fill(deploy!.name)
    const wlRow = page.getByTestId('cost-row').filter({ hasText: `${deploy!.kind}/${deploy!.name}` }).first()
    await wlRow.click()
    await expect.poll(() => detailOf(page)).toBe(`${deploy!.kind}/${deploy!.namespace}/${deploy!.name}`)

    // OpenCost's "no controller" bucket is a cost, not an object: its rows open nothing.
    const buckets = wlRows.filter((r) => r.name === '__unallocated__')
    if (buckets.length > 0) {
      await page.goto(`/cost?cluster=${CLUSTER}`)
      await page.getByRole('tab', { name: /by workload|워크로드별/i }).click()
      await page.getByTestId('cost-search').fill('__unallocated__')
      await expect(page.locator('[data-testid="cost-row"][data-openable="false"]').first()).toBeVisible()
      await expect(page.locator('[data-testid="cost-row"][data-openable="true"]')).toHaveCount(0)
      await page.getByTestId('cost-row').first().click()
      await expect.poll(() => detailOf(page)).toBeNull()
    }
  })

  test('cluster hygiene: a finding on the selected cluster opens its object, the pager counts the report', async ({ page, request }) => {
    const res = await request.get('/api/v1/cluster/hygiene', { headers: await headers(request), params: { cluster: CLUSTER } })
    test.skip(!res.ok(), `hygiene: ${res.status()}`)
    const findings: { kind: string; name: string; namespace?: string }[] = (await res.json()).report?.findings ?? []
    test.skip(!findings.some((f) => f.kind !== 'API' && f.name), 'no finding that names an object on cluster default')

    await page.goto(`/admin/cluster-hygiene?cluster=${CLUSTER}`)
    await expect(page.getByTestId('hygiene-pager')).toContainText(pagerTotal(findings.length), { timeout: 30_000 })
    const row = page.locator('[data-testid="hygiene-finding-row"][data-openable="true"]').first()
    const ns = (await row.locator('td').nth(2).innerText()).trim()
    const [kind, ...rest] = (await row.locator('td').nth(3).locator('span').first().innerText()).replace(/\u200b/g, '').trim().split('/')
    const name = rest.join('/')
    expect(findings.some((f) => f.kind === kind && f.name === name && (f.namespace || '-') === ns)).toBe(true)
    await row.click()
    await expect.poll(() => detailOf(page)).toBe(ns === '-' ? `${kind}/${name}` : `${kind}/${ns}/${name}`)
  })

  test('optimization window: a workload opens its own drawer over the window', async ({ page, request }) => {
    const res = await request.get('/api/v1/cluster/optimization', { headers: await headers(request), params: { cluster: CLUSTER, namespace: NS } })
    test.skip(!res.ok(), `optimization: ${res.status()}`)
    const rows: { kind: string; name: string }[] = (await res.json()).rows ?? []
    test.skip(rows.length === 0, `no workload in ${NS}`)

    await page.goto(`/?cluster=${CLUSTER}`)
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: NS, exact: true }).click()
    const open = page.getByTestId('optimization-open').first()
    await expect(open).toBeVisible({ timeout: 20_000 })
    const [kind, name] = (await open.innerText()).trim().split('/')
    expect(rows.some((r) => r.kind === kind && r.name === name)).toBe(true)
    await open.click()
    await expect.poll(() => detailOf(page)).toBe(`${kind}/${NS}/${name}`)
  })

  test('nodes page: a top-usage card opens its Node', async ({ page, request }) => {
    const res = await request.get('/api/v1/cluster/metrics/nodes', { headers: await headers(request), params: { cluster: CLUSTER } })
    test.skip(!res.ok(), `node metrics: ${res.status()}`)
    const nodes: NodeMetric[] = await res.json()
    test.skip(nodes.length === 0, 'no node metrics on cluster default')

    await page.goto(`/cluster/nodes?cluster=${CLUSTER}`)
    const card = page.getByTestId('node-top-usage').first()
    const name = (await card.locator('span').first().innerText()).replace(/^#\d+\s+/, '').trim()
    expect(nodes.map((n) => n.name)).toContain(name)
    await card.click()
    await expect.poll(() => detailOf(page)).toBe(`Node/${name}`)
  })

  test('access requests: the pager counts the pending requests, the search narrows them', async ({ page, request }) => {
    const res = await request.get('/api/v1/auth/admin/access-requests', { headers: await headers(request), params: { status: 'pending' } })
    expect(res.ok(), `access requests: ${res.status()}`).toBeTruthy()
    const pending: unknown[] = await res.json()

    await page.goto('/admin/access-requests')
    await expect(page.getByTestId('access-requests-pager')).toContainText(pagerTotal(pending.length))
    await page.getByTestId('access-requests-search').fill('no-such-requester-e2e')
    await expect(page.getByTestId('access-requests-table-pending')).toContainText(/No results found|검색 결과가 없습니다/)
    await expect(page.getByTestId('access-requests-pager')).toContainText(/Showing 0 of 0|0개 중 0/)
  })
})
