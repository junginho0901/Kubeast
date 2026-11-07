import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A policy report's result may pick its resources by label (resourceSelector) instead of naming them. On `default`, in
// a namespace of its run with a hand-written report (Kyverno's report controller leaves those alone): each object whose
// labels match has the row in its drawer, one that does not says "None", a Deployment's section takes its pods' rows
// named after the pod, and the Policy reports API says what the result picks. The namespace is removed after.

const CLUSTER = 'default'
const run = Date.now().toString(36)
const NS = `e2e-polsel-${run}`
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kc = execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-polsel-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const REPORT = {
  apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name: 'e2e-polsel', namespace: NS },
  results: [
    { policy: 'sel-web', rule: 'r', result: 'fail', source: 'e2e', message: 'picked by app=web', resourceSelector: { matchLabels: { app: 'web' } } },
    { policy: 'sel-canary', rule: 'r', result: 'warn', source: 'e2e', message: 'picked by app=sel-canary', resourceSelector: { matchLabels: { app: 'sel-canary' } } },
  ],
}
const FIXTURE = [
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm-web', namespace: NS, labels: { app: 'web' } }, data: { k: 'v' } },
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm-plain', namespace: NS, labels: { team: 'x' } }, data: { k: 'v' } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'dep', namespace: NS }, spec: {
    replicas: 1, selector: { matchLabels: { app: 'sel-canary' } },
    template: { metadata: { labels: { app: 'sel-canary' } }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'registry.k8s.io/pause:3.10', imagePullPolicy: 'IfNotPresent' }] } },
  } },
  REPORT,
]

const rowsIn = (page: Page) => page.locator(DRAWER).last().getByTestId('policy-violation-row').evaluateAll((rows) => rows.map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.innerText.trim())))

test.describe('number check — policy results that pick by label', () => {
  test.beforeAll(() => {
    let served = false
    try {
      served = /^policyreports\./m.test(kubectl('api-resources --api-group=wgpolicyk8s.io -o name'))
    } catch {
      served = false
    }
    test.skip(!served, 'needs the PolicyReport CRD on the second cluster')
    kubectl(`create namespace ${NS}`)
    kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: FIXTURE }))
  })

  test.afterAll(() => {
    try {
      kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    } catch { /* never made */ }
  })

  test('each object the labels pick has the row; the others say None; the API says what is picked', async ({ page, request }) => {
    test.setTimeout(150_000)
    const stored = JSON.parse(kubectl(`get policyreport e2e-polsel -n ${NS} -o json`))
    test.skip(!stored.results?.[0]?.resourceSelector, 'this PolicyReport CRD prunes resourceSelector')

    await test.step('the ConfigMap the labels pick: one row, its result, policy and message', async () => {
      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${NS}/cm-web`)}`)
      await expect.poll(() => rowsIn(page), { timeout: 30_000 }).toEqual([['fail', 'sel-web/r', '-', 'picked by app=web']])
    })

    await test.step('a ConfigMap they do not pick: None', async () => {
      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${NS}/cm-plain`)}`)
      await expect(page.locator(DRAWER).last().getByTestId('policy-violations-none')).toHaveText('None', { timeout: 30_000 })
      await expect(page.locator(DRAWER).last().getByTestId('policy-violation-row')).toHaveCount(0)
    })

    await test.step('a Deployment: its pod the labels pick, named', async () => {
      const pod = () => kubectl(`get pods -n ${NS} -l app=sel-canary -o name`).split('\n')[0]?.replace('pod/', '') ?? ''
      await expect.poll(pod, { timeout: 60_000 }).not.toBe('')
      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Deployment/${NS}/dep`)}`)
      await expect.poll(() => rowsIn(page), { timeout: 30_000 }).toEqual([['warn', 'sel-canary/r', '-', `Pod/${pod()}`, 'picked by app=sel-canary']])
    })

    await test.step('the results API keeps one row per result, saying what it picks', async () => {
      const res = await request.get(`/api/v1/cluster/policyreports/results?cluster=${CLUSTER}&namespace=${NS}`)
      expect(res.ok(), await res.text()).toBeTruthy()
      const rows = (await res.json()).rows as { policy: string; selector?: string; name: string }[]
      expect(rows.map((r) => [r.policy, r.selector, r.name]).sort()).toEqual([['sel-canary', 'app=sel-canary', ''], ['sel-web', 'app=web', '']])
    })
  })
})
