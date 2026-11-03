import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// Number check of a Deployment whose new rollout passed its progress deadline while its old pod stays available: the
// controller keeps Available=True and sets Progressing=False (ProgressDeadlineExceeded), and kubectl rollout status
// calls the rollout failed. The Deployments list, its tooltip, the Issues and the Resource Graph say Failed too.

const CLUSTER = 'default'
const NS = 'e2e-rollout'
const FIXTURE = `
apiVersion: v1
kind: Namespace
metadata: {name: ${NS}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: stuck, namespace: ${NS}}
spec:
  replicas: 1
  progressDeadlineSeconds: 10
  strategy: {type: RollingUpdate, rollingUpdate: {maxUnavailable: 0, maxSurge: 1}}
  selector: {matchLabels: {app: stuck}}
  template:
    metadata: {labels: {app: stuck}}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
      - {name: app, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400']}
`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-numrollout-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

let k: ((a: string, input?: string) => string) | undefined

test.beforeAll(() => {
  test.setTimeout(240_000)
  try { k = kubectlFor('kubeast-b') } catch { return }
  // a run before this one leaves the namespace terminating: new objects, not its last ones
  k(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
  k('apply -f -', FIXTURE)
  k(`rollout status deployment/stuck -n ${NS} --timeout=120s`)
  // a new revision no node takes: its pod stays Pending, the old one keeps serving
  k(`patch deployment/stuck -n ${NS} --type=merge -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubeast.io/e2e":"nowhere"}}}}}'`)
  k(`wait deployment/stuck -n ${NS} --for=jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}'=ProgressDeadlineExceeded --timeout=120s`)
})

test.afterAll(() => {
  k?.(`delete namespace/${NS} --wait=false --ignore-not-found`)
})

test.describe('Number check — a rollout past its progress deadline', () => {
  test.beforeEach(() => { test.skip(!k, 'kind cluster kubeast-b not found') })

  test('is Failed in the list, its tooltip, the Issues and the Resource Graph, as kubectl rollout status says', async ({ page }) => {
    // the cluster: the old pod still available, the rollout failed
    expect(k!(`get deployment/stuck -n ${NS} -o jsonpath='{.status.conditions[?(@.type=="Available")].status}'`), 'Available').toBe('True')
    let rollout = ''
    try { k!(`rollout status deployment/stuck -n ${NS} --timeout=5s`) } catch (e) { rollout = String((e as { stderr?: string }).stderr ?? e) }
    expect(rollout, 'kubectl rollout status').toContain('exceeded its progress deadline')

    // each place on its own (soft), so a reverse run names every one that differs
    const get = async (p: string) => (await page.request.get(`${p}${p.includes('?') ? '&' : '?'}cluster=${CLUSTER}`)).json()
    const list = (await get(`/api/v1/cluster/namespaces/${NS}/deployments`)) as { name: string; status: string; progressing_reason?: string }[]
    expect.soft(list.filter((d) => d.name === 'stuck').map((d) => ({ status: d.status, reason: d.progressing_reason })), 'the list API')
      .toEqual([{ status: 'Failed', reason: 'ProgressDeadlineExceeded' }])

    const issues = ((await get('/api/v1/cluster/issues')).issues as { kind: string; namespace?: string; name: string; severity: string; reason?: string }[])
      .filter((i) => i.kind === 'Deployment' && i.namespace === NS)
    expect.soft(issues.map((i) => ({ name: i.name, severity: i.severity, reason: i.reason })), 'the Issues').toEqual([{ name: 'stuck', severity: 'critical', reason: 'ProgressDeadlineExceeded' }])

    const nodes = (await get(`/api/v1/cluster/resource-graph?namespaces=${NS}`)).nodes as { id: string; status: string; health?: string }[]
    expect.soft(nodes.filter((n) => n.id === `Deployment/${NS}/stuck`).map((n) => `${n.status} ${n.health}`), 'the Resource Graph box').toEqual(['Failed error'])

    await page.goto(`/workloads/deployments?cluster=${CLUSTER}&namespace=${NS}`)
    const badge = page.locator('tr').filter({ hasText: 'stuck' }).locator('span.badge')
    await expect.soft(badge).toHaveText(/^(Failed|실패)$/)
    await expect.soft(badge).toHaveAttribute('title', 'Failed: ProgressDeadlineExceeded')
  })
})
