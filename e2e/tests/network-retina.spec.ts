import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Recent flows and the Resource Graph's traffic lines from Microsoft Retina's Hubble control plane, on the kind
// cluster that scripts/kind-retina.sh up registers (kubeast-retina: kindnet, Retina with deploy/kind/retina-values.yaml,
// the Prometheus of deploy/kind/cilium-prometheus.yaml, the traffic of deploy/kind/cilium-demo.yaml). Retina's flows
// name pods without their workload and show a Service's own address where the client sends; its metrics leave the
// workload labels empty. Kubeast names the pods' workloads as the Hubble agent does and counts a connection where it
// arrives — compared with the cluster. Skips without that cluster.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = process.env.E2E_RETINA_CLUSTER || 'kubeast-retina'
const NS = 'flows-demo'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function retinaKubectl(): ((args: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-retina-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

type End = { namespace?: string; kind?: string; name?: string; outside?: string }
type Line = { from: End; to: End; allowed: number; dropped: number; ports?: { protocol?: string; port?: number }[] }
type FlowEnd = { namespace?: string; pod?: string; workload?: { kind: string; name: string }; ip?: string; service?: string; service_address?: boolean }
type Group = { source: FlowEnd; destination: FlowEnd; count: number }
const endText = (e: End) => (e.namespace && e.name ? `${e.namespace}/${e.name}` : e.namespace || e.outside || 'unknown')
const key = (l: Line) => `${endText(l.from)} → ${endText(l.to)}`

test.describe('Recent flows and traffic lines from Retina', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  let admin = ''
  let ready = false
  let podMetrics = false
  let kubectl: ((args: string) => string) | null = null

  function promDirect(expr: string): { metric: Record<string, string>; value: [number, string] }[] {
    const q = encodeURIComponent(expr)
    return JSON.parse(kubectl!(`get --raw "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${q}"`)).data.result
  }

  async function get(request: APIRequestContext, url: string, params: Record<string, string>) {
    const res = await request.get(url, { headers: bearer(admin), params: { cluster: CLUSTER, ...params }, failOnStatusCode: false })
    expect(res.status(), await res.text()).toBe(200)
    return res.json()
  }

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    expect(res.ok()).toBeTruthy()
    admin = (await res.json()).access_token
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    kubectl = retinaKubectl()
    if (!kubectl) return
    ready = features?.networkFlows?.enabled === true && (features.networkFlows.clusters ?? []).includes(CLUSTER) && kubectl('-n kube-system get ds retina-agent -o name') !== ''
    try {
      podMetrics = promDirect(`sum(hubble_tcp_flags_total{flag="SYN",destination_namespace="${NS}",destination_pod!=""})`).length > 0
    } catch {
      podMetrics = false
    }
  })

  test('a Deployment’s recent flows: its pods by name, with the workloads the cluster runs', async ({ request }) => {
    test.skip(!ready, `no Retina cluster ${CLUSTER} with network flows (scripts/kind-retina.sh up)`)
    const body = await get(request, `/api/v1/cluster/namespaces/${NS}/networkflows`, { kind: 'Deployment', name: 'web', since: '5m' })
    const groups = body.groups as Group[]
    // Retina's flows name no workload, so the Relay is asked for web's pods by name as well
    const webPods = kubectl!(`-n ${NS} get pods -l app=web -o jsonpath={.items[*].metadata.name}`).split(' ')
    const fromClient = groups.find((g) => g.source.workload?.name === 'client')
    expect(fromClient, JSON.stringify(groups.map((g) => [g.source.workload, g.destination.workload]))).toBeTruthy()
    expect(fromClient!.destination).toMatchObject({ namespace: NS, workload: { kind: 'Deployment', name: 'web' } })
    expect(webPods).toContain(fromClient!.destination.pod)
    expect(kubectl!(`-n ${NS} get pod ${fromClient!.source.pod} -o jsonpath={.metadata.labels.app}`)).toBe('client')
    // every group has web at one end
    for (const g of groups) expect([g.source.workload?.name, g.destination.workload?.name]).toContain('web')
  })

  test('a connection to a Service is one line, counted where it arrives', async ({ request }) => {
    test.skip(!ready, `no Retina cluster ${CLUSTER} with network flows (scripts/kind-retina.sh up)`)
    // the namespace's flows: client sends to the Service's own address, which Kubeast marks
    const flows = await get(request, `/api/v1/cluster/namespaces/${NS}/networkflows`, { since: '5m' })
    const webIP = kubectl!(`-n ${NS} get svc web -o jsonpath={.spec.clusterIP}`)
    const toService = (flows.groups as Group[]).find((g) => g.source.workload?.name === 'client' && g.destination.ip === webIP)
    expect(toService?.destination).toMatchObject({ service: `${NS}/web`, service_address: true })
    // the lines: client → web once, and no line to an address outside the pods
    const traffic = await get(request, '/api/v1/cluster/networktraffic', { namespaces: NS, source: 'relay', since: '5m' })
    const lines = traffic.lines as Line[]
    const byKey = new Map(lines.map((l) => [key(l), l]))
    expect(byKey.get(`${NS}/client → ${NS}/web`), [...byKey.keys()].join('; ')).toMatchObject({ from: { kind: 'Deployment' }, to: { kind: 'Deployment' }, ports: [{ protocol: 'TCP', port: 80 }] })
    expect(lines.filter((l) => l.to.outside), [...byKey.keys()].join('; ')).toEqual([])
    const workloads = new Set([NS, 'kube-system'].flatMap((ns) => kubectl!(`-n ${ns} get deploy,ds,sts -o name`).split('\n').map((n) => `${ns}/${n.split('/')[1]}`)))
    for (const l of lines) for (const e of [l.from, l.to]) if (e.namespace && e.name) expect(workloads, endText(e)).toContain(endText(e))
  })

  test('the metric lines name the pods’ workloads and are what the cluster’s Prometheus counts', async ({ request }) => {
    test.skip(!podMetrics, `no Hubble TCP metric with pod labels on cluster ${CLUSTER} (scripts/kind-retina.sh up)`)
    const body = await get(request, '/api/v1/cluster/networktraffic', { namespaces: NS, source: 'metrics', range: '1h' })
    expect(body).toMatchObject({ available: true, source: 'metrics', style: 'labels' })
    // the SYNs leaving towards the Service's address name no destination: not drawn, and said so
    expect(body.notes).toContain('pods_only_no_outside')
    const byKey = new Map((body.lines as Line[]).map((l) => [key(l), l]))
    const line = byKey.get(`${NS}/client → ${NS}/web`)
    expect(line, [...byKey.keys()].join('; ')).toMatchObject({ from: { kind: 'Deployment' }, to: { kind: 'Deployment' }, dropped: 0 })
    const syn = promDirect(`sum(increase(hubble_tcp_flags_total{flag="SYN",source_namespace="${NS}",source_pod=~"client-.+",destination_pod=~"web-.+",traffic_direction="ingress"}[3600s]))`)
    const opened = Math.round(Number(syn[0].value[1]))
    expect(Math.abs(line!.allowed - opened), `Kubeast ${line!.allowed}, Prometheus ${opened}`).toBeLessThanOrEqual(Math.max(20, opened / 10))
    expect([...byKey.values()].filter((l) => l.to.outside)).toEqual([])
  })

  test('the graph draws the line between the Deployments', async ({ page }) => {
    test.skip(!ready, `no Retina cluster ${CLUSTER} with network flows (scripts/kind-retina.sh up)`)
    await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}&namespace=${NS}`)
    await page.getByTestId('graph-view-traffic').click({ timeout: 20_000 })
    await expect(page.locator(`[aria-label="${NS}/client → ${NS}/web (TCP 80)"]`)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator(`[data-testid="rf__node-Deployment/${NS}/web"] [data-port-text="TCP 80"]`)).toHaveCount(1)
    await expect(page.getByTestId('traffic-peer').filter({ hasText: 'world' })).toHaveCount(0)
  })
})
