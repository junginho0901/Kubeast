import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// Re-QA PR-5: the console says what really happened instead of "no … found"
// or a blank page —
//  #64 a list that failed on the server: "could not load (503)" and a retry
//  #65 an address no screen has: a 404 screen with a way back
//  #37/#42 a Gateway API kind whose CRD the cluster lacks: "not installed" for
//          every role (a Read user got "no permission", an admin "none"), no create button
//  #45 rest a cluster-scoped create button only where the cluster allows it
//          (SelfSubjectAccessReview): not for Write, yes for an admin
//  #43 a ServiceAccount drawer: bindings the user may not list are "cannot check", not "none" (a Read user
//          lists them through kubeast:cluster-reader; a namespace-limited reader bound to view does not)
//  #44 a Read user's Helm release page: "no permission", not "not found"
//  #72/#73 a user with no cluster: the chart's "where to ask" text and link, and the
//          footer says "no accessible cluster" on Settings too
//  a user with no role on self: the first page asked the feature flags before the picker chose a
//          cluster, the server answered for self (403) and every first page said "no permission"
//  the custom resource instances screen left out a CRD the cluster refuses without a word (permission matrix F):
//          it names the refused kinds, and so does the floating chat's screen data
// The dev install has no Gateway API CRDs on self and sets auth.accessHelp (deploy/kind/values.yaml).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const CREATE_BUTTON = 'button.btn-primary:has(svg.lucide-plus)'

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

function kubectl(args: string, input?: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-notices-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the lists' "no permission" words with the kinds they name
const FORBIDDEN_EMPTY = new RegExp(escape(EN.common.forbiddenEmpty).replace(escape('{{resource}}'), '(.+?)'))

// The floating chat's question is stopped in the browser and its body read (floating-context.spec.ts): no session is
// made and no model is called.
type Layer = { source: string; summary: string; data?: Record<string, unknown> }
type PageContext = { path: string; base?: Layer | null }
async function captureFloating(page: Page) {
  const sent: PageContext[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-notices-ctx', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback(),
  )
  await page.route(/\/api\/v1\/sessions\/e2e-notices-ctx(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-notices-ctx', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }),
  )
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-notices-ctx\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return sent
}
async function askFloating(page: Page, sent: PageContext[]): Promise<PageContext> {
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

// A temporary user with an optional role on self (limited to namespaces when given), and a browser signed in as it.
async function tempUser(browser: Browser, request: APIRequestContext, admin: Record<string, string>, tag: string, clusterRole?: string, namespaces?: string[]) {
  const email = `e2e-notices-${tag}-${Date.now()}@kubeast.local`
  const password = 'e2e-notices-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E notices ${tag}`, email, password } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  if (clusterRole) {
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: clusterRole, ...(namespaces ? { namespaces } : {}) } })).status()).toBe(200)
  }
  const ctx = await browser.newContext({ baseURL: BASE })
  expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok(), `login ${email}`).toBeTruthy()
  return {
    page: await ctx.newPage(),
    done: async () => {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    },
  }
}

