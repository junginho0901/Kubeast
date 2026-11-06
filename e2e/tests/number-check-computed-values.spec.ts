import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Screens that worked a value out for themselves, on cluster `self` in a namespace of this run's: a crashing pod in the
// dashboard's Pods window and the Namespace window says what kubectl prints and the floating chat is told the same word, a
// workload's window tells the floating chat the pods it lists and a Job's window its rows, a Node's window counts its pods
// by what kubectl prints, a LimitRange's "Violating Pods" counts pods and tells the floating chat its rows, and only a
// running Job reads Retrying in the issues.

const NS = 'e2e-computed-values'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-computed-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const container = (name: string, command: string[], limits?: Record<string, string>) => ({
  name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command, ...(limits ? { resources: { requests: limits, limits } } : {}),
})
const deployment = (name: string, command: string[]) => JSON.stringify({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: NS },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: name } },
    template: { metadata: { labels: { app: name } }, spec: { terminationGracePeriodSeconds: 0, containers: [container('app', command)] } },
  },
})
// two containers past the LimitRange in two fields each: four rows of one pod. Made before the LimitRange, which admission
// would refuse it after.
const LIMITS = { cpu: '20m', memory: '32Mi' }
const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  deployment('crash', ['false']),
  deployment('fine', ['sleep', '3600']),
  JSON.stringify({
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'too-big', namespace: NS },
    spec: { terminationGracePeriodSeconds: 0, containers: [container('one', ['sleep', '3600'], LIMITS), container('two', ['sleep', '3600'], LIMITS)] },
  }),
  JSON.stringify({
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'going', namespace: NS },
    spec: { completions: 3, parallelism: 1, template: { spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 0, containers: [container('app', ['sleep', '3600'])] } } },
  }),
].join('\n---\n')
const LIMIT_RANGE = JSON.stringify({
  apiVersion: 'v1', kind: 'LimitRange', metadata: { name: 'caps', namespace: NS },
  spec: { limits: [{ type: 'Container', max: { cpu: '10m', memory: '16Mi' } }] },
})

// what kubectl prints of one pod of a Deployment: its name and STATUS
const printed = (app: string) => {
  const cells = kubectl(`get pods -n ${NS} -l app=${app} --no-headers`).split('\n')[0].split(/\s+/)
  return { name: cells[0], status: cells[2] }
}

// the STATUS kubectl prints of each pod of the namespace, and each pod's phase
// What kubectl prints of a container that keeps exiting: Error most of the time on this Kubernetes, CrashLoopBackOff at moments.
const CRASHED = /^(CrashLoopBackOff|Error)$/

const printedStatuses = () => kubectl(`get pods -n ${NS} --no-headers`).split('\n').filter(Boolean).map((line) => line.split(/\s+/)[2])
const phases = () => (JSON.parse(kubectl(`get pods -n ${NS} -o json`)).items as { status: { phase: string } }[]).map((p) => p.status.phase)
const notRunning = (statuses: string[]) => statuses.filter((s) => !['Running', 'Completed', 'Succeeded'].includes(s)).length
const countWords = (words: string[]) => {
  const out: Record<string, number> = {}
  for (const w of words) out[w] = (out[w] ?? 0) + 1
  return out
}

type Layer = { source: string; summary: string; data?: { pods?: Record<string, unknown>[]; visible_items?: Record<string, unknown>[] } & Record<string, unknown> }
type PageContext = { base?: Layer | null; overlays: Layer[] }

