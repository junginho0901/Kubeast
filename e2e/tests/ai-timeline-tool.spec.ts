import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI tool timeline through the MCP endpoint, so the checks are exact, against the API the Timeline screen reads and
// against kubectl on self: the counts are the screen's, the list says when it holds the newest M of N (520 recent
// Normal events and 5 Warning events two hours old, past the screen's 500), a window that ends before now and a kind
// alone count what they can and say null for what they cannot, one object asks its own timeline, a grant limited to a
// namespace stays in it, and rollouts the cluster refuses are not counted as none.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-timeline-pass1!'
const CLUSTER = 'self'
const NS = 'e2e-ai-timeline'
const READ_GROUP = 'kubeast:role:read'
const NORMAL = 520
const WARNING = 5
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ai-timeline-')), 'kubeconfig')
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
const stamp = (at: Date) => at.toISOString().replace(/\.\d+Z$/, 'Z')
const event = (name: string, type: 'Normal' | 'Warning', at: Date, kind = 'ConfigMap', object = 'tl-cm') => [
  'apiVersion: v1', 'kind: Event', `metadata: {name: ${name}, namespace: ${NS}}`,
  `involvedObject: {kind: ${kind}, name: ${object}, namespace: ${NS}}`,
  `reason: E2E${type}`, `message: timeline tool check ${name}`, `type: ${type}`,
  `firstTimestamp: "${stamp(at)}"`, `lastTimestamp: "${stamp(at)}"`, 'count: 1',
].join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Ev = { type: string; lastTimestamp?: string; eventTime?: string; firstTimestamp?: string; series?: { lastObservedTime?: string }; metadata: { creationTimestamp: string }; involvedObject: { kind: string; name: string } }
const lastSeen = (e: Ev) => Date.parse(e.series?.lastObservedTime || e.lastTimestamp || e.eventTime || e.firstTimestamp || e.metadata.creationTimestamp)
const clusterEvents = () => (JSON.parse(kubectl(`get events -n ${NS} -o json`)).items as Ev[])

