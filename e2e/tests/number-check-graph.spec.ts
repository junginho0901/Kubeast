import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// The Resource Graph's boxes say what the lists say: a pod's Status and colour as the Pods list (`/pods/page`, its
// `status` and its `health` filter), a workload's summary status as its list, drawn as the lists draw it. With
// number-check.graph-fixture.yaml on self — a pod in CrashLoopBackOff (phase Running), a Deployment past its progress
// deadline with a pod that never gets ready, a StatefulSet with one of two pods ready, a failed Job, and fine ones —
// the API's nodes, the boxes' colours and the Issues filter are compared with the lists.

const NS = 'e2e-graph'
const GRAPH = { path: '/cluster/resource-graph', cluster: 'self' }
const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.graph-fixture.yaml'), 'utf8')
const COLOR: Record<string, string> = { ok: 'rgb(34, 197, 94)', warn: 'rgb(234, 179, 8)', error: 'rgb(239, 68, 68)' }
// how the lists draw a workload's summary status (frontend utils/workloadStatus; k8s-service workloadHealth)
const WORKLOAD_HEALTH: Record<string, string> = {
  Healthy: 'ok', Available: 'ok', Complete: 'ok', Running: 'ok', Progressing: 'warn', Degraded: 'warn', Unavailable: 'error', Failed: 'error',
}

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-graph-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

type Box = { id: string; kind: string; name: string; status: string; health?: string }
const api = async (page: Page, p: string) => (await page.request.get(`${p}${p.includes('?') ? '&' : '?'}cluster=${GRAPH.cluster}`)).json()

// what the lists say: every pod's Status and colour, every workload's status and its colour
async function lists(page: Page): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const pods = (await api(page, `/api/v1/cluster/pods/page?namespace=${NS}&limit=100`)).items as { name: string; status: string }[]
  for (const level of ['ok', 'warn', 'error']) {
    for (const p of (await api(page, `/api/v1/cluster/pods/page?namespace=${NS}&limit=100&health=${level}`)).items as { name: string }[]) {
      out.set(`Pod/${NS}/${p.name}`, `${pods.find((x) => x.name === p.name)?.status} ${level}`)
    }
  }
  for (const [kind, plural] of [['Deployment', 'deployments'], ['StatefulSet', 'statefulsets'], ['ReplicaSet', 'replicasets'], ['Job', 'jobs']]) {
    for (const w of (await api(page, `/api/v1/cluster/namespaces/${NS}/${plural}`)) as { name: string; status: string }[]) {
      out.set(`${kind}/${NS}/${w.name}`, `${w.status} ${WORKLOAD_HEALTH[w.status] ?? ''}`.trim())
    }
  }
  return out
}

