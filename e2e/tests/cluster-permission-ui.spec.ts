import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

// What a Write user and a Read user limited to one namespace are shown is the cluster's answer for the identity Kubeast
// acts as (X-Kubeast-Access, then kubectl auth can-i): a drawer's "Delete <Kind>" and the Create buttons of Endpoints,
// EndpointSlices, ResourceQuotas and LimitRanges show only where the cluster allows the action, and the Node, Namespace
// and custom resource drawers the cluster refuses say so with the drawers' notice. The objects and users of the run
// are removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const CLUSTER = 'self'
const KIND_CLUSTER = 'kubeast'
const PW = 'E2e-cpui-throwaway-1!'
const STAMP = Date.now().toString(36)
const PREFIX = `e2e-cpui-${STAMP}`
const NS_A = `${PREFIX}-a`
const NS_B = `${PREFIX}-b`
const CR_GROUP = `g${STAMP}.cpui.kubeast.io`
const CRD = `permchecks.${CR_GROUP}`
const ROLE = `${PREFIX}-cr`
const RBAC = 'rbac.authorization.k8s.io'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const LABELS = { 'kubeast.io/e2e': 'cluster-permission-ui' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

// Screen words come from the en catalog, the locale this project runs in.
const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string, vars: Record<string, string> = {}): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}

let kubeconfig = ''
let ready = ''
let node = ''
function kubectl(args: string[], input?: string, tolerate = false): string {
  const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input })
  if (r.status !== 0 && !tolerate) throw new Error(`kubectl ${args.slice(0, 4).join(' ')}: ${(r.stderr || '').slice(0, 400)}`)
  return (r.stdout || '').trim()
}
const asList = (items: object[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })
const clusterObjects = () => [
  { apiVersion: `${RBAC}/v1`, kind: 'ClusterRole', metadata: { name: ROLE, labels: LABELS }, rules: [{ apiGroups: ['cpui.kubeast.io'], resources: ['nothing'], verbs: ['get'] }] },
  { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: CRD, labels: LABELS }, spec: { group: CR_GROUP, scope: 'Namespaced', names: { kind: 'PermCheck', plural: 'permchecks', singular: 'permcheck', listKind: 'PermCheckList' }, versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }] } },
]

// The cluster's answer for the identity Kubeast acts as: one verb on one object, in its namespace or (null) none.
type Who = { user: string; groups: string[] }
function canI(who: Who, verb: string, target: string, namespace: string | null): boolean {
  const out = kubectl(['auth', 'can-i', verb, target, ...(namespace ? ['-n', namespace] : ['-A']), '--as', who.user, ...who.groups.flatMap((g) => ['--as-group', g])], undefined, true).split('\n').pop() ?? ''
  if (!/^(yes|no)\b/.test(out)) throw new Error(`kubectl auth can-i ${verb} ${target} answered "${out}"`)
  return out.startsWith('yes')
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}
// whom Kubeast acts as for a token on self (X-Kubeast-Access of a cluster answer); null when impersonation is off
async function identity(request: APIRequestContext, token: string): Promise<Who | null> {
  const res = await request.get(`/api/v1/cluster/namespaces?cluster=${CLUSTER}`, { headers: bearer(token), failOnStatusCode: false })
  const header = res.headers()['x-kubeast-access']
  if (!header) return null
  const access = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { user?: string; groups?: string[]; impersonation?: boolean }
  return access.impersonation && access.user ? { user: access.user, groups: access.groups ?? [] } : null
}

