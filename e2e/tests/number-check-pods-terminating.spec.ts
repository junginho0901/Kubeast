import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The Pods list while pods are being deleted, on cluster self: the Status and READY columns are what kubectl prints,
// each pod is in one state card so that the cards add up to the total (Restarted is what a pod went through, not a
// state), the drawer and the floating chat say the same, and a reader limited to a namespace counts that namespace's
// pods only. A pod stays Terminating here because its command ignores SIGTERM under a long grace period, and a
// finished one because a finalizer holds it; both are removed after.

const CLUSTER = 'self'
const RUN = Date.now().toString(36)
const NS = `e2e-podterm-${RUN}`
const OTHER = `e2e-podterm-o-${RUN}`
const LABEL = 'kubeast.io/e2e=pods-terminating'
const HOLD = 'kubeast.io/e2e-hold'
const RBAC = `e2e-podterm-${RUN}`
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-podterm-pass1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-podterm-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const k = kubectlFor('kubeast')
const tryK = (args: string) => { try { return k(args) } catch { return null } }

const IGNORES_TERM = ['sh', '-c', "trap '' TERM; while true; do sleep 1; done"]
const box = (name: string, command: string[], more: object = {}) => ({ name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command, ...more })
const pod = (ns: string, name: string, spec: object, finalizers: string[] = []) => JSON.stringify({
  apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, finalizers }, spec: { terminationGracePeriodSeconds: 600, ...spec },
})
const NEVER_READY = { readinessProbe: { exec: { command: ['false'] }, periodSeconds: 2 } }
const namespace = (name: string) => `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${name}, labels: {kubeast.io/e2e: pods-terminating}}`
const FIXTURE = [
  namespace(NS),
  namespace(OTHER),
  pod(NS, 'stay-ready', { containers: [box('app', IGNORES_TERM)] }),
  pod(NS, 'stay-unready', { containers: [box('app', IGNORES_TERM, NEVER_READY)] }),
  pod(NS, 'term-ready', { containers: [box('app', IGNORES_TERM)] }),
  pod(NS, 'term-unready', { containers: [box('app', IGNORES_TERM, NEVER_READY)] }),
  pod(NS, 'term-init', { initContainers: [box('wait', IGNORES_TERM)], containers: [box('app', IGNORES_TERM)] }),
  pod(NS, 'gated', { schedulingGates: [{ name: 'kubeast.io/e2e-gate' }], containers: [box('app', IGNORES_TERM)] }),
  pod(NS, 'no-image', { containers: [{ name: 'app', image: 'registry.invalid/e2e/none:1' }] }),
  pod(NS, 'done-held', { restartPolicy: 'Never', containers: [box('app', ['true'])] }, [HOLD]),
  pod(NS, 'fail-held', { restartPolicy: 'Never', containers: [box('app', ['sh', '-c', 'exit 1'])] }, [HOLD]),
  pod(OTHER, 'other-going', { containers: [box('app', IGNORES_TERM)] }),
].join('\n---\n')

// what a stopped run may have left too: held pods let go and waiting pods forced, so the namespaces can go
function removeRuns() {
  const list = tryK(`get namespaces -l ${LABEL} -o jsonpath={.items[*].metadata.name}`) ?? ''
  for (const ns of list.split(/\s+/).filter(Boolean)) {
    for (const name of ['done-held', 'fail-held']) tryK(`-n ${ns} patch pod ${name} --type=merge -p '{"metadata":{"finalizers":null}}'`)
    tryK(`-n ${ns} delete pods --all --grace-period=0 --force --wait=false`)
    tryK(`delete namespace ${ns} --ignore-not-found --wait=false`)
  }
}

interface KPod { metadata: { name: string; deletionTimestamp?: string }; status: { phase?: string } }
const clusterPods = (ns: string): KPod[] => JSON.parse(k(`-n ${ns} get pods -o json`)).items
// NAME READY STATUS as kubectl prints them
const printed = (ns: string) => {
  const out: Record<string, { ready: string; status: string }> = {}
  for (const line of k(`-n ${ns} get pods --no-headers`).split('\n').filter(Boolean)) {
    const [name, ready, status] = line.trim().split(/\s+/)
    out[name] = { ready, status }
  }
  return out
}
const statuses = (ns: string) => Object.fromEntries(Object.entries(printed(ns)).map(([name, p]) => [name, p.status]))

const CARDS: Record<string, RegExp> = {
  Total: /^(Total|전체)$/, Ready: /^(Ready|준비됨)$/, 'Not Ready': /^(Not Ready|준비 안 됨)$/, Pending: /^(Pending|대기)$/, Terminating: /^Terminating$/,
  Error: /^(Error|오류)$/, Restarted: /^(Restarted|재시작 이력)$/, Completed: /^(Completed|완료)$/,
}
const card = async (page: Page, label: RegExp) =>
  Number(await page.locator('div.rounded-lg.border').filter({ has: page.getByText(label) }).locator('.text-lg').first().innerText())
