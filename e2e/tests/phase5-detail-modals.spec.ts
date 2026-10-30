import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Phase 5 detail 모달 강화 + wsMultiplexer fix + 페이지네이션.
// Each drawer is opened on `self` (the kind cluster itself) and its counts are compared with what kubectl reads
// from the same cluster.

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-phase5-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
}
const kubectl = kubectlFor('kubeast')

const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

type Pod = { metadata: { name: string }; spec: Record<string, any>; status?: { phase?: string } }
const pods = (ns: string): Pod[] => JSON.parse(kubectl(`-n ${ns} get pods -o json`)).items

// The list on `self` once its rows are in, searched for `name`; the drawer of that row (in `namespace` when given).
async function openDrawer(page: Page, route: string, name: string, namespace?: string) {
  await page.goto(`${route}${route.includes('?') ? '&' : '?'}cluster=self`)
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 30000 })
  const search = page.getByPlaceholder(/search|검색/i).first()
  if (await search.count()) await search.fill(name)
  let row = page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) })
  if (namespace) row = row.filter({ has: page.locator(`td[title="${namespace}"]`) })
  await row.first().getByRole('cell', { name, exact: true }).click({ timeout: 20000 })
  const drawer = page.locator(DRAWER).last()
  await expect(drawer).toContainText(name, { timeout: 20000 })
  return drawer
}

// "<label> (N)" in the drawer, once the watch-fed count has settled on `expected`
async function expectCount(page: Page, label: string, expected: number) {
  await expect(page.locator(DRAWER).last().locator(`text=/${label} \\(\\d+\\)/`).first()).toHaveText(new RegExp(`${label} \\(${expected}\\)`), { timeout: 30000 })
}

