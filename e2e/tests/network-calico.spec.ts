import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Recent flows and the Resource Graph's traffic lines from Calico's Whisker, on the kind cluster that
// scripts/kind-calico.sh up registers (kubeast-calico: a control plane and a worker, Calico through the Tigera
// operator with Goldmane and Whisker, the policy that lets the API server reach Whisker, the traffic of
// deploy/kind/cilium-demo.yaml — client reaches web on port 80, the NetworkPolicy web-only-client denies stranger).
// Read through the API server service proxy as the user, compared with the cluster. Skips without that cluster.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = process.env.E2E_CALICO_CLUSTER || 'kubeast-calico'
const NS = 'flows-demo'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function calicoKubectl(): ((args: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-calico-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

type End = { namespace?: string; kind?: string; name?: string; outside?: string }
type Line = { from: End; to: End; allowed: number; dropped: number; ports?: { protocol?: string; port?: number }[] }
type FlowEnd = { namespace?: string; pod?: string; workload?: { kind: string; name: string } }
type Group = { source: FlowEnd; destination: FlowEnd; verdict: string; drop_reason?: string; count: number; policies?: { ingress_allowed_by?: { kind: string; namespace: string; name: string }[] } }
const endText = (e: End) => (e.namespace && e.name ? `${e.namespace}/${e.name}` : e.namespace || e.outside || 'unknown')
const key = (l: Line) => `${endText(l.from)} → ${endText(l.to)}`

test.describe('Recent flows and traffic lines from Calico', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  let admin = ''
  let ready = false
  let kubectl: ((args: string) => string) | null = null

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
    kubectl = calicoKubectl()
    ready = !!kubectl && features?.networkFlows?.providers?.[CLUSTER] === 'calico'
  })

  test('a Deployment’s recent flows: what Calico allowed and denied, and the policy that allowed it', async ({ request }) => {
    test.skip(!ready, `no Calico cluster ${CLUSTER} with network flows (scripts/kind-calico.sh up)`)
    const body = await get(request, `/api/v1/cluster/namespaces/${NS}/networkflows`, { kind: 'Deployment', name: 'web', since: '5m' })
    expect(body).toMatchObject({ provider: 'calico', relay: 'calico-system/whisker:8443', mode: 'proxy' })
    const groups = body.groups as Group[]
    const allowed = groups.find((g) => g.source.workload?.name === 'client' && g.verdict === 'FORWARDED')
    expect(allowed, JSON.stringify(groups)).toBeTruthy()
    // the policy Calico names is the cluster's
    expect(kubectl!(`-n ${NS} get networkpolicy web-only-client -o name`)).toBe('networkpolicy.networking.k8s.io/web-only-client')
    expect(allowed!.policies?.ingress_allowed_by).toEqual([{ kind: 'NetworkPolicy', namespace: NS, name: 'web-only-client' }])
    // Calico names a pod set by its GenerateName: the web pod's own
    const generateName = kubectl!(`-n ${NS} get pods -l app=web -o jsonpath={.items[0].metadata.generateName}`)
    expect(allowed!.destination).toMatchObject({ pod: `${generateName}*`, workload: { kind: 'Deployment', name: 'web' } })
    const denied = groups.find((g) => g.source.workload?.name === 'stranger' && g.verdict === 'DROPPED')
    expect(denied, JSON.stringify(groups)).toMatchObject({ drop_reason: 'POLICY_DENIED' })
    expect(denied!.count).toBeGreaterThan(0)
    // web's side dropped stranger's packets: what stranger's side saw leave is not a second, forwarded group
    expect(groups.filter((g) => g.source.workload?.name === 'stranger').map((g) => g.verdict)).toEqual(['DROPPED'])
    // a web pod's drawer shows its set's flows: the same connections
    const pod = kubectl!(`-n ${NS} get pods -l app=web -o jsonpath={.items[0].metadata.name}`)
    const podBody = await get(request, `/api/v1/cluster/namespaces/${NS}/networkflows`, { kind: 'Pod', name: pod, since: '5m' })
    expect((podBody.groups as Group[]).map((g) => `${g.source.workload?.name} ${g.verdict}`).sort()).toEqual(groups.map((g) => `${g.source.workload?.name} ${g.verdict}`).sort())
  })

  test('a web pod’s drawer reads its set’s flows as arriving from client and stranger', async ({ page }) => {
    test.skip(!ready, `no Calico cluster ${CLUSTER} with network flows (scripts/kind-calico.sh up)`)
    const pod = kubectl!(`-n ${NS} get pods -l app=web -o jsonpath={.items[0].metadata.name}`)
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=Pod/${NS}/${pod}`)
    const section = page.getByTestId('netflow-section')
    await section.getByTestId('netflow-load').click()
    const row = (peer: string) => section.getByTestId('netflow-row').filter({ has: page.getByTestId('netflow-peer').filter({ hasText: new RegExp(`^Deployment/${peer}$`) }) })
    await expect(row('client')).toHaveCount(1, { timeout: 30_000 })
    await expect(row('client').locator('td').nth(1)).toHaveText(/^(in|들어옴)$/)
    const denied = row('stranger').filter({ has: page.getByTestId('netflow-verdict').filter({ hasText: /^DROPPED$/ }) })
    await expect(denied.locator('td').nth(1)).toHaveText(/^(in|들어옴)$/)
    // the pod's own set is never the other end
    await expect(row('web')).toHaveCount(0)
  })

  test('the lines count a connection where it arrived', async ({ request }) => {
    test.skip(!ready, `no Calico cluster ${CLUSTER} with network flows (scripts/kind-calico.sh up)`)
    const body = await get(request, '/api/v1/cluster/networktraffic', { namespaces: NS, source: 'relay', since: '5m' })
    expect(body).toMatchObject({ available: true, source: 'relay', provider: 'calico' })
    const lines = body.lines as Line[]
    const byKey = new Map(lines.map((l) => [key(l), l]))
    expect(byKey.get(`${NS}/client → ${NS}/web`), [...byKey.keys()].join('; ')).toMatchObject({ from: { kind: 'Deployment' }, to: { kind: 'Deployment' }, dropped: 0, ports: [{ protocol: 'TCP', port: 80 }] })
    // stranger's packets leave it allowed and are denied at web: a dropped line, not a mixed one
    const dropped = byKey.get(`${NS}/stranger → ${NS}/web`)
    expect(dropped).toMatchObject({ allowed: 0 })
    expect(dropped!.dropped).toBeGreaterThan(0)
    const workloads = new Set([NS, 'kube-system'].flatMap((ns) => kubectl!(`-n ${ns} get deploy,ds,sts -o name`).split('\n').map((n) => `${ns}/${n.split('/')[1]}`)))
    for (const l of lines) for (const e of [l.from, l.to]) if (e.namespace && e.name) expect(workloads, endText(e)).toContain(endText(e))
  })

  test('the graph draws the lines from Whisker, and a dropped one opens the NetworkPolicy check', async ({ page }) => {
    test.skip(!ready, `no Calico cluster ${CLUSTER} with network flows (scripts/kind-calico.sh up)`)
    await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}&namespace=${NS}`)
    await page.getByTestId('graph-view-traffic').click({ timeout: 20_000 })
    await expect(page.locator(`[aria-label="${NS}/client → ${NS}/web (TCP 80)"]`)).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByTestId('traffic-status-source')).toContainText("Calico's Whisker")
    // no Prometheus for this cluster: the recent flows only, no metrics buttons
    await expect(page.locator('[data-testid^="traffic-source-"]')).toHaveCount(1)
    await page.locator(`[aria-label="${NS}/stranger → ${NS}/web (TCP 80)"] .react-flow__edge-textwrapper`).click()
    const panel = page.getByTestId('traffic-panel')
    await expect(panel.getByTestId('traffic-panel-reasons')).toContainText('POLICY_DENIED')
    await panel.getByTestId('traffic-panel-why').click()
    await expect(page.getByTestId('netpol-check-modal').getByTestId('netpol-check-overall')).toHaveText('Denied', { timeout: 20_000 })
  })
})
