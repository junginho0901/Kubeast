import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Number check of the RBAC tab of the Cluster View's pod window on cluster `self`: what the route answers and the tab
// draws adds up to `kubectl auth can-i --list --as system:serviceaccount:<ns>:<sa> -n <ns>`, each binding is listed by
// what matched it, a grant limited to a namespace is shown what the cluster gives it with the rest named as refused, an
// account with no RoleBinding and a role of many rules are drawn whole, and no Secret's value is in the answer.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const CLUSTER = 'self'
const NS = 'e2e-pod-rbac'
const EMPTY_NS = 'e2e-pod-rbac-empty'
const P = 'e2e-pod-rbac'
const WEB = `${P}-web`
const LONG = `${P}-long`
const LONELY = `${P}-lonely`
const FAKE_SECRET = 'not-a-real-token-for-this-test'
const READ_GROUP = 'kubeast:role:read'
const RBAC_API = 'rbac.authorization.k8s.io'
const API_VERSION = `${RBAC_API}/v1`

const serviceAccount = (name: string, namespace: string | undefined = NS) => ({ kind: 'ServiceAccount', name, ...(namespace ? { namespace } : {}) })
const group = (name: string) => ({ kind: 'Group', apiGroup: RBAC_API, name })
const user = (name: string) => ({ kind: 'User', apiGroup: RBAC_API, name })
const roleBinding = (name: string, roleKind: string, role: string, subjects: object[]) => ({
  apiVersion: API_VERSION, kind: 'RoleBinding', metadata: { name, namespace: NS }, subjects, roleRef: { apiGroup: RBAC_API, kind: roleKind, name: role },
})
const clusterRoleBinding = (name: string, role: string, subjects: object[]) => ({
  apiVersion: API_VERSION, kind: 'ClusterRoleBinding', metadata: { name }, subjects, roleRef: { apiGroup: RBAC_API, kind: 'ClusterRole', name: role },
})
const clusterRole = (name: string, rules: object[]) => ({ apiVersion: API_VERSION, kind: 'ClusterRole', metadata: { name }, rules })
const pod = (name: string, namespace: string, account?: string) => ({
  apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace },
  spec: {
    terminationGracePeriodSeconds: 0,
    ...(account ? { serviceAccountName: account } : {}),
    containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }],
  },
})