// A user of the run with a grant on self, signed in in a context of its own (not the project's admin sign-in).
type Session = { ctx: BrowserContext; page: Page; who: Who; userId: string }
async function signIn(browser: Browser, request: APIRequestContext, admin: string, key: string, grant: { role: string; namespaces?: string[] }): Promise<Session> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const email = `${PREFIX}-${key}@kubeast.local`
  const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E cpui ${key}`, email, password: PW, role_id: member.id } })
  expect(created.status(), `create ${email}`).toBe(201)
  const userId = (await created.json()).id as string
  const granted = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
  expect(granted.status(), await granted.text()).toBe(200)
  const who = await identity(request, await login(request, email, PW))
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
  return { ctx, page, who: who ?? { user: '', groups: [] }, userId }
}
async function signOut(request: APIRequestContext, admin: string, s: Session | null) {
  if (!s) return
  await s.ctx.close()
  await request.delete(`/api/v1/auth/admin/users/${s.userId}`, { headers: bearer(admin), failOnStatusCode: false })
}

// The cluster's answer to the screen's question (GET /cluster/can-i of that verb and resource): a button that is
// hidden while it is asked is read after it came. A build that does not ask is read after a few seconds instead.
function canIAnswer(page: Page, verb: string, resource: string): Promise<unknown> {
  return page.waitForResponse((r) => {
    const u = new URL(r.url())
    return u.pathname === '/api/v1/cluster/can-i' && u.searchParams.get('verb') === verb && u.searchParams.get('resource') === resource
  }, { timeout: 8_000 }).catch(() => null)
}

// A drawer opened by link, once its header is drawn and the delete question has its answer.
async function openDrawer(page: Page, ref: string, resource: string, api?: string): Promise<Locator> {
  const asked = canIAnswer(page, 'delete', resource)
  await page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(ref)}${api ? `&detailApi=${encodeURIComponent(api)}` : ''}`)
  const drawer = page.locator(DRAWER).last()
  await expect(drawer.getByRole('button', { name: 'YAML', exact: true })).toBeVisible({ timeout: 20_000 })
  await asked
  return drawer
}
// the drawer's "Delete <Kind>" buttons, given a moment to be drawn after the answer
async function deleteButtons(drawer: Locator, kind: string, want: number, why: string) {
  await expect.soft(drawer.getByRole('button', { name: tr('common.deleteKind', { kind }), exact: true }), why).toHaveCount(want, { timeout: 5_000 })
}

// What a refused or missing object's drawer says: the notice's words, a load error's, or nothing ("blank").
async function refusal(drawer: Locator): Promise<string> {
  const errors = [tr('nodes.detail.error'), tr('namespaces.detail.error')]
  const notice = drawer.getByTestId('detail-unreadable')
  await expect(notice.or(drawer.getByText(errors[0], { exact: true })).or(drawer.getByText(errors[1], { exact: true })).first())
    .toBeVisible({ timeout: 20_000 }).catch(() => {})
  if ((await notice.count()) > 0) return (await notice.innerText()).trim()
  const text = await drawer.innerText()
  return errors.find((e) => text.includes(e)) ?? 'blank'
}

