import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Number check of Advanced Search on cluster `default`: what it loads is each selected type's own list up to the
// limit, as the cluster has it (core Events and events.k8s.io Events are two types of one Kind); a type that fails is
// asked again and reported on every read; a list the server ends with an error partway is a failure, not the limit.
// The Status column is kubectl's STATUS, and a grant limited to namespaces searching All Namespaces loads what its
// identity lists in each of them (one user is made and removed). The expression box offers the objects' fields, not the
// browser's globals.

const SEARCH = { path: '/cluster/search', cluster: 'default' }
const NS = 'e2e-search'
// pods in a namespace of their own: their events would change the Events counts of NS
const NS_PODS = 'e2e-search-b'
// a namespace the grant names but the cluster does not bind it in, and one the cluster does not have
const NS_REFUSED = 'e2e-search-c'
const NS_GONE = 'e2e-search-none'
const READ_GROUP = 'kubeast:role:read'
const LIMIT = 4
const pod = (name: string, spec: object) => JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS_PODS }, spec: { terminationGracePeriodSeconds: 0, ...spec } })
const box = (name: string, command: string[]) => ({ name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command })
const readBinding = (ns: string) => JSON.stringify({
  apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'e2e-search-read', namespace: ns },
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
  subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: READ_GROUP }],
})
const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  ...[1, 2, 3].map((i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-${i}, namespace: ${NS}}\ndata: {n: "${i}"}`),
  ...[1, 2, 3, 4, 5, 6].map((i) => [
    'apiVersion: v1', 'kind: Event', `metadata: {name: e2e-search-${i}, namespace: ${NS}}`,
    `involvedObject: {kind: ConfigMap, name: e2e-search-1, namespace: ${NS}}`,
    'reason: E2ESearch', `message: number check ${i}`, 'type: Normal',
  ].join('\n')),
  ...[NS_PODS, NS_REFUSED].map((ns) => `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${ns}}`),
  `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-b, namespace: ${NS_PODS}}`,
  `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-c, namespace: ${NS_REFUSED}}`,
  readBinding(NS), readBinding(NS_PODS),
  // kubectl prints a STATUS other than the phase for three: Completed (Succeeded), Init:0/1 (Pending), Error (Failed);
  // states that stay, not a restarting container's
  pod('e2e-search-run', { containers: [box('app', ['sleep', '3600'])] }),
  pod('e2e-search-done', { restartPolicy: 'Never', containers: [box('app', ['true'])] }),
  pod('e2e-search-init', { initContainers: [box('wait', ['sleep', '3600'])], containers: [box('app', ['sleep', '3600'])] }),
  pod('e2e-search-failed', { restartPolicy: 'Never', containers: [box('app', ['sh', '-c', 'exit 1'])] }),
].join('\n---\n')

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-numsearch-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

let k: ((a: string, input?: string) => string) | undefined
const count = (type: string) => JSON.parse(k!(`get ${type} -n ${NS} -o json`)).items.length as number

test.beforeAll(() => {
  try { k = kubectlFor('kubeast-b') } catch { return }
  // a run before this one leaves the namespaces terminating: new objects, not their last ones
  k(`delete namespace/${NS} namespace/${NS_PODS} namespace/${NS_REFUSED} --ignore-not-found --timeout=120s`)
  k('apply -f -', FIXTURE)
})

test.afterAll(() => {
  k?.(`delete namespace/${NS} namespace/${NS_PODS} namespace/${NS_REFUSED} --wait=false --ignore-not-found`)
})

// the page with these types chosen (as the picker keeps them) and the namespace picked (none: All Namespaces)
async function open(page: Page, types: string[], ns: string | null = NS) {
  await page.addInitScript((t) => localStorage.setItem('advanced-search-resources', JSON.stringify(t)), types)
  await page.goto(`${SEARCH.path}?cluster=${SEARCH.cluster}`)
  if (ns === null) return
  await page.getByTestId('advanced-search-namespace').click()
  await page.getByRole('button', { name: ns, exact: true }).click()
}

async function typeQuery(page: Page, query: string) {
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type(query)
}

// kubectl get pods' NAME and STATUS (the third column; RESTARTS after it may hold spaces)
const kubectlStatuses = () => Object.fromEntries(k!(`get pods -n ${NS_PODS} --no-headers`).split('\n').map((l) => l.trim().split(/\s+/)).map((f) => [f[0], f[2]]))

// the results table's Name and Status cells
const pageStatuses = async (page: Page) => Object.fromEntries(await page.locator('table tbody tr').evaluateAll((rows) =>
  rows.map((r) => { const td = r.querySelectorAll('td'); return [td[1]?.querySelector('button')?.textContent?.trim() ?? '', td[3]?.textContent?.trim() ?? ''] })))

const loaded = (n: number) => new RegExp(`(^|\\D)${n} items loaded|(^|\\D)${n}개 항목 로드됨`)

test.describe('Number check — Advanced Search loads what the cluster has', () => {
  test.beforeEach(() => { test.skip(!k, 'kind cluster kubeast-b not found') })

  test('core and events.k8s.io Events are two types, each read up to the limit', async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, ['configmaps'])
    // the picker offers both groups' Events and both can be chosen
    const picker = page.getByRole('button', { name: /Select Resources|리소스 선택/ })
    await picker.click()
    await page.getByRole('button', { name: /^(Clear All|선택 해제)$/ }).click()
    await page.getByPlaceholder(/Filter resources|리소스 필터/).fill('Event')
    const events = page.locator('button').filter({ hasText: /^Event$/ })
    await expect(events, 'one Event entry per API group').toHaveCount(2)
    await events.nth(0).click()
    await events.nth(1).click()
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)

    await page.getByRole('button', { name: /^(Settings|설정)$/ }).click()
    await page.locator('input[type="number"]').fill(String(LIMIT))
    await page.getByRole('button', { name: /^(Save|저장)$/ }).click()

    const core = count('events')
    const grouped = count('events.events.k8s.io')
    expect([core, grouped], 'the fixture events through both APIs').toEqual([6, 6])
    const want = Math.min(core, LIMIT) + Math.min(grouped, LIMIT)
    await expect(page.getByText(loaded(want))).toHaveCount(1)
    await expect(page.getByTestId('search-truncated')).toHaveAttribute('title', `events: ${LIMIT} (+${core - LIMIT}), events.events.k8s.io: ${LIMIT} (+${grouped - LIMIT})`)

    // every loaded object matches `true`: the table's range counts them all
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.type('true')
    await expect(page.getByTestId('search-page-info')).toHaveText(new RegExp(`^Showing 1-\\d+ of ${want}$|^${want}개 중 1-\\d+ 표시$`))
  })

  test('a type that fails is asked again on each read and still reported', async ({ page }) => {
    // the reads of each type in the namespace: the page reads all namespaces first, then the one picked
    const asked = { configmaps: 0, nosuchthings: 0 }
    page.on('request', (r) => {
      const u = new URL(r.url())
      const type = u.searchParams.get('resource_type') as keyof typeof asked
      if (u.pathname === '/api/v1/cluster/resources' && u.searchParams.get('namespace') === NS && type in asked) asked[type]++
    })
    await open(page, ['configmaps', 'nosuchthings'])
    await expect(page.getByText(loaded(count('configmaps')))).toHaveCount(1)
    expect(asked, 'both types read in the namespace picked after a failure').toEqual({ configmaps: 1, nosuchthings: 1 })
    const failed = page.getByTestId('search-failed')
    await expect(failed).toHaveText(/^(1 failed|1개 실패)$/)
    await expect(failed).toHaveAttribute('title', /^nosuchthings: /)

    await page.getByRole('button', { name: /^(Refresh|새로고침)$/ }).click()
    await expect.poll(() => asked.configmaps).toBe(2)
    await expect.poll(() => asked.nosuchthings, 'the failed type is asked again').toBe(2)
    await expect(failed).toHaveText(/^(1 failed|1개 실패)$/)
  })

  test('a list the server ends with an error partway is a failure with what it read, not the limit', async ({ page }) => {
    const message = 'the provided continue parameter is too old to display a consistent list result'
    // the server's answer when a later page fails (writeRawList): the objects so far, truncated and error
    await page.route((u) => u.pathname === '/api/v1/cluster/resources' && u.searchParams.get('resource_type') === 'configmaps', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, truncated: true, error: message } })
    })
    await open(page, ['configmaps'])
    const read = count('configmaps')
    await expect(page.getByText(loaded(read))).toHaveCount(1)
    await expect(page.getByTestId('search-truncated')).toHaveCount(0)
    await expect(page.getByTestId('search-failed')).toHaveText(/^(1 failed|1개 실패)$/)
    await expect(page.getByTestId('search-failed')).toHaveAttribute('title', new RegExp(`^configmaps: (stopped after ${read}|${read}개를 읽은 뒤 멈춤): ${message}$`))
  })

  test("the Status column is kubectl's STATUS, not the pod's phase", async ({ page }) => {
    test.setTimeout(120_000)
    // the pods settle; kubectl's STATUS turns before the phase does, so both are waited for
    const phases = () => Object.fromEntries(JSON.parse(k!(`get pods -n ${NS_PODS} -o json`)).items.map((p: { metadata: { name: string }; status: { phase: string } }) => [p.metadata.name, p.status.phase]))
    await expect.poll(() => ({ status: kubectlStatuses(), phase: phases() }), { timeout: 90_000, intervals: [2_000] }).toEqual({
      status: { 'e2e-search-run': 'Running', 'e2e-search-done': 'Completed', 'e2e-search-init': 'Init:0/1', 'e2e-search-failed': 'Error' },
      // what the column showed before
      phase: { 'e2e-search-run': 'Running', 'e2e-search-done': 'Succeeded', 'e2e-search-init': 'Pending', 'e2e-search-failed': 'Failed' },
    })
    await open(page, ['pods'], NS_PODS)
    await expect(page.getByText(loaded(4))).toHaveCount(1)
    await typeQuery(page, 'true')
    await expect(page.getByTestId('search-page-info')).toHaveText(/ of 4$|^4개 중 /)
    expect(await pageStatuses(page)).toEqual(kubectlStatuses())
  })

  test('a grant limited to namespaces searching All Namespaces loads what its identity lists in each', async ({ browser, request }) => {
    test.setTimeout(90_000)
    const admin = process.env.E2E_USER_EMAIL || 'admin'
    const login = async (email: string, password: string) => {
      const res = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
      return (await res.json()).access_token as string
    }
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
    const adminToken = await login(admin, process.env.E2E_USER_PASSWORD || '')
    const id = Date.now().toString(36)
    const email = `e2e-search-scoped-${id}@kubeast.local`
    const password = `search-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(adminToken), data: { name: `E2E search ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = madeUser((await created.json()).id, bearer(adminToken))
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      const grant = { role: 'Read', namespaces: [NS, NS_PODS, NS_REFUSED, NS_GONE] }
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${SEARCH.cluster}`, { headers: bearer(adminToken), data: grant })
      expect(put.ok(), await put.text()).toBeTruthy()

      // what the identity Kubeast acts as lists in each namespace of the grant (a refusal lists nothing)
      const as = `--as=${email} --as-group=kubeast:authenticated --as-group=${READ_GROUP}`
      const want = (type: string) => grant.namespaces.flatMap((ns) => {
        try {
          return (JSON.parse(k!(`get ${type} -n ${ns} ${as} -o json`)).items as { metadata: { namespace: string; name: string } }[]).map((o) => `${o.metadata.namespace}/${o.metadata.name}`)
        } catch { return [] }
      }).sort()
      expect(() => k!(`get configmaps -n ${NS_REFUSED} ${as}`), 'the cluster refuses the grant one of its namespaces').toThrow(/forbidden/)

      const page = await ctx.newPage()
      const got: Record<string, string[]> = {}
      const scopes = new Set<string | null>()
      page.on('response', async (r) => {
        const u = new URL(r.url())
        if (u.pathname !== '/api/v1/cluster/resources' || !r.ok()) return
        scopes.add(u.searchParams.get('all_namespaces'))
        const body = await r.json()
        got[u.searchParams.get('resource_type')!] = (body.items as { metadata: { namespace: string; name: string } }[]).map((o) => `${o.metadata.namespace}/${o.metadata.name}`).sort()
      })
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await open(page, ['configmaps', 'pods'], null)
      const configmaps = want('configmaps')
      const pods = want('pods')
      expect(configmaps.length * pods.length, 'the identity lists something in its namespaces').toBeGreaterThan(0)
      await expect(page.getByText(loaded(configmaps.length + pods.length))).toHaveCount(1, { timeout: 30_000 })
      await expect(page.getByTestId('search-failed'), 'no type failed').toHaveCount(0)
      await expect.poll(() => got).toEqual({ configmaps, pods })
      expect([...scopes], 'read as All Namespaces').toEqual(['true'])
      await typeQuery(page, 'true')
      await expect(page.getByTestId('search-page-info')).toHaveText(new RegExp(` of ${configmaps.length + pods.length}$|^${configmaps.length + pods.length}개 중 `))
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(adminToken) })
    }
  })
})

