import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// What the screens know, said as it is, on cluster self: a pod being deleted reads Terminating in every drawer's pod
// table (its command ignores SIGTERM under a long grace period, so it stays that way), a crashing pod's Status tile is
// kubectl's with the last crash in a row of its own, a node's Allocated Resources are kubectl describe node's, and a
// limited admin's refused cluster access change says why. The states no dev cluster can be put in on demand are stood
// in: an Optimization row of another owner, rollouts that could not be read, Prometheus with no DCGM series, a cluster
// whose Test failed.

const CLUSTER = 'self'
const RUN = Date.now().toString(36)
const NS = `e2e-say-${RUN}`
const LABEL = 'kubeast.io/e2e=screens-say'
const CRB = `e2e-say-${RUN}`
const PC = `e2e-say-${RUN}`
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-say-throwaway-1!'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-say-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const k = kubectlFor('kubeast')
const tryK = (args: string) => { try { return k(args) } catch { return null } }

const IGNORES_TERM = ['sh', '-c', "trap '' TERM; while true; do sleep 1; done"]
const FIXTURE = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS, labels: { 'kubeast.io/e2e': 'screens-say' } } },
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'say-cm', namespace: NS }, data: { a: 'b' } },
  { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'say-secret', namespace: NS }, stringData: { a: 'fake-value' } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'say-sa', namespace: NS } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'say-svc', namespace: NS }, spec: { selector: { app: 'say' }, ports: [{ port: 80 }] } },
  { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'say-pdb', namespace: NS }, spec: { maxUnavailable: 1, selector: { matchLabels: { app: 'say' } } } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'say-np', namespace: NS }, spec: { podSelector: { matchLabels: { app: 'say' } }, policyTypes: ['Ingress'] } },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'say-rb', namespace: NS }, subjects: [{ kind: 'ServiceAccount', name: 'say-sa', namespace: NS }], roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' } },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: CRB, labels: { 'kubeast.io/e2e': 'screens-say' } }, subjects: [{ kind: 'ServiceAccount', name: 'say-sa', namespace: NS }], roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' } },
  { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: PC, labels: { 'kubeast.io/e2e': 'screens-say' } }, value: 1 },
  {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'say-going', namespace: NS, labels: { app: 'say' } },
    spec: {
      terminationGracePeriodSeconds: 600, serviceAccountName: 'say-sa', priorityClassName: PC,
      volumes: [{ name: 'cm', configMap: { name: 'say-cm' } }, { name: 'secret', secret: { secretName: 'say-secret' } }],
      containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: IGNORES_TERM, volumeMounts: [{ name: 'cm', mountPath: '/cm' }, { name: 'secret', mountPath: '/secret' }] }],
    },
  },
  {
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'say-crash', namespace: NS },
    spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sh', '-c', 'exit 3'] }] },
  },
].map((o) => JSON.stringify(o)).join('\n---\n')

function removeRuns() {
  for (const ns of (tryK(`get namespaces -l ${LABEL} -o jsonpath='{.items[*].metadata.name}'`) ?? '').split(/\s+/).filter(Boolean)) {
    tryK(`-n ${ns} delete pods --all --grace-period=0 --force --wait=false`)
    tryK(`delete namespace ${ns} --ignore-not-found --wait=false`)
  }
  tryK(`delete clusterrolebinding,priorityclass -l ${LABEL} --ignore-not-found --wait=false`)
}

// the pod's STATUS as kubectl prints it
const printedStatus = (name: string) => k(`-n ${NS} get pod ${name} --no-headers`).trim().split(/\s+/)[2]

// kubectl describe node's rows under "Allocated resources"
function kubectlAllocated(node: string): string[][] {
  const section = k(`describe node ${node}`).split('Allocated resources:')[1] ?? ''
  const rows: string[][] = []
  for (const line of section.split('\n').slice(1)) {
    if (!line.startsWith(' ')) { if (line.trim()) break; continue }
    const cols = line.trim().split(/\s{2,}/)
    if (cols.length === 3 && cols[0] !== 'Resource' && !cols[0].startsWith('--')) rows.push(cols)
  }
  return rows
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}

