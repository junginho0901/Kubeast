import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A drawer whose own read (describe) failed says so where its fields would be, with the server's reason, instead of a
// fixed sentence ("Failed to load describe data", "Some detailed fields are unavailable"), "No data" or a value it
// never read: a Role's Rules Count is "—", not 0. Every describe read is answered 503 in the browser with a reason of
// its own, so nothing on the cluster changes; the objects are ones a kind dev cluster always has on `self`, but for an
// IngressClass, which the dev cluster has none of: one is made for the run (a controller no one runs) and removed.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the API server did not answer'
const SAID = EN.common.describeFailed.replace('{{reason}}', REASON)
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const INGRESS_CLASS = `e2e-read-failures-${Date.now().toString(36)}`

const DRAWERS: { what: string; detail: string; notShown?: string }[] = [
  { what: 'Role', detail: 'Role/kube-system/extension-apiserver-authentication-reader' },
  { what: 'ClusterRole', detail: 'ClusterRole/view' },
  { what: 'HorizontalPodAutoscaler', detail: 'HorizontalPodAutoscaler/default/e2e-fixture', notShown: 'No data' },
  { what: 'Deployment', detail: 'Deployment/kube-system/coredns', notShown: 'Some detailed fields are unavailable right now.' },
  { what: 'Service', detail: 'Service/default/kubernetes', notShown: 'Failed to load describe data. Showing summary from list.' },
  { what: 'StorageClass', detail: 'StorageClass/standard', notShown: 'Some detailed StorageClass fields are unavailable right now.' },
  { what: 'Node', detail: 'Node/kubeast-control-plane', notShown: 'Failed to load node details.' },
  { what: 'Namespace', detail: 'Namespace/default', notShown: 'Failed to load.' },
  { what: 'ClusterRoleBinding', detail: 'ClusterRoleBinding/cluster-admin' },
  { what: 'RoleBinding', detail: 'RoleBinding/kube-system/kube-proxy' },
  { what: 'ConfigMap', detail: 'ConfigMap/kube-system/coredns' },
  { what: 'Secret', detail: 'Secret/kubeast/kubeast-ai-keys' },
  { what: 'ServiceAccount', detail: 'ServiceAccount/kube-system/coredns' },
  { what: 'CustomResourceDefinition', detail: 'CustomResourceDefinition/modelconfigs.ai.kubeast.io' },
  { what: 'Pod', detail: 'Pod/kube-system/etcd-kubeast-control-plane' },
  { what: 'EndpointSlice', detail: 'EndpointSlice/default/kubernetes' },
  { what: 'IngressClass', detail: `IngressClass/${INGRESS_CLASS}` },
  { what: 'Ingress', detail: 'Ingress/default/e2e-fixture' },
  { what: 'NetworkPolicy', detail: 'NetworkPolicy/kubeast/kubeast-allow-dns' },
]

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-drawer-reads-')), 'kubeconfig')
const ingressClass = `{"apiVersion":"networking.k8s.io/v1","kind":"IngressClass","metadata":{"name":"${INGRESS_CLASS}"},"spec":{"controller":"example.com/e2e-none"}}`
test.beforeAll(() => {
  fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  execSync(`kubectl --kubeconfig ${kubeconfig} create -f -`, { input: ingressClass, stdio: ['pipe', 'pipe', 'pipe'] })
})
test.afterAll(() => {
  execSync(`kubectl --kubeconfig ${kubeconfig} delete ingressclass ${INGRESS_CLASS} --ignore-not-found`, { stdio: 'pipe' })
})

// A CRD drawer whose objects could not be listed says so instead of leaving its Custom Resources section out. The CRD is
// Kubeast's own ModelConfig, which the dev install serves on `self`.
test("a CRD drawer whose custom resources could not be listed says why", async ({ page }) => {
  await page.route((u) => u.pathname === '/api/v1/cluster/custom-resources/ai.kubeast.io/v1alpha1/modelconfigs', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { detail: REASON } }) : route.fallback())
  await page.goto(`/?cluster=self&detail=${encodeURIComponent('CustomResourceDefinition/modelconfigs.ai.kubeast.io')}`)
  const drawer = page.locator(DRAWER).last()
  await expect(drawer.getByTestId('crd-instances-read-failed')).toHaveText(EN.common.readFailed.replace('{{reason}}', REASON), { timeout: 30_000 })
})

