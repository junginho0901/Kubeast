import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Reading the stores through Grafana and taking Grafana's alerts (scripts/kind-grafana.sh: a Grafana 13 in the second
// cluster with its Prometheus and the log-search Loki as data sources, a Viewer service account token in the Secret
// grafana/kubeast-reader). Cluster `default` (that cluster) is pointed at the data source proxy: the same answers as
// the direct path, the dashboard and the node drawer fill from it, a wrong token shows in the status. A Grafana
// webhook contact point test sends a firing alert to the investigation webhook, which queues and investigates it.
// Skipped without that Grafana.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const NS = 'kube-system'

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-grafana-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string, input?: string) =>
    execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSelf = kubectlFor('kubeast')
const kubectlSecond = kubectlFor('kubeast-b')
const secretValue = (k: typeof kubectlSelf, ns: string, name: string, key: string) =>
  Buffer.from(k(`-n ${ns} get secret ${name} -o jsonpath={.data.${key}}`), 'base64').toString()

// grafanaAPI calls Grafana as admin from inside its pod; credentials and body go in on stdin (a curl config).
function grafanaAPI(method: string, apiPath: string, body: object): any {
  const quote = (s: string) => JSON.stringify(s)
  const config = [
    `user = ${quote(`admin:${secretValue(kubectlSecond, 'grafana', 'grafana-admin', 'password')}`)}`,
    `request = ${quote(method)}`,
    `header = "Content-Type: application/json"`,
    `data = ${quote(JSON.stringify(body))}`,
    `url = ${quote(`http://localhost:3000${apiPath}`)}`,
  ].join('\n')
  return JSON.parse(kubectlSecond('-n grafana exec -i deploy/grafana -- curl -s -K -', config))
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const get = async (request: APIRequestContext, admin: string, url: string) => {
  const res = await request.get(url, { headers: bearer(admin) })
  expect(res.status(), `${url}: ${await res.text()}`).toBe(200)
  return res.json()
}
const patch = (request: APIRequestContext, admin: string, body: object) =>
  request.patch(`/api/v1/clusters/${CLUSTER}`, { headers: bearer(admin), data: body, failOnStatusCode: false })
const promQuery = (request: APIRequestContext, admin: string, q: string) =>
  get(request, admin, `/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=${encodeURIComponent(q)}`)

test.describe('Grafana in front of the stores', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let token = ''
  let grafana = ''

  test.beforeAll(async ({ request }) => {
    try {
      token = secretValue(kubectlSecond, 'grafana', 'kubeast-reader', 'token')
      kubectlSecond('-n grafana rollout status deploy/grafana --timeout=5s')
    } catch {
      test.skip(true, 'no Grafana in the second kind cluster — run scripts/kind-grafana.sh up')
    }
    test.skip(!token, 'no token in grafana/kubeast-reader — run scripts/kind-grafana.sh up')
    admin = await login(request)
    const prom = await get(request, admin, `/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`)
    test.skip(prom.source === 'external', `cluster ${CLUSTER} already names an external store (${prom.endpoint})`)
    const nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
    grafana = `http://${nodeIP}:31300`
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await patch(request, admin, {
      prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' },
      log_search_url: '', log_search_tenant: '', log_search_cluster_label: '', log_search_auth: { type: 'none' },
    })
  })

  test('metrics through the data source proxy match the direct path and fill the dashboard and the node drawer', async ({ request, page }) => {
    const direct = await promQuery(request, admin, 'count by (job) (up)')
    expect(direct.results.length).toBeGreaterThan(0)

    const url = `${grafana}/api/datasources/proxy/uid/prometheus`
    const res = await patch(request, admin, { prometheus_url: url, prometheus_cluster_label: 'kubeast-b', prometheus_auth: { type: 'bearer', token } })
    expect(res.status(), await res.text()).toBe(200)
    const st = await get(request, admin, `/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`)
    expect(st, JSON.stringify(st)).toMatchObject({ available: true, source: 'external', endpoint: url, auth: true, cluster_label: 'kubeast-b' })

    const viaGrafana = await promQuery(request, admin, 'count by (job) (up)')
    const byJob = (r: any) => Object.fromEntries(r.results.map((x: any) => [x.metric.job, x.value]))
    expect(byJob(viaGrafana)).toEqual(byJob(direct))
    for (const r of (await promQuery(request, admin, 'up')).results) expect(r.metric.cluster, JSON.stringify(r.metric)).toBe('kubeast-b')

    // The dashboard's pod count is count(kube_pod_info) read through Grafana.
    await page.goto(`/?cluster=${CLUSTER}`)
    const card = page.locator('div.card').filter({ has: page.getByRole('heading', { name: /Cluster Resource Utilization|클러스터 리소스/ }) })
    await expect(card).toContainText(/CPU/, { timeout: 30_000 })
    await expect
      .poll(async () => {
        const pods = (await promQuery(request, admin, 'count(kube_pod_info)')).results[0]?.value
        const shown = (await card.locator('div.text-2xl').last().textContent())?.trim()
        return shown === String(Math.round(pods))
      }, { timeout: 60_000, intervals: [5_000] })
      .toBe(true)

    // The node drawer's cards are node-exporter series of that node, read through Grafana.
    const node = kubectlSecond(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    await page.goto(`/cluster/nodes?cluster=${CLUSTER}`)
    await page.getByRole('cell', { name: node, exact: true }).first().click({ timeout: 30_000 })
    const section = page.locator('div.rounded-lg').filter({ has: page.getByText(/Real-time Metrics|실시간/i) }).first()
    await expect(section).toContainText(/CPU Usage[\s\S]*\d+(\.\d+)?\s*%/, { timeout: 30_000 })
    await expect(section).toContainText(/Memory Usage[\s\S]*\d+(\.\d+)?\s*%/)
  })

  test('a wrong token shows as 401 in the status and reads nothing', async ({ request }) => {
    const res = await patch(request, admin, { prometheus_auth: { type: 'bearer', token: 'glsa_wrong_token' } })
    expect(res.status(), await res.text()).toBe(200)
    const st = await get(request, admin, `/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`)
    expect(st.available).toBe(false)
    expect(String(st.message)).toContain('401')
    const q = await request.get(`/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=up`, { headers: bearer(admin) })
    expect(q.status()).not.toBe(200)
    expect(await q.text()).toContain('status 401')
    const back = await patch(request, admin, { prometheus_auth: { type: 'bearer', token } })
    expect(back.status()).toBe(200)
    expect((await get(request, admin, `/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`)).available).toBe(true)
  })

  test('log search through the data source proxy returns the same lines as the direct path', async ({ request }) => {
    const features = await get(request, admin, '/api/v1/cluster/features')
    test.skip(!features.logSearch?.clusters?.includes(CLUSTER), `log search is off for cluster ${CLUSTER} — run scripts/kind-logsearch.sh up`)
    // A window that ended a minute ago: nothing more arrives in it, so both paths must give the same lines.
    const end = new Date(Date.now() - 60_000)
    const window = `start=${new Date(end.getTime() - 10 * 60_000).toISOString()}&end=${end.toISOString()}&limit=200`
    const search = async () => (await get(request, admin, `/api/v1/namespaces/${NS}/logsearch?cluster=${CLUSTER}&${window}`)).lines
    const direct = await search()
    expect(direct.length).toBeGreaterThan(0)

    const url = `${grafana}/api/datasources/proxy/uid/loki`
    const res = await patch(request, admin, { log_search_url: url, log_search_tenant: '', log_search_cluster_label: 'kubeast-b', log_search_auth: { type: 'bearer', token } })
    expect(res.status(), await res.text()).toBe(200)
    const st = await get(request, admin, `/api/v1/cluster/logsearch/status?cluster=${CLUSTER}`)
    expect(st, JSON.stringify(st)).toMatchObject({ available: true, source: 'cluster', endpoint: url, auth: true })

    const viaGrafana = await search()
    expect(viaGrafana).toEqual(direct)
    for (const l of viaGrafana) expect(l.namespace).toBe(NS)
  })

  test('a Grafana alert reaches the investigation webhook and is investigated', async ({ request }) => {
    test.setTimeout(420_000)
    const name = `E2EGrafana${Date.now()}`
    const webhookToken = secretValue(kubectlSelf, 'kubeast', 'kubeast-secrets', 'ALERT_WEBHOOK_TOKEN')
    // A new webhook contact point is tested with these labels: Grafana sends one firing notification to it.
    const out = grafanaAPI('POST', '/apis/notifications.alerting.grafana.app/v1beta1/namespaces/default/receivers/-/test', {
      integration: {
        type: 'webhook',
        version: 'v1',
        settings: {
          url: `http://kubeast-control-plane:30080/api/v1/alerts/webhook?cluster=${CLUSTER}`,
          httpMethod: 'POST',
          authorization_scheme: 'Bearer',
          authorization_credentials: webhookToken,
        },
      },
      alert: {
        labels: { alertname: name, severity: 'warning', namespace: NS },
        annotations: { summary: 'CoreDNS check from a Grafana alert' },
      },
    })
    expect(JSON.stringify(out)).not.toContain(webhookToken)
    expect(out.status, JSON.stringify(out)).toBe('success')

    const find = async () =>
      ((await get(request, admin, `/api/v1/ai/investigations?cluster=${CLUSTER}&limit=50`)).items as any[]).find((r) => r.alertname === name)
    await expect.poll(async () => (await find())?.severity, { timeout: 60_000, intervals: [2_000] }).toBe('warning')
    await expect.poll(async () => (await find())?.status, { timeout: 360_000, intervals: [3_000] }).toMatch(/^(done|failed)$/)
    const d = await get(request, admin, `/api/v1/ai/investigations/${(await find()).id}`)
    expect(d.status, `investigation error: ${d.error}`).toBe('done')
    expect(d.namespace).toBe(NS)
    expect(d.alertmanager_url).toBe('http://kubeast-b-control-plane:31300/')
    expect(d.annotations.summary).toBe('CoreDNS check from a Grafana alert')
  })
})