// a row of the API without the second copy of its object, which the tool leaves out
const listed = ({ resource: _copy, ...row }: Obj) => row
// the API's summary without its clock
const counted = (s: Obj) => { const { time_range: _clock, ...rest } = s; return rest }

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'timeline', arguments: { cluster: CLUSTER, ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), await res.text()).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}
const timeline = async (request: APIRequestContext, token: string, args: Record<string, unknown>) => {
  const out = await call(request, token, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}
// what the screen asks: the namespace's timeline through the gateway
const screenAnswer = async (request: APIRequestContext, token: string, query: string, tail = '') => {
  const res = await request.get(`/api/v1/cluster/namespaces/${NS}/timeline${tail}?cluster=${CLUSTER}&${query}`, { headers: bearer(token) })
  expect(res.ok(), await res.text()).toBeTruthy()
  return res.json()
}

test.describe('AI tool timeline', () => {
  test.setTimeout(180_000)
  let admin = ''
  let ready = false
  let madeAt = 0
  const userIds: string[] = []

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000)
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (!config.ok() || !(await config.json()).enabled) return
    kubectl(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', workloads)
    const now = Date.now()
    madeAt = now
    kubectl('create -f -', [
      ...Array.from({ length: NORMAL }, (_, i) => event(`tl-normal-${i}`, 'Normal', new Date(now - (i + 1) * 1000))),
      ...Array.from({ length: WARNING }, (_, i) => event(`tl-warning-${i}`, 'Warning', new Date(now - 2 * 3600_000 - i * 60_000))),
      event('tl-web-1', 'Normal', new Date(now - 90_000), 'Deployment', 'web'),
    ].join('\n---\n'))
    kubectl(`rollout status deployment/web -n ${NS} --timeout=120s`)
    kubectl(`rollout status statefulset/db -n ${NS} --timeout=120s`)
    ready = true
  })

  test.afterAll(async ({ request }) => {
    for (const id of userIds) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    if (ready) kubectl(`delete namespace/${NS} --wait=false --ignore-not-found`)
  })

  test.beforeEach(() => {
    test.skip(!ready, 'needs the MCP server (mcp.enabled in the dev values)')
  })

  test('the counts, rows and rollouts are the answer the screen reads, and kubectl\'s', async ({ request }) => {
    // the pods keep writing events for a moment: compare when two reads of the cluster agree around the API's
    await expect(async () => {
      const before = clusterEvents()
      const screen = await screenAnswer(request, admin, 'hours=24&limit=500')
      const tool = await timeline(request, admin, { namespace: NS, since_time: '24h', limit: 500 })
      const after = clusterEvents()
      expect(after.length, 'the cluster held still').toBe(before.length)
      expect(counted(tool.summary)).toEqual(counted(screen.summary))
      expect(tool.summary.total_events).toBe(before.length)
      expect(tool.summary.warning_count).toBe(before.filter((e) => e.type === 'Warning').length)
      expect(tool.events).toEqual(screen.events.map(listed))
      expect(tool.rollout_history).toEqual(screen.rollout_history)
      expect(tool.rollouts_total).toBe(screen.rollout_history.length)
      expect(tool.rollout_history.map((r: Obj) => r.kind).sort()).toEqual(expect.arrayContaining(['Deployment', 'StatefulSet']))
      expect(tool.summary.events_shown, 'the screen\'s list').toBe(500)
      expect(tool.events_note).toBe(`The newest 500 of the ${before.length} events in this range are listed.`)
      expect(tool.namespace).toBe(NS)
    }).toPass({ timeout: 90_000, intervals: [3_000] })
  })

  test('a list shorter than the window says it holds the newest M of N', async ({ request }) => {
    await expect(async () => {
      const before = clusterEvents().length
      const tool = await timeline(request, admin, { namespace: NS, limit: 10 })
      expect(clusterEvents().length, 'the cluster held still').toBe(before)
      expect({ rows: tool.events.length, shown: tool.summary.events_shown, matching: tool.summary.events_matching, total: tool.summary.total_events }).toEqual({ rows: 10, shown: 10, matching: before, total: before })
      expect(tool.events_note).toBe(`The newest 10 of the ${before} events in this range are listed.`)
    }).toPass({ timeout: 60_000, intervals: [3_000] })
  })

  test('an event type lists the newest of that type and the counts stay of every event', async ({ request }) => {
    const screen = await screenAnswer(request, admin, 'hours=24&limit=3&type=Warning')
    const tool = await timeline(request, admin, { namespace: NS, event_type: 'Warning', limit: 3 })
    expect(tool.events.map((e: Obj) => e.type)).toEqual(['Warning', 'Warning', 'Warning'])
    expect(tool.events.map((e: Obj) => e.involved_object.name)).toEqual(screen.events.map((e: Obj) => e.involved_object.name))
    expect(tool.summary.events_matching).toBe(screen.summary.events_matching)
    expect(tool.summary.events_matching).toBeGreaterThanOrEqual(WARNING)
    expect(tool.events_note).toBe(`The newest 3 of the ${tool.summary.events_matching} Warning events in this range are listed.`)
    const whole = await timeline(request, admin, { namespace: NS, event_type: 'Warning', limit: 500 })
    expect(whole.events.length).toBe(whole.summary.events_matching)
    expect(whole.events_note, 'a whole list says nothing').toBeUndefined()
    const typo = await call(request, admin, { namespace: NS, event_type: 'warning' })
    expect(typo.isError, 'a word the API would ignore is refused, not read as both').toBe(true)
  })

  test('a window ending before now keeps what came before it and counts it: a whole list, or a cut one that reached past the end', async ({ request }) => {
    // the fixture's warnings are the only events an hour old: the list of warnings is whole
    const anHourAgo = new Date(madeAt - 3600_000)
    const old = await timeline(request, admin, { namespace: NS, until_time: stamp(anHourAgo), since_time: '24h', event_type: 'Warning' })
    const oldWant = clusterEvents().filter((e) => e.type === 'Warning' && lastSeen(e) <= anHourAgo.getTime())
    expect(oldWant.length, 'the fixture\'s old warnings').toBeGreaterThanOrEqual(WARNING)
    expect(old.narrowed.until_time).toBe(stamp(anHourAgo))
    expect(old.narrowed.events_matching).toBe(oldWant.length)
    expect(old.events.length).toBe(oldWant.length)
    for (const e of old.events) expect(Date.parse(e.timestamp)).toBeLessThanOrEqual(anHourAgo.getTime())
    expect(old.rollouts_total, 'the workloads were made after the end').toBe(0)

    // a hundred seconds into the fixture's events: the newest 500 hold everything after it, so the rest are counted
    await expect(async () => {
      const until = new Date(madeAt - 100_000)
      const before = clusterEvents()
      const tool = await timeline(request, admin, { namespace: NS, until_time: stamp(until), since_time: '24h', limit: 10 })
      expect(clusterEvents().length, 'the cluster held still').toBe(before.length)
      expect(tool.summary.events_shown, 'the list was cut').toBeLessThan(tool.summary.events_matching)
      expect(tool.narrowed.events_matching).toBe(before.filter((e) => lastSeen(e) <= until.getTime()).length)
      expect(tool.narrowed.events_listed).toBe(10)
      expect(tool.events_note).toBe(`The newest 10 of the ${tool.narrowed.events_matching} events in this range are listed.`)
    }).toPass({ timeout: 60_000, intervals: [3_000] })
  })

  test('a window whose end the list did not reach says null, not zero', async ({ request }) => {
    // every one of the newest 500 is newer than an hour ago: the warnings are older and were not read
    const tool = await timeline(request, admin, { namespace: NS, until_time: stamp(new Date(madeAt - 3600_000)), since_time: '24h' })
    expect(tool.summary.events_shown).toBeLessThan(tool.summary.events_matching)
    expect(tool.events).toEqual([])
    expect(tool.narrowed.events_matching).toBeNull()
    expect(tool.events_note).toContain('not counted, not zero')
    expect(clusterEvents().filter((e) => lastSeen(e) <= madeAt - 3600_000).length, 'the cluster has them').toBeGreaterThanOrEqual(WARNING)
  })

  test('a kind alone keeps that kind of what was read, counted when the list is whole', async ({ request }) => {
    const cut = await timeline(request, admin, { namespace: NS, kind: 'Deployment' })
    expect(cut.narrowed.kind).toBe('Deployment')
    expect(cut.narrowed.events_matching, 'the list was cut').toBeNull()
    expect(cut.events.map((e: Obj) => e.involved_object.name)).toContain('web')
    expect(new Set(cut.events.map((e: Obj) => e.involved_object.kind))).toEqual(new Set(['Deployment']))
    expect(new Set(cut.rollout_history.map((r: Obj) => r.kind))).toEqual(new Set(['Deployment']))

    const whole = await timeline(request, admin, { namespace: NS, kind: 'configmaps', event_type: 'Warning' })
    const want = clusterEvents().filter((e) => e.type === 'Warning' && e.involvedObject.kind === 'ConfigMap')
    expect(whole.narrowed.kind).toBe('ConfigMap')
    expect(whole.narrowed.events_matching).toBe(want.length)
    expect(whole.events.length).toBe(WARNING)
    expect(whole.rollouts_total, 'a ConfigMap has no rollouts').toBe(0)
  })

  test('one object asks its own timeline, whichever way the kind is written', async ({ request }) => {
    const screen = await screenAnswer(request, admin, 'hours=24&limit=200', '/Deployment/web')
    for (const kind of ['Deployment', 'deployments']) {
      const tool = await timeline(request, admin, { namespace: NS, kind, name: 'web' })
      expect(tool.object).toEqual({ kind: 'Deployment', name: 'web' })
      expect(counted(tool.summary)).toEqual(counted(screen.summary))
      expect(tool.rollout_history).toEqual(screen.rollout_history)
      expect(tool.events.map((e: Obj) => e.involved_object.name)).toContain('web')
      expect(tool.narrowed).toBeUndefined()
    }
    const noNamespace = await call(request, admin, { kind: 'Deployment', name: 'web' })
    expect(noNamespace.isError, 'an object needs its namespace').toBe(true)
  })

  test('a grant limited to a namespace stays in it, and rollouts it may not list are not none', async ({ request }) => {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-timeline-${Date.now().toString(36)}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E timeline', email, password: PW, role_id: member.id } })
    expect(created.status(), email).toBe(201)
    const userId = (await created.json()).id as string
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })
    expect(put.ok(), await put.text()).toBeTruthy()
    const scoped = await login(request, email, PW)
    const bind = (role: string, kind: string) => JSON.stringify({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'e2e-ai-timeline-read', namespace: NS },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: role },
      subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: READ_GROUP }],
    })
    try {
      // first events only: the cluster refuses the workloads, which the screen says and the tool too
      kubectl('apply -f -', JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'e2e-events-only', namespace: NS },
        rules: [{ apiGroups: [''], resources: ['events'], verbs: ['get', 'list', 'watch'] }],
      }))
      kubectl('apply -f -', bind('e2e-events-only', 'Role'))
      await expect(async () => {
        const tool = await timeline(request, scoped, { limit: 500 })
        expect(tool.rollouts_total).toBeNull()
        expect(tool.rollout_history).toBeNull()
        expect(tool.rollouts_note).toContain('not counted, not zero')
        expect(tool.summary.rollouts_error).toContain('forbidden')
        expect(tool.summary.total_events).toBeGreaterThanOrEqual(NORMAL + WARNING)
      }).toPass({ timeout: 60_000, intervals: [3_000] })

      kubectl(`delete rolebinding e2e-ai-timeline-read -n ${NS}`)
      kubectl('apply -f -', bind('view', 'ClusterRole'))
      await expect(async () => {
        // another limit is another entry of the answers k8s-service keeps for half a minute
        const tool = await timeline(request, scoped, { limit: 499 })
        expect(tool.namespace, 'the grant\'s namespaces').toEqual([NS])
        expect(tool.rollouts_total).toBeGreaterThanOrEqual(2)
        expect(new Set(tool.events.map((e: Obj) => e.involved_object.namespace))).toEqual(new Set([NS]))
        expect(new Set(tool.rollout_history.map((r: Obj) => r.namespace))).toEqual(new Set([NS]))
        // only the grant's namespace is counted, as the admin reads that namespace
        const admins = await timeline(request, admin, { namespace: NS, limit: 499 })
        expect(tool.summary.total_events).toBe(admins.summary.total_events)
      }).toPass({ timeout: 60_000, intervals: [3_000] })

      const elsewhere = await call(request, scoped, { namespace: 'kube-system' })
      expect(elsewhere.isError, 'a namespace outside the grant').toBe(true)
      expect(elsewhere.text).toContain('outside your grant')
    } finally {
      kubectl(`delete rolebinding e2e-ai-timeline-read -n ${NS} --ignore-not-found`)
      kubectl(`delete role e2e-events-only -n ${NS} --ignore-not-found`)
    }
  })
})
