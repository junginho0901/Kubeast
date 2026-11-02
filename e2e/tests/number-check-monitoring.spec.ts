import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Number check of the node usage numbers (Monitoring's Nodes tab, the dashboard's top nodes): each node's CPU,
// memory and their percents are what `kubectl top nodes` prints from the same metrics — CPU rounded up to a
// millicore, memory in Mi rounded down, the share of the node's allocatable cut to a whole percent. Cluster
// `default` runs metrics-server; its kind node's allocatable equals its capacity, so the allocatable denominator
// itself is held by the Go test (TestNodeUsage_AsKubectlTopPrintsIt) and by the EKS check. A node the
// metrics-server has no sample for is a card with -, as kubectl top lists it with <unknown>. The Pods tab's limits
// are the pod cgroup's the kubelet wrote on the node (memory.max, cpu.max).

const CLUSTER = 'default'
const MONITORING = { path: '/monitoring', cluster: CLUSTER }
const NS = 'e2e-nummon'
const MIB = 1024 ** 2
// The kubelet's pod limit is not the app containers' sum: a sidecar adds to it and an init container's peak
// (with the sidecars started before it) can be above it (limits-sidecar: 400m and 128Mi, its app 150m and 48Mi);
// an init container without a limit leaves the pod without one (limits-open-init); a pod-level limit wins
// (limits-pod-level: 200m and 64Mi, its app has none).
const FIXTURE = `
apiVersion: v1
kind: Namespace
metadata: {name: ${NS}}
---
apiVersion: v1
kind: Pod
metadata: {name: limits-sidecar, namespace: ${NS}}
spec:
  terminationGracePeriodSeconds: 0
  initContainers:
  - {name: proxy, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400'], restartPolicy: Always, resources: {limits: {cpu: 100m, memory: 32Mi}}}
  - {name: setup, image: docker.io/library/busybox:1.38.0, command: ['true'], resources: {limits: {cpu: 300m, memory: 96Mi}}}
  containers:
  - {name: app, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400'], resources: {limits: {cpu: 150m, memory: 48Mi}}}
---
apiVersion: v1
kind: Pod
metadata: {name: limits-open-init, namespace: ${NS}}
spec:
  terminationGracePeriodSeconds: 0
  initContainers:
  - {name: setup, image: docker.io/library/busybox:1.38.0, command: ['true']}
  containers:
  - {name: app, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400'], resources: {limits: {cpu: 150m, memory: 48Mi}}}
---
apiVersion: v1
kind: Pod
metadata: {name: limits-pod-level, namespace: ${NS}}
spec:
  terminationGracePeriodSeconds: 0
  resources: {limits: {cpu: 200m, memory: 64Mi}}
  containers:
  - {name: app, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400']}
  - {name: helper, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400'], resources: {limits: {cpu: 50m, memory: 16Mi}}}
`
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

type NodeRow = { name: string; cpu: string; memory: string; cpu_percent?: string; memory_percent?: string; timestamp?: string }
type TopRow = { name: string; cpu: string; cpu_percent: string; memory: string; memory_percent: string }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nummon-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