async function captureFloating(page: Page) {
  const sent: PageContext[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-computed-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback())
  await page.route(/\/api\/v1\/sessions\/e2e-computed-\d+(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-computed-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-computed-\d+\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return async () => {
    if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
    const input = page.getByTestId('floating-chat-input')
    await expect(input).toBeVisible()
    const before = sent.length
    await input.fill('what is on this screen?')
    await input.press('Enter')
    await expect.poll(() => sent.length).toBe(before + 1)
    await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
    return sent[sent.length - 1]
  }
}

// the window's row of one pod: other pods' rows are there until the search has answered
const windowBadge = (page: Page, name: string) =>
  page.locator('div.cursor-pointer').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByTestId('resource-modal-pod-status')

test.describe('values a screen worked out for itself', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    kubectl(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', FIXTURE)
    kubectl(`-n ${NS} rollout status deployment/fine --timeout=120s`)
    kubectl(`-n ${NS} wait pod/too-big --for=condition=Ready --timeout=120s`)
    await expect.poll(() => printed('crash').status, { timeout: 120_000, intervals: [2_000], message: 'the crashing pod' }).toMatch(CRASHED)
    await expect.poll(() => JSON.parse(kubectl(`get job going -n ${NS} -o json`)).status.ready ?? 0, { timeout: 120_000, intervals: [2_000], message: 'the Job\'s pod' }).toBe(1)
    kubectl('apply -f -', LIMIT_RANGE)
  })

  test.afterAll(() => {
    kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test('the dashboard\'s Pods window says what kubectl prints of a crashing pod, in the Running bar\'s window too', async ({ page }) => {
    const ask = await captureFloating(page)
    const { name } = printed('crash')
    expect(kubectl(`get pod ${name} -n ${NS} -o jsonpath='{.status.phase}'`), 'its phase').toBe('Running')
    await page.goto('/?cluster=self')
    await page.getByTestId('stat-pods').click()
    await page.getByPlaceholder(/Search|검색/).last().fill(name)
    const badge = windowBadge(page, name)
    await expect(badge).toHaveText(CRASHED, { timeout: 20_000 })
    await expect(badge).toHaveClass(/badge-error/)
    await expect(badge).toHaveAttribute('title', 'Phase: Running')
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'ResourceModal')
      return layer?.data?.visible_items?.find((p) => p.name === name)
    }, { timeout: 15_000 }).toMatchObject({ status: expect.stringMatching(CRASHED), phase: 'Running' })
  })

  test('the dashboard\'s Pods window keeps a running pod green', async ({ page }) => {
    const { name, status } = printed('fine')
    expect(status, 'kubectl prints').toBe('Running')
    await page.goto('/?cluster=self')
    await page.getByTestId('stat-pods').click()
    await page.getByPlaceholder(/Search|검색/).last().fill(name)
    const badge = windowBadge(page, name)
    await expect(badge).toHaveText('Running', { timeout: 20_000 })
    await expect(badge).toHaveClass(/badge-success/)
  })

  test('a workload\'s window tells the floating chat its pods, each with what kubectl prints', async ({ page }) => {
    const ask = await captureFloating(page)
    const { name } = printed('crash')
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Deployment/${NS}/crash`)}`)
    await expect(page.locator(DRAWER).last()).toContainText('crash', { timeout: 20_000 })
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'WorkloadInfo')
      return { summary: layer?.summary, pods: layer?.data?.pods?.map((p) => [p.name, p.status, p.phase]) }
    }, { timeout: 20_000 }).toEqual({
      summary: expect.stringContaining('Pod 1개 (NotRunning 1)'),
      pods: [[name, expect.stringMatching(CRASHED), 'Running']],
    })
  })

  test('a LimitRange counts its violating pods, not the rows that list them', async ({ page }) => {
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`LimitRange/${NS}/caps`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText(/Violating Pods: 1(?!\d)|위반 Pod: 1(?!\d)/, { timeout: 20_000 })
    await expect(drawer).toContainText(/Violating Pods \(1\)|위반 Pod \(1\)/)
    // the table keeps a row per container and field
    const rows = drawer.locator('tbody tr').filter({ hasText: 'too-big' })
    await expect(rows).toHaveCount(4)
    await expect(rows.filter({ hasText: 'cpu max' })).toHaveCount(2)
    await expect(rows.filter({ hasText: 'memory max' })).toHaveCount(2)
  })

  test('a LimitRange tells the floating chat the pods and rows its window shows', async ({ page }) => {
    const ask = await captureFloating(page)
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`LimitRange/${NS}/caps`)}`)
    await expect(page.locator(DRAWER).last().locator('tbody tr').filter({ hasText: 'too-big' })).toHaveCount(4, { timeout: 20_000 })
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'LimitRangeInfo')
      const d = layer?.data
      return {
        summary: layer?.summary,
        counts: [d?.violating_pods, d?.violation_rows, d?.violations_shown],
        rows: (d?.violations as { pod: string; container: string; field: string }[] | undefined)?.map((v) => `${v.pod}/${v.container}/${v.field}`).sort(),
      }
    }, { timeout: 20_000 }).toEqual({
      summary: expect.stringContaining('위반 Pod 1개, 위반 행 4개'),
      counts: [1, 4, 4],
      rows: ['too-big/one/cpu max', 'too-big/one/memory max', 'too-big/two/cpu max', 'too-big/two/memory max'],
    })
  })

  // The list asks the caller's own identity; a role that reads LimitRanges but not pods gets this answer from the cluster.
  test('a LimitRange whose violations cannot be read says so, not that no pod violates', async ({ page }) => {
    const ask = await captureFloating(page)
    await page.route('**/limitranges/caps/violations*', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'pods is forbidden' }) }))
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`LimitRange/${NS}/caps`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('limitrange-violations-unread')).toContainText(/You may not read the pods of this namespace|이 Namespace의 Pod를 읽을 권한이 없어/, { timeout: 20_000 })
    await expect(drawer.getByTestId('limitrange-violations-unread')).toContainText('pods is forbidden')
    await expect(drawer).toContainText(/Violating Pods: -|위반 Pod: -/)
    await expect(drawer).toContainText(/Violating Pods \(-\)|위반 Pod \(-\)/)
    await expect(drawer).not.toContainText(/currently violates this LimitRange|이 LimitRange를 위반하는 Pod가 없습니다/)
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'LimitRangeInfo')
      return { summary: layer?.summary, unread: layer?.data?.violations_unread, count: layer?.data?.violating_pods }
    }, { timeout: 20_000 }).toEqual({
      summary: expect.stringContaining('위반 Pod 목록을 읽지 못함'),
      unread: { status: 403, detail: 'pods is forbidden' },
      count: undefined,
    })
  })

  test('the floating chat is told a drawer\'s object as it is now, not the row it opened from', async ({ page }) => {
    const ask = await captureFloating(page)
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}`)
    await page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name: 'fine', exact: true }) }).click({ timeout: 20_000 })
    await expect(page.locator(DRAWER).last()).toContainText('fine', { timeout: 20_000 })
    kubectl(`-n ${NS} label deployment fine e2e-raw=changed --overwrite`)
    try {
      await expect.poll(async () => {
        const data = (await ask()).overlays.find((o) => o.source === 'ResourceDetailDrawer')?.data
        return { label: (data?.raw as { metadata?: { labels?: Record<string, string> } } | undefined)?.metadata?.labels?.['e2e-raw'], from: data?.raw_from }
      }, { timeout: 40_000, intervals: [3_000] }).toEqual({ label: 'changed', from: undefined })
    } finally {
      kubectl(`-n ${NS} label deployment fine e2e-raw-`)
    }
  })

  test('a Job\'s window tells the floating chat the rows it shows', async ({ page }) => {
    const ask = await captureFloating(page)
    await page.goto(`/workloads/jobs?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Job/${NS}/going`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText(/Parallelism\s*1/, { timeout: 20_000 })
    const job = JSON.parse(kubectl(`get job going -n ${NS} -o json`))
    const want = {
      status: 'Running',
      completions: String(job.spec.completions),
      parallelism: String(job.spec.parallelism),
      active: String(job.status.active ?? 0),
      succeeded: String(job.status.succeeded ?? 0),
      failed: String(job.status.failed ?? 0),
    }
    expect(want, 'the fixture runs its first of three').toEqual({ status: 'Running', completions: '3', parallelism: '1', active: '1', succeeded: '0', failed: '0' })
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'WorkloadInfo')
      const d = layer?.data ?? {}
      return { summary: layer?.summary, fields: Object.fromEntries(Object.keys(want).map((k) => [k, d[k]])), started: d.start_time === job.status.startTime }
    }, { timeout: 20_000 }).toEqual({
      summary: expect.stringContaining('Status Running, Completions 3, Parallelism 1, Active 1, Succeeded 0, Failed 0'),
      fields: want,
      started: true,
    })
    // the same words on screen
    for (const [label, value] of [['Completions', want.completions], ['Parallelism', want.parallelism], ['Active', want.active], ['Succeeded', want.succeeded], ['Failed', want.failed], ['Status', want.status]]) {
      await expect(drawer, label).toContainText(new RegExp(`${label}\\s*${value}`))
    }
  })

  test('the Namespace window says what kubectl prints of its pods, in the Pods list\'s colour, and tells the floating chat', async ({ page }) => {
    const ask = await captureFloating(page)
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`Namespace/${NS}`)}`)
    const drawer = page.locator(DRAWER).last()
    const cell = (name: string) => drawer.locator('tbody tr').filter({ hasText: name }).getByTestId('namespace-pod-status')
    const crash = printed('crash').name
    const fine = printed('fine').name
    // the crashing pod goes between CrashLoopBackOff and Error: the screen is read again against kubectl each time
    await expect.poll(async () => {
      await page.reload()
      await cell(crash).waitFor({ timeout: 20_000 })
      const shown = await cell(crash).textContent()
      const said = printed('crash').status
      return shown === said && CRASHED.test(said)
    }, { timeout: 60_000, intervals: [2_000] }).toBe(true)
    await expect(cell(crash)).toHaveClass(/badge-error/)
    await expect(cell(crash)).toHaveAttribute('title', 'Phase: Running')
    await expect(cell(fine)).toHaveText('Running')
    await expect(cell(fine)).toHaveClass(/badge-success/)
    await expect.poll(async () => {
      const d = (await ask()).overlays.find((o) => o.source === 'NamespaceInfo')?.data
      const statuses = printedStatuses()
      const row = d?.pods?.find((p) => p.name === fine)
      return {
        // the crashing pod's word moves, so the words that hold still are compared
        notRunning: d?.pods_not_running === notRunning(statuses),
        running: (d?.pods_by_status as Record<string, number> | undefined)?.Running === countWords(statuses).Running,
        phases: d?.pods_by_phase,
        first: d?.pods?.[0]?.name,
        fine: [row?.status, row?.ready, row?.phase],
      }
    }, { timeout: 30_000 }).toEqual({
      notRunning: true, running: true, phases: countWords(phases()), first: crash, fine: ['Running', '1/1', 'Running'],
    })
  })

  test('a Node\'s window counts its pods by what kubectl prints', async ({ page }) => {
    const ask = await captureFloating(page)
    const crash = printed('crash').name
    const node = kubectl(`get pod ${crash} -n ${NS} -o jsonpath='{.spec.nodeName}'`)
    const onNode = () => kubectl(`get pods -A --field-selector spec.nodeName=${node} --no-headers`).split('\n').filter(Boolean).map((line) => line.split(/\s+/)[3])
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`Node/${node}`)}`)
    await expect(page.locator(DRAWER).last()).toContainText(node, { timeout: 20_000 })
    await expect.poll(async () => {
      const d = (await ask()).overlays.find((o) => o.source === 'NodeInfo')?.data
      const statuses = onNode()
      return {
        notRunning: d?.pods_not_running === notRunning(statuses),
        running: (d?.pods_by_status as Record<string, number> | undefined)?.Running === countWords(statuses).Running,
      }
    }, { timeout: 60_000, intervals: [3_000] }).toEqual({ notRunning: true, running: true })
  })

  // A Job's other states hold no pod that retries: the job controller stops counting a pod as active once it is being
  // deleted, so a stopped Job leaves the issues with its pods still there.
  test('a running Job with a failed pod reads Retrying in the issues, and a suspended one does not', async ({ page }) => {
    test.setTimeout(180_000)
    const name = 'retrying'
    const issue = async () => ((await (await page.request.get('/api/v1/cluster/issues?cluster=self')).json()).issues as { id: string; reason: string }[])
      .find((i) => i.id === `Job/${NS}/${name}`)?.reason
    const state = () => {
      const job = JSON.parse(kubectl(`get job ${name} -n ${NS} -o json`))
      const status = kubectl(`get job ${name} -n ${NS} --no-headers`).split(/\s+/)[1]
      return { status, failed: (job.status.failed ?? 0) > 0, active: (job.status.active ?? 0) > 0 }
    }
    kubectl('apply -f -', JSON.stringify({
      apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: NS },
      spec: {
        completionMode: 'Indexed', completions: 2, parallelism: 2, backoffLimit: 100,
        template: { spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 0, containers: [container('app', ['sh', '-c', 'if [ "$JOB_COMPLETION_INDEX" = 0 ]; then exit 1; fi; sleep 3600'])] } },
      },
    }))
    try {
      await expect.poll(state, { timeout: 60_000, intervals: [2_000], message: 'kubectl prints' }).toEqual({ status: 'Running', failed: true, active: true })
      await expect.poll(issue, { timeout: 20_000 }).toBe('Retrying')
      kubectl(`patch job ${name} -n ${NS} --type=merge -p '{"spec":{"suspend":true}}'`)
      await expect.poll(() => state().status, { timeout: 60_000, intervals: [2_000], message: 'kubectl prints' }).toBe('Suspended')
      await expect.poll(issue, { timeout: 30_000 }).toBeUndefined()
    } finally {
      kubectl(`delete job ${name} -n ${NS} --ignore-not-found --wait=false`)
      kubectl(`delete pod -n ${NS} -l batch.kubernetes.io/job-name=${name} --ignore-not-found --wait=false --grace-period=0 --force`)
    }
  })
})
