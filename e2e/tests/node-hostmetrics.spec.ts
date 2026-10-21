import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Node values from the OpenTelemetry Collector's hostmetrics receiver instead of node-exporter
// (scripts/kind-hostmetrics.sh: a collector on the first cluster writes system_* series with cluster="kubeast"
// and k8s_node_name to the second cluster's Prometheus). Cluster `self` has no node-exporter; pointed at that
// Prometheus, its node drawer and dashboard fill from hostmetrics. The kind nodes share the Docker VM's kernel, so
// the memory and load figures match node-exporter's on the second cluster. Skipped without that collector.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const SELF = 'self'
const SECOND = 'default'

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-hostmetrics-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSelf = kubectlFor('kubeast')
const kubectlSecond = kubectlFor('kubeast-b')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function value(request: APIRequestContext, admin: string, cluster: string, q: string): Promise<number | undefined> {
  const res = await request.get(`/api/v1/cluster/prometheus/query?cluster=${cluster}&query=${encodeURIComponent(q)}`, { headers: bearer(admin) })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).results[0]?.value
}

test.describe('node values from OpenTelemetry hostmetrics', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let node = ''
  let secondNode = ''

  test.beforeAll(async ({ request }) => {
    try {
      kubectlSelf('-n hostmetrics rollout status ds/hostmetrics --timeout=5s')
    } catch {
      test.skip(true, 'no hostmetrics collector on the first kind cluster — run scripts/kind-hostmetrics.sh up')
    }
    admin = await login(request)
    const st = await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SELF}`, { headers: bearer(admin) })).json()
    test.skip(st.source === 'external', `cluster ${SELF} already names an external store (${st.endpoint})`)
    test.skip(kubectlSelf('get svc -A --no-headers').split('\n').some((l) => /\bnode-exporter\b/.test(l)), `cluster ${SELF} runs node-exporter`)
    node = kubectlSelf(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    secondNode = kubectlSecond(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    const nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
    const res = await request.patch(`/api/v1/clusters/${SELF}`, {
      headers: bearer(admin),
      data: { prometheus_url: `http://${nodeIP}:30090`, prometheus_cluster_label: 'kubeast', prometheus_auth: { type: 'none' } },
    })
    expect(res.status(), await res.text()).toBe(200)
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await request.patch(`/api/v1/clusters/${SELF}`, {
      headers: bearer(admin),
      data: { prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } },
    })
  })

  test('the store has the node series, and memory and load match node-exporter on the same kernel', async ({ request }) => {
    const sel = `k8s_node_name="${node}"`
    await expect
      .poll(() => value(request, admin, SELF, `count(system_cpu_time_seconds_total{${sel}})`), { timeout: 120_000, intervals: [5_000] })
      .toBeGreaterThan(0)
    for (const name of ['system_memory_usage_bytes', 'system_memory_limit_bytes', 'system_cpu_load_average_1m', 'system_network_io_bytes_total', 'system_disk_io_bytes_total']) {
      expect(await value(request, admin, SELF, `count(${name}{${sel}})`), name).toBeGreaterThan(0)
    }
    // a collector upgrade leaves the old version's series (otel_scope_version) for minutes: count each once, as the drawer does
    const one = (s: string) => `max without (otel_scope_name, otel_scope_version) (${s})`
    const memory = await value(request, admin, SELF, `100 * sum(${one(`system_memory_usage_bytes{state="used",${sel}}`)}) / sum(${one(`system_memory_limit_bytes{${sel}}`)})`)
    const memoryNE = await value(request, admin, SECOND, '(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100')
    expect(Math.abs((memory as number) - (memoryNE as number)), `hostmetrics ${memory} vs node-exporter ${memoryNE}`).toBeLessThan(5)
    const total = await value(request, admin, SELF, `sum(${one(`system_memory_limit_bytes{${sel}}`)})`)
    const totalNE = await value(request, admin, SECOND, 'sum(node_memory_MemTotal_bytes)')
    expect(total).toBe(totalNE)
    // the two collectors read the kernel at different moments: compare two-minute averages, not one sample each
    const load = await value(request, admin, SELF, `max(avg_over_time(system_cpu_load_average_1m{${sel}}[2m]))`)
    const loadNE = await value(request, admin, SECOND, 'max(avg_over_time(node_load1[2m]))')
    expect(Math.abs((load as number) - (loadNE as number)), `hostmetrics ${load} vs node-exporter ${loadNE}`).toBeLessThan(2)
    const cpu = await value(request, admin, SELF, `100 * (1 - sum(${one(`rate(system_cpu_time_seconds_total{state="idle",${sel}}[5m])`)}) / sum(${one(`system_cpu_logical_count{${sel}}`)}))`)
    const cpuNE = await value(request, admin, SECOND, '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)')
    expect(Math.abs((cpu as number) - (cpuNE as number)), `hostmetrics ${cpu} vs node-exporter ${cpuNE}`).toBeLessThan(5)
    expect(secondNode).not.toBe(node)
  })

  test('the node drawer and the dashboard fill from hostmetrics', async ({ request, page }) => {
    await page.goto(`/cluster/nodes?cluster=${SELF}`)
    await page.getByRole('cell', { name: node, exact: true }).first().click({ timeout: 30_000 })
    const section = page.locator('div.rounded-lg').filter({ has: page.getByText(/Real-time Metrics|실시간/i) }).first()
    await expect(section).toContainText(/CPU Usage/, { timeout: 30_000 })
    const card = (label: string) => section.locator('div.rounded-lg.border.px-3').filter({ hasText: label }).first()
    const shown = async (label: string) => parseFloat(((await card(label).textContent()) ?? '').replace(label, ''))
    // The card and a fresh query of the same figure agree (the page refetches every 30 s).
    const sel = `k8s_node_name="${node}"`
    await expect
      .poll(async () => {
        const api = await value(request, admin, SELF, `100 * sum(system_memory_usage_bytes{state="used",${sel}}) / sum(system_memory_limit_bytes{${sel}})`)
        return Math.abs((await shown('Memory Usage')) - (api as number))
      }, { timeout: 60_000, intervals: [5_000] })
      .toBeLessThan(2)
    expect(await shown('CPU Usage')).toBeGreaterThanOrEqual(0)
    expect(await shown('Load (1m)')).toBeGreaterThanOrEqual(0)
    await expect(section).toContainText(/Network I\/O[\s\S]*Receive[\s\S]*MB\/s/)
    await expect(section).toContainText(/24h CPU%/)

    await page.goto(`/?cluster=${SELF}`)
    const dash = page.locator('div.card').filter({ has: page.getByRole('heading', { name: /Cluster Resource Utilization|클러스터 리소스/ }) })
    await expect(dash).toContainText(/CPU[\s\S]*\d+(\.\d+)?%/, { timeout: 30_000 })
    await expect(dash).toContainText(/Memory[\s\S]*\d+(\.\d+)?%/)
  })
})
