import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster can name its Prometheus Service (Admin → Clusters → Edit, namespace/service:port), and
// discovery looks for labels in every namespace first. On the second kind cluster a Service
// monitoring/prom-alt:8080 points at the same Prometheus pods — a name and a port the old namespace probe
// never finds. Named, the cluster reads from it (and the status says so); a name that does not answer
// shows up in the status; a malformed one is refused; labelled kubeast.io/prometheus=true it is found
// without being named; cleared, the cluster is back on monitoring/prometheus:9090.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const ALT = 'monitoring/prom-alt:8080'
const DISCOVERED = 'monitoring/prometheus:9090 (via K8s API proxy)'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-promsvc-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSecond = kubectlFor('kubeast-b')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const status = async (request: APIRequestContext, admin: string) =>
  (await request.get(`/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
const patch = (request: APIRequestContext, admin: string, body: object) =>
  request.patch(`/api/v1/clusters/${CLUSTER}`, { headers: bearer(admin), data: body, failOnStatusCode: false })

test.describe('Prometheus Service named or found by label', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const before = await status(request, admin)
    test.skip(before.source !== 'proxy' || before.endpoint !== DISCOVERED, `cluster ${CLUSTER} does not read ${DISCOVERED} (${JSON.stringify(before)})`)
    const svc = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'prom-alt', namespace: 'monitoring' },
      spec: { selector: { app: 'prometheus' }, ports: [{ name: 'web', port: 8080, targetPort: 9090 }] },
    }
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-promsvc-')), 'svc.json')
    fs.writeFileSync(file, JSON.stringify(svc))
    kubectlSecond(`apply -f ${file}`)
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await patch(request, admin, { prometheus_service: '' })
    try {
      kubectlSecond('-n monitoring delete service prom-alt --ignore-not-found')
    } catch {
      /* already gone */
    }
    await patch(request, admin, { prometheus_service: '' }) // drop the discovery that may have found prom-alt
  })

  test('a named Service is read through the proxy, a wrong one shows in the status, a malformed one is refused', async ({ request }) => {
    const bad = await patch(request, admin, { prometheus_service: 'http://prometheus:9090' })
    expect(bad.status()).toBe(400)
    expect(await bad.text()).toContain('namespace/service:port')

    const ok = await patch(request, admin, { prometheus_service: ALT })
    expect(ok.status(), await ok.text()).toBe(200)
    expect((await ok.json()).prometheus_service).toBe(ALT)
    const st = await status(request, admin)
    expect(st).toMatchObject({ available: true, source: 'proxy', configured: true, endpoint: `${ALT} (via K8s API proxy)` })
    const q = await (await request.get(`/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=${encodeURIComponent('up{job="kubelet"}')}`, { headers: bearer(admin) })).json()
    expect(q.available).toBe(true)
    expect(q.results.length).toBeGreaterThan(0)

    type Row = { TargetID?: string; target_id?: string; After?: { prometheus_service?: string }; after?: { prometheus_service?: string } }
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.cluster.update&limit=5', { headers: bearer(admin) })).json()).items ?? []) as Row[]
    const row = rows.find((r) => (r.TargetID ?? r.target_id) === CLUSTER)
    expect((row?.After ?? row?.after)?.prometheus_service).toBe(ALT)

    expect((await patch(request, admin, { prometheus_service: 'monitoring/nope:9090' })).status()).toBe(200)
    const wrong = await status(request, admin)
    expect(wrong).toMatchObject({ available: false, configured: true })
    expect(wrong.message).toContain('monitoring/nope:9090')
    expect(wrong.message).toContain('not found')
  })

  test('labelled kubeast.io/prometheus=true, the Service is found without being named; cleared, the old one comes back', async ({ request }) => {
    kubectlSecond('-n monitoring label service prom-alt kubeast.io/prometheus=true --overwrite')
    // Clearing the name also drops the cluster's remembered discovery.
    expect((await patch(request, admin, { prometheus_service: '' })).status()).toBe(200)
    expect(await status(request, admin)).toMatchObject({ available: true, source: 'proxy', configured: false, endpoint: `${ALT} (via K8s API proxy)` })

    kubectlSecond('-n monitoring label service prom-alt kubeast.io/prometheus-')
    expect((await patch(request, admin, { prometheus_service: '' })).status()).toBe(200)
    expect(await status(request, admin)).toMatchObject({ available: true, configured: false, endpoint: DISCOVERED })
  })

  test('the edit dialog takes the Service, refuses a malformed one, and the list shows it', async ({ page, request }) => {
    await page.goto('/admin/clusters')
    const row = page.locator('tbody tr').filter({ hasText: CLUSTER }).filter({ hasNot: page.getByText('self', { exact: true }) }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.getByRole('button', { name: /Edit|편집/ }).click()

    const field = page.getByTestId('edit-prometheus-service')
    await field.fill('monitoring/prom-alt')
    await expect(page.getByTestId('edit-prometheus-service-hint')).toHaveClass(/text-red-400/)
    await expect(page.getByTestId('edit-submit')).toBeDisabled()
    await field.fill(ALT)
    await expect(page.getByTestId('edit-prometheus-service-hint')).not.toHaveClass(/text-red-400/)
    await page.getByTestId('edit-submit').click()

    await expect(row.getByTestId('cluster-prometheus-service')).toHaveAttribute('title', ALT, { timeout: 15000 })
    expect((await status(request, admin)).endpoint).toBe(`${ALT} (via K8s API proxy)`)
    await row.getByRole('button', { name: /Edit|편집/ }).click()
    await expect(page.getByTestId('edit-prometheus-service')).toHaveValue(ALT)
    await page.getByTestId('edit-prometheus-check').click()
    await expect(page.getByTestId('edit-prometheus-status')).toContainText(`Service ${ALT}`, { timeout: 20000 })
    await expect(page.getByTestId('edit-prometheus-status')).toContainText(/OK|정상/)
    await expect(page.getByTestId('edit-prometheus-status')).not.toContainText('VictoriaMetrics')
  })
})

test('a cluster with no Prometheus says why in the page language', async ({ page, request }) => {
  const admin = await login(request)
  const st = await (await request.get('/api/v1/cluster/prometheus/status?cluster=self', { headers: bearer(admin) })).json()
  test.skip(st.source !== 'none', `cluster self has a Prometheus here (${JSON.stringify(st)})`)
  expect(st.reason).toBe('not_found')

  await page.goto('/admin/clusters')
  const row = page.locator('tbody tr').filter({ has: page.getByText('self', { exact: true }) }).first()
  await row.getByRole('button', { name: /Edit|편집/ }).click()
  await page.getByTestId('edit-prometheus-check').click()
  const result = page.getByTestId('edit-prometheus-status')
  await expect(result).toContainText(/none found in the cluster|클러스터 안에서 찾지 못했습니다/, { timeout: 20000 })
  await expect(result).not.toContainText(st.message)
})
