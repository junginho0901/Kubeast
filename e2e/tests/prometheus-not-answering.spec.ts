import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster's Prometheus that is set but does not answer: cluster `default` is pointed at its own Prometheus Service on a
// port nothing serves, so each query is the server's 502 with its reason. The dashboard's Cluster Resource Utilization
// and a Pod drawer's Real-time Resource Usage say "Prometheus did not answer: <that reason>" where they used to leave
// the section out, as for a cluster with no Prometheus; the Resource Graph keeps its Structure/Traffic switch and says
// the status's reason where the metrics sources were. The setting is put back and the card and the sources return.
// GPU Nodes' real-time panel and GPU Pods' metric columns say the same, while their lists keep their own empty row.
// A Read user refused the Prometheus (a Service its proxy Role does not name) keeps that empty row too, the refused
// read named in the banner.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const PROMETHEUS = 'monitoring/prometheus:9090 (via K8s API proxy)'
const NOWHERE = 'monitoring/prometheus:9'
// the same Prometheus under another Service: the Read group's proxy Role names monitoring/prometheus:9090 only (viewer-proxy.spec.ts)
const REFUSED_TO_READ = 'monitoring/prometheus-nodeport:9090'
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

    // the Resource Graph reads the status, which answers 200 with available false and its message
    let statusMessage = ''
    await expect.poll(async () => {
      const st = await status(request)
      statusMessage = st.message ?? ''
      return st.available
    }, { timeout: 30_000 }).toBe(false)
    expect(statusMessage, 'the status says why').not.toBe('')
    await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}`)
    await page.getByTestId('graph-view-traffic').click({ timeout: 30_000 })
    await expect(page.getByTestId('traffic-metrics-failure')).toHaveText(`Prometheus did not answer: ${statusMessage}`)
    await expect(page.getByTestId('traffic-source-1h'), 'no metrics source without an answer').toHaveCount(0)

    await patch(request, { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
    moved = false
    expect((await status(request)).endpoint, 'the setting is back').toBe(PROMETHEUS)
    await page.goto(`/?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-metric-cpu'), 'the card is back').toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('prometheus-not-answering')).toHaveCount(0)
    await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}`)
    await page.getByTestId('graph-view-traffic').click({ timeout: 30_000 })
    await expect(page.getByTestId('traffic-source-24h'), 'the metrics sources are back').toHaveText('Metrics 24h', { timeout: 30_000 })
    await expect(page.getByTestId('traffic-metrics-failure')).toHaveCount(0)
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

  // The metrics read refused (403) beside a list that answered was the list's refusal: the empty row said "You do not
  // have permission to view gpu in this cluster." The banner above the page keeps naming the refused read.
  test('GPU Nodes and GPU Pods for a Read user refused the Prometheus: the empty row says "No items." and the banner names the read', async ({ browser, request }) => {
    const list = await (await request.get(`/api/v1/cluster/gpu/dashboard?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    test.skip(list.gpu_nodes.length > 0 || list.gpu_pods.length > 0, `cluster ${CLUSTER} has GPU nodes or GPU pods`)
    const id = Date.now().toString(36)
    const email = `e2e-prom-refused-${id}@kubeast.local`
    const password = `prom-refused-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E prom refused ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      expect(put.ok(), await put.text()).toBeTruthy()
      await patch(request, { prometheus_service: REFUSED_TO_READ })
      moved = true
      const signedIn = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(signedIn.ok(), `login ${email}`).toBeTruthy()
      const asUser = bearer((await signedIn.json()).access_token as string)
      // what the screens read: the list answers the user, the metrics read is refused to the user and answers the admin
      expect((await request.get(`/api/v1/cluster/gpu/dashboard?cluster=${CLUSTER}`, { headers: asUser })).status(), 'the GPU list').toBe(200)
      await expect.poll(async () => (await request.get(`/api/v1/cluster/gpu/metrics?cluster=${CLUSTER}`, { headers: asUser, failOnStatusCode: false })).status(), { timeout: 30_000 }).toBe(403)
      expect((await request.get(`/api/v1/cluster/gpu/metrics?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })).status(), 'the admin reads it').toBe(200)

      const user = await ctx.newPage()
      await user.goto('/login')
      await user.locator('input[autocomplete="email"]').first().fill(email)
      await user.locator('input[type="password"]').first().fill(password)
      await user.locator('button[type="submit"]').first().click()
      await user.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
      for (const [screen, columns] of [['nodes', '8'], ['pods', '9']] as const) {
        await user.goto(`/gpu/${screen}?cluster=${CLUSTER}`)
        // the banner comes with the metrics' 403, so the row below is read after that refusal
        await expect(user.getByTestId('forbidden-banner'), `GPU ${screen}: the banner`).toContainText(/You do not have permission to view (.+, )?gpu(, .+)? in this cluster/, { timeout: 30_000 })
        await expect(user.getByRole('cell', { name: 'No items.', exact: true }), `GPU ${screen}: the empty list`).toHaveAttribute('colspan', columns)
        await expect(user.getByTestId('table-forbidden'), `GPU ${screen}: no list refused`).toHaveCount(0)
      }
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
      if (moved) {
        await patch(request, { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
        moved = false
      }
    }
    expect((await status(request)).endpoint, 'the setting is back').toBe(PROMETHEUS)
  })
})