test.describe('Phase 5 — detail modal sections', () => {

  test('5.2 + backend fix — Service Matching Pods 가 selector 매칭 Pod 만', async ({ page }) => {
    const expected = pods('kubeast').filter((p) => p.metadata.name.startsWith('ai-service-')).length
    test.skip(expected === 0, 'no ai-service pod on self')
    await openDrawer(page, '/network/services', 'ai-service', 'kubeast')
    await expectCount(page, 'Matching Pods', expected)
  })

  test('페이지네이션 — PriorityClass system-node-critical', async ({ page }) => {
    await openDrawer(page, '/cluster/priorityclasses', 'system-node-critical')
    const usingSection = page.locator('text=/Used By Pods \\(\\d+\\)/').first()
    await usingSection.waitFor({ timeout: 15000 })
    const total = parseInt((await usingSection.innerText()).match(/\((\d+)\)/)?.[1] ?? '0', 10)
    test.skip(total <= 10, `Pods ${total}개 → 페이지네이션 무의미`)

    await expect(page.locator(`text=/1-10 \\/ ${total}/`).first()).toBeVisible()
    await page.locator('button:has-text("Next")').first().click()
    // the next page of the pods
    await expect(page.locator(`text=/11-\\d+ \\/ ${total}/`).first()).toContainText(`11-${Math.min(20, total)} / ${total}`)
  })

  test('5.4 — ConfigMap kube-root-ca.crt Used By Pods', async ({ page }) => {
    // the projected service-account volume of every pod that mounts its token
    const expected = pods('kubeast').filter((p) => (p.spec.volumes ?? []).some((v: any) =>
      (v.projected?.sources ?? []).some((s: any) => s.configMap?.name === 'kube-root-ca.crt'))).length
    await openDrawer(page, '/configuration/configmaps', 'kube-root-ca.crt', 'kubeast')
    await expectCount(page, 'Used By Pods', expected)
  })

  test('5.4 — ServiceAccount Effective Permissions (k8s-service)', async ({ page }) => {
    const verbs = kubectl(`get clusterrole kubeast-impersonator -o jsonpath='{.rules[*].verbs[*]}'`)
    test.skip(!verbs, 'kubeast-impersonator ClusterRole missing on self')
    const drawer = await openDrawer(page, '/security/serviceaccounts', 'k8s-service', 'kubeast')
    await expect(drawer.locator('text=/Effective Permissions/').first()).toBeVisible({ timeout: 15000 })
    await expect(drawer).toContainText(verbs.split(' ')[0])
  })

  test('5.7 — RuntimeClass Used By Pods', async ({ page }) => {
    const all = JSON.parse(kubectl('get pods -A -o json')).items as Pod[]
    const expected = all.filter((p) => p.spec.runtimeClassName === 'e2e-fixture').length
    await openDrawer(page, '/cluster/runtimeclasses', 'e2e-fixture')
    await expectCount(page, 'Used By Pods', expected)
  })

  test('5.5 #2 — Namespace Resource Summary (kubeast) is the containers\' requests and limits kubectl reads', async ({ page }) => {
    // The sums the drawer shows, from the pods kubectl lists, in the drawer's format; they read 0 before (10-30).
    const quantity = (s: string | undefined, milli: boolean): number => {
      if (!s) return 0
      const units: Array<[string, number]> = [['Ki', 1024], ['Mi', 1024 ** 2], ['Gi', 1024 ** 3], ['Ti', 1024 ** 4], ['m', 0.001], ['k', 1e3], ['K', 1e3], ['M', 1e6], ['G', 1e9], ['T', 1e12]]
      const u = units.find(([suffix]) => s.endsWith(suffix))
      const value = u ? parseFloat(s.slice(0, -u[0].length)) * u[1] : parseFloat(s)
      return milli ? value * 1000 : value
    }
    const list = pods('kubeast')
    let cpuReq = 0, cpuLim = 0, memReq = 0, memLim = 0
    for (const p of list) {
      for (const c of p.spec.containers ?? []) {
        cpuReq += quantity(c.resources?.requests?.cpu, true)
        cpuLim += quantity(c.resources?.limits?.cpu, true)
        memReq += quantity(c.resources?.requests?.memory, false)
        memLim += quantity(c.resources?.limits?.memory, false)
      }
    }
    expect(cpuReq, 'kubeast pods ask for CPU').toBeGreaterThan(0)
    const cpu = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`)
    const mem = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GiB` : `${(b / 1024 ** 2).toFixed(0)} MiB`)
    const drawer = await openDrawer(page, '/cluster/namespaces', 'kubeast')
    await expect(drawer.locator('text=/Resource Summary/').first()).toHaveText(new RegExp(`\\b${list.length} pods`), { timeout: 30000 })
    const row = (name: string) => drawer.locator('tr').filter({ has: page.getByRole('cell', { name, exact: true }) }).first()
    await expect(row('CPU')).toHaveText(new RegExp(`CPU\\s*${cpu(cpuReq)}\\s*${cpu(cpuLim)}`))
    await expect(row('Memory')).toHaveText(new RegExp(`Memory\\s*${mem(memReq)}\\s*${mem(memLim)}`))
    const running = list.filter((p) => p.status?.phase === 'Running').length
    await expect(drawer).toContainText(`Running: ${running}`)
  })

  test('5.7 — ClusterRoleBinding Bound Pods (kubeast impersonator)', async ({ page }) => {
    const binding = 'kubeast-kubeast-impersonator'
    const sa = kubectl(`get clusterrolebinding ${binding} -o jsonpath='{.subjects[0].name}'`)
    test.skip(!sa, `${binding} missing on self`)
    const bound = pods('kubeast').filter((p) => p.spec.serviceAccountName === sa).map((p) => p.metadata.name)
    const drawer = await openDrawer(page, '/security/clusterrolebindings', binding)
    await expect(drawer.locator('text=/Subjects/').first()).toBeVisible({ timeout: 15000 })
    for (const name of bound) await expect(drawer).toContainText(name)
  })

  test('회귀 — Namespace 기존 Pods 페이지네이션 (kube-system)', async ({ page }) => {
    const expected = pods('kube-system').length
    await openDrawer(page, '/cluster/namespaces', 'kube-system')
    await expectCount(page, 'Pods', expected)
  })

  test('5.4 — Secret 의 Used By Pods / ServiceAccounts (kubeast-secrets)', async ({ page }) => {
    const expected = pods('kubeast').filter((p) => JSON.stringify(p.spec).includes('"kubeast-secrets"')).length
    test.skip(expected === 0, 'no pod reads kubeast-secrets on self')
    await openDrawer(page, '/configuration/secrets', 'kubeast-secrets', 'kubeast')
    await expectCount(page, 'Used By Pods', expected)
  })

  test('5.7 — PriorityClass system-cluster-critical Used By Pods (>0)', async ({ page }) => {
    const all = JSON.parse(kubectl('get pods -A -o json')).items as Pod[]
    const expected = all.filter((p) => p.spec.priorityClassName === 'system-cluster-critical').length
    test.skip(expected === 0, 'no system-cluster-critical pod on self')
    await openDrawer(page, '/cluster/priorityclasses', 'system-cluster-critical')
    await expectCount(page, 'Used By Pods', expected)
  })
})