// The pod's cgroup on its kind node (a container of that name) as the kubelet sized it: memory.max in bytes and
// cpu.max as "<quota> <period>", "max" where it set no limit.
function cgroupLimits(node: string, uid: string) {
  const [mem, cpu] = execSync(
    `docker exec ${node} sh -c 'd=$(find /sys/fs/cgroup -type d -name "*pod${uid.replaceAll('-', '_')}.slice" | head -1); cat "$d/memory.max" "$d/cpu.max"'`,
    { encoding: 'utf8' },
  ).trim().split('\n')
  const [quota, period] = cpu.split(' ')
  return { cpu_limit_millicores: quota === 'max' ? null : (Number(quota) * 1000) / Number(period), memory_limit_bytes: mem === 'max' ? null : Number(mem) }
}

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login ${res.status()}`).toBe(true)
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// `kubectl top nodes --no-headers`: NAME CPU(cores) CPU(%) MEMORY(bytes) MEMORY(%); a node without a sample is
// <unknown> there and not in the metrics API (the Nodes tab adds it, the next test)
const kubectlTop = (k: (a: string) => string): TopRow[] => k('top nodes --no-headers').split('\n').filter(Boolean).map((l) => {
  const [name, cpu, cpu_percent, memory, memory_percent] = l.trim().split(/\s+/)
  return { name, cpu, cpu_percent, memory, memory_percent }
}).filter((r) => r.cpu !== '<unknown>')

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
    await page.goto(`${MONITORING.path}?cluster=${MONITORING.cluster}`)
    const drawn = (await (await answer).json()) as NodeRow[]
    for (const n of drawn) {
      const card = page.getByTestId('monitoring-node').filter({ hasText: n.name })
      await expect(card).toContainText(n.cpu_percent ?? '-')
      await expect(card).toContainText(n.memory_percent ?? '-')
    }
  })

  test('a node the metrics-server has no sample for is a card with -, counted in the total and the pager', async ({ page, request }) => {
    const h = await adminHeaders(request)
    const metrics = (await (await request.get(`/api/v1/cluster/metrics/nodes?cluster=${CLUSTER}`, { headers: h })).json()) as NodeRow[]
    test.skip(metrics.length === 0, `no node metrics on cluster ${CLUSTER}`)
    // a node that joined before the metrics-server's next scrape: in the node list, not in the metrics
    const joined = 'e2e-node-without-metrics'
    await page.route((u) => u.pathname === '/api/v1/cluster/nodes', async (route) => {
      const res = await route.fetch()
      const list = (await res.json()) as { name: string }[]
      await route.fulfill({ response: res, json: [...list, { ...list[0], name: joined }] })
    })
    await page.goto(`${MONITORING.path}?cluster=${MONITORING.cluster}`)
    const total = metrics.length + 1
    const cards = page.getByTestId('monitoring-node')
    await expect(cards).toHaveCount(total)
    await expect(cards.last()).toContainText(joined)
    await expect(cards.last()).not.toContainText('%')
    await expect(page.getByText(new RegExp(`^(Total ${total} nodes|총 ${total}개 Node)$`))).toHaveCount(1)
    await expect(page.getByTestId('monitoring-node-pager')).toContainText(new RegExp(`of ${total}(?!\\d)|(?<!\\d)${total}개 중`))
  })

  test('the Pods tab shows the limits the kubelet gave each pod cgroup', async ({ page, request }) => {
    test.setTimeout(240_000)
    let k: (a: string, input?: string) => string
    try { k = kubectlFor('kubeast-b') } catch { test.skip(true, 'kind cluster kubeast-b not found'); return }
    // a run before this one leaves the namespace terminating: new pods, not its last ones
    k(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
    k('apply -f -', FIXTURE)
    try {
      k(`wait --for=condition=Ready pod --all -n ${NS} --timeout=120s`)
      const pods = JSON.parse(k(`get pods -n ${NS} -o json`)).items as { metadata: { name: string; uid: string }; spec: { nodeName: string } }[]
      const want = Object.fromEntries(pods.map((p) => [p.metadata.name, cgroupLimits(p.spec.nodeName, p.metadata.uid)]))
      expect(Object.keys(want).sort(), 'fixture pods').toEqual(['limits-open-init', 'limits-pod-level', 'limits-sidecar'])

      const h = await adminHeaders(request)
      type PodRow = { name: string; cpu_limit_millicores?: number | null; memory_limit_bytes?: number | null }
      let rows: PodRow[] = []
      // the metrics-server lists a pod once it has two samples of it
      await expect(async () => {
        rows = (await (await request.get(`/api/v1/cluster/metrics/pods?cluster=${CLUSTER}&namespace=${NS}&with_limits=1`, { headers: h })).json()) as PodRow[]
        expect(rows.map((r) => r.name).sort(), 'pods with metrics').toEqual(Object.keys(want).sort())
      }).toPass({ timeout: 150_000, intervals: [5_000] })
      const got = Object.fromEntries(rows.map((r) => [r.name, { cpu_limit_millicores: r.cpu_limit_millicores ?? null, memory_limit_bytes: r.memory_limit_bytes ?? null }]))
      expect(got, 'GET /metrics/pods?with_limits=1 = the pod cgroups').toEqual(want)

      await page.goto(`${MONITORING.path}?cluster=${MONITORING.cluster}`)
      await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
      await page.getByTestId('monitoring-namespace').click()
      await page.getByTestId(`monitoring-namespace-opt-${NS}`).click()
      await expect(page.getByTestId('monitoring-pod-row')).toHaveCount(3)
      for (const [name, lim] of Object.entries(want)) {
        const row = page.getByTestId('monitoring-pod-row').filter({ hasText: name })
        await expect(row.locator('td').nth(3)).toHaveText(lim.cpu_limit_millicores === null ? '-' : new RegExp(`^${lim.cpu_limit_millicores}m \\(\\d+%\\)$`))
        await expect(row.locator('td').nth(5)).toHaveText(lim.memory_limit_bytes === null ? '-' : new RegExp(`^${Math.round(lim.memory_limit_bytes / MIB)}Mi \\(\\d+%\\)$`))
      }
    } finally {
      k(`delete namespace/${NS} --wait=false --ignore-not-found`)
    }
  })
})
