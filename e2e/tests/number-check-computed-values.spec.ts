import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Screens that worked a value out for themselves, on cluster `self` in a namespace of this run's: a crashing pod in the
// dashboard's Pods window says what kubectl prints and the floating chat is told the same word, a workload's window tells
// the floating chat the pods it lists, and a LimitRange's "Violating Pods" counts pods.

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

type Layer = { source: string; summary: string; data?: { pods?: Record<string, unknown>[]; visible_items?: Record<string, unknown>[] } }
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
    await expect.poll(() => printed('crash').status, { timeout: 120_000, intervals: [2_000], message: 'the crashing pod' }).toBe('CrashLoopBackOff')
    kubectl('apply -f -', LIMIT_RANGE)
  })

  test.afterAll(() => {
    kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test('the dashboard\'s Pods window says what kubectl prints of a crashing pod, in the Running bar\'s window too', async ({ page }) => {
    const ask = await captureFloating(page)
    const { name, status } = printed('crash')
    expect(kubectl(`get pod ${name} -n ${NS} -o jsonpath='{.status.phase}'`), 'its phase').toBe('Running')
    await page.goto('/?cluster=self')
    await page.getByTestId('stat-pods').click()
    await page.getByPlaceholder(/Search|검색/).last().fill(name)
    const badge = windowBadge(page, name)
    await expect(badge).toHaveText(status, { timeout: 20_000 })
    await expect(badge).toHaveClass(/badge-error/)
    await expect(badge).toHaveAttribute('title', 'Phase: Running')
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'ResourceModal')
      return layer?.data?.visible_items?.find((p) => p.name === name)
    }, { timeout: 15_000 }).toMatchObject({ status, phase: 'Running' })
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
    const { name, status } = printed('crash')
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Deployment/${NS}/crash`)}`)
    await expect(page.locator(DRAWER).last()).toContainText('crash', { timeout: 20_000 })
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'WorkloadInfo')
      return { summary: layer?.summary, pods: layer?.data?.pods?.map((p) => [p.name, p.status, p.phase]) }
    }, { timeout: 20_000 }).toEqual({
      summary: expect.stringContaining('Pod 1개 (NotRunning 1)'),
      pods: [[name, status, 'Running']],
    })
  })

  test('a LimitRange counts its violating pods, not the rows that list them', async ({ page }) => {
    await page.goto(`/?cluster=self&detail=${encodeURIComponent(`LimitRange/${NS}/caps`)}`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText(/Violating Pods: 1\b|위반 Pod: 1\b/, { timeout: 20_000 })
    await expect(drawer).toContainText(/Violating Pods \(1\)|위반 Pod \(1\)/)
    // the table keeps a row per container and field
    const rows = drawer.locator('tbody tr').filter({ hasText: 'too-big' })
    await expect(rows).toHaveCount(4)
    await expect(rows.filter({ hasText: 'cpu max' })).toHaveCount(2)
    await expect(rows.filter({ hasText: 'memory max' })).toHaveCount(2)
  })
})
