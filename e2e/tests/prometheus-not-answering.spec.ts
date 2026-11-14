import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster's Prometheus that is set but does not answer: cluster `default` is pointed at its own Prometheus Service on a
// port nothing serves, so each query is the server's 502 with its reason. The dashboard's Cluster Resource Utilization
// and a Pod drawer's Real-time Resource Usage say "Prometheus did not answer: <that reason>" where they used to leave
// the section out, as for a cluster with no Prometheus. The setting is put back and the dashboard's card returns.
// GPU Nodes' real-time panel and GPU Pods' metric columns say the same, while their lists keep their own empty row.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const PROMETHEUS = 'monitoring/prometheus:9090 (via K8s API proxy)'
const NOWHERE = 'monitoring/prometheus:9'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prom-silent-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('a Prometheus that is set but does not answer', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  let admin = ''
  let moved = false

  const status = async (request: APIRequestContext) =>
    (await request.get(`/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
  const patch = async (request: APIRequestContext, body: object) => {
    const res = await request.patch(`/api/v1/clusters/${CLUSTER}`, { headers: bearer(admin), data: body, failOnStatusCode: false })
    expect(res.status(), await res.text()).toBe(200)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const st = await status(request)
    test.skip(st.source !== 'proxy' || st.endpoint !== PROMETHEUS, `cluster ${CLUSTER} does not read ${PROMETHEUS} (${JSON.stringify(st)})`)
  })

  test.afterAll(async ({ request }) => {
    if (!admin || !moved) return
    await request.patch(`/api/v1/clusters/${CLUSTER}`, {
      headers: bearer(admin), data: { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } }, failOnStatusCode: false,
    })
  })

  test('the dashboard and a drawer say why instead of leaving the section out; the card comes back with the setting', async ({ page, request }) => {
    const pod = kubectlFor('kubeast-b')('-n kube-system get pods -o jsonpath={.items[0].metadata.name}')
    await patch(request, { prometheus_service: NOWHERE })
    moved = true

    // what the screens read: a query is the server's 502 and its reason
    let reason = ''
    await expect.poll(async () => {
      const res = await request.get(`/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=up`, { headers: bearer(admin), failOnStatusCode: false })
      if (res.status() !== 502) return res.status()
      reason = (await res.json()).detail
      return 502
    }, { timeout: 30_000 }).toBe(502)
    expect(reason, 'the 502 carries a reason').not.toBe('')

    await page.goto(`/?cluster=${CLUSTER}`)
    const card = page.getByTestId('prometheus-not-answering')
    await expect(card).toContainText('Cluster Resource Utilization', { timeout: 30_000 })
    await expect(card).toContainText(`Prometheus did not answer: ${reason}`)
    await expect(page.getByTestId('cluster-metric-cpu'), 'no metric slots without an answer').toHaveCount(0)

    await page.goto(`/workloads/pods?cluster=${CLUSTER}&detail=Pod/kube-system/${pod}`)
    const section = page.getByTestId('prometheus-not-answering')
    await expect(section).toContainText('Real-time Resource Usage', { timeout: 30_000 })
    await expect(section).toContainText(`Prometheus did not answer: ${reason}`)

    await patch(request, { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
    moved = false
    expect((await status(request)).endpoint, 'the setting is back').toBe(PROMETHEUS)
    await page.goto(`/?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-metric-cpu'), 'the card is back').toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('prometheus-not-answering')).toHaveCount(0)
  })

  // The GPU lists answered (no GPU node, no pod asking for one) and only the metrics read beside them failed: the empty
  // row is the list's "No items.", not "Could not load gpu (server error 502): …", and the metrics' place says why.
  test('GPU Nodes and GPU Pods on a cluster with no GPUs: the empty row says "No items." and the metrics say why', async ({ page, request }) => {
    const list = await (await request.get(`/api/v1/cluster/gpu/dashboard?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    test.skip(list.gpu_nodes.length > 0 || list.gpu_pods.length > 0, `cluster ${CLUSTER} has GPU nodes or GPU pods`)
    await patch(request, { prometheus_service: NOWHERE })
    moved = true

    // what the screens read: the list answers, the metrics read is the server's 502 and its reason — the first of its
    // four queries (gpu_util) failing, so no answer of the store from before the change is still in the server's cache
    let reason = ''
    await expect.poll(async () => {
      const res = await request.get(`/api/v1/cluster/gpu/metrics?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
      if (res.status() !== 502) return res.status()
      reason = (await res.json()).detail
      return reason.startsWith('GPU metric gpu_util: ') ? 502 : reason
    }, { timeout: 30_000 }).toBe(502)
    const listNow = await request.get(`/api/v1/cluster/gpu/dashboard?cluster=${CLUSTER}`, { headers: bearer(admin) })
    expect(listNow.status(), 'the GPU list still answers').toBe(200)

    await page.goto(`/gpu/nodes?cluster=${CLUSTER}`)
    await page.getByRole('button', { name: 'Metrics' }).click()
    const panel = page.getByTestId('gpu-realtime-not-answering')
    await expect(panel.locator('p')).toHaveText(`Prometheus did not answer: ${reason}`, { timeout: 30_000 })
    await expect(panel.locator('h2')).toHaveText('Real-time GPU Utilization')
    await expect(page.getByRole('cell', { name: 'No items.', exact: true }), 'GPU Nodes: the empty list').toHaveAttribute('colspan', '8')
    await expect(page.getByTestId('table-load-error'), 'GPU Nodes: no list failure').toHaveCount(0)

    await page.goto(`/gpu/pods?cluster=${CLUSTER}`)
    await expect(page.getByTestId('gpu-pods-metrics-not-answering')).toHaveText(`Prometheus did not answer: ${reason}`, { timeout: 30_000 })
    await expect(page.getByRole('cell', { name: 'No items.', exact: true }), 'GPU Pods: the empty list').toHaveAttribute('colspan', '9')
    await expect(page.getByTestId('table-load-error'), 'GPU Pods: no list failure').toHaveCount(0)

    await patch(request, { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
    moved = false
    expect((await status(request)).endpoint, 'the setting is back').toBe(PROMETHEUS)
    await page.goto(`/gpu/pods?cluster=${CLUSTER}`)
    await expect(page.getByRole('columnheader', { name: 'GPU Utilization', exact: true }), 'the metric columns are back').toHaveText('GPU Utilization', { timeout: 60_000 })
    await expect(page.getByTestId('gpu-pods-metrics-not-answering')).toHaveCount(0)
    await expect(page.getByRole('cell', { name: 'No items.', exact: true })).toHaveAttribute('colspan', '9')
  })
})
