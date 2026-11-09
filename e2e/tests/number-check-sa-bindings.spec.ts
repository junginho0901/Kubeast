import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A ServiceAccount drawer's Effective Permissions on self count what the API server applies to it, the subjects a pod's RBAC
// tab matches: the ServiceAccount itself, its user name, the group of every ServiceAccount and of its namespace. Compared with
// kubectl's bindings and with what `kubectl auth can-i` as that ServiceAccount allows through each.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const PAUSE = 'registry.k8s.io/pause:3.10'
const RBAC = 'rbac.authorization.k8s.io'
const stamp = Date.now().toString(36)
const NS = `e2e-sa-bindings-${stamp}`
const SA = 'bot'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type Subject = { kind: string; name: string; namespace?: string; apiGroup?: string }
type Binding = { metadata: { name: string; namespace?: string }; roleRef: { kind: string; name: string }; subjects?: Subject[] }

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sa-bindings-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[], input?: string) => execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const group = (name: string): Subject => ({ kind: 'Group', apiGroup: RBAC, name })
const user = (name: string): Subject => ({ kind: 'User', apiGroup: RBAC, name })
const itself: Subject = { kind: 'ServiceAccount', name: SA, namespace: NS }

// name → subject, what it means for the ServiceAccount, and the one resource its role lets it list
const BINDINGS: Array<{ name: string; subject: Subject; applies: boolean; matchedBy?: string; resource: string }> = [
  { name: 'by-itself', subject: itself, applies: true, resource: 'configmaps' },
  { name: 'by-user', subject: user(`system:serviceaccount:${NS}:${SA}`), applies: true, matchedBy: `User system:serviceaccount:${NS}:${SA}`, resource: 'secrets' },
  { name: 'by-namespace-group', subject: group(`system:serviceaccounts:${NS}`), applies: true, matchedBy: `Group system:serviceaccounts:${NS}`, resource: 'services' },
  { name: 'by-all-group', subject: group('system:serviceaccounts'), applies: true, matchedBy: 'Group system:serviceaccounts', resource: 'endpoints' },
  { name: 'other-namespace-group', subject: group(`system:serviceaccounts:${NS}-other`), applies: false, resource: 'pods' },
  { name: 'other-user', subject: user(`system:serviceaccount:${NS}:other`), applies: false, resource: 'events' },
  { name: 'everyone', subject: group('system:authenticated'), applies: false, resource: 'limitranges' },
]

// A ClusterRole of URL and resource rules bound to the ServiceAccount itself; URLs of this run, so nothing else grants them.
const URLS = `${NS}-urls`
const URL_RULE = [`/e2e-sa-urls-${stamp}`, `/e2e-sa-urls-${stamp}/*`]
// Another ClusterRole with URLs of its own, bound to it by a RoleBinding only: no URL, as the API server reads a RoleBinding.
const RB_URLS = `${NS}-rb-urls`
const RB_URL_RULE = [`/e2e-sa-rb-urls-${stamp}`]
const RB_URLS_BINDING = 'urls-by-rolebinding'
const RB_URL_NOTE = 'Not in effect through a RoleBinding; URLs need a ClusterRoleBinding.'
const LABEL = 'kubeast.io/e2e=sa-bindings'
const removeClusterObjects = () => kubectl(['delete', 'clusterrolebinding,clusterrole', '-l', LABEL, '--ignore-not-found', '--wait=false'])

