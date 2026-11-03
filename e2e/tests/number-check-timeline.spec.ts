import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// Number check of the Timeline on self: the cards count every event of the window, the list holds the newest 500 of
// the type chosen — with 520 recent Normal events and 5 Warning events two hours old, the Warning list is those 5,
// not the warnings among the newest 500 (none) — and the rollouts are each Deployment's ReplicaSets and each
// StatefulSet's and DaemonSet's ControllerRevisions created in the window, as kubectl lists them.

const TIMELINE = { path: '/timeline', cluster: 'self' }
const NS = 'e2e-timeline'
const NORMAL = 520
const WARNING = 5

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-timeline-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()

const workloads = `
apiVersion: v1
kind: Namespace
metadata: {name: ${NS}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: ${NS}}
spec:
  replicas: 1
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec: {terminationGracePeriodSeconds: 0, containers: [{name: web, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400']}]}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db, namespace: ${NS}}
spec:
  serviceName: db
  replicas: 1
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec: {terminationGracePeriodSeconds: 0, containers: [{name: db, image: docker.io/library/busybox:1.38.0, command: [sleep, '86400']}]}
`
const event = (name: string, type: 'Normal' | 'Warning', at: Date) => [
  'apiVersion: v1', 'kind: Event', `metadata: {name: ${name}, namespace: ${NS}}`,
  `involvedObject: {kind: ConfigMap, name: tl-cm, namespace: ${NS}}`,
  `reason: E2E${type}`, `message: timeline check ${name}`, `type: ${type}`,
  `firstTimestamp: "${at.toISOString().replace(/\.\d+Z$/, 'Z')}"`, `lastTimestamp: "${at.toISOString().replace(/\.\d+Z$/, 'Z')}"`, 'count: 1',
].join('\n')

type Ev = { type: string; lastTimestamp?: string; eventTime?: string; firstTimestamp?: string; series?: { lastObservedTime?: string }; metadata: { creationTimestamp: string } }
type Timeline = { events: { type: string }[]; rollout_history: { kind: string; name: string; revision: number }[]; summary: Record<string, number | string> }

// what kubectl has: the events seen in the last 24 hours (kubectl's printEvent time), and the rollouts created in it
function cluster() {
  const since = Date.now() - 24 * 3600_000
  const last = (e: Ev) => Date.parse(e.series?.lastObservedTime || e.lastTimestamp || e.eventTime || e.firstTimestamp || e.metadata.creationTimestamp)
  const events = (JSON.parse(kubectl(`get events -n ${NS} -o json`)).items as Ev[]).filter((e) => last(e) >= since)
  type Owned = { metadata: { creationTimestamp: string; annotations?: Record<string, string>; ownerReferences?: { kind: string; name: string; controller?: boolean }[] }; revision?: number }
  const owner = (o: Owned) => o.metadata.ownerReferences?.find((r) => r.controller)
  const rollouts = [
    ...(JSON.parse(kubectl(`get replicasets -n ${NS} -o json`)).items as Owned[])
      .filter((r) => Date.parse(r.metadata.creationTimestamp) >= since && owner(r)?.kind === 'Deployment' && r.metadata.annotations?.['deployment.kubernetes.io/revision'])
      .map((r) => `Deployment/${owner(r)!.name}#${r.metadata.annotations!['deployment.kubernetes.io/revision']}`),
    ...(JSON.parse(kubectl(`get controllerrevisions -n ${NS} -o json`)).items as Owned[])
      .filter((r) => Date.parse(r.metadata.creationTimestamp) >= since && ['StatefulSet', 'DaemonSet'].includes(owner(r)?.kind ?? ''))
      .map((r) => `${owner(r)!.kind}/${owner(r)!.name}#${r.revision}`),
  ].sort()
  return { total: events.length, warnings: events.filter((e) => e.type === 'Warning').length, rollouts }
}

test.describe('Number check — Timeline', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', workloads)
    const now = Date.now()
    const docs = [
      ...Array.from({ length: NORMAL }, (_, i) => event(`tl-normal-${i}`, 'Normal', new Date(now - (i + 1) * 1000))),
      ...Array.from({ length: WARNING }, (_, i) => event(`tl-warning-${i}`, 'Warning', new Date(now - 2 * 3600_000 - i * 60_000))),
    ]
    kubectl('create -f -', docs.join('\n---\n'))
    kubectl(`rollout status deployment/web -n ${NS} --timeout=120s`)
    kubectl(`rollout status statefulset/db -n ${NS} --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test('the Warning list is the newest warnings, the counts every event, the rollouts every workload kind', async ({ page }) => {
    test.setTimeout(120_000)
    const get = async (q: string) => (await page.request.get(`/api/v1/cluster/namespaces/${NS}/timeline?hours=24&limit=500&cluster=${TIMELINE.cluster}${q}`)).json() as Promise<Timeline>
    // the pods keep writing events for a moment: compare when two reads of the cluster agree around the API's
    await expect(async () => {
      const before = cluster()
      const warn = await get('&type=Warning')
      const all = await get('')
      const after = cluster()
      expect(after, 'the cluster held still').toEqual(before)
      expect(before.warnings, 'the fixture warnings').toBeGreaterThanOrEqual(WARNING)
      expect.soft({ listed: warn.events.length, warnings: warn.events.filter((e) => e.type === 'Warning').length, matching: warn.summary.events_matching, total: warn.summary.total_events },
        'type=Warning: the newest warnings').toEqual({ listed: Math.min(before.warnings, 500), warnings: Math.min(before.warnings, 500), matching: before.warnings, total: before.total })
      expect.soft({ shown: all.summary.events_shown, matching: all.summary.events_matching, total: all.summary.total_events, warnings: all.summary.warning_count },
        'every type: the newest 500 of all').toEqual({ shown: Math.min(before.total, 500), matching: before.total, total: before.total, warnings: before.warnings })
      expect.soft(all.rollout_history.map((r) => `${r.kind}/${r.name}#${r.revision}`).sort(), 'the rollouts').toEqual(before.rollouts)
      expect(before.rollouts.some((r) => r.startsWith('StatefulSet/db#')), 'a StatefulSet rollout to compare').toBe(true)
    }).toPass({ timeout: 90_000, intervals: [3_000] })

    // the screen: the Warning list holds the warnings, and the cap note names the type
    const { warnings, total } = cluster()
    await page.goto(`${TIMELINE.path}?cluster=${TIMELINE.cluster}`)
    await page.getByTestId('timeline-namespace').click()
    await page.getByRole('button', { name: NS, exact: true }).click()
    await expect(page.getByTestId('timeline-events-capped')).toContainText(new RegExp(`500 of the ${total} events|이벤트 ${total}개 중 최신 500개`))
    await page.getByRole('button', { name: 'Warning', exact: true }).click()
    await expect(page.getByTestId('timeline-count')).toHaveText(new RegExp(`^${warnings} items \\(${warnings} events · 0 rollouts\\)$|^${warnings}개 항목\\(이벤트 ${warnings} · 롤아웃 0\\)$`))
    await expect(page.getByTestId('timeline-events-capped')).toHaveCount(0)
  })
})