test.describe('notices instead of "nothing here"', () => {
  test('a list that fails on the server says so and retries', async ({ page }) => {
    let fail = true
    await page.route('**/api/v1/cluster/deployments/all**', (route) =>
      fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"injected"}' }) : route.continue(),
    )
    await page.goto('/workloads/deployments?cluster=self')
    const row = page.getByTestId('table-load-error')
    await expect(row).toBeVisible({ timeout: 20000 })
    await expect(row).toContainText('503')
    fail = false
    await page.getByTestId('table-load-error-retry').click()
    await expect(row).toHaveCount(0, { timeout: 20000 })
    await expect(page.locator('tbody tr').first()).not.toContainText(/No .* found|찾을 수 없/)
  })

  test('an address no screen has shows a 404 screen with a way back', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    await expect(page.getByTestId('not-found')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('not-found')).toContainText('/this-route-does-not-exist')
    await expect(page.getByTestId('cluster-status')).toBeVisible() // the sidebar is there
    await page.getByTestId('not-found-home').click()
    await expect(page).toHaveURL(new URL('/', BASE).toString())
  })

  test('a Gateway API kind the cluster lacks is "not installed" for an admin and a Read user, with no create button', async ({ browser, page, request }) => {
    const admin = await adminHeaders(request)
    const probe = await request.get('/api/v1/cluster/httproutes/all?cluster=self', { headers: admin })
    test.skip(!probe.headers()['x-kubeast-not-installed'], 'self serves HTTPRoute: the Gateway API CRDs are installed')

    await page.goto('/gateway/httproutes?cluster=self')
    await expect(page.getByTestId('table-not-installed')).toContainText('HTTPRoute', { timeout: 20000 })
    await expect(page.locator(CREATE_BUTTON)).toHaveCount(0)

    const reader = await tempUser(browser, request, admin, 'read', 'Read')
    try {
      await reader.page.goto('/gateway/httproutes?cluster=self')
      await expect(reader.page.getByTestId('table-not-installed')).toBeVisible({ timeout: 20000 })
      await expect(reader.page.getByTestId('forbidden-banner')).toHaveCount(0)
    } finally {
      await reader.done()
    }
  })

  test('the create button of a kind the cluster lacks is not shown either for the moment before the list answers', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await adminHeaders(request)
    // every page that hides its create button when the cluster does not serve its kind (useKindServed)
    const pages = [
      ['gateway/gateways', 'gateways'], ['gateway/gatewayclasses', 'gatewayclasses'], ['gateway/httproutes', 'httproutes'],
      ['gateway/grpcroutes', 'grpcroutes'], ['gateway/referencegrants', 'referencegrants'],
      ['gateway/backendtlspolicies', 'backendtlspolicies'], ['workloads/vpas', 'vpas'],
    ]
    for (const [, kind] of pages) {
      // GatewayClass is cluster-scoped: its list has no /all
      const probe = await request.get(`/api/v1/cluster/${kind}${kind === 'gatewayclasses' ? '' : '/all'}?cluster=self`, { headers: admin })
      expect(probe.headers()['x-kubeast-not-installed'], `self does not serve ${kind}`).toBeTruthy()
    }
    // the list answers 1.5 s late (the permission check does not), and the page records every create button it shows
    const listPath = new RegExp(`^/api/v1/cluster/(namespaces/[^/]+/)?(${pages.map(([, k]) => k).join('|')})(/all)?$`)
    await page.route((u) => listPath.test(u.pathname), async (route) => {
      await new Promise((r) => setTimeout(r, 1_500))
      await route.continue()
    })
    await page.addInitScript((selector) => {
      const w = window as unknown as { __createShown: number }
      w.__createShown = 0
      new MutationObserver(() => { if (document.querySelector(selector)) w.__createShown += 1 }).observe(document, { subtree: true, childList: true })
    }, CREATE_BUTTON)
    const shown: Record<string, number> = {}
    for (const [route, kind] of pages) {
      const answered = page.waitForResponse((r) => listPath.test(new URL(r.url()).pathname) && new URL(r.url()).pathname.includes(`/${kind}`))
      await page.goto(`/${route}?cluster=self`)
      expect((await answered).headers()['x-kubeast-not-installed'], `${kind} answered "not installed"`).toBeTruthy()
      await expect(page.getByTestId('table-not-installed')).toBeVisible({ timeout: 20_000 })
      shown[kind] = await page.evaluate(() => (window as unknown as { __createShown: number }).__createShown)
    }
    expect(shown, 'a create button shown on each page').toEqual(Object.fromEntries(pages.map(([, k]) => [k, 0])))

    // where the cluster serves the kind, the button comes once the list has answered
    const test2 = await request.get('/api/v1/cluster/gateways/all?cluster=test2', { headers: admin, failOnStatusCode: false })
    if (test2.ok() && !test2.headers()['x-kubeast-not-installed']) {
      for (const [route] of pages) {
        await page.goto(`/${route}?cluster=test2`)
        await expect(page.locator(CREATE_BUTTON), `${route} on test2`).toBeVisible({ timeout: 20_000 })
      }
    }
  })

  test('a cluster-scoped create button shows only where the cluster allows it', async ({ browser, page, request }) => {
    const admin = await adminHeaders(request)
    await page.goto('/cluster/priorityclasses?cluster=self')
    await expect(page.locator(CREATE_BUTTON)).toHaveCount(1, { timeout: 20000 })

    const writer = await tempUser(browser, request, admin, 'write', 'Write')
    try {
      // the app permission says yes (resource.*.create), the cluster says no
      const canI = await (await writer.page.request.get('/api/v1/cluster/can-i?cluster=self&verb=create&group=scheduling.k8s.io&resource=priorityclasses')).json()
      expect(canI.allowed).toBe(false)
      await writer.page.goto('/cluster/priorityclasses?cluster=self')
      await expect(writer.page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20000 })
      await expect(writer.page.locator('tbody tr').first()).toBeVisible({ timeout: 20000 })
      await expect(writer.page.locator(CREATE_BUTTON)).toHaveCount(0)
      // a namespaced kind Write may create keeps its button
      await writer.page.goto('/configuration/configmaps?cluster=self')
      await expect(writer.page.locator(CREATE_BUTTON)).toHaveCount(1, { timeout: 20000 })
    } finally {
      await writer.done()
    }
  })

  test('a Read user: the bindings are listed, a refused Helm release is "no permission"', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const reader = await tempUser(browser, request, admin, 'read2', 'Read')
    try {
      expect(await (await reader.page.request.get('/api/v1/cluster/rolebindings/all?cluster=self')).status()).toBe(200)
      await reader.page.goto('/security/serviceaccounts?cluster=self')
      await reader.page.locator('tbody tr').filter({ hasText: 'default' }).first().click()
      const drawer = reader.page.locator(DRAWER).last()
      // the loaded title counts the bindings ("(n bindings)") only when every binding kind could be listed
      await expect(drawer.getByText(/Effective Permissions \(\d+ bindings?\)|실효 권한 \(바인딩 \d+개\)/)).toHaveCount(1, { timeout: 20000 })
      await expect(drawer.getByTestId('sa-bindings-unreadable')).toHaveCount(0)

      // Kubeast's own namespace says its own reason (protected-namespaces.spec.ts); this is the cluster refusing a Read grant.
      await reader.page.goto('/helm/releases/default/kubeast?cluster=self')
      await expect(reader.page.getByTestId('helm-release-forbidden')).toContainText(/Secrets?.*Read cannot|Secret을 읽을 수 없어/, { timeout: 20000 })
    } finally {
      await reader.done()
    }
  })

  test('a namespace-limited reader bound to view: unlistable bindings are "cannot check"', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const binding = `e2e-notices-view-${Date.now()}`
    // view lists ServiceAccounts in default but not RoleBindings; the group is kubeast:role:read (the chart allows it)
    kubectl(`-n default create rolebinding ${binding} --clusterrole=view --group=kubeast:role:read`)
    const reader = await tempUser(browser, request, admin, 'nsread', 'Read', ['default'])
    try {
      expect(await (await reader.page.request.get('/api/v1/cluster/namespaces/default/rolebindings?cluster=self')).status()).toBe(403)
      await reader.page.goto('/security/serviceaccounts?cluster=self')
      await reader.page.locator('tbody tr').filter({ hasText: 'default' }).first().click()
      const drawer = reader.page.locator(DRAWER).last()
      await expect(drawer.getByTestId('sa-bindings-unreadable')).toContainText('RoleBinding', { timeout: 20000 })
      await expect(drawer.getByText(/No RoleBinding or ClusterRoleBinding binds|묶는 RoleBinding·ClusterRoleBinding이 없습니다/)).toHaveCount(0)
    } finally {
      await reader.done()
      kubectl(`-n default delete rolebinding ${binding} --ignore-not-found`)
    }
  })

  test('a user with no cluster sees where to ask, and the footer agrees on Settings', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const cfg = await (await request.get('/api/v1/auth/access-requests/config', { headers: admin })).json()
    test.skip(!cfg.help_url, 'auth.accessHelp is not set on this install')
    const member = await tempUser(browser, request, admin, 'member')
    try {
      await member.page.goto('/')
      await expect(member.page.getByTestId('no-accessible-cluster')).toBeVisible({ timeout: 20000 })
      await expect(member.page.getByTestId('access-help')).toContainText(cfg.help_text)
      await expect(member.page.getByTestId('access-help-link')).toHaveAttribute('href', cfg.help_url)

      await member.page.goto('/account')
      await expect(member.page.getByTestId('cluster-status')).toContainText(/No accessible cluster|접근 가능한 클러스터 없음/, { timeout: 20000 })
      await expect(member.page.getByTestId('access-help').first()).toBeVisible()
    } finally {
      await member.done()
    }
  })

  test('a user without access to self opens the console with no "no permission": the feature flags wait for their cluster', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const email = `e2e-notices-noself-${Date.now()}@kubeast.local`
    const password = 'e2e-notices-throwaway'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E notices no self', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } })
    try {
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read' } })).status()).toBe(200)
      expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok(), `login ${email}`).toBeTruthy()
      const page = await ctx.newPage()
      const asked: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/api/v1/cluster/features')) asked.push(new URL(r.url()).searchParams.get('cluster') ?? '')
      })
      await page.goto('/account')
      await expect(page.getByTestId('cluster-picker')).toContainText('default', { timeout: 20000 })
      await expect.poll(() => asked.length, { timeout: 20000 }).toBeGreaterThan(0)
      await page.waitForLoadState('networkidle')
      expect(asked, 'every feature request names the picked cluster').toEqual(asked.map(() => 'default'))
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  // On self, two CRDs of this run with an instance each in a namespace of its run; a ClusterRole aggregated to view
  // lets the Read role list one of them. A Read user's screen names every kind the cluster refuses its identity
  // (X-Kubeast-Access, kubectl auth can-i list -A: this run's other CRD and any view leaves out on self) in the lists'
  // "no permission" words, drawn with the rows from the same answer and the table not moved after, keeps the rows it
  // may list, and the floating chat's screen data names the same kinds; an admin's screen names none.
  test('the custom resource instances screen names the kinds the cluster refuses and keeps the rows of the others', async ({ browser, page, request }) => {
    test.setTimeout(180_000)
    const admin = await adminHeaders(request)
    const run = Date.now().toString(36)
    const ns = `e2e-notices-cr-${run}`
    const labels = { 'kubeast.io/e2e': 'notices' }
    const seen = { kind: 'NoticeSeen', plural: 'noticeseens', group: `seen-${run}.notices.kubeast.io` }
    const hidden = { kind: 'NoticeHidden', plural: 'noticehiddens', group: `hidden-${run}.notices.kubeast.io` }
    type Kind = typeof seen
    const resource = (c: Kind) => `${c.plural}.${c.group}`
    const instance = (c: Kind) => `${c.kind.toLowerCase()}-${run}`
    const crd = (c: Kind) => ({
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: resource(c), labels },
      spec: {
        group: c.group, scope: 'Namespaced', names: { kind: c.kind, plural: c.plural, singular: c.kind.toLowerCase(), listKind: `${c.kind}List` },
        versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } }],
      },
    })
    const viewRole = `e2e-notices-cr-${run}`
    const email = `e2e-notices-crread-${run}@kubeast.local`
    const password = 'e2e-notices-throwaway'
    const row = (p: Page, name: string) => p.locator('main table tbody tr').filter({ hasText: name })
    // a CRD made a moment ago may be served a moment later: the screen is opened again until the instance is listed
    const openListed = async (p: Page, name: string) => {
      let listed = false
      for (let i = 0; i < 6 && !listed; i++) {
        await p.goto('/custom-resources/instances?cluster=self')
        listed = await expect.poll(() => row(p, name).count(), { timeout: 10_000 }).toBe(1).then(() => true, () => false)
      }
      expect(listed, `${name} is listed on ${new URL(p.url()).pathname}`).toBe(true)
      // what the screen shows once it is still (a second with nothing redrawn)
      await p.waitForTimeout(1_000)
    }
    let userId = ''
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    try {
      kubectl('apply -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } },
        crd(seen), crd(hidden),
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: viewRole, labels: { ...labels, 'rbac.authorization.k8s.io/aggregate-to-view': 'true' } },
          rules: [{ apiGroups: [seen.group], resources: [seen.plural], verbs: ['get', 'list', 'watch'] }] },
      ] }))
      kubectl(`wait --for=condition=Established crd/${resource(seen)} crd/${resource(hidden)} --timeout=60s`)
      const instances = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [seen, hidden].map((c) => ({ apiVersion: `${c.group}/v1`, kind: c.kind, metadata: { name: instance(c), namespace: ns, labels } })) })
      // kubectl's discovery may not have the new kinds for a moment
      await expect.poll(() => { try { kubectl('apply -f -', instances); return 'applied' } catch (e) { return String(e).slice(0, 200) } }, { timeout: 30_000 }).toBe('applied')

      const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E notices cr read', email, password } })
      expect(created.status()).toBe(201)
      userId = (await created.json()).id as string
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })).status()).toBe(200)
      expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok(), `login ${email}`).toBeTruthy()
      // whom Kubeast acts as for the user, so the cluster is asked the same question
      const header = (await ctx.request.get('/api/v1/cluster/namespaces?cluster=self')).headers()['x-kubeast-access']
      expect(header, 'X-Kubeast-Access on a cluster answer').toBeTruthy()
      const access = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { user?: string; groups?: string[]; impersonation?: boolean }
      test.skip(access.impersonation !== true, 'impersonation is off: Kubeast lists as its own service account, which the cluster refuses nothing')
      const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-notices-')), 'kubeconfig')
      fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
      const canList = (r: string) => {
        const args = ['--kubeconfig', kc, 'auth', 'can-i', 'list', r, '-A', '--as', access.user ?? '', ...(access.groups ?? []).flatMap((g) => ['--as-group', g])]
        return (spawnSync('kubectl', args, { encoding: 'utf8' }).stdout || '').trim() === 'yes'
      }
      await expect.poll(() => canList(resource(seen)), { timeout: 30_000, message: 'the ClusterRole aggregated to view lets the Read role list NoticeSeen' }).toBe(true)
      expect(canList(resource(hidden)), 'the Read role may not list NoticeHidden').toBe(false)

      // every CRD as the screen names it (the Kind, with its group where another CRD has that Kind); those refused
      const crds = kubectl(`get crd -o jsonpath='{range .items[*]}{.spec.names.kind}{"\\t"}{.spec.group}{"\\t"}{.spec.names.plural}{"\\n"}{end}'`)
        .split('\n').filter(Boolean).map((l) => { const [kind, group, plural] = l.split('\t'); return { kind, group, plural } })
      const label = (c: { kind: string; group: string }) => (crds.some((o) => o.kind === c.kind && o.group !== c.group) ? `${c.kind} (${c.group})` : c.kind)
      const refused = crds.filter((c) => !canList(`${c.plural}.${c.group}`)).map(label).sort()

      // a screen loaded before the answer named these kinds (a tab left open across an upgrade) asks without
      // with_unlisted and still reads the instances alone; the screen of now asks with it
      const instancesAnswer = async (query: string) => (await ctx.request.get(`/api/v1/cluster/custom-resources/all?cluster=self${query}`)).json()
      const plain = await instancesAnswer('')
      expect.soft(Array.isArray(plain) && plain.some((i: { name: string }) => i.name === instance(seen)), 'without with_unlisted: the instances alone, as a screen from before reads them').toBe(true)
      const withUnlisted = await instancesAnswer('&with_unlisted=1')
      expect.soft([...(withUnlisted.forbidden_kinds ?? [])].sort(), 'with_unlisted=1: the kinds the cluster refuses the user').toEqual(refused)

      // an admin: both instances, no notice
      await openListed(page, instance(hidden))
      expect.soft(await row(page, instance(seen)).count(), `an admin lists ${instance(seen)}`).toBe(1)
      expect.soft(await page.getByTestId('cr-instances-notice').count(), 'an admin is refused no kind: no notice').toBe(0)

      // the Read user: every state the screen passes through (instance rows, the notice, where the table's header is)
      const upage = await ctx.newPage()
      await upage.addInitScript(() => {
        type State = { rows: number; notice: boolean; top: number | null }
        const w = window as unknown as { __crStates: State[] }
        w.__crStates = []
        const note = () => {
          const main = document.querySelector('main')
          if (!main) return
          const head = main.querySelector('table thead')
          const state = {
            rows: main.querySelectorAll('table tbody tr.cursor-pointer').length,
            notice: !!main.querySelector('[data-testid="cr-instances-notice"]'),
            top: head ? Math.round(head.getBoundingClientRect().top) : null,
          }
          const last = w.__crStates[w.__crStates.length - 1]
          if (!last || last.rows !== state.rows || last.notice !== state.notice || last.top !== state.top) w.__crStates.push(state)
        }
        new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      })
      const sent = await captureFloating(upage)
      await openListed(upage, instance(seen))
      const said = (await upage.getByTestId('cr-instances-forbidden').allInnerTexts()).join('\n')
      const named = (said.match(FORBIDDEN_EMPTY)?.[1] ?? '').split(', ').filter(Boolean).sort()
      expect.soft(named, `the kinds the notice names ("${said}") = the CRDs the cluster refuses the user (kubectl auth can-i list -A)`).toEqual(refused)
      expect.soft(named.includes(label(hidden)), `the notice names ${label(hidden)}`).toBe(true)
      expect.soft(named.includes(label(seen)), `the notice does not name ${label(seen)}`).toBe(false)
      expect.soft(await row(upage, instance(seen)).count(), `the user lists ${instance(seen)}`).toBe(1)
      expect.soft(await row(upage, instance(hidden)).count(), `no row of ${instance(hidden)}`).toBe(0)
      const states = await upage.evaluate(() => (window as unknown as { __crStates: { rows: number; notice: boolean; top: number | null }[] }).__crStates)
      const drawn = states.filter((s) => s.rows > 0)
      expect.soft(drawn[0]?.notice, `the notice is on screen in the first state with rows, not after them: ${JSON.stringify(states)}`).toBe(true)
      expect.soft([...new Set(drawn.map((s) => s.top))], `the table's header does not move once rows are drawn: ${JSON.stringify(states)}`).toEqual([drawn[0]?.top])

      // the floating chat's screen data: the same kinds
      const asked = await askFloating(upage, sent)
      expect.soft(asked.path, 'the floating chat sent the instances screen').toBe('/custom-resources/instances')
      const data = (asked.base?.data ?? {}) as { forbidden_kinds?: string[] }
      expect.soft([...(data.forbidden_kinds ?? [])].sort(), 'the kinds the floating chat\'s screen data names').toEqual(refused)
    } finally {
      await ctx.close()
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
      kubectl(`delete crd ${resource(seen)} ${resource(hidden)} --ignore-not-found --wait=false`)
      kubectl(`delete clusterrole ${viewRole} --ignore-not-found`)
      kubectl(`delete namespace ${ns} --ignore-not-found --wait=false`)
    }
  })
})