function makeFixture() {
  removeClusterObjects()
  kubectl(['create', 'namespace', NS])
  kubectl(['-n', NS, 'create', 'serviceaccount', SA])
  const objects = BINDINGS.flatMap((b) => [
    { apiVersion: `${RBAC}/v1`, kind: 'Role', metadata: { name: b.name, namespace: NS }, rules: [{ apiGroups: [''], resources: [b.resource], verbs: ['list'] }] },
    { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: b.name, namespace: NS }, roleRef: { apiGroup: RBAC, kind: 'Role', name: b.name }, subjects: [b.subject] },
  ])
  kubectl(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }))
  const labels = { 'kubeast.io/e2e': 'sa-bindings' }
  kubectl(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRole', metadata: { name: URLS, labels }, rules: [
      { nonResourceURLs: URL_RULE, verbs: ['get'] },
      { apiGroups: [''], resources: ['nodes'], verbs: ['get'] },
    ] },
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRoleBinding', metadata: { name: URLS, labels }, roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: URLS }, subjects: [itself] },
    { apiVersion: `${RBAC}/v1`, kind: 'ClusterRole', metadata: { name: RB_URLS, labels }, rules: [
      { nonResourceURLs: RB_URL_RULE, verbs: ['get'] },
      { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['list'] },
    ] },
    { apiVersion: `${RBAC}/v1`, kind: 'RoleBinding', metadata: { name: RB_URLS_BINDING, namespace: NS }, roleRef: { apiGroup: RBAC, kind: 'ClusterRole', name: RB_URLS }, subjects: [itself] },
  ] }))
  // Its pod's RBAC tab reads the same ServiceAccount; no node has to run it.
  kubectl(['create', '-f', '-'], JSON.stringify({
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'uses-bot', namespace: NS },
    spec: { serviceAccountName: SA, automountServiceAccountToken: false, containers: [{ name: 'app', image: PAUSE }] },
  }))
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

// The section as it reads now: its title, its cards and whether another page follows; clickNext also turns the page.
function readSection(page: Page, clickNext = false) {
  return page.locator(DRAWER).last().evaluate((root, clickNext) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const sec = [...root.querySelectorAll('div.rounded-lg.border')].find((s) => {
      const t = s.firstElementChild?.firstElementChild
      return !!t && t.tagName === 'P' && txt(t).startsWith('Effective Permissions')
    })
    if (!sec) return null
    const pager = [...sec.querySelectorAll('span')].find((s) => /^\d+-\d+ \/ \d+$/.test(txt(s)))
    const next = pager ? [...(pager.parentElement?.querySelectorAll('button') ?? [])].find((b) => txt(b) === 'Next') as HTMLButtonElement | undefined : undefined
    if (next && !next.disabled && clickNext) next.click()
    return {
      title: txt(sec.firstElementChild!.firstElementChild!),
      cards: [...sec.querySelectorAll('div.rounded-sm.border.p-2')].map((c) => {
        const matched = c.querySelector('[data-testid="sa-binding-matched-by"]')
        const rows = [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(txt))
        return { head: txt(c.firstElementChild!), matchedBy: matched ? txt(matched) : null, rows }
      }),
      rulesLoading: [...sec.querySelectorAll('div.rounded-sm.border.p-2')].some((c) => txt(c).includes('Loading rules')),
      pager: pager ? txt(pager) : null,
      more: !!next && !next.disabled,
    }
  }, clickNext)
}

// Every card, page by page, once the title has its count (the rules load after the bindings).
async function readCards(page: Page) {
  await expect.poll(async () => (await readSection(page))?.title, { timeout: 30_000 }).toMatch(/^Effective Permissions \(\d+ bindings?\)$/)
  const rulesShown = () => expect.poll(async () => (await readSection(page))?.rulesLoading, { timeout: 30_000 }).toBe(false)
  await rulesShown()
  let read = (await readSection(page))!
  const title = read.title
  const cards = [...read.cards]
  while (read.more) {
    const pager = read.pager
    await readSection(page, true)
    await expect.poll(async () => (await readSection(page))?.pager, { timeout: 10_000 }).not.toBe(pager)
    await rulesShown()
    read = (await readSection(page))!
    cards.push(...read.cards)
  }
  return { title, cards }
}