const screenCards = async (page: Page) => {
  const out: Record<string, number> = {}
  for (const [name, label] of Object.entries(CARDS)) out[name] = await card(page, label)
  return out
}
// the card each pod is in, from what kubectl prints and the object's phase
const wantCards = (ns: string) => {
  const lines = printed(ns)
  const out: Record<string, number> = { Total: 0, Ready: 0, 'Not Ready': 0, Pending: 0, Terminating: 0, Error: 0, Restarted: 0, Completed: 0 }
  for (const p of clusterPods(ns)) {
    const { ready, status } = lines[p.metadata.name]
    const [have, all] = ready.split('/').map(Number)
    out.Total++
    if (p.status.phase === 'Failed' || /error|failed|backoff|errimagepull|oomkilled/i.test(status)) out.Error++
    else if (status === 'Terminating') out.Terminating++
    else if (p.status.phase === 'Pending') out.Pending++
    else if (p.status.phase === 'Succeeded') out.Completed++
    else if (p.status.phase === 'Running' && !p.metadata.deletionTimestamp && all > 0 && have === all) out.Ready++
    else out['Not Ready']++
  }
  return out
}
const cardSum = (c: Record<string, number>) => c.Ready + c['Not Ready'] + c.Pending + c.Terminating + c.Error + c.Completed

