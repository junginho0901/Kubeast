import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// What an open window and a list keep up with by themselves, on cluster `self` in a namespace of this run's, and what that
// costs the server: an Ingress drawer follows its object on the read it already makes, a workload's Events move on their
// own frames, a pod's RBAC tab and a CRD's instances read again only when something changed, a Node's Allocated Resources
// follow its pods, a new row goes where the next read puts it, and a grant limited to namespaces follows a kind of the
// cluster its RBAC lets it list, with one watch. It does not skip. The objects and the user are removed after.

const NS = 'e2e-live-drawers'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const STAMP = Date.now().toString(36)
const CRD = 'livewidgets.e2e-live.kubeast.io'
const SC = `e2e-live-sc-${STAMP}`
const CLUSTER_ROLE = `e2e-live-sc-read-${STAMP}`
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const PW = 'E2e-live-drawers-throwaway-1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-live-drawers-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const ingress = (host: string) => JSON.stringify({
  apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'web', namespace: NS },
  spec: { rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] },
})
// an event counts up under one first time, as a recorder writes it
const FIRST_SEEN = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
const event = (count: number) => JSON.stringify({
  apiVersion: 'v1', kind: 'Event', metadata: { name: 'web.e2e-live', namespace: NS },
  involvedObject: { kind: 'Deployment', name: 'web', namespace: NS, apiVersion: 'apps/v1' },
  reason: 'E2ELiveWarning', message: 'told by the run', type: 'Warning', count,
  firstTimestamp: FIRST_SEEN, lastTimestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), source: { component: 'e2e-live' },
})
const widget = (name: string) => JSON.stringify({ apiVersion: 'e2e-live.kubeast.io/v1', kind: 'LiveWidget', metadata: { name, namespace: NS }, spec: { size: 1 } })

const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  JSON.stringify({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: NS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'web' } },
      template: { metadata: { labels: { app: 'web' } }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }] } },
    },
  }),
  ingress('first.example.com'),
  `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: alpha, namespace: ${NS}}`,
  `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: gamma, namespace: ${NS}}`,
  JSON.stringify({
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: CRD },
    spec: {
      group: 'e2e-live.kubeast.io', scope: 'Namespaced', names: { plural: 'livewidgets', singular: 'livewidget', kind: 'LiveWidget', listKind: 'LiveWidgetList' },
      versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }],
    },
  }),
].join('\n---\n')

const requests = (page: Page, match: RegExp) => {
  const seen: string[] = []
  page.on('request', (r) => { if (match.test(r.url())) seen.push(r.url()) })
  return seen
}