test.describe('number check — resource graph', () => {
  test('the Resource Graph draws each pod and workload as its list does, and Issues keeps the ones drawn yellow or red', async ({ page }) => {
    test.setTimeout(420_000)
    // a namespace left by an earlier run would hand over its settled objects: start from none
    kubectl(`delete namespace ${NS} --wait=true --timeout=120s --ignore-not-found`)
    kubectl('apply -f -', FIXTURE)
    try {
      await test.step('the objects reach the states the check is about', async () => {
        const jp = (args: string) => { try { return kubectl(args) } catch { return '' } }
        await expect.poll(() => Number(jp(`get pods -n ${NS} -l app=num-crash -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}'`) || 0),
          { timeout: 150_000, message: 'num-crash restarted 3 times (its back-off now 40 s)' }).toBeGreaterThanOrEqual(3)
        await expect.poll(() => jp(`get deploy num-stuck -n ${NS} -o jsonpath='{.status.conditions[?(@.type=="Progressing")].reason}'`),
          { timeout: 90_000 }).toBe('ProgressDeadlineExceeded')
        await expect.poll(() => jp(`get sts num-sts -n ${NS} -o jsonpath='{.status.readyReplicas}/{.status.replicas}'`), { timeout: 90_000 }).toBe('1/2')
        await expect.poll(() => jp(`get job num-job-fail num-job-ok -n ${NS} -o jsonpath='{range .items[*]}{.status.conditions[?(@.status=="True")].type}{" "}{end}'`),
          { timeout: 90_000 }).toMatch(/Failed.*Complete/)
      })

      await test.step('the API: every pod and workload node has its list\'s status and colour', async () => {
        const both = async () => {
          const want = await lists(page)
          const nodes = (await api(page, `/api/v1/cluster/resource-graph?namespaces=${NS}`)).nodes as Box[]
          const got = new Map(nodes.filter((n) => want.has(n.id)).map((n) => [n.id, `${n.status} ${n.health ?? ''}`.trim()]))
          return { got: [...got].sort(), want: [...want].sort() }
        }
        try {
          await expect(async () => {
            const { got, want } = await both()
            expect(got).toEqual(want)
            // between its restarts the pod is a problem, as the Pods list says
            expect(got.find(([id]) => id.startsWith(`Pod/${NS}/num-crash`))?.[1]).toMatch(/ error$/)
          }).toPass({ timeout: 60_000 })
        } catch {
          // record the difference and go on to the screen
          const { got, want } = await both()
          expect.soft(got, 'the graph nodes against the lists').toEqual(want)
        }
      })

      await test.step('the screen: each box\'s border is its colour, and Issues keeps the yellow and red ones', async () => {
        await page.setViewportSize({ width: 2560, height: 1400 })
        // the boxes against the answer the page itself drew them from (the crash-looping pod moves between reads)
        const answer = page.waitForResponse((r) => r.url().includes('/api/') && r.url().includes('/resource-graph') && r.status() === 200)
        await page.goto(`${GRAPH.path}?cluster=${GRAPH.cluster}&namespace=${NS}`)
        const nodes = (await (await answer).json()).nodes as Box[]
        const boxes = () => page.locator('.react-flow__node[data-id]').evaluateAll((els) =>
          els.map((el) => ({ id: el.getAttribute('data-id') ?? '', border: getComputedStyle(el).borderTopColor })))
        await expect.poll(async () => (await boxes()).length, { timeout: 30_000 }).toBeGreaterThan(0)
        const shown = await boxes()
        const drawn = shown.map((b) => b.id).filter((id) => /^(Pod|Deployment|StatefulSet|ReplicaSet|Job)\//.test(id))
        const wrong = drawn.flatMap((id) => {
          const n = nodes.find((x) => x.id === id)
          const want = n?.health ? COLOR[n.health] : undefined
          const got = shown.find((b) => b.id === id)?.border
          return want && got !== want ? [`${id}: ${got} ≠ ${want} (${n?.status})`] : []
        })
        expect.soft(wrong, 'a box drawn other than its list').toEqual([])
        const problems = shown.filter((b) => b.border === COLOR.warn || b.border === COLOR.error).map((b) => b.id).sort()
        await page.getByRole('button', { name: /Issues/ }).click()
        await expect.poll(async () => (await boxes()).map((b) => b.id).sort(), { timeout: 20_000 }).toEqual(problems)
      })
    } finally {
      kubectl(`delete namespace ${NS} --wait=true --timeout=120s --ignore-not-found`)
    }
  })

  // A box the graph adds for a reference says what the lists have (Active, Missing — a warning when the pod needs it
  // — or no status where the graph lists nothing of that kind, a Role), and the header counts the boxes and lines
  // drawn of the graph's, a line to an object with no box (a claim that does not exist) not among them.
  test('referenced objects say what the lists have, and the header counts what is drawn', async ({ page }) => {
    test.setTimeout(120_000)
    const RNS = 'e2e-graph-refs'
    const refs = `
apiVersion: v1
kind: Namespace
metadata: {name: ${RNS}}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: refs-present, namespace: ${RNS}}
data: {k: v}
---
apiVersion: v1
kind: Pod
metadata: {name: refs, namespace: ${RNS}}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - {name: app, image: registry.k8s.io/pause:3.10}
  volumes:
  - {name: a, configMap: {name: refs-present}}
  - {name: b, configMap: {name: refs-gone}}
  - {name: c, configMap: {name: refs-maybe, optional: true}}
  - {name: d, persistentVolumeClaim: {claimName: refs-noclaim}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: refs-rb, namespace: ${RNS}}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: refs-nope}
subjects:
- {kind: ServiceAccount, name: default, namespace: ${RNS}}
- {kind: ServiceAccount, name: refs-ghost, namespace: ${RNS}}
`
    kubectl(`delete namespace/${RNS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', refs)
    try {
      // the cluster: which referenced objects exist
      await expect.poll(() => kubectl(`get serviceaccount/default -n ${RNS} -o name --ignore-not-found`), { timeout: 30_000 }).toBe('serviceaccount/default')
      const exists = (what: string) => kubectl(`get ${what} -n ${RNS} -o name --ignore-not-found`) !== ''
      expect([exists('configmap/refs-present'), exists('configmap/refs-gone'), exists('configmap/refs-maybe'), exists('pvc/refs-noclaim'), exists('role/refs-nope'), exists('serviceaccount/refs-ghost')],
        'present, gone, maybe, claim, role, ghost').toEqual([true, false, false, false, false, false])

      type Graph = { nodes: Box[]; edges: { source: string; target: string }[] }
      const graph = (await api(page, `/api/v1/cluster/resource-graph?namespaces=${RNS}`)) as Graph
      const state = (id: string) => { const n = graph.nodes.find((x) => x.id === id); return n ? `${n.status}|${n.health ?? ''}` : 'no box' }
      expect.soft({
        present: state(`ConfigMap/${RNS}/refs-present`), gone: state(`ConfigMap/${RNS}/refs-gone`), maybe: state(`ConfigMap/${RNS}/refs-maybe`),
        role: state(`Role/${RNS}/refs-nope`), sa: state(`ServiceAccount/${RNS}/default`), ghost: state(`ServiceAccount/${RNS}/refs-ghost`),
      }, 'the boxes the references made').toEqual({
        present: 'Active|', gone: 'Missing|warn', maybe: 'Missing|', role: '|', sa: 'Active|', ghost: 'Missing|',
      })

      // the header against the screen: boxes and lines drawn, of the graph's (lines to a missing claim never drawn)
      const ids = new Set(graph.nodes.map((n) => n.id))
      const whole = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).length
      expect(graph.edges.length - whole, 'a line to the missing claim').toBeGreaterThan(0)
      await page.goto(`${GRAPH.path}?cluster=${GRAPH.cluster}&namespace=${RNS}`)
      await expect.poll(() => page.locator('.react-flow__node[data-id]').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      const header = async (re: RegExp) => {
        const text = (await page.locator('span').filter({ hasText: re }).first().innerText()).trim()
        const nums = (text.match(/\d+/g) ?? []).map(Number)
        // "12 of 20 nodes" / "리소스 20개 중 12개": shown and the whole; "20 nodes" / "리소스 20개": both the same
        return nums.length === 2 ? (/ of /.test(text) ? { shown: nums[0], total: nums[1] } : { shown: nums[1], total: nums[0] }) : { shown: nums[0], total: nums[0] }
      }
      const drawn = { nodes: await page.locator('.react-flow__node[data-id]').count(), edges: await page.locator('.react-flow__edge').count() }
      expect.soft(await header(/^(\d+ of )?\d+ nodes$|^리소스 \d+개( 중 \d+개)?$/), 'the node count').toEqual({ shown: drawn.nodes, total: graph.nodes.length })
      expect.soft(await header(/^(\d+ of )?\d+ edges$|^연결 \d+개( 중 \d+개)?$/), 'the edge count').toEqual({ shown: drawn.edges, total: whole })
    } finally {
      kubectl(`delete namespace/${RNS} --wait=false --ignore-not-found`)
    }
  })
})