// what the page sends the floating chat about what is on screen, the request stopped before any model
type Layer = { source?: string; data?: Record<string, unknown> }
async function pageContext(page: Page): Promise<() => Promise<{ overlays: Layer[] }>> {
  const sent: { overlays: Layer[] }[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-say-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback())
  await page.route(/\/api\/v1\/sessions\/e2e-say-ctx-\d+(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-say-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-say-ctx-\d+\/floating-chat/, (route) => {
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

const drawerRowValue = (page: Page, label: string) =>
  page.locator(DRAWER).last().getByText(label, { exact: true }).first().locator('xpath=following-sibling::span[1]')

test.describe('the screens say what they know', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    removeRuns()
    k('apply -f -', FIXTURE)
    const deadline = Date.now() + 180_000
    const ready = () => {
      const going = tryK(`-n ${NS} get pod say-going -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}'`)
      const crashed = tryK(`-n ${NS} get pod say-crash -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'`)
      return !!going && crashed === '3'
    }
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`fixture did not settle: ${tryK(`-n ${NS} get pods`)}`)
      await new Promise((r) => setTimeout(r, 2_000))
    }
    k(`-n ${NS} delete pod say-going --wait=false`)
    while (printedStatus('say-going') !== 'Terminating') {
      if (Date.now() > deadline) throw new Error(`say-going is ${printedStatus('say-going')}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  })

  test.afterAll(() => removeRuns())

  test('a pod being deleted reads Terminating in every drawer\'s pod table, not its phase', async ({ page }) => {
    test.setTimeout(180_000)
    expect(JSON.parse(k(`-n ${NS} get pod say-going -o json`)).status.phase, 'the phase the tables read before').toBe('Running')
    for (const ref of [
      `ConfigMap/${NS}/say-cm`, `Secret/${NS}/say-secret`, `ServiceAccount/${NS}/say-sa`, `Service/${NS}/say-svc`, `PodDisruptionBudget/${NS}/say-pdb`,
      `NetworkPolicy/${NS}/say-np`, `RoleBinding/${NS}/say-rb`, `ClusterRoleBinding/${CRB}`, `PriorityClass/${PC}`,
    ]) {
      await page.goto(`/workloads/pods?cluster=${CLUSTER}&detail=${encodeURIComponent(ref)}`)
      const row = page.locator(DRAWER).last().locator('tr').filter({ hasText: 'say-going' })
      await expect.soft(row.locator('.badge').first(), ref).toHaveText('Terminating', { timeout: 20_000 })
    }
  })

  test('a crashing pod\'s Status tile is the list\'s, its last crash has a row of its own, and the chat is told both', async ({ page }) => {
    test.setTimeout(120_000)
    const ask = await pageContext(page)
    const last = () => JSON.parse(k(`-n ${NS} get pod say-crash -o json`)).status.containerStatuses[0].lastState.terminated
    await expect(async () => {
      const want = printedStatus('say-crash')
      await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/say-crash`)}`)
      await expect(page.getByTestId('pod-drawer-status')).toHaveText(want, { timeout: 10_000 })
    }).toPass({ timeout: 60_000 })
    const { reason, exitCode } = last()
    expect(exitCode).toBe(3)
    await expect(drawerRowValue(page, 'Last State')).toHaveText(new RegExp(`^${reason} \\(exit code 3, `))
    const layer = (await ask()).overlays.find((o) => o.source === 'PodInfo')?.data
    expect(layer?.last_states).toMatchObject([{ container: 'app', reason, exit_code: 3 }])
    expect(layer?.phase).toBe('Running')
    expect(typeof layer?.status).toBe('string')
  })

  test('a node\'s Allocated Resources are kubectl describe node\'s, and its Ready time says what it is', async ({ page }) => {
    test.setTimeout(120_000)
    const node = k(`get nodes -o jsonpath='{.items[0].metadata.name}'`)
    await expect(async () => {
      const want = kubectlAllocated(node)
      expect(want.length, 'kubectl prints the three resources at least').toBeGreaterThanOrEqual(3)
      await page.goto(`/cluster/nodes?cluster=${CLUSTER}&detail=${encodeURIComponent(`Node/${node}`)}`)
      const rows = page.getByTestId('node-allocated').locator('tbody tr')
      await expect(rows).toHaveCount(want.length, { timeout: 15_000 })
      expect(await rows.evaluateAll((trs) => trs.map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.innerText.trim())))).toEqual(want)
    }).toPass({ timeout: 90_000 })
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByText('Since Ready Changed')).toHaveCount(1)
    await expect(drawer.getByText('Uptime')).toHaveCount(0)
  })

  test('an Optimization row of an owner the server does not resize has no Apply and says why', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features?cluster=default', { headers: bearer(admin) })).json()
    test.skip(!features.inPlaceResize?.enabled || !features.inPlaceResize?.serverSupports, 'in-place resize is off or the server is older than 1.35')
    // the server's own refusal is why the button would be a lie
    const refused = await request.post('/api/v1/cluster/namespaces/kube-system/optimization/resize?cluster=default', {
      headers: bearer(admin), data: { kind: 'Widget', name: 'say-widget', container: 'app', cpu_request_m: 10 }, failOnStatusCode: false,
    })
    expect(refused.status()).toBe(400)

    let kinds: string[] = []
    await page.route(/\/api\/v1\/cluster\/optimization(\?|$)/, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      kinds = body.resize_kinds
      const widget = { kind: 'Widget', api_version: 'qa.example.com/v1', namespace: 'kube-system', name: 'say-widget', container: 'app', pods: 1, cpu_request_m: 50, cpu_limit_m: 0, cpu_recommend_m: 10, mem_request_bytes: 0, mem_limit_bytes: 0, flags: [] }
      await route.fulfill({ response: res, json: { ...body, rows: [widget, ...body.rows] } })
    })
    await page.goto('/?cluster=default')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kube-system', exact: true }).click()
    const row = page.getByTestId('optimization-row').filter({ hasText: 'say-widget' })
    // what the server named is known once its answer has come
    await expect(row.getByTestId('optimization-resize-kind')).toHaveText(/^Not available for Widget: only .+ can be applied here\.$/, { timeout: 20_000 })
    await expect(row.getByTestId('optimization-resize-kind')).toHaveText(`Not available for Widget: only ${kinds.join(', ')} can be applied here.`)
    await expect(row.getByTestId('optimization-resize')).toHaveCount(0)
    expect(kinds).toContain('Deployment')
  })

  test('rollouts that could not be read are "-" on the Timeline card, not 0', async ({ page }) => {
    await page.route(/\/api\/v1\/cluster\/timeline(\?|$)/, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, rollout_history: [], summary: { ...body.summary, rollouts_error: 'replicasets is forbidden' } } })
    })
    await page.goto(`/timeline?cluster=${CLUSTER}`)
    await expect(page.getByTestId('timeline-rollouts-error')).toHaveAttribute('title', 'replicasets is forbidden', { timeout: 20_000 })
    const card = page.locator('div.border.rounded-lg').filter({ has: page.getByText(/^(Rollouts|롤아웃)$/) })
    await expect(card.locator('p.text-2xl')).toHaveText('-')
  })

  test('Prometheus with no DCGM series is "-" on the GPU cards, and a plugin not found names its company', async ({ page }) => {
    await page.route(/\/api\/v1\/cluster\/gpu\/metrics(\?|$)/, (route) => route.fulfill({ json: {
      available: true, gpu_count: 0, avg_gpu_util: 0, avg_memory_util: 0, total_memory_used_mb: 0, total_memory_free_mb: 0, total_memory_mb: 0, gpus: [],
    } }))
    await page.route(/\/api\/v1\/cluster\/gpu\/dashboard(\?|$)/, (route) => route.fulfill({ json: {
      total_gpu_capacity: 2, total_gpu_allocatable: 2, total_gpu_used: 0, total_gpu_waiting: 0,
      vendors: [{ vendor: 'AMD', capacity: 2, allocatable: 2, used: 0, waiting: 0 }],
      gpu_nodes: [{ name: 'say-gpu', gpu_capacity: 2, gpu_allocatable: 2, gpu_used: 0, status: 'Ready', gpu_vendors: [{ vendor: 'AMD', capacity: 2, allocatable: 2, used: 0 }] }],
      gpu_pods: [], device_plugins: [{ vendor: 'AMD', found: false }], mig_enabled: false, time_slicing_enabled: false, time_slicing_config: null, dra_pods: [],
    } }))
    await page.goto(`/gpu/dashboard?cluster=${CLUSTER}`)
    for (const id of ['gpu-realtime-avg-util', 'gpu-realtime-avg-mem', 'gpu-realtime-mem-used', 'gpu-realtime-count']) {
      await expect.soft(page.getByTestId(id), id).toHaveText('-', { timeout: 20_000 })
    }
    await expect(page.getByTestId('gpu-plugin-note')).toHaveText(/^AMD device plugin: not under the names Kubeast looks for\. It may run under another name/)
  })

  test('a cluster whose Test failed has the red dot its word says, on the admin page and in the picker', async ({ page }) => {
    await page.route(/\/api\/v1\/clusters(\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, items: body.items.map((c: { id: string }) => (c.id === CLUSTER ? { ...c, health_status: 'unreachable' } : c)) } })
    })
    await page.goto(`/admin/clusters?cluster=${CLUSTER}`)
    const row = page.locator('tr').filter({ has: page.getByTestId(`access-cluster-${CLUSTER}`) })
    await expect(row.locator('span.rounded-full.w-2')).toHaveClass(/bg-red-500/, { timeout: 20_000 })
    await expect(row).toContainText(/Unreachable|연결 안 됨/)
    await expect(page.getByTestId('cluster-picker').locator('span.rounded-full.w-2')).toHaveClass(/bg-red-500/)
  })

  test('the role screen says what resource.*.read asks for, and the cluster decides the other lists', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const body = await (await request.get('/api/v1/auth/permissions', { headers: bearer(admin) })).json()
    const categories: { permissions: { key: string; description: string }[] }[] = Array.isArray(body) ? body : body.categories ?? body.items
    const read = categories.flatMap((c) => c.permissions).find((p) => p.key === 'resource.*.read')
    expect(read?.description).toMatch(/^Asked by Pod logs, .*The other lists are decided by the role on the cluster and the cluster's RBAC\.$/)
  })

  test('a refused cluster access change says why and changes nothing', async ({ browser, request }: { browser: Browser; request: APIRequestContext }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const headers = bearer(admin)
    const made: string[] = []
    let roleId: number | undefined
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    try {
      const role = await request.post('/api/v1/auth/admin/roles', { headers, data: { name: `e2e-say-${RUN}`, description: 'e2e', permissions: ['admin.users.*', 'admin.clusters.*', 'menu.*'] } })
      expect(role.status(), await role.text()).toBe(201)
      roleId = (await role.json()).id as number
      const user = async (key: string, data: object) => {
        const email = `e2e-say-${key}-${RUN}@kubeast.local`
        const res = await request.post('/api/v1/auth/admin/users', { headers, data: { name: `E2E say ${key}`, email, password: PW, ...data } })
        expect(res.status(), await res.text()).toBe(201)
        const id = (await res.json()).id as string
        made.push(id)
        return { id, email }
      }
      const limited = await user('limited', { role_id: roleId })
      const victim = await user('victim', {})
      const viewer = await request.put(`/api/v1/auth/admin/users/${limited.id}/cluster-roles/${CLUSTER}`, { headers, data: { role: 'Read' } })
      expect(viewer.status(), await viewer.text()).toBe(200)

      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(limited.email)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })

      const grants = async () => (await (await request.get(`/api/v1/auth/admin/users/${victim.id}/cluster-roles`, { headers })).json()) as Record<string, string>

      await page.goto('/admin/users')
      await page.getByTestId(`user-detail-${victim.email}`).click()
      await page.getByTestId(`cluster-role-${CLUSTER}`).click()
      await page.getByTestId(`cluster-role-${CLUSTER}-opt-Admin`).click()
      await expect(page.getByTestId('cluster-role-matrix-refusal')).toHaveText(/^Not changed: .*permission/i, { timeout: 15_000 })
      expect(await grants()).toEqual({})

      await page.goto('/admin/clusters')
      await page.getByTestId(`access-cluster-${CLUSTER}`).click()
      await page.getByTestId('cluster-access-add-user').click()
      await page.getByTestId(`cluster-access-add-user-opt-${victim.id}`).click()
      await page.getByTestId('cluster-access-add-role').click()
      await page.getByTestId('cluster-access-add-role-opt-Admin').click()
      await page.getByTestId('cluster-access-add-btn').click()
      await expect(page.getByTestId('cluster-access-refusal')).toHaveText(/^Not changed: .*permission/i, { timeout: 15_000 })
      // the choice stays beside the reason
      await expect(page.getByTestId('cluster-access-add-user')).toContainText(victim.email)
      expect(await grants()).toEqual({})
    } finally {
      await ctx.close()
      for (const id of made) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers, failOnStatusCode: false })
      if (roleId !== undefined) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers, failOnStatusCode: false })
    }
  })
})
