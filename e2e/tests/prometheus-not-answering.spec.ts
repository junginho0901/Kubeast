import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster's Prometheus that is set but does not answer: cluster `default` is pointed at its own Prometheus Service on a
// port nothing serves, so each query is the server's 502 with its reason. The dashboard's Cluster Resource Utilization
// and a Pod drawer's Real-time Resource Usage say "Prometheus did not answer: <that reason>" where they used to leave
// the section out, as for a cluster with no Prometheus. The setting is put back and the dashboard's card returns.

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
})