// A Role's and a ClusterRole's Referenced By whose binding list the cluster refused says the server's reason beside
// the fixed sentence, not "Request failed with status code 403". The refusal is answered in the browser.
for (const d of [
  { what: 'Role', detail: 'Role/kube-system/extension-apiserver-authentication-reader', list: '/api/v1/cluster/namespaces/kube-system/rolebindings', kind: 'RoleBindings' },
  { what: 'ClusterRole', detail: 'ClusterRole/view', list: '/api/v1/cluster/clusterrolebindings', kind: 'ClusterRoleBindings' },
]) {
  test(`${d.what}: Referenced By says why its bindings could not be listed`, async ({ page }) => {
    const REFUSED = 'e2e stand-in: bindings may not be listed by this identity'
    await page.route((u) => u.pathname === d.list, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 403, json: { detail: REFUSED } }) : route.fallback())
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(d.detail)}`)
    const line = page.locator(DRAWER).last().getByTestId('referenced-by-read-failed').first()
    await expect(line).toHaveText(`You may not list ${d.kind} here, so the bindings that reference this ${d.what} cannot be shown: ${REFUSED}`, { timeout: 30_000 })
    await expect(line).not.toContainText('status code')
  })
}

test.describe("a drawer whose own read failed says why", () => {
  for (const d of DRAWERS) {
    test(`${d.what}: the reason where its fields would be`, async ({ page }) => {
      await page.route((u) => u.pathname.startsWith('/api/v1/cluster/') && u.pathname.endsWith('/describe'), (route) =>
        route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { detail: REASON } }) : route.fallback())
      await page.goto(`/?cluster=self&detail=${encodeURIComponent(d.detail)}`)
      const drawer = page.locator(DRAWER).last()
      const line = drawer.getByTestId('describe-failed')
      await expect(line).toContainText(SAID, { timeout: 30_000 })
      await expect(line).toHaveAttribute('role', 'alert')
      if (d.notShown) await expect(drawer.getByText(d.notShown, { exact: true }), 'the fixed sentence is gone').toHaveCount(0)
      if (d.what === 'Role' || d.what === 'ClusterRole') {
        const count = drawer.getByText('Rules Count', { exact: true }).locator('xpath=..')
        await expect(count, 'rules not read are not 0 rules').toContainText('—')
        await expect(count).not.toContainText(/\b0\b/)
      }
    })
  }
})

// What a drawer reads beside its object, and what only its describe answer holds, says why it is missing instead of 0
// or None: a Pod opened from the Pods list (whose row holds no spec), a Namespace's pods, an IngressClass's Ingresses
// and a Service's endpoints. Each read is answered in the browser; nothing on the cluster changes.
test.describe('what a drawer could not read is not 0 or None', () => {
  const failing = (page: import('@playwright/test').Page, pick: (path: string) => boolean) =>
    page.route((u) => pick(u.pathname), (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { detail: REASON } }) : route.fallback())

  test('a Pod opened from the Pods list: the reason, not 0 containers', async ({ page }) => {
    await failing(page, (p) => p.startsWith('/api/v1/cluster/') && p.endsWith('/describe'))
    await page.goto('/workloads/pods?cluster=self&namespace=kube-system')
    await page.locator('tbody:not([aria-hidden="true"]) tr').filter({ hasText: 'etcd-kubeast-control-plane' }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('describe-failed')).toContainText(SAID, { timeout: 30_000 })
    await expect(drawer.getByText('Containers', { exact: true }), 'no counts drawn from nothing').toHaveCount(0)
  })

  test("a Namespace's pods that could not be listed", async ({ page }) => {
    await failing(page, (p) => p === '/api/v1/cluster/namespaces/kube-system/owned-pods')
    await page.goto(`/?cluster=self&detail=${encodeURIComponent('Namespace/kube-system')}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('list-read-failed')).toHaveText(EN.common.readFailed.replace('{{reason}}', REASON), { timeout: 30_000 })
    await expect(drawer.getByText('Pods', { exact: true }).first().locator('xpath=..'), 'a count not read is not 0').toContainText('—')
  })

  test("an IngressClass's Ingresses that could not be listed", async ({ page }) => {
    await failing(page, (p) => p === `/api/v1/cluster/ingressclasses/${INGRESS_CLASS}/ingresses`)
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`IngressClass/${INGRESS_CLASS}`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('list-read-failed')).toHaveText(EN.common.readFailed.replace('{{reason}}', REASON), { timeout: 30_000 })
    await expect(drawer.getByText('No Ingress in the cluster uses this IngressClass.', { exact: true })).toHaveCount(0)
  })

  test("a Service whose describe failed: its endpoints are not 0 Ready", async ({ page }) => {
    await failing(page, (p) => p.startsWith('/api/v1/cluster/') && p.endsWith('/describe'))
    await page.goto(`/?cluster=self&detail=${encodeURIComponent('Service/default/kubernetes')}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('service-endpoints-unread')).toHaveText('—', { timeout: 30_000 })
    await expect(drawer.getByTestId('service-ready-addresses')).toHaveCount(0)
  })
})
