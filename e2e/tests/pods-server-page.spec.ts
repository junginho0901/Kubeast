import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The Pods list is paged by k8s-service (pods_page.go): the browser gets one block of rows, the count, the cards and a
// revision, never every pod. What it shows must still be what the cluster has — compared here with kubectl on cluster
// self — and follow the cluster within a poll; a namespace-scoped reader is paged its namespaces only.

const CLUSTER = 'self'
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-podpage-pass1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-podpage-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const tryKubectl = (args: string) => { try { return kubectl(args) } catch { return null } }

interface KPod {
  metadata: { name: string; namespace: string }
  spec: { containers: unknown[] }
  status: { phase?: string; containerStatuses?: { ready: boolean; restartCount: number }[] }
}
const clusterPods = (): KPod[] => JSON.parse(kubectl('get pods -A -o json')).items
const restarts = (p: KPod) => (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)

const rows = (page: Page) => page.locator('table tbody tr.cursor-pointer')
const card = async (page: Page, label: RegExp) =>
  Number(await page.locator('div.rounded-lg.border').filter({ has: page.getByText(label) }).locator('.text-lg').first().innerText())
const search = (page: Page) => page.getByPlaceholder(/Search pods|파드/i)

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Pods list paged by the server', () => {
  test('the count, the cards, a search and the restarts order are the cluster\'s; the browser gets one block', async ({ page }) => {
    const asked: { url: string; items: number }[] = []
    page.on('response', async (r) => {
      if (!r.url().includes('/cluster/pods/')) return
      const body = await r.json().catch(() => ({}))
      asked.push({ url: r.url(), items: Array.isArray(body.items) ? body.items.length : -1 })
    })
    await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
    await expect(rows(page).first()).toBeVisible()

    // the cluster's pods (polled: a pod may come or go between the two reads)
    await expect.poll(async () => {
      const pods = clusterPods()
      const shown = (await page.getByText(/Showing \d+-\d+ of \d+|\d+ 중/).first().innerText()).match(/of (\d+)/)?.[1]
      return Number(shown) === pods.length && (await card(page, /^(Total|전체)$/)) === pods.length
    }, { timeout: 20_000 }).toBe(true)
    const pods = clusterPods()
    expect(await card(page, /^(Pending|대기)$/)).toBe(pods.filter((p) => p.status.phase === 'Pending').length)
    expect(await card(page, /^(Completed|완료)$/)).toBe(pods.filter((p) => p.status.phase === 'Succeeded').length)
    expect(await card(page, /^(Restarted|재시작 이력)$/)).toBe(pods.filter((p) => restarts(p) > 0).length)

    // the browser asked for pages only, each one block of rows
    expect(asked.some((a) => a.url.includes('/pods/all'))).toBe(false)
    const pageAnswers = asked.filter((a) => a.url.includes('/pods/page') && a.items >= 0)
    expect(pageAnswers.length).toBeGreaterThan(0)
    for (const a of pageAnswers) expect(a.items).toBeLessThanOrEqual(50)

    // a search the server runs: the rows whose name, namespace, node or IP has the text
    const want = pods.filter((p) => p.metadata.name.includes('coredns')).length
    await search(page).fill('CoreDNS')
    await expect(page.getByText(new RegExp(`${want} pods? match`))).toBeVisible()
    await expect(rows(page)).toHaveCount(want)
    await search(page).fill('')

    // the Restarts column, descending (second click): the first row has the most
    const header = page.locator('th', { hasText: /^(Restarts|재시작)/ })
    await header.click()
    await header.click()
    const most = Math.max(...clusterPods().map(restarts))
    await expect.poll(async () => Number(await rows(page).first().locator('td').nth(4).innerText()), { timeout: 10_000 }).toBe(most)
  })

  test('a pod made and deleted with kubectl appears and goes within a poll', async ({ page }) => {
    const name = `e2e-podpage-live-${Date.now().toString(36)}`
    try {
      await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
      await search(page).fill(name)
      await expect(page.getByText('0 pods match.', { exact: true })).toBeVisible()
      kubectl(`-n default run ${name} --image=registry.k8s.io/pause:3.10 --restart=Never`)
      await expect(rows(page).filter({ hasText: name })).toHaveCount(1, { timeout: 15_000 })
      await expect(rows(page).filter({ hasText: name }).locator('td').nth(3)).toHaveText(/Running|Pending|ContainerCreating/)
      kubectl(`-n default delete pod ${name} --grace-period=0 --force --wait=false`)
      await expect(rows(page).filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 })
    } finally {
      tryKubectl(`-n default delete pod ${name} --ignore-not-found --grace-period=0 --force --wait=false`)
    }
  })

  test('a namespace-scoped reader is paged its namespaces only, and a namespace the cluster refuses is refused', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const s = Date.now().toString(36)
    const [nsA, nsB, nsC] = ['a', 'b', 'c'].map((x) => `e2e-podpage-${x}-${s}`)
    const email = `e2e-podpage-${s}@kubeast.local`
    const rbac = `e2e-podpage-${s}`
    let userId = ''
    const page = (token: string, q: string) => request.get(`/api/v1/cluster/pods/page?cluster=${CLUSTER}&limit=50${q}`, { headers: bearer(token), failOnStatusCode: false })
    try {
      for (const ns of [nsA, nsB, nsC]) {
        kubectl(`create namespace ${ns}`)
        kubectl(`-n ${ns} run pod-${ns.split('-')[2]} --image=registry.k8s.io/pause:3.10 --restart=Never`)
      }
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E pod page', email, password: PW, role_id: member.id } })
      expect(created.status(), `create ${email}`).toBe(201)
      userId = (await created.json()).id
      // the grant names A and C; the cluster lets the scoped Read group list pods in A only
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [nsA, nsC] } })
      expect(grant.status(), await grant.text()).toBe(200)
      kubectl(`create clusterrole ${rbac}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:read`)
      kubectl(`create clusterrolebinding ${rbac}-imp --clusterrole=${rbac}-imp --serviceaccount=kubeast:k8s-service`)
      kubectl(`-n ${nsA} create rolebinding ${rbac}-view --clusterrole=view --group=kubeast:role:read`)
      const user = await login(request, email, PW)

      // every namespace: A's pod only (C refused by the cluster, B outside the grant)
      await expect.poll(async () => {
        const res = await page(user, '')
        if (!res.ok()) return `${res.status()}`
        const body = await res.json()
        return (body.items as { namespace: string; name: string }[]).map((i) => `${i.namespace}/${i.name}`).join(',') + ` total ${body.total} stats ${body.stats.total}`
      }, { timeout: 30_000 }).toBe(`${nsA}/pod-a total 1 stats 1`)
      const outside = await page(user, `&namespace=${nsB}`)
      expect(outside.status()).toBe(403)
      expect(await outside.text()).toMatch(/outside your grant/)
      const refused = await page(user, `&namespace=${nsC}`)
      expect(refused.status()).toBe(403)
      expect(await refused.text()).toMatch(/may not list pods/)

      // the admin is paged all three (the search matches the namespaces' names) and B on its own
      const all = await (await page(admin, `&q=${s}`)).json()
      expect((all.items as { name: string }[]).map((i) => i.name)).toEqual(['pod-a', 'pod-b', 'pod-c'])
      const adminB = await (await page(admin, `&namespace=${nsB}`)).json()
      expect((adminB.items as { name: string }[]).map((i) => i.name)).toEqual(['pod-b'])
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryKubectl(`delete clusterrolebinding ${rbac}-imp --ignore-not-found`)
      tryKubectl(`delete clusterrole ${rbac}-imp --ignore-not-found`)
      tryKubectl(`delete namespace ${nsA} ${nsB} ${nsC} --ignore-not-found --wait=false`)
    }
  })
})
