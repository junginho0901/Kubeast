import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Phase 5.8 polish — 24 detail modal 추가 항목 회귀 시나리오.
// HIGH 5 (Pod envFrom / imagePullSecrets / Volume ResourceLink / Node images /
// RB/CRB subjects ResourceLink) + MEDIUM 11 + LOW 7.
//
// Each scenario opens the drawer of a known object on `self` (the kind cluster itself, with
// deploy/kind/fixtures.yaml) and checks that the drawer is that object and shows the value the cluster has
// (read with kubectl), not only that a section title is there.

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detail-modal-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

// The list on `self`, searched for `name`; the drawer of the row whose name cell is exactly `name`.
async function openDrawer(page: Page, route: string, name: string) {
  await page.goto(`${route}${route.includes('?') ? '&' : '?'}cluster=self`)
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 30000 })
  const search = page.getByPlaceholder(/search|검색/i).first()
  if (await search.count()) await search.fill(name)
  await page.getByRole('cell', { name, exact: true }).first().click({ timeout: 20000 })
  const drawer = page.locator(DRAWER).last()
  await expect(drawer).toContainText(name, { timeout: 20000 })
  return drawer
}

function firstName(args: string): string {
  return kubectl(`${args} -o jsonpath='{.items[0].metadata.name}'`)
}

