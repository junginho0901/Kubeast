import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// Number check of the dashboard's Issues on self: each number of a row counts one thing, as kubectl has it — a
// crash-looping pod's restarts (kubectl's RESTARTS) and how many times its newest Warning event happened (the
// event's COUNT), a failed Job's failed pods — and the window says which is which instead of one "×N".

const NS = 'e2e-issue-counts'
const POD = 'crash'
const JOB = { namespace: 'default', name: 'e2e-failing-job' } // deploy/kind/fixtures.yaml

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-issues-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

type Ev = { count?: number; series?: { count?: number; lastObservedTime?: string }; lastTimestamp?: string; eventTime?: string; firstTimestamp?: string; metadata: { creationTimestamp: string } }
type Issue = { id: string; kind: string; namespace?: string; name: string; restarts?: number; failed?: number; events?: number }

// what kubectl has: the pod's restarts, the count of its newest Warning event (kubectl's printEvent rules), the
// Job's failed pods
function cluster() {
  const pod = JSON.parse(kubectl(`get pod ${POD} -n ${NS} -o json`))
  const restarts = (pod.status.containerStatuses ?? []).reduce((n: number, c: { restartCount: number }) => n + c.restartCount, 0)
  const last = (e: Ev) => Date.parse(e.series?.lastObservedTime || e.lastTimestamp || e.eventTime || e.firstTimestamp || e.metadata.creationTimestamp)
  const events = (JSON.parse(kubectl(`get events -n ${NS} --field-selector involvedObject.name=${POD},type=Warning -o json`)).items as Ev[])
    .sort((a, b) => last(b) - last(a))
  const newest = events[0]
  const eventCount = newest ? (newest.series?.count ?? newest.count ?? 1) : 0
  const failed = Number(kubectl(`get job ${JOB.name} -n ${JOB.namespace} -o jsonpath={.status.failed}`) || 0)
  return { restarts, events: eventCount, failed }
}

test.describe('Number check — Issues numbers', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', [
      'apiVersion: v1', 'kind: Namespace', `metadata: {name: ${NS}}`, '---',
      'apiVersion: v1', 'kind: Pod', `metadata: {name: ${POD}, namespace: ${NS}}`,
      'spec: {terminationGracePeriodSeconds: 0, containers: [{name: app, image: docker.io/library/busybox:1.38.0, command: [sh, -c, "exit 1"]}]}',
    ].join('\n'))
    // two restarts and a Warning event that happened more than once (BackOff)
    const deadline = Date.now() + 180_000
    for (;;) {
      const c = cluster()
      if (c.restarts >= 2 && c.events >= 2) break
      if (Date.now() > deadline) throw new Error(`the pod did not crash-loop: ${JSON.stringify(c)}`)
      execSync('sleep 5')
    }
  })

  test.afterAll(() => {
    kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test("each number is one thing, as kubectl counts it, and the window names it", async ({ page }) => {
    test.setTimeout(180_000)
    const get = async () => (await (await page.request.get('/api/v1/cluster/issues?cluster=self')).json()).issues as Issue[]
    // the pod keeps restarting: compare when two reads of the cluster agree around the API's
    await expect(async () => {
      const before = cluster()
      const issues = await get()
      const after = cluster()
      expect(after, 'the cluster held still').toEqual(before)
      const pod = issues.find((i) => i.id === `Pod/${NS}/${POD}`)
      const job = issues.find((i) => i.id === `Job/${JOB.namespace}/${JOB.name}`)
      expect.soft({ restarts: pod?.restarts, events: pod?.events, failed: pod?.failed ?? 0 }, 'the pod').toEqual({ restarts: before.restarts, events: before.events, failed: 0 })
      expect.soft({ failed: job?.failed, restarts: job?.restarts ?? 0 }, 'the Job').toEqual({ failed: before.failed, restarts: 0 })
    }).toPass({ timeout: 90_000, intervals: [3_000] })

    // the window: each row's numbers named, as the answer it loaded has them
    await page.goto('/?cluster=self')
    const loaded = page.waitForResponse((r) => r.url().includes('/cluster/issues') && r.ok())
    await page.locator('button').filter({ hasText: /Check issues|이슈 확인/ }).first().click()
    const issues = (await (await loaded).json()).issues as Issue[]
    const pod = issues.find((i) => i.id === `Pod/${NS}/${POD}`)!
    const job = issues.find((i) => i.id === `Job/${JOB.namespace}/${JOB.name}`)!
    const podRow = page.getByTestId('issues-kind-Pod').getByTestId('issue-row').filter({ hasText: POD })
    await expect.soft(podRow, 'the pod row: restarts').toContainText(new RegExp(`Restarts ${pod.restarts}(?!\\d)|재시작 ${pod.restarts}회`), { timeout: 20_000 })
    await expect.soft(podRow, 'the pod row: its newest event').toContainText(new RegExp(`Event ×${pod.events}(?!\\d)|이벤트 ×${pod.events}(?!\\d)`))
    const jobRow = page.getByTestId('issues-kind-Job').getByTestId('issue-row').filter({ hasText: JOB.name })
    await expect.soft(jobRow, 'the Job row: failed pods').toContainText(new RegExp(`Failed ${job.failed}(?!\\d)|실패 ${job.failed}(?!\\d)`))
  })
})