// Accounts made by the tests above are deleted after each test as well: a test that times out has its request context
// ended before its own finally runs, so the delete there never reaches the server. A second delete answers 404.
const madeUsers: { id: string; headers: Record<string, string> }[] = []
function madeUser<T>(id: T, headers: Record<string, string>): T {
  madeUsers.push({ id: String(id), headers })
  return id
}
test.afterEach(async ({ request }) => {
  for (const { id, headers } of madeUsers.splice(0)) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers, failOnStatusCode: false })
})

// The examples and the expressions the search cannot read, on objects of a namespace of their own (made in the test,
// deleted after it): a ConfigMap with data and one without, beside the kube-root-ca.crt the cluster puts in every namespace.
const NS_DATA = 'e2e-search-d'
const madeNamespaces: string[] = []
test.afterEach(() => {
  for (const ns of madeNamespaces.splice(0)) k?.(`delete namespace/${ns} --wait=false --ignore-not-found`)
})

test.describe('Advanced Search examples and expressions it cannot read', () => {
  test.beforeEach(() => { test.skip(!k, 'kind cluster kubeast-b not found') })

  test('the example "ConfigMaps that carry data" finds the ConfigMaps kubectl lists with data, and no other', async ({ page }) => {
    test.setTimeout(180_000)
    k!(`delete namespace/${NS_DATA} --ignore-not-found --timeout=120s`)
    madeNamespaces.push(NS_DATA)
    k!('apply -f -', [
      `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS_DATA}}`,
      `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-data, namespace: ${NS_DATA}}\ndata: {n: "1"}`,
      `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: e2e-search-empty, namespace: ${NS_DATA}}`,
    ].join('\n---\n'))
    const listed = () => JSON.parse(k!(`get configmaps -n ${NS_DATA} -o json`)).items as { metadata: { name: string }; data?: unknown }[]
    await expect.poll(() => listed().map((c) => c.metadata.name).sort(), { timeout: 30_000 }).toEqual(['e2e-search-data', 'e2e-search-empty', 'kube-root-ca.crt'])
    const withData = listed().filter((c) => c.data != null).map((c) => c.metadata.name).sort()
    expect(withData, 'kubectl lists data on the ConfigMap made with it and on kube-root-ca.crt').toEqual(['e2e-search-data', 'kube-root-ca.crt'])

    await open(page, ['configmaps'], NS_DATA)
    await expect(page.getByText(loaded(3))).toHaveCount(1)
    const example = page.locator('button').filter({ hasText: /ConfigMaps that carry data|data가 있는 ConfigMap/ })
    await expect(example.locator('code')).toHaveText('data != null')
    await example.click()
    await expect(page.getByTestId('search-page-info')).toHaveText(new RegExp(` of ${withData.length}$|^${withData.length}개 중 `))
    const found = Object.keys(await pageStatuses(page)).sort()
    expect(found).toEqual(withData)
    expect(found, 'the ConfigMap without data').not.toContain('e2e-search-empty')
  })

  test('an expression the search cannot compute says why in place of the results, with no count and no rows', async ({ page }) => {
    await open(page, ['configmaps'])
    await expect(page.getByText(loaded(count('configmaps')))).toHaveCount(1)
    // simple-eval refuses a unary operator on a unary operator, whatever the objects hold
    await typeQuery(page, '!!data')
    await expect(page.getByTestId('search-unreadable')).toHaveText(/^(The expression could not be read|표현식을 읽지 못했습니다): Unexpected operator$/)
    await expect(page.getByText(/\d+ results?\b|\d+건 결과/), 'no "N results" line').toHaveCount(0)
    await expect(page.locator('table tbody tr'), 'no result rows').toHaveCount(0)
    await expect(page.getByTestId('search-page-info')).toHaveCount(0)
    await expect(page.getByText(/No resources match your query|쿼리에 일치하는 리소스가 없습니다/)).toHaveCount(0)
  })

  test('the expression box offers the fields of the objects read and no browser global', async ({ page }) => {
    await open(page, ['configmaps'])
    await expect(page.getByText(loaded(count('configmaps')))).toHaveCount(1)
    const widget = page.locator('.suggest-widget')
    const offered = () => widget.locator('.monaco-list-row:visible .label-name').allTextContents()
    // every ConfigMap read has metadata, which the box offers from the objects read (inferTypes)
    await typeQuery(page, 'metad')
    await page.keyboard.press('Control+Space')
    await expect.poll(offered, { timeout: 20_000 }).toContain('metadata')
    // TextTrack, TextTrackCue, TextTrackCueList and TextTrackList are the browser's own: the box offered them here while
    // it ran on the browser's library, and an expression names only what the objects hold (simple-eval)
    await page.keyboard.type(' || TextTrack')
    await page.keyboard.press('Control+Space')
    await expect(widget.locator('.message'), 'the box answered with nothing to offer').toHaveText('No suggestions.', { timeout: 20_000 })
    expect(await offered(), 'no browser global offered').toEqual([])
  })
})