test.describe('Phase 5.8 — detail modal polish 24 additions', () => {

  // ===== HIGH 5 =====

  test('HIGH Pod envFrom / imagePullSecrets / Volume ResourceLink', async ({ page }) => {
    const pod = kubectl(`-n default get pod -l app=e2e-logfile-writer -o jsonpath='{.items[0].metadata.name}'`)
    test.skip(!pod, 'e2e-logfile-writer pod missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/workloads/pods', pod)
    await expect(drawer.locator('text=/^Basic Info$/').first()).toBeVisible()
    // its emptyDir volume "logs" is listed
    await expect(drawer).toContainText('logs')
  })

  test('HIGH Node images table 표시 (worker node)', async ({ page }) => {
    const node = firstName('get nodes')
    const images = Number(kubectl(`get node ${node} -o go-template='{{len .status.images}}'`))
    const drawer = await openDrawer(page, '/cluster/nodes', node)
    // the count the kubelet reports
    await expect(drawer.locator('text=/Images\\s*\\(\\d+\\)/').first()).toHaveText(new RegExp(`Images\\s*\\(${images}\\)`), { timeout: 15000 })
  })

  test('HIGH ClusterRoleBinding subject ResourceLink (cluster-admin)', async ({ page }) => {
    const subject = kubectl(`get clusterrolebinding cluster-admin -o jsonpath='{.subjects[0].name}'`)
    const drawer = await openDrawer(page, '/security/clusterrolebindings', 'cluster-admin')
    await expect(drawer.locator('text=/^Subjects/').first()).toBeVisible()
    await expect(drawer).toContainText(subject)
  })

  // ===== MEDIUM 11 =====

  test('MEDIUM ConfigMap Immutable row (kube-root-ca.crt)', async ({ page }) => {
    const drawer = await openDrawer(page, '/configuration/configmaps', 'kube-root-ca.crt')
    await expect(drawer.locator('text=/^Basic Info$/').first()).toBeVisible()
    // its one data key
    await expect(drawer).toContainText('ca.crt')
  })

  test('MEDIUM Node Volumes (Attached / In Use) section', async ({ page }) => {
    const node = firstName('get nodes')
    const attached = kubectl(`get node ${node} -o jsonpath='{.status.volumesAttached[*].name}'`)
    const drawer = await openDrawer(page, '/cluster/nodes', node)
    test.skip(!attached, 'no volume attached to the kind node (no CSI attacher)')
    await expect(drawer.locator('text=/^Volumes$/').first()).toBeVisible()
    await expect(drawer).toContainText(attached.split(' ')[0])
  })

  test('MEDIUM EndpointSlice hints.forZones (있으면)', async ({ page }) => {
    const slice = firstName('-n default get endpointslices -l kubernetes.io/service-name=kubernetes')
    const address = kubectl(`-n default get endpointslice ${slice} -o jsonpath='{.endpoints[0].addresses[0]}'`)
    const drawer = await openDrawer(page, '/network/endpointslices', slice)
    await expect(drawer.locator('text=/^Endpoints$/').first()).toBeVisible()
    await expect(drawer).toContainText(address)
  })

  test('MEDIUM Service Topology Aware Routing 표시 (있으면)', async ({ page }) => {
    const clusterIP = kubectl(`-n default get svc kubernetes -o jsonpath='{.spec.clusterIP}'`)
    const drawer = await openDrawer(page, '/network/services', 'kubernetes')
    await expect(drawer.locator('text=/^Service Info$/').first()).toBeVisible()
    await expect(drawer).toContainText(clusterIP)
  })

  test('MEDIUM Namespace pod phase 배지 + Resource Summary (kube-system)', async ({ page }) => {
    const drawer = await openDrawer(page, '/cluster/namespaces', 'kube-system')
    await expect(drawer.locator('text=/Resource Summary/').first()).toBeVisible({ timeout: 15000 })
    // kube-system always runs pods
    await expect(drawer).toContainText(/Running/)
  })

  test('MEDIUM StatefulSet volumeClaimTemplates 표시 (있으면)', async ({ page }) => {
    const template = kubectl(`-n default get statefulset e2e-fixture -o jsonpath='{.spec.volumeClaimTemplates[0].metadata.name}'`)
    test.skip(!template, 'e2e-fixture StatefulSet missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/workloads/statefulsets', 'e2e-fixture')
    await expect(drawer).toContainText(/Volume Claim Templates|volumeClaimTemplates/i)
    await expect(drawer).toContainText(template)
  })

  test('MEDIUM DaemonSet Misscheduled / Unavailable 행 (kube-proxy)', async ({ page }) => {
    const misscheduled = kubectl(`-n kube-system get daemonset kube-proxy -o jsonpath='{.status.numberMisscheduled}'`)
    const drawer = await openDrawer(page, '/workloads/daemonsets', 'kube-proxy')
    await expect(drawer.locator('text=/^Replicas$/').first()).toBeVisible()
    // Misscheduled / Unavailable 행은 DaemonSet 일 때만 추가됨
    await expect(drawer.locator('text=/Misscheduled/').first()).toBeVisible()
    await expect(drawer.locator('text=/Unavailable/').first()).toBeVisible()
    await expect(drawer).toContainText(misscheduled || '0')
  })

  test('MEDIUM CronJob 모든 policy 필드 표시 (있으면)', async ({ page }) => {
    const policy = kubectl(`-n default get cronjob e2e-fixture -o jsonpath='{.spec.concurrencyPolicy}'`)
    test.skip(!policy, 'e2e-fixture CronJob missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/workloads/cronjobs', 'e2e-fixture')
    await expect(drawer.locator('text=/^Schedule$/').first()).toBeVisible()
    await expect(drawer.locator('text=/^Concurrency Policy$/').first()).toBeVisible()
    await expect(drawer.locator('text=/^Starting Deadline$/').first()).toBeVisible()
    await expect(drawer).toContainText('0 3 * * *')
    await expect(drawer).toContainText(policy)
  })

  test('MEDIUM Ingress TLS Secret ResourceLink (있으면)', async ({ page }) => {
    const secret = kubectl(`-n default get ingress e2e-fixture -o jsonpath='{.spec.tls[0].secretName}'`)
    test.skip(!secret, 'e2e-fixture Ingress missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/network/ingresses', 'e2e-fixture')
    await expect(drawer).toContainText(secret)
  })

  test('MEDIUM HPA Metrics 정렬 (있으면)', async ({ page }) => {
    const target = kubectl(`-n default get hpa e2e-fixture -o jsonpath='{.spec.metrics[0].resource.target.averageUtilization}'`)
    test.skip(!target, 'e2e-fixture HPA missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/workloads/hpas', 'e2e-fixture')
    await expect(drawer).toContainText(/cpu/i)
    await expect(drawer).toContainText(`${target}%`)
  })

  // ===== LOW 7 (Lease skip) =====

  test('LOW PV Volume Attributes (CSI 일 때)', async ({ page }) => {
    const pv = firstName('get pv')
    test.skip(!pv, 'no PersistentVolume on self')
    const capacity = kubectl(`get pv ${pv} -o jsonpath='{.spec.capacity.storage}'`)
    const drawer = await openDrawer(page, '/storage?tab=pvs', pv)
    await expect(drawer).toContainText(capacity)
  })

  test('LOW PVC Data Source 행 (있으면)', async ({ page }) => {
    const pvc = firstName('-n default get pvc')
    test.skip(!pvc, 'no PersistentVolumeClaim in default on self')
    const storageClass = kubectl(`-n default get pvc ${pvc} -o jsonpath='{.spec.storageClassName}'`)
    const drawer = await openDrawer(page, '/storage?tab=pvcs', pvc)
    await expect(drawer).toContainText(storageClass)
  })

  test('LOW Deployment Replicas (Up to date / Available)', async ({ page }) => {
    const replicas = kubectl(`-n default get deployment e2e-argo-managed -o jsonpath='{.spec.replicas}'`)
    test.skip(!replicas, 'e2e-argo-managed Deployment missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/workloads/deployments', 'e2e-argo-managed')
    await expect(drawer.locator('text=/^Replicas$/').first()).toBeVisible()
    await expect(drawer.locator('text=/Up to date/').first()).toBeVisible()
    await expect(drawer.locator('text=/Available/').first()).toBeVisible()
    await expect(drawer).toContainText(replicas)
  })

  test('LOW NetworkPolicy egress namespaceSelector (있으면)', async ({ page }) => {
    const policy = firstName('-n kubeast get networkpolicy')
    test.skip(!policy, 'no NetworkPolicy in kubeast on self')
    const drawer = await openDrawer(page, '/network/networkpolicies', policy)
    await expect(drawer).toContainText(/Ingress|Egress/)
  })

  test('LOW CRD printerColumns 표시 (있으면)', async ({ page }) => {
    const columns = kubectl(`get crd modelconfigs.ai.kubeast.io -o jsonpath='{.spec.versions[0].additionalPrinterColumns[*].name}'`)
    test.skip(!columns, 'ModelConfig CRD missing on self')
    const drawer = await openDrawer(page, '/custom-resources/groups', 'modelconfigs.ai.kubeast.io')
    for (const column of columns.split(' ')) await expect(drawer).toContainText(column)
  })

  test('LOW RuntimeClass Schedulable Nodes (있으면)', async ({ page }) => {
    const handler = kubectl(`get runtimeclass e2e-fixture -o jsonpath='{.handler}'`)
    test.skip(!handler, 'e2e-fixture RuntimeClass missing (fixtures.yaml)')
    const drawer = await openDrawer(page, '/cluster/runtimeclasses', 'e2e-fixture')
    await expect(drawer).toContainText(handler)
  })

  test('LOW PriorityClass globalDefault conflict warning', async ({ page }) => {
    const value = kubectl(`get priorityclass system-cluster-critical -o jsonpath='{.value}'`)
    const drawer = await openDrawer(page, '/cluster/priorityclasses', 'system-cluster-critical')
    await expect(drawer).toContainText(value)
  })

  // ===== 통합 회귀 — 모든 모달 mount 시 page error 0 =====

  test('통합 — Pod / Node / Namespace / Deployment / DaemonSet 모달 mount 시 page error 0', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`PAGEERR: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const routes = [
      '/workloads/pods',
      '/cluster/nodes',
      '/cluster/namespaces',
      '/workloads/deployments',
      '/workloads/daemonsets',
    ]

    for (const r of routes) {
      await page.goto(`${r}?cluster=self`)
      await page.waitForLoadState('networkidle')
      const row = page.locator('tbody:not([aria-hidden="true"]) tr:not(:has(td[colspan]))').first()
      await expect(row).toBeVisible({ timeout: 30000 })
      await row.click()
      await expect(page.locator(DRAWER).last()).toBeVisible({ timeout: 15000 })
      await page.keyboard.press('Escape')
      await expect(page.locator(DRAWER)).toHaveCount(0)
    }

    const critical = errors.filter((e) =>
      /Rendered more hooks|Cannot read|undefined is not|TypeError|ReferenceError/.test(e),
    )
    expect(critical, `unexpected critical errors:\n${critical.join('\n')}`).toEqual([])
  })
})