const FIXTURE = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: EMPTY_NS } },
  { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-sa-token', namespace: NS }, type: 'Opaque', stringData: { token: FAKE_SECRET } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'web-sa', namespace: NS }, secrets: [{ name: 'web-sa-token' }] },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'long-sa', namespace: NS } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'other-sa', namespace: NS } },
  {
    apiVersion: API_VERSION, kind: 'Role', metadata: { name: 'web-reader', namespace: NS },
    rules: [
      { apiGroups: [''], resources: ['configmaps'], resourceNames: ['app-config', 'app-flags'], verbs: ['get'] },
      { apiGroups: ['apps'], resources: ['deployments', 'deployments/scale'], verbs: ['get', 'list'] },
      { apiGroups: ['', 'batch'], resources: ['events'], verbs: ['list'] },
    ],
  },
  clusterRole(`${P}-nodes`, [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] }, { nonResourceURLs: [`/${P}/*`], verbs: ['get'] }]),
  clusterRole(`${P}-pods`, [{ apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get'] }]),
  clusterRole(`${P}-leases`, [{ apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get'] }]),
  clusterRole(`${P}-volumes`, [{ apiGroups: [''], resources: ['persistentvolumes'], verbs: ['list'] }]),
  roleBinding('web-rb', 'Role', 'web-reader', [serviceAccount('web-sa')]),
  // a ServiceAccount subject without a namespace is one of the RoleBinding's namespace
  roleBinding('bare-subject-rb', 'ClusterRole', `${P}-pods`, [serviceAccount('web-sa', '')]),
  roleBinding('namespace-group-rb', 'ClusterRole', `${P}-leases`, [group(`system:serviceaccounts:${NS}`)]),
  roleBinding('other-account-rb', 'ClusterRole', 'admin', [serviceAccount('other-sa')]),
  roleBinding('long-rb', 'ClusterRole', 'admin', [serviceAccount('long-sa')]),
  clusterRoleBinding(`${P}-by-name`, `${P}-nodes`, [serviceAccount('web-sa')]),
  clusterRoleBinding(`${P}-by-user`, `${P}-volumes`, [user(`system:serviceaccount:${NS}:web-sa`)]),
  clusterRoleBinding(`${P}-alice`, 'cluster-admin', [user('alice')]),
  pod(WEB, NS, 'web-sa'),
  pod(LONG, NS, 'long-sa'),
  pod(LONELY, EMPTY_NS),
].map((o) => JSON.stringify(o)).join('\n---\n')

const CLUSTER_OBJECTS = [
  `clusterrolebinding/${P}-by-name`, `clusterrolebinding/${P}-by-user`, `clusterrolebinding/${P}-alice`, `clusterrolebinding/${P}-imp`,
  `clusterrole/${P}-nodes`, `clusterrole/${P}-pods`, `clusterrole/${P}-leases`, `clusterrole/${P}-volumes`, `clusterrole/${P}-imp`,
].join(' ')

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-podrbac-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const k = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', kcPath, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
// `kubectl auth can-i` answers "no" with a non-zero exit
const saidBy = (args: string[]) => {
  try {
    return k(args)
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '').trim()
  }
}

// kubectl's printed form of a resource and its group (describe.CombineResourceGroup)
const printed = (resource: string, apiGroup: string) => {
  const [head, ...rest] = resource.split('/')
  return head + (apiGroup ? `.${apiGroup}` : '') + (rest.length ? `/${rest.join('/')}` : '')
}

// one fact per resource, name, URL and verb, the form both sides break down to
function canIList(namespace: string, account: string): string[] {
  const lines = k(['auth', 'can-i', '--list', '-n', namespace, '--as', `system:serviceaccount:${namespace}:${account}`]).split('\n')
  const header = lines[0]
  const urlsAt = header.indexOf('Non-Resource URLs')
  const namesAt = header.indexOf('Resource Names')
  const verbsAt = header.indexOf('Verbs')
  const list = (cell: string) => cell.trim().replace(/^\[|\]$/g, '').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (const line of lines.slice(1)) {
    const resource = line.slice(0, urlsAt).trim()
    const urls = list(line.slice(urlsAt, namesAt))
    const names = list(line.slice(namesAt, verbsAt))
    for (const verb of list(line.slice(verbsAt))) {
      for (const url of urls) out.add(`url:${url}|${verb}`)
      if (resource) for (const name of names.length ? names : ['']) out.add(`${resource}|${name}|${verb}`)
    }
  }
  return [...out].sort()
}

function factsOfRoute(answer: Obj, which: (binding: Obj) => boolean = () => true): string[] {
  const out = new Set<string>()
  for (const binding of [...(answer.role_bindings ?? []), ...(answer.cluster_role_bindings ?? [])].filter(which)) {
    for (const rule of binding.resolved_role.rules) {
      for (const verb of rule.verbs) {
        for (const url of rule.non_resource_urls) out.add(`url:${url}|${verb}`)
        for (const apiGroup of rule.api_groups) {
          for (const resource of rule.resources) {
            const names = rule.resource_names.length ? rule.resource_names : ['']
            for (const name of names) out.add(`${printed(resource, apiGroup)}|${name}|${verb}`)
          }
        }
      }
    }
  }
  return [...out].sort()
}

type Row = { apiGroup: string; resource: string; names: string[]; verbs: string[] }

// the permission summary as the screen writes it
async function rowsOnScreen(page: Page): Promise<{ resources: Row[]; urls: { url: string; verbs: string[] }[] }> {
  return page.getByTestId('pod-rbac-summary').evaluate((root) => {
    const split = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean)
    return {
      resources: [...root.querySelectorAll('[data-testid="pod-rbac-resources"] tr')].map((tr) => {
        const [apiGroup, resource, verbs] = [...tr.querySelectorAll('td')]
        const names = /:\s*(.*)\)$/.exec(resource.querySelector('span')?.textContent ?? '')?.[1] ?? ''
        return { apiGroup: apiGroup.textContent ?? '', resource: resource.firstChild?.textContent ?? '', names: split(names), verbs: split(verbs.textContent ?? '') }
      }),
      urls: [...root.querySelectorAll('[data-testid="pod-rbac-urls"] tr')].map((tr) => {
        const [url, verbs] = [...tr.querySelectorAll('td')]
        return { url: url.textContent ?? '', verbs: split(verbs.textContent ?? '') }
      }),
    }
  })
}

function factsOfScreen(rows: Awaited<ReturnType<typeof rowsOnScreen>>): string[] {
  const out = new Set<string>()
  for (const row of rows.resources) {
    const apiGroup = row.apiGroup === '(core)' ? '' : row.apiGroup
    for (const verb of row.verbs) for (const name of row.names.length ? row.names : ['']) out.add(`${printed(row.resource, apiGroup)}|${name}|${verb}`)
  }
  for (const row of rows.urls) for (const verb of row.verbs) out.add(`url:${row.url}|${verb}`)
  return [...out].sort()
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}
const adminToken = (request: APIRequestContext) => login(request, process.env.E2E_USER_EMAIL || 'admin', process.env.E2E_USER_PASSWORD || '')

async function routeOf(request: APIRequestContext, token: string, namespace: string, name: string, params: Record<string, string> = {}): Promise<Obj> {
  const res = await request.get(`/api/v1/cluster/namespaces/${namespace}/pods/${name}/rbac`, { headers: bearer(token), params: { cluster: CLUSTER, ...params } })
  expect(res.status(), await res.text()).toBe(200)
  return res.json()
}

const names = (rows: Obj[] | undefined) => (rows ?? []).map((r: Obj) => r.name as string).sort()
const matchedBy = (rows: Obj[], name: string) => rows.find((r: Obj) => r.name === name)?.matched_by.map((m: Obj) => m.reason)

async function openRbacTab(page: Page, podName: string, namespace?: string) {
  await page.goto(`/cluster-view?cluster=${CLUSTER}`)
  await expect(page.getByTestId('cluster-view-map')).toBeVisible({ timeout: 20_000 })
  if (namespace) {
    await page.getByRole('button', { name: /All namespaces|전체 네임스페이스|모든 Namespace/i }).first().click()
    await page.getByRole('button', { name: namespace, exact: true }).click()
  }
  const card = page.locator('[data-testid="cluster-view-node"] button').filter({ hasText: podName }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  await page.getByRole('button', { name: 'RBAC', exact: true }).click()
  await expect(page.getByTestId('pod-rbac-summary')).toBeVisible({ timeout: 20_000 })
}

// the counts line, "-" for a list not read
async function countsOnScreen(page: Page) {
  const text = (await page.getByTestId('pod-rbac-binding-counts').innerText()).replace(/\s+/g, ' ')
  const of = (kind: RegExp) => kind.exec(text)?.[1]
  return { roleBindings: of(/(?:^| )RoleBinding (\d+|-)/), clusterRoleBindings: of(/ClusterRoleBinding (\d+|-)/) }
}

const bindingNames = async (page: Page, section: string) =>
  (await page.getByTestId(section).getByTestId('pod-rbac-binding-name').allInnerTexts()).sort()

test.beforeAll(() => {
  test.setTimeout(240_000)
  // a run before this one leaves the namespaces terminating: new objects, not its last ones
  k(['delete', `namespace/${NS}`, `namespace/${EMPTY_NS}`, '--ignore-not-found', '--timeout=120s'])
  k(['delete', ...CLUSTER_OBJECTS.split(' '), '--ignore-not-found'])
  k(['apply', '-f', '-'], FIXTURE)
  k(['-n', NS, 'wait', `pod/${WEB}`, `pod/${LONG}`, '--for=condition=Ready', '--timeout=120s'])
  k(['-n', EMPTY_NS, 'wait', `pod/${LONELY}`, '--for=condition=Ready', '--timeout=120s'])
})

test.afterAll(() => {
  k(['delete', `namespace/${NS}`, `namespace/${EMPTY_NS}`, '--ignore-not-found', '--timeout=120s'])
  k(['delete', ...CLUSTER_OBJECTS.split(' '), '--ignore-not-found'])
})

test.describe('RBAC tab of the pod window — number check', () => {
  test('the route lists each binding by what matched it, and its rules add up to kubectl auth can-i --list', async ({ request }) => {
    const token = await adminToken(request)
    const plain = await routeOf(request, token, NS, WEB)
    const broad = await routeOf(request, token, NS, WEB, { include_authenticated: 'true' })
    const want = canIList(NS, 'web-sa')

    expect(plain.errors).toEqual([])
    expect(plain.service_account).toEqual({ name: 'web-sa', namespace: NS })
    expect(names(plain.role_bindings)).toEqual(['bare-subject-rb', 'namespace-group-rb', 'web-rb'])
    expect(matchedBy(plain.role_bindings, 'web-rb')).toEqual(['serviceaccount'])
    expect(matchedBy(plain.role_bindings, 'bare-subject-rb')).toEqual(['serviceaccount'])
    expect(matchedBy(plain.role_bindings, 'namespace-group-rb')).toEqual(['group:serviceaccounts:namespace'])
    expect(matchedBy(plain.cluster_role_bindings, `${P}-by-name`)).toEqual(['serviceaccount'])
    expect(matchedBy(plain.cluster_role_bindings, `${P}-by-user`)).toEqual(['user:system:serviceaccount'])
    expect(names(plain.cluster_role_bindings)).not.toContain(`${P}-alice`)

    // with the broad group the rules are what the API server says this account may do
    expect(factsOfRoute(broad)).toEqual(want)
    // without it, all of that but what only system:authenticated gives
    const onlyBroad = factsOfRoute(broad, (b) => b.is_broad === true)
    expect(onlyBroad.length, 'the cluster binds system:authenticated by default').toBeGreaterThan(0)
    expect([...new Set([...factsOfRoute(plain), ...onlyBroad])].sort()).toEqual(want)

    // the facts the fixture gave, spelled out so that a wrong reading of kubectl's table cannot hide them
    for (const fact of [
      'configmaps|app-config|get', 'configmaps|app-flags|get', 'events||list', 'events.batch||list', 'deployments.apps/scale||list',
      'pods/log||get', 'leases.coordination.k8s.io||get', 'nodes||list', 'persistentvolumes||list', `url:/${P}/*|get`,
    ]) {
      expect(want, 'kubectl').toContain(fact)
    }
  })

  test('the tab draws the route: the account, the counts, each section and the summary, with the broad group as kubectl has it', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const plain = await routeOf(request, token, NS, WEB)
    await openRbacTab(page, WEB, NS)

    await expect(page.getByTestId('pod-rbac-service-account')).toHaveText(`system:serviceaccount:${NS}:web-sa`)
    expect(await countsOnScreen(page)).toEqual({ roleBindings: String(plain.role_bindings.length), clusterRoleBindings: String(plain.cluster_role_bindings.length) })
    expect(await bindingNames(page, 'pod-rbac-role-bindings')).toEqual(names(plain.role_bindings))
    expect(await bindingNames(page, 'pod-rbac-cluster-role-bindings')).toEqual(names(plain.cluster_role_bindings))
    await expect(page.getByTestId('pod-rbac-role-bindings')).toContainText(`system:serviceaccounts:${NS}`)
    await expect(page.getByTestId('pod-rbac-warning')).toHaveCount(0)
    expect(factsOfScreen(await rowsOnScreen(page))).toEqual(factsOfRoute(plain))

    // turning the group on asks again: while that answer is held the tab shows its loading line and none of the
    // bindings or the summary read without the group, then the answer with it
    const isBroad = (url: URL) => url.pathname === `/api/v1/cluster/namespaces/${NS}/pods/${WEB}/rbac` && url.searchParams.get('include_authenticated') === 'true'
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = 0
    await page.route(isBroad, async (route) => {
      held++
      await gate
      try { await route.continue() } catch { /* the page went on */ }
    })
    try {
      await page.getByRole('checkbox', { name: /system:authenticated/ }).check()
      await expect.poll(() => held, { message: 'the answer with the group is held' }).toBeGreaterThan(0)
      await expect(page.getByText(EN.clusterView.rbac.loading, { exact: true })).toHaveCount(1)
      await expect(page.getByTestId('pod-rbac-summary'), 'the summary read without the group, while the answer with it is held').toHaveCount(0)
      expect(await page.getByTestId('pod-rbac-binding-name').count(), 'bindings read without the group, while the answer with it is held').toBe(0)
      expect(await page.getByTestId('pod-rbac-binding-counts').count(), 'the counts read without the group, while the answer with it is held').toBe(0)
    } finally {
      release()
      await page.unroute(isBroad)
    }
    const want = canIList(NS, 'web-sa')
    await expect.poll(async () => factsOfScreen(await rowsOnScreen(page)), { timeout: 15_000 }).toEqual(want)

    const broad = await routeOf(request, token, NS, WEB, { include_authenticated: 'true' })
    expect(await countsOnScreen(page)).toEqual({ roleBindings: String(broad.role_bindings.length), clusterRoleBindings: String(broad.cluster_role_bindings.length) })
    expect(await bindingNames(page, 'pod-rbac-cluster-role-bindings')).toEqual(names(broad.cluster_role_bindings))

    // a broad role of URLs names its URLs and no API group
    const rule = page.getByTestId('pod-rbac-cluster-role-bindings').getByTestId('pod-rbac-rule').filter({ hasText: '/version' }).first()
    await expect(rule).toContainText('/version')
    await expect(rule).not.toContainText('(core)')
  })

  test('the floating chat is told what the tab shows', async ({ page }) => {
    test.setTimeout(120_000)
    const sent: { base?: Obj; overlays?: Obj[] }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-pod-rbac-ctx', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-pod-rbac-ctx(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-pod-rbac-ctx', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-pod-rbac-ctx\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    await openRbacTab(page, WEB, NS)
    const rows = await rowsOnScreen(page)
    await page.getByTestId('floating-chat-toggle').click()
    const input = page.getByTestId('floating-chat-input')
    await expect(input).toBeVisible()
    await input.fill('what can this pod do?')
    await input.press('Enter')
    await expect.poll(() => sent.length).toBe(1)
    const data = [sent[0].base, ...(sent[0].overlays ?? [])].find((l) => l?.source === 'PodRbacTab')?.data
    expect(data?.service_account).toBe(`system:serviceaccount:${NS}:web-sa`)
    expect(data?.permissions_incomplete).toBe(false)
    expect(data?.permissions).toEqual([
      ...rows.resources.map((r) => `${r.apiGroup}|${r.resource}|${r.names.join(',')}|${r.verbs.join(',')}`),
      ...rows.urls.map((r) => `${r.url}|${r.verbs.join(',')}`),
    ])
    expect(names(data?.role_bindings)).toEqual(await bindingNames(page, 'pod-rbac-role-bindings'))
  })

  test('a grant limited to a namespace is shown what the cluster gives it, and the rest is named as refused', async ({ browser, request }) => {
    test.setTimeout(180_000)
    const admin = await adminToken(request)
    const id = Date.now().toString(36)
    const email = `e2e-pod-rbac-${id}@kubeast.local`
    const password = `pr-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E pod RBAC ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    const as = ['--as', email, '--as-group', 'kubeast:authenticated', '--as-group', READ_GROUP]
    try {
      k(['delete', `clusterrolebinding/${P}-imp`, `clusterrole/${P}-imp`, '--ignore-not-found'])
      k(['create', 'clusterrole', `${P}-imp`, '--verb=impersonate', '--resource=groups', `--resource-name=${READ_GROUP}`])
      k(['create', 'clusterrolebinding', `${P}-imp`, `--clusterrole=${P}-imp`, '--serviceaccount=kubeast:k8s-service'])
      k(['-n', NS, 'create', 'rolebinding', `${P}-view`, '--clusterrole=view', `--group=${READ_GROUP}`])
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })
      expect(put.ok(), await put.text()).toBeTruthy()
      await expect.poll(() => saidBy(['auth', 'can-i', 'get', 'pods', '-n', NS, ...as]), { timeout: 20_000 }).toBe('yes')
      const token = await login(request, email, password)

      // view alone: the cluster refuses both lists, as it refuses kubectl as this identity
      expect(saidBy(['auth', 'can-i', 'list', 'rolebindings', '-n', NS, ...as])).toBe('no')
      expect(saidBy(['auth', 'can-i', 'list', 'clusterrolebindings', ...as])).toBe('no')
      const res = await request.get(`/api/v1/cluster/namespaces/${NS}/pods/${WEB}/rbac`, { headers: bearer(token), params: { cluster: CLUSTER } })
      const body = await res.text()
      expect(res.status(), body).toBe(200)
      const refused = JSON.parse(body)
      expect(refused.service_account.name).toBe('web-sa')
      expect(refused).not.toHaveProperty('role_bindings')
      expect(refused).not.toHaveProperty('cluster_role_bindings')
      expect(refused.role_bindings_error).toMatch(/forbidden/)
      expect(refused.cluster_role_bindings_error).toMatch(/forbidden/)
      expect(refused.bindings).toEqual([])
      expect(refused.errors.length).toBe(2)
      for (const hidden of ['web-reader', `${P}-nodes`, `${P}-by-name`, `${P}-alice`, 'alice']) expect(body).not.toContain(hidden)

      const outside = await request.get(`/api/v1/cluster/namespaces/${EMPTY_NS}/pods/${LONELY}/rbac`, { headers: bearer(token), params: { cluster: CLUSTER } })
      expect(outside.status(), 'a namespace outside the grant').toBe(403)

      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await openRbacTab(page, WEB)
      expect(await countsOnScreen(page)).toEqual({ roleBindings: '-', clusterRoleBindings: '-' })
      await expect(page.getByTestId('pod-rbac-role-bindings')).toContainText('forbidden')
      await expect(page.getByTestId('pod-rbac-cluster-role-bindings')).toContainText('forbidden')
      await expect(page.getByTestId('pod-rbac-role-bindings')).not.toContainText(/None|없음/)
      await expect(page.getByTestId('pod-rbac-cluster-role-bindings')).not.toContainText(/None|없음/)
      await expect(page.getByTestId('pod-rbac-summary')).toContainText(/could not be read|읽지 못해/)
      await expect(page.getByTestId('pod-rbac-summary')).not.toContainText(/None|없음/)
      await expect(page.getByTestId('pod-rbac-warning')).toHaveCount(2)

      // RoleBindings and Roles of the namespace allowed too: what is read shows, a ClusterRole stays named as refused
      k(['-n', NS, 'create', 'role', `${P}-rbac-reader`, '--verb=get,list', `--resource=rolebindings.${RBAC_API},roles.${RBAC_API}`])
      k(['-n', NS, 'create', 'rolebinding', `${P}-rbac-reader`, `--role=${P}-rbac-reader`, `--group=${READ_GROUP}`])
      await expect.poll(() => saidBy(['auth', 'can-i', 'list', 'rolebindings', '-n', NS, ...as]), { timeout: 20_000 }).toBe('yes')
      expect(saidBy(['auth', 'can-i', 'get', 'clusterroles', ...as])).toBe('no')
      const partly = await routeOf(request, token, NS, WEB)
      expect(names(partly.role_bindings)).toEqual(['bare-subject-rb', 'namespace-group-rb', 'web-rb'])
      expect(partly.role_bindings.find((b: Obj) => b.name === 'web-rb').resolved_role.rules.length).toBe(3)
      expect(partly.role_bindings.find((b: Obj) => b.name === 'bare-subject-rb').resolved_role.error).toMatch(/forbidden/)
      expect(partly.cluster_role_bindings_error).toMatch(/forbidden/)

      await openRbacTab(page, WEB)
      expect(await countsOnScreen(page)).toEqual({ roleBindings: '3', clusterRoleBindings: '-' })
      expect(await bindingNames(page, 'pod-rbac-role-bindings')).toEqual(['bare-subject-rb', 'namespace-group-rb', 'web-rb'])
      await expect(page.getByTestId('pod-rbac-role-bindings')).toContainText('rules: -')
      await expect(page.getByTestId('pod-rbac-role-bindings')).toContainText('forbidden')
      await expect(page.getByTestId('pod-rbac-summary')).toContainText(/could not be read|읽지 못해/)
      expect(factsOfScreen(await rowsOnScreen(page))).toEqual(factsOfRoute(partly))
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
    }
  })

  test('an account no RoleBinding names says None there, and its rules are still kubectl\'s', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const plain = await routeOf(request, token, EMPTY_NS, LONELY)
    expect(plain.service_account.name).toBe('default')
    expect(plain.role_bindings).toEqual([])
    const broad = await routeOf(request, token, EMPTY_NS, LONELY, { include_authenticated: 'true' })
    expect(factsOfRoute(broad)).toEqual(canIList(EMPTY_NS, 'default'))

    await openRbacTab(page, LONELY, EMPTY_NS)
    await expect(page.getByTestId('pod-rbac-service-account')).toHaveText(`system:serviceaccount:${EMPTY_NS}:default`)
    expect((await countsOnScreen(page)).roleBindings).toBe('0')
    await expect(page.getByTestId('pod-rbac-role-bindings')).toContainText(/None|없음/)
    expect(await bindingNames(page, 'pod-rbac-role-bindings')).toEqual([])
    expect(factsOfScreen(await rowsOnScreen(page))).toEqual(factsOfRoute(plain))
  })

  test('a role of many rules is drawn whole, in a list that scrolls, and the window does not slide sideways', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const broad = await routeOf(request, token, NS, LONG, { include_authenticated: 'true' })
    expect(factsOfRoute(broad)).toEqual(canIList(NS, 'long-sa'))
    const plain = await routeOf(request, token, NS, LONG)
    const role = JSON.parse(k(['get', 'clusterrole', 'admin', '-o', 'json']))
    expect(role.rules.length, 'admin has many rules').toBeGreaterThan(10)

    await openRbacTab(page, LONG, NS)
    expect(factsOfScreen(await rowsOnScreen(page))).toEqual(factsOfRoute(plain))
    const card = page.locator('[data-testid="pod-rbac-binding"][data-name="long-rb"]')
    await expect(card.getByTestId('pod-rbac-rule')).toHaveCount(role.rules.length)
    await expect(card).toContainText(`rules: ${role.rules.length}`)
    const list = card.getByTestId('pod-rbac-rules')
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), 'the rules scroll inside their card').toBe(true)
    expect(await page.getByTestId('pod-rbac-summary').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the summary stays inside its card').toBe(true)
  })

  test('the answer names the account\'s Secrets and holds no value of them', async ({ request }) => {
    const token = await adminToken(request)
    const res = await request.get(`/api/v1/cluster/namespaces/${NS}/pods/${WEB}/rbac`, { headers: bearer(token), params: { cluster: CLUSTER, include_authenticated: 'true' } })
    const body = await res.text()
    expect(res.status(), body).toBe(200)
    expect(JSON.parse(body).secrets).toEqual(['web-sa-token'])
    expect(body).not.toContain(FAKE_SECRET)
    expect(body).not.toContain(Buffer.from(FAKE_SECRET).toString('base64'))
  })
})
