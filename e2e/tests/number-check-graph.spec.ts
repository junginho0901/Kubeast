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
    test.setTimeout(300_000)
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
          }).toPass({ timeout: 60_000 })
        } catch {
          // record the difference and go on to the screen
          const { got, want } = await both()
          expect.soft(got, 'the graph nodes against the lists').toEqual(want)
        }
      })

      await test.step('the screen: each box\'s border is its colour, and Issues keeps the yellow and red ones', async () => {
        await page.setViewportSize({ width: 2560, height: 1400 })
        await page.goto(`${GRAPH.path}?cluster=${GRAPH.cluster}&namespace=${NS}`)
        const nodes = (await api(page, `/api/v1/cluster/resource-graph?namespaces=${NS}`)).nodes as Box[]
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
        expect.soft(problems, 'the crash-looping pod is among the problems').toContain(nodes.find((n) => n.id.startsWith(`Pod/${NS}/num-crash`))?.id)
        await page.getByRole('button', { name: /Issues/ }).click()
        await expect.poll(async () => (await boxes()).map((b) => b.id).sort(), { timeout: 20_000 }).toEqual(problems)
      })
    } finally {
      kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    }
  })
})
