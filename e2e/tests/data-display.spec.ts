import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Numbers and values on screen are the ones the cluster reports (re-QA #30
// #31 #32 #33 #35 #36 #40 #59): each test reads the same thing through
// kubectl and compares. Runs against `self` (fixtures.yaml: the Argo CD
// Deployment, the HPA, the failed Job); objects it creates are deleted.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'

type Headers = Record<string, string>

async function login(request: APIRequestContext): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// kubectl against the kind cluster behind `self`, through its own kubeconfig
// (never the shell's).
function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-data-display-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

async function rowCells(page: Page, text: string): Promise<string[]> {
  const row = page.locator('tbody tr').filter({ hasText: text }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  return (await row.locator('td').allInnerTexts()).map((s) => s.trim())
}

async function columnIndex(page: Page, header: RegExp): Promise<number> {
  const headers = (await page.locator('thead th').allInnerTexts()).map((s) => s.trim())
  const i = headers.findIndex((h) => header.test(h))
  expect(i, `column ${header} in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0)
  return i
}

test.describe('data display matches the cluster', () => {
  test('ReplicaSet current count, containers and owner are what kubectl reports (#30)', async ({ page }) => {
    const rs = kubectl(`-n default get rs -l app=e2e-argo-managed -o 'jsonpath={.items[0].metadata.name}'`)
    test.skip(!rs, 'fixture e2e-argo-managed missing')
    const current = kubectl(`-n default get rs ${rs} -o 'jsonpath={.status.replicas}'`) || '0'
    const containers = kubectl(`-n default get rs ${rs} -o 'jsonpath={.spec.template.spec.containers[*].name}'`)

    await page.goto(`/workloads/replicasets?cluster=${CLUSTER}`)
    const cells = await rowCells(page, rs)
    expect(cells[await columnIndex(page, /^Current/)]).toBe(current)
    expect(cells[await columnIndex(page, /^Containers/)]).toBe(containers.split(' ').join(', '))
    expect(cells[await columnIndex(page, /^Owner/)]).toBe('e2e-argo-managed')

    // the drawer's Replicas section (InfoRow: label span, then value span)
    await page.locator('tbody tr').filter({ hasText: rs }).first().click()
    const drawerCurrent = page.locator('span.shrink-0', { hasText: /^Current$/ }).locator('xpath=following-sibling::span[1]')
    await expect(drawerCurrent).toHaveText(current, { timeout: 15_000 })
  })

  test('the HPA YAML is in the preferred version, every time (#31)', async ({ request }) => {
    const headers = await login(request)
    const hpa = kubectl('-n default get hpa e2e-fixture -o name --ignore-not-found')
    test.skip(!hpa, 'fixture HPA e2e-fixture missing')
    const preferred = JSON.parse(kubectl('get --raw /apis/autoscaling')).preferredVersion.groupVersion as string
    for (let i = 0; i < 3; i++) {
      const res = await request.get(`/api/v1/cluster/resources/yaml?resource_type=horizontalpodautoscalers&namespace=default&name=e2e-fixture&cluster=${CLUSTER}`, { headers })
      expect(res.ok()).toBeTruthy()
      expect((await res.json()).yaml).toContain(`apiVersion: ${preferred}`)
    }
  })

  test('creating from YAML posts to the version the document names (#31)', async ({ request }) => {
    const headers = await login(request)
    const doc = [
      'apiVersion: autoscaling/v1',
      'kind: HorizontalPodAutoscaler',
      'metadata: {name: e2e-data-display-v1, namespace: default}',
      'spec: {scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: e2e-data-display-none}, maxReplicas: 2}',
    ].join('\n')
    try {
      const res = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers, data: { yaml: doc, namespace: 'default' } })
      expect(res.ok(), await res.text()).toBeTruthy()
      expect(kubectl(`-n default get hpa.v1.autoscaling e2e-data-display-v1 -o 'jsonpath={.metadata.name}'`)).toBe('e2e-data-display-v1')

      const beta = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, {
        headers, data: { yaml: 'apiVersion: resource.k8s.io/v1beta1\nkind: DeviceClass\nmetadata: {name: e2e-data-display-beta}\n', namespace: '' },
      })
      expect(beta.ok()).toBeFalsy()
      expect((await beta.json()).detail).toContain('resource.k8s.io/v1beta1 DeviceClass is not served')
    } finally {
      kubectl('-n default delete hpa e2e-data-display-v1 --ignore-not-found')
    }
  })

  test('the DRA create examples create what they show (#32)', async ({ page }) => {
    test.skip(!kubectl('api-versions').split('\n').includes('resource.k8s.io/v1'), 'cluster does not serve resource.k8s.io/v1')
    const created = [
      { route: 'gpu/deviceclasses', button: 'Create DeviceClass', get: 'deviceclass example-gpu-class' },
      { route: 'gpu/resourceclaimtemplates', button: 'Create ResourceClaimTemplate', get: '-n default resourceclaimtemplate example-gpu-claim-template' },
      { route: 'gpu/resourceclaims', button: 'Create ResourceClaim', get: '-n default resourceclaim example-gpu-claim' },
    ]
    try {
      for (const c of created) {
        await page.goto(`/${c.route}?cluster=${CLUSTER}`)
        await page.getByRole('button', { name: c.button }).click()
        await page.getByRole('button', { name: 'Create', exact: true }).click()
        await expect.poll(() => kubectl(`get ${c.get} -o name --ignore-not-found`), { message: c.get, timeout: 10_000 }).not.toBe('')
      }
    } finally {
      for (const c of [...created].reverse()) kubectl(`delete ${c.get} --ignore-not-found`)
    }
  })

  test('HPA active card counts ScalingActive=True (#33)', async ({ page }) => {
    const conds = kubectl(`get hpa -A -o 'jsonpath={range .items[*]}{.status.conditions[?(@.type=="ScalingActive")].status}{","}{end}'`)
    const all = conds.split(',').filter((_, i, a) => i < a.length - 1)
    test.skip(all.length === 0, 'no HPA on the cluster')
    const active = all.filter((s) => s === 'True').length

    await page.goto(`/workloads/hpas?cluster=${CLUSTER}`)
    const card = (label: string) => page.locator('div.rounded-lg', { has: page.getByText(label, { exact: true }) }).locator('p').nth(1)
    await expect(card('Total')).toHaveText(String(all.length), { timeout: 15_000 })
    await expect(card('Active')).toHaveText(String(active))
    await expect(card('Inactive')).toHaveText(String(all.length - active))
  })

  test('Node drawer shows the runtime, the Pod CIDR and byte capacities in units (#35)', async ({ page }) => {
    const node = kubectl(`get nodes -o 'jsonpath={.items[0].metadata.name}'`)
    const runtime = kubectl(`get node ${node} -o 'jsonpath={.status.nodeInfo.containerRuntimeVersion}'`)
    const podCIDR = kubectl(`get node ${node} -o 'jsonpath={.spec.podCIDR}'`)

    await page.goto(`/cluster/nodes?cluster=${CLUSTER}`)
    await page.locator('tbody tr').filter({ hasText: node }).first().click()
    await expect(page.getByText(`Runtime: ${runtime}`)).toBeVisible({ timeout: 15_000 })
    if (podCIDR) await expect(page.getByText(podCIDR, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/Kube Proxy/)).toHaveCount(0)
    const storage = page.locator('tr').filter({ hasText: 'ephemeral-storage' }).first()
    await expect(storage.locator('td').nth(1)).toHaveText(/^\d+(\.\d)?(Ki|Mi|Gi|Ti)$/)
  })

  test('a failed Job pod reads as kubectl does, after the watch too (#59)', async ({ page }) => {
    const line = kubectl('-n default get pod -l job-name=e2e-failing-job --no-headers')
    test.skip(!line, 'fixture e2e-failing-job missing')
    const [pod, , status] = line.split(/\s+/)

    await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
    await rowCells(page, pod)
    await page.waitForTimeout(4_000) // the watch's first sync arrives after the list
    const cells = await rowCells(page, pod)
    expect(cells[await columnIndex(page, /^Status/)]).toBe(status)
  })

  test('Advanced Search offers extension resources under their API group (#36)', async ({ page }) => {
    await page.goto(`/cluster/search?cluster=${CLUSTER}`)
    await page.getByRole('button', { name: /Select Resources/ }).click()
    await page.getByPlaceholder('Filter resources...').fill('autoscaling')
    await expect(page.getByText('HorizontalPodAutoscaler', { exact: true })).toBeVisible()
    await page.getByPlaceholder('Filter resources...').fill('ai.kubeast.io')
    await expect(page.getByText('ModelConfig', { exact: true })).toBeVisible()
  })

  test('Clusters show the API server each cluster is reached at (#40)', async ({ page, request }) => {
    const headers = await login(request)
    const { items: list } = (await (await request.get('/api/v1/clusters', { headers })).json()) as { items: Array<{ id: string; is_self_cluster?: boolean }> }
    const external = list.filter((c) => !c.is_self_cluster)
    test.skip(external.length === 0, 'no external cluster registered')
    const servers: Record<string, string> = {}
    for (const c of external) {
      const res = await request.post(`/api/v1/clusters/${c.id}/test`, { headers })
      const body = await res.json()
      expect(body.healthy, `${c.id}: ${body.message ?? ''}`).toBeTruthy()
      servers[c.id] = body.server
      expect(servers[c.id]).toMatch(/^https:\/\//)
    }

    await page.goto('/admin/clusters')
    for (const c of external) await expect(page.locator('tbody tr').filter({ hasText: c.id }).first()).toContainText(servers[c.id])
    const self = list.find((c) => c.is_self_cluster)
    if (self) await expect(page.locator('tbody tr').filter({ hasText: 'self' }).first()).toContainText(/In-cluster|https:\/\//)
  })
})
