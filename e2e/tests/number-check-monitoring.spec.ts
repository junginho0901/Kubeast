import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Number check of the node usage numbers (Monitoring's Nodes tab, the dashboard's top nodes): each node's CPU,
// memory and their percents are what `kubectl top nodes` prints from the same metrics — CPU rounded up to a
// millicore, memory in Mi rounded down, the share of the node's allocatable cut to a whole percent. Cluster
// `default` runs metrics-server; its kind node's allocatable equals its capacity, so the allocatable denominator
// itself is held by the Go test (TestNodeUsage_AsKubectlTopPrintsIt) and by the EKS check.

const CLUSTER = 'default'
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

type NodeRow = { name: string; cpu: string; memory: string; cpu_percent?: string; memory_percent?: string; timestamp?: string }
type TopRow = { name: string; cpu: string; cpu_percent: string; memory: string; memory_percent: string }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nummon-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login ${res.status()}`).toBe(true)
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// `kubectl top nodes --no-headers`: NAME CPU(cores) CPU(%) MEMORY(bytes) MEMORY(%)
const kubectlTop = (k: (a: string) => string): TopRow[] => k('top nodes --no-headers').split('\n').filter(Boolean).map((l) => {
  const [name, cpu, cpu_percent, memory, memory_percent] = l.trim().split(/\s+/)
  return { name, cpu, cpu_percent, memory, memory_percent }
})

const pick = (r: NodeRow | TopRow) => ({ cpu: r.cpu, cpu_percent: r.cpu_percent, memory: r.memory, memory_percent: r.memory_percent })

test.describe('Number check — node usage as kubectl top prints it', () => {
  test('Monitoring nodes and the dashboard top nodes give each node the numbers kubectl top nodes prints', async ({ page, request }) => {
    test.setTimeout(120_000)
    let k: (a: string) => string
    try { k = kubectlFor('kubeast-b') } catch { test.skip(true, 'kind cluster kubeast-b not found'); return }
    const h = await adminHeaders(request)
    const nodes = async () => (await request.get(`/api/v1/cluster/metrics/nodes?cluster=${CLUSTER}`, { headers: h })).json() as Promise<NodeRow[]>
    const first = await nodes()
    test.skip(first.length === 0, `no node metrics on cluster ${CLUSTER}`)

    // metrics-server answers one sample per node until its next scrape: read Kubeast, kubectl top, Kubeast again,
    // and compare only when both Kubeast reads carry the same sample (timestamps), so all three saw the same usage.
    await expect(async () => {
      const before = await nodes()
      const top = kubectlTop(k)
      const after = await nodes()
      expect(before.map((n) => n.timestamp), 'one metrics sample around the kubectl read').toEqual(after.map((n) => n.timestamp))
      const want = Object.fromEntries(top.map((t) => [t.name, pick(t)]))
      expect(Object.fromEntries(after.map((n) => [n.name, pick(n)])), 'GET /metrics/nodes = kubectl top nodes').toEqual(want)
      const tops = (await (await request.get(`/api/v1/cluster/metrics/top-resources?cluster=${CLUSTER}&pod_limit=1&node_limit=10`, { headers: h })).json()).top_nodes as NodeRow[]
      const again = await nodes()
      expect(again.map((n) => n.timestamp), 'still the same sample').toEqual(after.map((n) => n.timestamp))
      expect(Object.fromEntries(tops.map((n) => [n.name, pick(n)])), 'dashboard top nodes = kubectl top nodes').toEqual(want)
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] })

    // the Nodes tab draws the percents of the answer it got
    const answer = page.waitForResponse((r) => r.url().includes('/api/v1/cluster/metrics/nodes') && r.url().includes(`cluster=${CLUSTER}`))
    await page.goto(`/monitoring?cluster=${CLUSTER}`)
    const drawn = (await (await answer).json()) as NodeRow[]
    for (const n of drawn) {
      const card = page.getByTestId('monitoring-node').filter({ hasText: n.name })
      await expect(card).toContainText(n.cpu_percent ?? '-')
      await expect(card).toContainText(n.memory_percent ?? '-')
    }
  })
})