test.describe('what keeps up by itself', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace ${NS} --ignore-not-found --timeout=120s`)
    kubectl(`delete crd ${CRD} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', FIXTURE)
    kubectl(`wait --for=condition=Established crd/${CRD} --timeout=60s`)
    kubectl(`-n ${NS} rollout status deployment/web --timeout=120s`)
    kubectl('apply -f -', widget('first'))
  })

  test.afterAll(() => {
    kubectl(`delete crd ${CRD} --ignore-not-found --wait=false`)
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
  })

  test('an Ingress drawer opened from its list shows its object as it is now, and reads nothing while it stays', async ({ page }) => {
    test.setTimeout(120_000)
    const describes = requests(page, /\/ingresses\/web\/describe/)
    await page.goto(`/network/ingresses?cluster=self&namespace=${NS}`)
    await page.locator('main tbody tr').filter({ hasText: 'web' }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByText('first.example.com').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(15_000)
    expect(describes.length, 'an object that stays as it is is not read again').toBe(1)

    kubectl('apply -f -', ingress('second.example.com'))
    await expect(drawer.getByText('second.example.com').first()).toBeVisible({ timeout: 25_000 })
    await expect(drawer.getByText('first.example.com')).toHaveCount(0)
    await expect.poll(() => describes.length, { timeout: 15_000 }).toBe(2)
  })

  test('a Deployment\'s Events count up while it stays as it is, and its answer is not read for that', async ({ page }) => {
    test.setTimeout(120_000)
    const describes = requests(page, /\/deployments\/web\/describe/)
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Deployment/${NS}/web`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByText('Events', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => describes.length, { timeout: 20_000 }).toBeGreaterThan(0)
    const before = describes.length

    kubectl('apply -f -', event(1))
    const row = drawer.locator('tr').filter({ hasText: 'E2ELiveWarning' })
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    kubectl('apply -f -', event(7))
    await expect.poll(async () => (await row.locator('td').last().innerText()).trim(), { timeout: 20_000 }).toBe(kubectl(`-n ${NS} get event web.e2e-live -o 'jsonpath={.count}'`))
    expect(describes.length, 'the frame is the row').toBe(before)
  })

  test('a Pod\'s Events count up while it stays as it is, and its answer is not read for that', async ({ page }) => {
    test.setTimeout(120_000)
    const podName = kubectl(`-n ${NS} get pod -l app=web -o 'jsonpath={.items[0].metadata.name}'`)
    const eventOf = (count: number) => JSON.stringify({
      apiVersion: 'v1', kind: 'Event', metadata: { name: 'pod.e2e-live', namespace: NS },
      involvedObject: { apiVersion: 'v1', kind: 'Pod', name: podName, namespace: NS },
      type: 'Warning', reason: 'E2ELiveBackOff', message: 'Back-off restarting failed container', count,
      firstTimestamp: '2026-11-07T00:00:00Z', lastTimestamp: new Date().toISOString(), source: { component: 'kubelet' },
    })
    const describes = requests(page, new RegExp(`/pods/${podName}/describe`))
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${podName}`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByText('Events', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => describes.length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(3_000)
    const before = describes.length

    kubectl('apply -f -', eventOf(1))
    const row = drawer.locator('tr').filter({ hasText: 'E2ELiveBackOff' })
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    kubectl('apply -f -', eventOf(7))
    await expect.poll(async () => (await row.locator('td').last().innerText()).trim(), { timeout: 20_000 }).toBe(kubectl(`-n ${NS} get event pod.e2e-live -o 'jsonpath={.count}'`))
    expect(describes.length, 'the frame is the row').toBe(before)
    kubectl(`-n ${NS} delete event pod.e2e-live --ignore-not-found`)
  })

  test('a pod\'s RBAC tab shows a binding made while it is open, and takes it away when it is gone', async ({ page }) => {
    test.setTimeout(150_000)
    kubectl(`-n ${NS} create role e2e-live-role --verb=get --resource=pods`)
    const reads = requests(page, /\/pods\/[^/]+\/rbac/)
    await page.goto('/cluster-view?cluster=self')
    await expect(page.getByTestId('cluster-view-map')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: /All namespaces|전체 네임스페이스|모든 Namespace/i }).first().click()
    await page.getByRole('button', { name: NS, exact: true }).click()
    const card = page.locator('[data-testid="cluster-view-node"] button').filter({ hasText: 'web-' }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    await page.getByRole('button', { name: 'RBAC', exact: true }).click()
    await expect(page.getByTestId('pod-rbac-summary')).toBeVisible({ timeout: 20_000 })
    const names = page.getByTestId('pod-rbac-role-bindings').getByTestId('pod-rbac-binding-name')
    await expect(names.filter({ hasText: 'e2e-live-binding' })).toHaveCount(0)
    await page.waitForTimeout(8_000)
    expect(reads.length, 'nothing changed, so nothing is read again').toBe(1)

    kubectl(`-n ${NS} create rolebinding e2e-live-binding --role=e2e-live-role --serviceaccount=${NS}:default`)
    await expect(names.filter({ hasText: 'e2e-live-binding' })).toHaveCount(1, { timeout: 25_000 })
    kubectl(`-n ${NS} delete rolebinding e2e-live-binding`)
    await expect(names.filter({ hasText: 'e2e-live-binding' })).toHaveCount(0, { timeout: 25_000 })
  })

  test('a Node\'s Allocated Resources follow the pods on it, as kubectl describe node adds them up', async ({ page }) => {
    test.setTimeout(150_000)
    const node = kubectl(`-n ${NS} get pod -l app=web -o 'jsonpath={.items[0].spec.nodeName}'`)
    const describes = requests(page, new RegExp(`/nodes/${node}/describe`))
    const kubectlRows = () => {
      const section = kubectl(`describe node ${node}`).split('Allocated resources:')[1] ?? ''
      const rows: string[][] = []
      for (const line of section.split('\n').slice(1)) {
        if (!line.startsWith(' ')) { if (line.trim()) break; continue }
        const cols = line.trim().split(/\s{2,}/)
        if (cols.length === 3 && cols[0] !== 'Resource' && !cols[0].startsWith('--')) rows.push(cols)
      }
      return rows
    }
    await page.goto(`/cluster/nodes?cluster=self&detail=${encodeURIComponent(`Node/${node}`)}`)
    const rows = page.getByTestId('node-allocated').locator('tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 30_000 })
    const onScreen = () => rows.evaluateAll((trs) => trs.map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.innerText.trim())))
    await expect(async () => expect(await onScreen()).toEqual(kubectlRows())).toPass({ timeout: 30_000 })
    const before = await onScreen()
    expect(describes.every((url) => url.includes('events=0')), 'the drawer lists its events by itself').toBe(true)

    kubectl('apply -f -', JSON.stringify({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'e2e-live-big', namespace: NS },
      spec: { nodeName: node, terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'], resources: { requests: { cpu: '11m' } } }] },
    }))
    await expect(async () => {
      const shown = await onScreen()
      expect(shown).not.toEqual(before)
      expect(shown).toEqual(kubectlRows())
    }).toPass({ timeout: 45_000 })
    kubectl(`-n ${NS} delete pod e2e-live-big --wait=false`)
  })

  test('a Node drawer keeps when its node last turned Ready while a change of the node comes live', async ({ page }) => {
    test.setTimeout(120_000)
    const node = kubectl(`-n ${NS} get pod -l app=web -o 'jsonpath={.items[0].spec.nodeName}'`)
    const readyAt = kubectl(`get node ${node} -o 'jsonpath={.status.conditions[?(@.type=="Ready")].lastTransitionTime}'`)
    expect(readyAt, 'kubectl reads the Ready condition').toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const describes = requests(page, new RegExp(`/nodes/${node}/describe`))
    await page.goto(`/cluster/nodes?cluster=self&detail=${encodeURIComponent(`Node/${node}`)}`)
    const drawer = page.locator(DRAWER).last()
    const since = drawer.getByText('Since Ready Changed', { exact: true }).locator('xpath=following-sibling::p[1]')
    await expect(since).not.toHaveText(/^\s*-?\s*$/, { timeout: 30_000 })
    const shown = (await since.innerText()).trim()
    // every frame from here on: what the cell says while the change comes in and is read again
    await since.evaluate((cell) => {
      const seen: string[] = []
      ;(window as unknown as { __readySeen: string[] }).__readySeen = seen
      const sample = () => {
        seen.push((cell as HTMLElement).innerText.trim())
        if (seen.length < 2000) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    const readsBefore = describes.length
    const label = `e2e-live-ready-${STAMP}`
    kubectl(`label node ${node} ${label}=yes --overwrite`)
    try {
      // the Labels section shows the key on its own, the frame's labels written over the answer's
      await expect(drawer.getByText(label, { exact: true })).toHaveCount(1, { timeout: 20_000 })
      await expect.poll(() => describes.length, { timeout: 20_000 }).toBeGreaterThan(readsBefore)
      await page.waitForTimeout(2_000)
      const seen = await page.evaluate(() => (window as unknown as { __readySeen: string[] }).__readySeen)
      expect(seen.length, 'the cell was sampled while the change came in').toBeGreaterThan(10)
      // the age it shows may move on by a minute meanwhile; it never goes empty
      expect(seen.filter((text) => text === '' || text === '-'), `the cell, ${shown} when the drawer opened, never went empty`).toEqual([])
      expect(kubectl(`get node ${node} -o 'jsonpath={.status.conditions[?(@.type=="Ready")].lastTransitionTime}'`), 'a label leaves the Ready condition as it was').toBe(readyAt)
    } finally {
      kubectl(`label node ${node} ${label}-`)
    }
  })

  test('a CRD drawer\'s table and the chosen kind\'s rows follow its objects, and the list of every kind says it does not', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`CustomResourceDefinition/${CRD}`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByText('Custom Resources (1)')).toHaveCount(1, { timeout: 20_000 })
    kubectl('apply -f -', widget('second'))
    await expect(drawer.getByText('Custom Resources (2)')).toHaveCount(1, { timeout: 25_000 })
    kubectl(`-n ${NS} delete livewidget second`)
    await expect(drawer.getByText('Custom Resources (1)')).toHaveCount(1, { timeout: 25_000 })
    kubectl('apply -f -', widget('second'))

    const everyKind = requests(page, /\/custom-resources\/all/)
    await page.goto('/custom-resources/instances?cluster=self')
    await expect(page.getByTestId('cr-not-live')).toHaveCount(1, { timeout: 30_000 })
    await page.getByTestId('cr-instances-kind').click()
    await page.getByRole('button', { name: 'LiveWidget', exact: true }).click()
    await expect(page.getByTestId('cr-not-live')).toHaveCount(0, { timeout: 20_000 })
    const rows = page.locator('main tbody tr')
    await expect(rows.filter({ hasText: 'second' })).toHaveCount(1, { timeout: 20_000 })
    const reads = everyKind.length
    kubectl('apply -f -', widget('third'))
    await expect(rows.filter({ hasText: 'third' })).toHaveCount(1, { timeout: 25_000 })
    kubectl(`-n ${NS} delete livewidget first`)
    await expect(rows.filter({ hasText: 'first' })).toHaveCount(0, { timeout: 25_000 })
    expect(everyKind.length, 'the list of every kind is not read for one kind').toBe(reads)
  })

  test('a new row goes where the next read of the list puts it', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto(`/configuration/configmaps?cluster=self&namespace=${NS}`)
    const rows = page.locator('main tbody tr')
    await expect(rows.filter({ hasText: 'gamma' })).toHaveCount(1, { timeout: 20_000 })
    kubectl(`-n ${NS} create configmap beta`)
    await expect(rows.filter({ hasText: 'beta' })).toHaveCount(1, { timeout: 20_000 })
    const order = async () => (await rows.allInnerTexts()).map((text) => text.trim().split(/\s+/)[0]).filter((name) => ['alpha', 'beta', 'gamma'].includes(name))
    expect(await order()).toEqual(['alpha', 'beta', 'gamma'])
    await page.reload()
    await expect(rows.filter({ hasText: 'gamma' })).toHaveCount(1, { timeout: 20_000 })
    expect(await order()).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('a grant limited to a namespace follows a kind of the cluster its RBAC lets it list, with one watch and no notice', async ({ request, browser }) => {
    test.setTimeout(120_000)
    const login = async (r: APIRequestContext, email: string, password: string) => {
      const res = await r.post('/api/v1/auth/login', { data: { email, password } })
      expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
      return (await res.json()).access_token as string
    }
    const signIn = async (b: Browser, email: string) => {
      const ctx = await b.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
      const page = await ctx.newPage()
      return { page, go: async () => {
        await page.goto('/login')
        await page.locator('input[autocomplete="email"]').first().fill(email)
        await page.locator('input[type="password"]').first().fill(PW)
        await page.locator('button[type="submit"]').first().click()
        await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
      } }
    }
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as { id: number; name: string }[]
    const email = `e2e-live-${STAMP}@kubeast.local`
    let id = ''
    kubectl(`create clusterrole ${CLUSTER_ROLE} --verb=get,list,watch --resource=storageclasses`)
    kubectl(`create clusterrolebinding ${CLUSTER_ROLE} --clusterrole=${CLUSTER_ROLE} --group=kubeast:role:read`)
    kubectl(`-n ${NS} create rolebinding e2e-live-view --clusterrole=view --group=kubeast:role:read`)
    try {
      const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E live drawers', email, password: PW, role_id: roles.find((r) => r.name.toLowerCase() === 'member')!.id } })
      expect(made.status(), `create ${email}`).toBe(201)
      id = (await made.json()).id
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })).ok()).toBeTruthy()

      const { page, go } = await signIn(browser, email)
      await go()
      const asked: string[] = []
      const refused: string[] = []
      await page.routeWebSocket(/wsMultiplexer/, (ws) => {
        const server = ws.connectToServer()
        ws.onMessage((message) => {
          const request = JSON.parse(String(message))
          if (request.type === 'REQUEST' && String(request.path).endsWith('/storageclasses')) asked.push(request.path)
          server.send(message)
        })
        server.onMessage((message) => {
          const frame = JSON.parse(String(message))
          if (frame.type === 'ERROR' && String(frame.path).endsWith('/storageclasses')) refused.push(frame.error?.reason)
          ws.send(message)
        })
      })
      await page.goto('/storage?tab=storageclasses&cluster=self')
      const rows = page.locator('main tbody tr')
      await expect.poll(() => asked.length, { timeout: 20_000 }).toBeGreaterThan(0)
      expect(asked).toEqual(['/api/v1/storageclasses'])
      kubectl(`apply -f -`, JSON.stringify({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: SC }, provisioner: 'kubernetes.io/no-provisioner' }))
      await expect(rows.filter({ hasText: SC })).toHaveCount(1, { timeout: 25_000 })
      expect(refused).toEqual([])
      await expect(page.getByTestId('watch-problem-notice')).toHaveCount(0)
      await page.context().close()
    } finally {
      if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      kubectl(`delete storageclass ${SC} --ignore-not-found`)
      kubectl(`delete clusterrolebinding ${CLUSTER_ROLE} --ignore-not-found`)
      kubectl(`delete clusterrole ${CLUSTER_ROLE} --ignore-not-found`)
    }
  })
})
