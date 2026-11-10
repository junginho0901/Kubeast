import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { everyPage, pagesOf, type Pages } from './drawer-pages'

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

// the section's rows on every page (ten to a page) and each page's range; none while the drawer has no rows
async function pagesIn(page: Page): Promise<Pages> {
  const list = page.locator(DRAWER).last().getByTestId('policy-violations-list')
  return (await list.count()) === 0 ? { items: [], pagers: [] } : everyPage(list, '[data-testid="policy-violation-row"]')
}
const rowsIn = async (page: Page) => (await pagesIn(page)).items

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

  test('a drawer of more results than a page lists every one, page by page, as the report has them', async ({ page }) => {
    test.setTimeout(120_000)
    // a namespace of its own: the first test holds every result of NS
    const ns = `${NS}-many`
    const results = Array.from({ length: 23 }, (_, i) => ({
      policy: `many-${String(i).padStart(2, '0')}`, rule: 'r', result: 'fail', source: 'e2e', message: `failure ${i}`,
      resources: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'cm-many', namespace: ns }],
    }))
    try {
      kubectl(`create namespace ${ns}`)
      kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm-many', namespace: ns }, data: { k: 'v' } },
        { apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name: 'e2e-polsel-many', namespace: ns }, results },
      ] }))
      // the report as stored, in the drawer's order of a resource's rows (result, then policy)
      const stored = (JSON.parse(kubectl(`get policyreport e2e-polsel-many -n ${ns} -o json`)).results ?? []) as { policy: string; rule?: string; result: string; severity?: string; message?: string }[]
      const want = stored.filter((r) => ['fail', 'warn', 'error'].includes(r.result)).sort((a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : 0))
        .map((r) => [r.result, `${r.policy}${r.rule ? `/${r.rule}` : ''}`, r.severity || '-', r.message || '-'])
      expect(want, 'the report keeps its 23 failures').toHaveLength(23)
      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${ns}/cm-many`)}`)
      await expect.poll(() => pagesIn(page), { timeout: 30_000 }).toEqual(pagesOf(want))
    } finally {
      kubectl(`delete namespace ${ns} --wait=false --ignore-not-found`)
    }
  })

  test('a ClusterPolicyReport naming an object of a namespace is in that object\'s drawer', async ({ page, request }) => {
    test.setTimeout(120_000)
    let served = false
    try {
      served = /^clusterpolicyreports\./m.test(kubectl('api-resources --api-group=wgpolicyk8s.io -o name'))
    } catch {
      served = false
    }
    test.skip(!served, 'needs the ClusterPolicyReport CRD on the second cluster')
    const name = `e2e-polsel-cluster-${run}`
    const resource = `/api/v1/cluster/namespaces/${NS}/policyreports/resource?cluster=${CLUSTER}&kind=ConfigMap&name=cm-plain`
    // the cluster reports are read once a minute per identity: past that read, as a refresh is
    const readNow = async () => {
      const res = await request.get(`${resource}&force_refresh=true`)
      expect(res.ok(), await res.text()).toBeTruthy()
      return (await res.json()) as { rows: { policy: string; report: string }[]; cluster_reports_error?: string }
    }
    try {
      kubectl('create -f -', JSON.stringify({
        apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'ClusterPolicyReport', metadata: { name },
        results: [{ policy: 'cluster-names-it', rule: 'r', result: 'fail', source: 'e2e', message: 'named by a cluster report',
          resources: [{ apiVersion: 'v1', kind: 'ConfigMap', name: 'cm-plain', namespace: NS }] }],
      }))
      const answer = await readNow()
      expect(answer.rows.map((r) => [r.policy, r.report])).toEqual([['cluster-names-it', name]])
      expect(answer.cluster_reports_error).toBeUndefined()

      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ConfigMap/${NS}/cm-plain`)}`)
      await expect.poll(() => rowsIn(page), { timeout: 30_000 }).toEqual([['fail', 'cluster-names-it/r', '-', 'named by a cluster report']])
      await expect(page.locator(DRAWER).last().getByTestId('policy-violations-cluster-error')).toHaveCount(0)

      await test.step('the page and the AI tool narrowed to the namespace count the same row', async () => {
        const query = `cluster=${CLUSTER}&namespace=${NS}&force_refresh=true`
        const summaryAnswer = await request.get(`/api/v1/cluster/policyreports/summary?${query}`)
        expect(summaryAnswer.ok(), await summaryAnswer.text()).toBeTruthy()
        const summary = (await summaryAnswer.json()) as { totals: { fail: number; warn: number }; cluster_reports_error?: string }
        const resultsAnswer = await request.get(`/api/v1/cluster/policyreports/results?${query}&result=fail`)
        expect(resultsAnswer.ok(), await resultsAnswer.text()).toBeTruthy()
        const results = (await resultsAnswer.json()) as { total: number; rows: { policy: string; namespace: string; kind: string; name: string }[] }
        expect(results.rows.find((r) => r.policy === 'cluster-names-it')).toMatchObject({ namespace: NS, kind: 'ConfigMap', name: 'cm-plain' })
        expect(summary.totals.fail, 'the card counts what the rows list').toBe(results.total)
        expect(summary.cluster_reports_error).toBeUndefined()

        await page.goto(`/security/policyreports?cluster=${CLUSTER}`)
        await page.getByTestId('policy-reports-namespace').click({ timeout: 30_000 })
        await page.getByTestId(`policy-reports-namespace-opt-${NS}`).click()
        await expect(page.getByTestId('policy-reports-stat-fail')).toHaveText(String(summary.totals.fail), { timeout: 30_000 })
        await expect(page.getByTestId('policy-reports-cluster-error')).toHaveCount(0)

        const login = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_USER_EMAIL || 'admin', password: process.env.E2E_USER_PASSWORD || '' } })
        expect(login.ok(), `login: ${login.status()}`).toBeTruthy()
        const token = (await login.json()).access_token as string
        const config = await request.get('/api/v1/ai/mcp/config', { headers: { Authorization: `Bearer ${token}` } })
        if (config.ok() && (await config.json()).enabled) {
          const call = await request.post('/api/v1/ai/mcp', {
            headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'policy_reports', arguments: { cluster: CLUSTER, namespace: NS, view: 'results', results: 'fail' } } },
          })
          expect(call.status(), await call.text()).toBe(200)
          const tool = JSON.parse((await call.json()).result.content[0].text) as { total: number; rows: { policy: string }[] }
          expect(tool.total, 'the tool says the page\'s number').toBe(results.total)
          expect(tool.rows.map((r) => r.policy)).toContain('cluster-names-it')
        }
      })
    } finally {
      kubectl(`delete clusterpolicyreport ${name} --ignore-not-found`)
      await readNow()
    }
  })
})