test.describe('buttons and drawers follow the cluster\'s answer', () => {
  test.beforeAll(() => {
    const which = spawnSync('kind', ['get', 'kubeconfig', '--name', KIND_CLUSTER], { encoding: 'utf8' })
    if (which.status !== 0) {
      ready = `no kind cluster ${KIND_CLUSTER} (kind get kubeconfig)`
      return
    }
    kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cpui-')), 'kubeconfig')
    fs.writeFileSync(kubeconfig, which.stdout, { mode: 0o600 })
    const impersonator = JSON.parse(kubectl(['get', 'clusterrole', 'kubeast-impersonator', '-o', 'json'], undefined, true) || '{}')
    if (!(impersonator.rules ?? []).some((r: { resourceNames?: string[] }) => (r.resourceNames ?? []).includes('kubeast:role:read'))) {
      ready = 'the impersonator may not act as kubeast:role:read (helm/kubeast/files/impersonation-rbac.yaml)'
      return
    }
    node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
    kubectl(['apply', '-f', '-'], asList([NS_A, NS_B].map((name) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: LABELS } }))))
    kubectl(['apply', '-f', '-'], asList(clusterObjects()))
    kubectl(['apply', '-f', '-'], asList([
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cpui-cm', namespace: NS_A, labels: LABELS }, data: { k: 'v' } },
      { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'cpui-ep', namespace: NS_A, labels: LABELS } },
      // the limited Read grant acts as kubeast:role:read: the cluster lets that group read (view) in NS_A only
      { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: `${PREFIX}-view`, namespace: NS_A, labels: LABELS }, roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: 'view' }, subjects: [{ apiGroup: RBAC, kind: 'Group', name: 'kubeast:role:read' }] },
    ]))
    kubectl(['wait', '--for', 'condition=Established', `crd/${CRD}`, '--timeout=60s'])
    for (let i = 0; ; i++) {
      const r = spawnSync('kubectl', ['--kubeconfig', kubeconfig, 'apply', '-f', '-'], { encoding: 'utf8', input: asList([{ apiVersion: `${CR_GROUP}/v1`, kind: 'PermCheck', metadata: { name: 'cpui-pc', namespace: NS_A, labels: LABELS }, spec: { note: 'cpui' } }]) })
      if (r.status === 0) break
      if (i >= 10) throw new Error(`the PermCheck instance: ${r.stderr}`)
      spawnSync('sleep', ['1'])
    }
  })

  test.afterAll(() => {
    if (!kubeconfig) return
    kubectl(['delete', 'namespace', NS_A, NS_B, '--ignore-not-found', '--wait=false'], undefined, true)
    kubectl(['delete', '-f', '-', '--ignore-not-found', '--wait=false'], asList(clusterObjects()), true)
  })

  test('a Write user: Delete where the cluster lets it delete, not on Endpoints, nodes, namespaces, ClusterRoles or custom resources; no Create on four lists', async ({ browser, request }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(180_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    let s: Session | null = null
    try {
      s = await signIn(browser, request, admin, 'write', { role: 'Write' })
      test.skip(!s.who.user, 'impersonation is off: Kubeast acts as its own service account, there is no per-user identity to ask about')
      const drawers: [string, string, string, string, string | null, string?][] = [
        // kind shown, link, resource asked, kubectl target, namespace, detailApi
        ['ConfigMap', `ConfigMap/${NS_A}/cpui-cm`, 'configmaps', 'configmaps/cpui-cm', NS_A],
        ['Endpoints', `Endpoints/${NS_A}/cpui-ep`, 'endpoints', 'endpoints/cpui-ep', NS_A],
        ['Node', `Node/${node}`, 'nodes', `nodes/${node}`, null],
        ['Namespace', `Namespace/${NS_A}`, 'namespaces', `namespaces/${NS_A}`, NS_A],
        ['ClusterRole', `ClusterRole/${ROLE}`, 'clusterroles', `clusterroles.${RBAC}/${ROLE}`, null],
        ['PermCheck', `PermCheck/${NS_A}/cpui-pc`, 'permchecks', `${CRD}/cpui-pc`, NS_A, `${CR_GROUP}/v1/permchecks`],
      ]
      const cluster: Record<string, boolean> = {}
      for (const [kind, ref, resource, target, namespace, api] of drawers) {
        cluster[kind] = canI(s.who, 'delete', target, namespace)
        const drawer = await openDrawer(s.page, ref, resource, api)
        await deleteButtons(drawer, kind, cluster[kind] ? 1 : 0, `"${tr('common.deleteKind', { kind })}" ↔ kubectl auth can-i delete ${target}${namespace ? ` -n ${namespace}` : ''} → ${cluster[kind] ? 'yes' : 'no'}`)
      }
      // the dev cluster's Write grant (edit + viewer) deletes ConfigMaps and nothing else here: both branches were seen
      expect.soft(cluster, 'the cluster\'s answers').toEqual({ ConfigMap: true, Endpoints: false, Node: false, Namespace: false, ClusterRole: false, PermCheck: false })

      const lists: [string, string, string, string][] = [
        ['/network/endpoints', 'endpoints', 'endpoints', 'endpointsPage.create'],
        ['/network/endpointslices', 'endpointslices', 'endpointslices.discovery.k8s.io', 'endpointSlicesPage.create'],
        ['/cluster/resourcequotas', 'resourcequotas', 'resourcequotas', 'resourceQuotas.create'],
        ['/cluster/limitranges', 'limitranges', 'limitranges', 'limitRanges.create'],
      ]
      for (const [p, resource, target, label] of lists) {
        const allowed = canI(s.who, 'create', target, NS_A)
        const asked = canIAnswer(s.page, 'create', resource)
        await s.page.goto(`${p}?cluster=${CLUSTER}&namespace=${NS_A}`)
        await expect(s.page.locator('main h1').first()).toBeVisible({ timeout: 20_000 })
        await asked
        await expect.soft(s.page.locator('main').getByRole('button', { name: tr(label), exact: true }), `${p} "${tr(label)}" ↔ kubectl auth can-i create ${target} -n ${NS_A} → ${allowed ? 'yes' : 'no'}`)
          .toHaveCount(allowed ? 1 : 0, { timeout: 5_000 })
      }
    } finally {
      await signOut(request, admin, s)
    }
  })

  test('a Read user limited to one namespace: the Node, other Namespace and refused custom resource drawers say it may not see them', async ({ browser, request }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(150_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    let s: Session | null = null
    try {
      s = await signIn(browser, request, admin, 'nsread', { role: 'Read', namespaces: [NS_A] })
      test.skip(!s.who.user, 'impersonation is off: Kubeast acts as its own service account, there is no per-user identity to ask about')
      const drawers: [string, string, string, string | null, string?][] = [
        ['Node', `Node/${node}`, `nodes/${node}`, null],
        ['Namespace', `Namespace/${NS_B}`, `namespaces/${NS_B}`, NS_B],
        ['PermCheck', `PermCheck/${NS_A}/cpui-pc`, `${CRD}/cpui-pc`, NS_A, `${CR_GROUP}/v1/permchecks`],
      ]
      const forbidden = tr('common.objectForbidden')
      for (const [kind, ref, target, namespace, api] of drawers) {
        const allowed = canI(s.who, 'get', target, namespace)
        await s.page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(ref)}${api ? `&detailApi=${encodeURIComponent(api)}` : ''}`)
        const drawer = s.page.locator(DRAWER).last()
        await expect(drawer.getByRole('button', { name: 'YAML', exact: true })).toBeVisible({ timeout: 20_000 })
        expect.soft(allowed, `kubectl auth can-i get ${target}${namespace ? ` -n ${namespace}` : ''}`).toBe(false)
        expect.soft(await refusal(drawer), `the ${kind} drawer, refused by the cluster`).toBe(forbidden)
        await deleteButtons(drawer, kind, 0, `no "${tr('common.deleteKind', { kind })}" for a Read grant`)
      }
    } finally {
      await signOut(request, admin, s)
    }
  })

  test('the admin keeps every Delete the cluster allows it, a Namespace\'s and a custom resource\'s included; a missing custom resource says it does not exist', async ({ page, request }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(150_000)
    const who = await identity(request, await login(request, ADMIN_EMAIL, ADMIN_PASSWORD))
    test.skip(!who, 'impersonation is off: Kubeast acts as its own service account, there is no per-user identity to ask about')
    const drawers: [string, string, string, string, string | null, string?][] = [
      ['ConfigMap', `ConfigMap/${NS_A}/cpui-cm`, 'configmaps', 'configmaps/cpui-cm', NS_A],
      ['Namespace', `Namespace/${NS_A}`, 'namespaces', `namespaces/${NS_A}`, NS_A],
      ['ClusterRole', `ClusterRole/${ROLE}`, 'clusterroles', `clusterroles.${RBAC}/${ROLE}`, null],
      ['PermCheck', `PermCheck/${NS_A}/cpui-pc`, 'permchecks', `${CRD}/cpui-pc`, NS_A, `${CR_GROUP}/v1/permchecks`],
    ]
    for (const [kind, ref, resource, target, namespace, api] of drawers) {
      const allowed = canI(who!, 'delete', target, namespace)
      const drawer = await openDrawer(page, ref, resource, api)
      expect.soft(allowed, `kubectl auth can-i delete ${target} for the admin`).toBe(true)
      await deleteButtons(drawer, kind, allowed ? 1 : 0, `"${tr('common.deleteKind', { kind })}" for the admin ↔ kubectl auth can-i → ${allowed ? 'yes' : 'no'}`)
    }
    // a custom resource that is not there, opened by link: the drawers' "does not exist" notice, not empty sections
    expect.soft(kubectl(['get', CRD, 'cpui-gone', '-n', NS_A, '--ignore-not-found', '-o', 'name']), 'kubectl get: no such PermCheck').toBe('')
    await page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(`PermCheck/${NS_A}/cpui-gone`)}&detailApi=${encodeURIComponent(`${CR_GROUP}/v1/permchecks`)}`)
    const gone = page.locator(DRAWER).last()
    await expect(gone.getByRole('button', { name: 'YAML', exact: true })).toBeVisible({ timeout: 20_000 })
    expect.soft(await refusal(gone), 'the drawer of a PermCheck that does not exist').toBe(tr('common.objectNotFound'))
  })

  test('a drawer opened by link shows no empty object while it reads: a missing one goes from loading to its notice, asking once', async ({ page }) => {
    test.skip(ready !== '', ready)
    test.setTimeout(90_000)
    // every text the drawer passes through, recorded in the page so no moment between two reads is missed
    await page.addInitScript((selector) => {
      const w = window as unknown as { drawerTexts: string[] }
      w.drawerTexts = []
      new MutationObserver(() => {
        const text = document.querySelector(selector)?.textContent ?? ''
        if (text && w.drawerTexts[w.drawerTexts.length - 1] !== text) w.drawerTexts.push(text)
      }).observe(document, { childList: true, subtree: true, characterData: true })
    }, DRAWER)
    const texts = () => page.evaluate(() => (window as unknown as { drawerTexts: string[] }).drawerTexts)

    // the object of an alert whose custom resource and CRD are gone: what the Alerts inbox opens after a run ended
    const reads: number[] = []
    page.on('response', (r) => {
      const u = new URL(r.url())
      if (u.pathname === '/api/v1/cluster/resources/json' && u.searchParams.get('resource_name') === 'cpui-gone-widget') reads.push(r.status())
    })
    await page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(`Widget/${NS_A}/cpui-gone-widget`)}&detailApi=${encodeURIComponent('gone.cpui.kubeast.io/v1')}`)
    const gone = page.locator(DRAWER).last()
    await expect(gone.getByTestId('detail-unreadable')).toHaveText(tr('common.objectNotFound'), { timeout: 20_000 })
    expect.soft((await texts()).filter((t) => t.includes('Basic Info')), 'the drawer on its way to "does not exist"').toEqual([])
    expect.soft(reads, 'a 404 is an answer: the object is read once').toEqual([404])

    // an object that is there, in the same view: its values or Loading, never its fields with nothing in them
    const name = 'cpui-revision'
    kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'apps/v1', kind: 'ControllerRevision', metadata: { name, namespace: NS_A }, revision: 1, data: {} }))
    await page.goto(`/account?cluster=${CLUSTER}&detail=${encodeURIComponent(`ControllerRevision/${NS_A}/${name}`)}`)
    await expect(page.locator(DRAWER).last().getByText('apps/v1', { exact: true })).toBeVisible({ timeout: 20_000 })
    const passed = await texts()
    expect.soft(passed.filter((t) => t.includes('Basic Info') && !t.includes('apps/v1')), 'the drawer before the object arrived').toEqual([])
  })
})
