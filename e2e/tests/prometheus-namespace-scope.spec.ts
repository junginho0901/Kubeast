import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A grant limited to namespaces is refused the cluster's Prometheus, which answers for the whole cluster, whichever
// way the cluster reaches it: through the API server's proxy as the user (a cluster-wide reader's cached answer was
// served to it for 30 s) or an external store with Kubeast's own credentials (it was served whole). A cluster-wide
// reader keeps every read, and the drawers tell a limited reader why their metrics are missing. Two users are made
// and removed; the self cluster names the second cluster's Prometheus (NodePort 30090) for one test and is put back.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const SELF = 'self'
const SECOND = 'default'
const NS = 'default'
const id = Date.now().toString(36)
const PW = `promscope-${id}-pw`
const POD = `promscope-${id}`
const BINDING = `e2e-promscope-${id}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-promscope-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSecond = kubectlFor('kubeast-b')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const READS = [
  'prometheus/query?query=up',
  `prometheus/query_range?query=up&start=${Math.floor(Date.now() / 1000) - 600}&end=${Math.floor(Date.now() / 1000)}&step=60`,
  'prometheus/metrics',
  'prometheus/labels?label=namespace',
  'prometheus/rules',
  'prometheus/targets',
  'gpu/metrics',
]

test.describe('the cluster\'s Prometheus and a grant limited to namespaces', () => {
  let admin = ''
  let full = ''
  let scoped = ''
  const userIds: string[] = []
  const scopedEmail = `e2e-promscope-scoped-${id}@kubeast.local`

  async function user(request: APIRequestContext, email: string, grant: object): Promise<string> {
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E promscope ${id}`, email, password: PW } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    for (const cluster of [SELF, SECOND]) {
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: grant })
      expect(put.ok(), await put.text()).toBeTruthy()
    }
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const status = await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SECOND}`, { headers: bearer(admin) })).json()
    test.skip(status.source !== 'proxy' || !status.available, `cluster ${SECOND} does not read its Prometheus through the proxy (${JSON.stringify(status)})`)
    full = await user(request, `e2e-promscope-full-${id}@kubeast.local`, { role: 'Read' })
    scoped = await user(request, scopedEmail, { role: 'Read', namespaces: [NS] })
  })

  test.afterAll(async ({ request }) => {
    for (const userId of userIds) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
  })

  test('through the proxy: refused, also right after a cluster-wide reader asked the same', async ({ request }) => {
    const q = `count by (namespace) (kube_pod_info) + 0 * ${Date.now()}`
    const target = `/api/v1/cluster/prometheus/query?cluster=${SECOND}&query=${encodeURIComponent(q)}`
    const first = await request.get(target, { headers: bearer(full) })
    expect(first.status()).toBe(200)
    const namespaces = ((await first.json()).results as { metric: { namespace?: string } }[]).map((r) => r.metric.namespace)
    expect(namespaces.filter((n) => n && n !== NS).length, 'the reader sees other namespaces').toBeGreaterThan(0)
    // within the cache's 30 s the same text from the limited grant
    const second = await request.get(target, { headers: bearer(scoped) })
    expect(second.status()).toBe(403)
    expect((await second.json()).detail).toContain(`limited to namespaces (${NS})`)
    for (const read of READS) {
      const asScoped = await request.get(`/api/v1/cluster/${read}${read.includes('?') ? '&' : '?'}cluster=${SECOND}`, { headers: bearer(scoped) })
      expect(asScoped.status(), `${read} as the limited grant`).toBe(403)
      const asFull = await request.get(`/api/v1/cluster/${read}${read.includes('?') ? '&' : '?'}cluster=${SECOND}`, { headers: bearer(full) })
      expect(asFull.status(), `${read} as the cluster-wide reader`).toBe(200)
    }
  })

  test('an external store: refused to the limited grant, served to the cluster-wide reader', async ({ request }) => {
    const before = await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SELF}`, { headers: bearer(admin) })).json()
    test.skip(before.source === 'external', `the self cluster already names an external store (${before.endpoint})`)
    let nodeIP = ''
    try {
      nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
      kubectlSecond('-n monitoring get svc prometheus-nodeport -o name')
    } catch {
      test.skip(true, 'the second kind cluster has no Prometheus NodePort (deploy/kind/second-cluster.yaml)')
    }
    const patch = (body: object) => request.patch(`/api/v1/clusters/${SELF}`, { headers: bearer(admin), data: body, failOnStatusCode: false })
    expect((await patch({ prometheus_url: `http://${nodeIP}:30090`, prometheus_cluster_label: 'kubeast-b', prometheus_auth: { type: 'none' } })).status()).toBe(200)
    try {
      const asFull = await request.get(`/api/v1/cluster/prometheus/query?cluster=${SELF}&query=${encodeURIComponent('count by (namespace) (kube_pod_info)')}`, { headers: bearer(full) })
      expect(asFull.status()).toBe(200)
      expect(((await asFull.json()).results as unknown[]).length, 'the store answers the reader').toBeGreaterThan(0)
      for (const read of READS) {
        const asScoped = await request.get(`/api/v1/cluster/${read}${read.includes('?') ? '&' : '?'}cluster=${SELF}`, { headers: bearer(scoped) })
        expect(asScoped.status(), `${read} as the limited grant`).toBe(403)
      }
    } finally {
      expect((await patch({ prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })).status()).toBe(200)
    }
  })

  test('the features say so, and a Pod drawer tells the limited reader why its metrics are missing', async ({ browser, request }) => {
    const features = async (token: string) => (await (await request.get(`/api/v1/cluster/features?cluster=${SECOND}`, { headers: bearer(token) })).json()).prometheus
    expect((await features(scoped)).namespaceLimited).toBe(true)
    expect((await features(full)).namespaceLimited).toBe(false)

    // a pod the limited grant may open: the second cluster lets kubeast:role:read view namespace default for the test
    kubectlSecond('apply -f -', JSON.stringify({
      apiVersion: 'v1', kind: 'List', items: [
        { apiVersion: 'v1', kind: 'Pod', metadata: { name: POD, namespace: NS }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }] } },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: BINDING, namespace: NS },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
          subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeast:role:read' }] },
      ],
    }))
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      const page = await ctx.newPage()
      const promReads: string[] = []
      page.on('request', (r) => { if (/\/cluster\/prometheus\/query/.test(r.url())) promReads.push(r.url()) })
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(scopedEmail)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await page.goto(`/workloads/pods?cluster=${SECOND}&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${POD}`)}`)
      const note = page.getByTestId('prometheus-namespace-limited').first()
      await expect(note).toContainText('need a grant on the whole cluster', { timeout: 30_000 })
      expect(promReads, 'the page does not ask the cluster\'s Prometheus for a limited grant').toEqual([])
    } finally {
      await ctx.close()
      kubectlSecond(`delete pod/${POD} rolebinding/${BINDING} -n ${NS} --ignore-not-found --wait=false`)
    }
  })
})