const screenRows = (page: Page) => page.locator('table tbody tr.cursor-pointer').evaluateAll((trs) => Object.fromEntries(trs.map((tr) => {
  const cells = [...(tr as HTMLTableRowElement).cells].map((td) => td.innerText.trim())
  return [cells[0], { ready: cells[1], status: cells[2] }]
})))

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Pods being deleted', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    removeRuns()
    k('apply -f -', FIXTURE)
    const deadline = Date.now() + 180_000
    const settled = () => {
      const p = printed(NS)
      const running = (name: string, ready: string) => p[name]?.status === 'Running' && p[name]?.ready === ready
      return running('stay-ready', '1/1') && running('term-ready', '1/1') && running('stay-unready', '0/1') && running('term-unready', '0/1') &&
        p['term-init']?.status === 'Init:0/1' && p.gated?.status === 'SchedulingGated' && /ErrImagePull|ImagePullBackOff/.test(p['no-image']?.status ?? '') &&
        p['done-held']?.status === 'Completed' && p['fail-held']?.status === 'Error' && printed(OTHER)['other-going']?.status === 'Running'
    }
    while (!settled()) {
      if (Date.now() > deadline) throw new Error(`fixture did not settle: ${JSON.stringify(printed(NS))}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
    k(`-n ${NS} delete pod term-ready term-unready term-init done-held fail-held --wait=false`)
    k(`-n ${OTHER} delete pod other-going --wait=false`)
    await expect.poll(() => statuses(NS), { timeout: 30_000 }).toMatchObject({ 'term-ready': 'Terminating', 'term-unready': 'Terminating', 'term-init': 'Terminating', 'done-held': 'Completed', 'fail-held': 'Error' })
  })

  test.afterAll(() => removeRuns())

  test('the rows are what kubectl prints and the cards add up to the total', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}`)
    await expect.poll(() => screenRows(page), { timeout: 20_000 }).toEqual(printed(NS))
    // the words themselves, so a kubectl that printed something else would not pass unseen
    expect(statuses(NS)).toMatchObject({
      'stay-ready': 'Running', 'stay-unready': 'Running', 'term-ready': 'Terminating', 'term-unready': 'Terminating', 'term-init': 'Terminating',
      gated: 'SchedulingGated', 'done-held': 'Completed', 'fail-held': 'Error',
    })
    await expect.poll(() => screenCards(page), { timeout: 20_000 }).toEqual(wantCards(NS))
    const cards = await screenCards(page)
    expect(cards).toEqual({ Total: 9, Ready: 1, 'Not Ready': 1, Pending: 1, Terminating: 3, Error: 2, Restarted: 0, Completed: 1 })
    expect(cardSum(cards)).toBe(cards.Total)
    // a pod being deleted is drawn as a warning, the colour Cluster View gives it
    await expect(page.locator('table tbody tr.cursor-pointer').filter({ hasText: 'term-ready' }).locator('td').nth(2).locator('.badge')).toHaveClass(/badge-warning/)
    await expect(page.getByText('Terminating: 3', { exact: true })).toHaveCount(1) // Top status reasons

    // one more deleted while the page is open: within a poll it leaves Ready for Terminating
    k(`-n ${NS} delete pod stay-ready --wait=false`)
    await expect.poll(() => screenCards(page), { timeout: 20_000 }).toEqual({ Total: 9, Ready: 0, 'Not Ready': 1, Pending: 1, Terminating: 4, Error: 2, Restarted: 0, Completed: 1 })
    await expect.poll(() => screenRows(page), { timeout: 20_000 }).toEqual(printed(NS))
  })

  test('the Pod drawer\'s Status tile says what the row says', async ({ page }) => {
    for (const [name, want] of [['term-ready', 'Terminating'], ['term-init', 'Terminating'], ['gated', 'SchedulingGated'], ['done-held', 'Completed']] as const) {
      expect(statuses(NS)[name]).toBe(want)
      await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${name}`)}`)
      const tile = page.locator('div.rounded-sm.border').filter({ has: page.getByText(/^(Status|상태)$/) }).first().locator('div').nth(1)
      await expect(tile).toHaveText(want, { timeout: 20_000 })
    }
  })

  test('the floating chat is told the cards', async ({ page }) => {
    const sent: { base?: { data?: { stats?: Record<string, unknown> } } | null }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-podterm-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-podterm-ctx-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-podterm-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-podterm-ctx-\d+\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    const ask = async () => {
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()
      const before = sent.length
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length).toBe(before + 1)
      await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
      return sent[sent.length - 1].base?.data?.stats
    }
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}`)
    await expect.poll(() => screenCards(page), { timeout: 20_000 }).toEqual(wantCards(NS))
    const want = wantCards(NS)
    await expect.poll(ask, { timeout: 20_000 }).toMatchObject({
      total: want.Total, ready: want.Ready, not_ready: want['Not Ready'], pending: want.Pending, terminating: want.Terminating, error: want.Error, completed: want.Completed,
    })
  })

  test('a reader limited to a namespace counts that namespace\'s pods only', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-podterm-${RUN}@kubeast.local`
    let userId = ''
    const pageAs = (token: string, q: string) => request.get(`/api/v1/cluster/pods/page?cluster=${CLUSTER}&limit=50${q}`, { headers: bearer(token), failOnStatusCode: false })
    try {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E pods terminating', email, password: PW, role_id: member.id } })
      expect(created.status(), `create ${email}`).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })
      expect(grant.status(), await grant.text()).toBe(200)
      k(`create clusterrole ${RBAC}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:read`)
      k(`create clusterrolebinding ${RBAC}-imp --clusterrole=${RBAC}-imp --serviceaccount=kubeast:k8s-service`)
      k(`-n ${NS} create rolebinding ${RBAC}-view --clusterrole=view --group=kubeast:role:read`)
      const user = await login(request, email, PW)

      // every namespace it may see: this one's pods, with the pod being deleted in the other namespace left out
      const want = wantCards(NS)
      await expect.poll(async () => {
        const res = await pageAs(user, '')
        if (!res.ok()) return `${res.status()}`
        const { stats, items } = await res.json()
        return { total: stats.total, terminating: stats.terminating, sum: stats.ready + stats.not_ready + stats.pending + stats.terminating + stats.error + stats.completed, other: (items as { namespace: string }[]).filter((i) => i.namespace !== NS).length }
      }, { timeout: 30_000 }).toEqual({ total: want.Total, terminating: want.Terminating, sum: want.Total, other: 0 })
      const outside = await pageAs(user, `&namespace=${OTHER}`)
      expect(outside.status()).toBe(403)

      // the other namespace has one, which the admin sees there
      const adminOther = await (await pageAs(admin, `&namespace=${OTHER}`)).json()
      expect({ total: adminOther.stats.total, terminating: adminOther.stats.terminating }).toEqual({ total: 1, terminating: 1 })
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      tryK(`delete clusterrolebinding ${RBAC}-imp --ignore-not-found`)
      tryK(`delete clusterrole ${RBAC}-imp --ignore-not-found`)
    }
  })

  // Last in the file: its ReplicaSet adds pods to the namespace the tests above count.
  test('a pod table left open in a workload drawer says Terminating once kubectl does', async ({ page }) => {
    test.setTimeout(180_000)
    const SET = 'term-set'
    k('apply -f -', JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: { name: SET, namespace: NS },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: SET } },
        template: { metadata: { labels: { app: SET } }, spec: { terminationGracePeriodSeconds: 600, containers: [box('app', IGNORES_TERM)] } },
      },
    }))
    let name = ''
    await expect.poll(() => {
      name = k(`-n ${NS} get pods -l app=${SET} -o jsonpath='{.items[*].metadata.name}'`).split(' ')[0]
      return printed(NS)[name]?.status
    }, { timeout: 120_000, message: `${SET}: its pod runs` }).toBe('Running')

    await page.goto(`/workloads/replicasets?cluster=${CLUSTER}&namespace=${NS}&detail=ReplicaSet/${NS}/${SET}`)
    const drawer = page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()
    // the pods table's cells: the pod's name, then its Status
    const status = drawer.locator('tr').filter({ has: page.getByRole('cell', { name, exact: true }) }).locator('td').nth(1)
    await expect(status).toHaveText('Running', { timeout: 20_000 })

    k(`-n ${NS} delete pod ${name} --wait=false`)
    await expect.poll(() => printed(NS)[name]?.status, { timeout: 30_000, message: 'kubectl' }).toBe('Terminating')
    await expect(status, 'the row a live update left').toHaveText('Terminating', { timeout: 20_000 })
    // a replacement comes and the row of the one going stays as it is
    const podRows = drawer.locator('tr').filter({ has: page.getByRole('cell', { name: new RegExp(`^${SET}-`) }) })
    await expect.poll(() => podRows.count(), { timeout: 60_000, message: 'the replacement pod' }).toBe(2)
    await expect(status).toHaveText('Terminating')
  })
})