test.describe('number check — a ServiceAccount drawer counts what applies to it', () => {
  test.beforeAll(makeFixture)

  test.afterAll(() => {
    kubectl(['delete', 'namespace', NS, '--wait=false', '--ignore-not-found'])
    removeClusterObjects()
  })

  test('the bindings of every subject the API server reads as it', async ({ page, request }) => {
    test.setTimeout(180_000)
    const namespaced: Binding[] = JSON.parse(kubectl(['-n', NS, 'get', 'rolebindings', '-o', 'json'])).items
    const cluster: Binding[] = JSON.parse(kubectl(['get', 'clusterrolebindings', '-o', 'json'])).items
    const allGroups = new Set(['system:serviceaccounts', `system:serviceaccounts:${NS}`])
    const applies = (b: Binding) => (b.subjects ?? []).some((s) =>
      (s.kind === 'ServiceAccount' && s.name === SA && (s.namespace || b.metadata.namespace) === NS) ||
      (s.kind === 'User' && s.name === `system:serviceaccount:${NS}:${SA}`) ||
      (s.kind === 'Group' && allGroups.has(s.name)))
    const want = [...namespaced, ...cluster].filter(applies)
    expect(want.map((b) => b.metadata.name), 'the fixture\'s bindings that apply').toEqual(expect.arrayContaining(BINDINGS.filter((b) => b.applies).map((b) => b.name)))
    for (const b of BINDINGS.filter((x) => !x.applies)) expect(want.map((x) => x.metadata.name)).not.toContain(b.name)

    // what the API server itself says of the fixture's bindings
    const asBot = `system:serviceaccount:${NS}:${SA}`
    const canList = (resource: string) => {
      try {
        return kubectl(['auth', 'can-i', 'list', resource, '-n', NS, `--as=${asBot}`, '--as-group=system:serviceaccounts', `--as-group=system:serviceaccounts:${NS}`])
      } catch {
        return 'no'
      }
    }
    for (const b of BINDINGS.filter((x) => x.name !== 'everyone')) {
      expect(canList(b.resource), `${b.name} lets it list ${b.resource}`).toBe(b.applies ? 'yes' : 'no')
    }
    const canGet = (url: string) => {
      try {
        return kubectl(['auth', 'can-i', 'get', url, `--as=${asBot}`, '--as-group=system:serviceaccounts', `--as-group=system:serviceaccounts:${NS}`])
      } catch {
        return 'no'
      }
    }
    expect(canGet(URL_RULE[0]), `${URLS} lets it get its URL`).toBe('yes')
    expect(canGet(`/e2e-sa-urls-${stamp}-other`), 'and no URL it does not name').toBe('no')
    expect(canList('persistentvolumeclaims'), `${RB_URLS_BINDING} applies to it`).toBe('yes')
    expect(canGet(RB_URL_RULE[0]), `${RB_URLS_BINDING} gives it no URL of ${RB_URLS}`).toBe('no')

    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`ServiceAccount/${NS}/${SA}`)}`)
    await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
    const { title, cards } = await readCards(page)
    expect(title).toBe(`Effective Permissions (${want.length} bindings)`)
    expect(cards.map((c) => c.head).sort()).toEqual(want.map((b) => `via ${b.metadata.name} → ${b.roleRef.name}`).sort())
    for (const b of BINDINGS.filter((x) => x.applies)) {
      const card = cards.find((c) => c.head === `via ${b.name} → ${b.name}`)
      expect(card?.matchedBy ?? null, b.name).toBe(b.matchedBy ? `Applies through ${b.matchedBy}` : null)
      // the Role's one rule, its core group written "" as the Role drawer writes it, no URL
      expect(card?.rows, `${b.name} rules`).toEqual([['""', b.resource, '-', 'list', '-']])
    }
    // the URLs a rule names in their own column, as kubectl describe's Non-Resource URLs, the resource rule beside it "-" there
    const urlCard = cards.find((c) => c.head === `via ${URLS} → ${URLS}`)
    expect(urlCard?.rows, `${URLS} rules`).toEqual([['-', '-', URL_RULE.join(', '), 'get', '-'], ['""', 'nodes', '-', 'get', '-']])
    // the same through a RoleBinding: the row of URLs says they are not in effect, the resource row beside it nothing
    const rbUrlCard = cards.find((c) => c.head === `via ${RB_URLS_BINDING} → ${RB_URLS}`)
    expect(rbUrlCard?.rows, `${RB_URLS_BINDING} rules`).toEqual([['-', '-', `${RB_URL_RULE.join(', ')} ${RB_URL_NOTE}`, 'get', '-'], ['""', 'persistentvolumeclaims', '-', 'list', '-']])

    // The pod's RBAC tab counts the same bindings.
    const admin = await login(request)
    const rbac = await (await request.get(`/api/v1/cluster/namespaces/${NS}/pods/uses-bot/rbac?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    const onTab = [...rbac.role_bindings, ...rbac.cluster_role_bindings].map((b: { name: string }) => b.name).sort()
    expect(onTab).toEqual(want.map((b) => b.metadata.name).sort())
  })
})
