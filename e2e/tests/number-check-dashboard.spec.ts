import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Number check of the dashboard's count cards on self: each count is what the user's own identity in the cluster
// lists, as kubectl as that identity — a custom role whose group the cluster lets list namespaces and services only
// sees those two counted, and the others as not counted ("—", named in the API's "refused"), not the cache's numbers.

const DASHBOARD = { path: '/', cluster: 'self' }
const CLUSTER = DASHBOARD.cluster
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-dash-refused-pass1!'
const stamp = Date.now().toString(36)
const ROLE = `e2e-dash-${stamp}`
const GROUP = `kubeast:role:${ROLE}`
const EMAIL = `e2e-dash-${stamp}@example.com`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-dashboard-')), 'kubeconfig')
fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const asUser = `--as=${EMAIL} --as-group=kubeast:authenticated --as-group=${GROUP}`

// the overview's counts, the card each is on ("" = none) and the list kubectl makes for it
const KINDS = [
  { card: 'pods', key: 'total_pods', resource: 'pods', namespaced: true },
  { card: 'services', key: 'total_services', resource: 'services', namespaced: true },
  { card: 'deployments', key: 'total_deployments', resource: 'deployments.apps', namespaced: true },
  { card: 'pvcs', key: 'total_pvcs', resource: 'persistentvolumeclaims', namespaced: true },
  { card: '', key: 'total_pvs', resource: 'persistentvolumes', namespaced: false },
  { card: 'nodes', key: 'node_count', resource: 'nodes', namespaced: false },
]

// what kubectl as the user's identity may list, and how many it lists
function asTheUser(resource: string, namespaced: boolean): number | null {
  const all = namespaced ? ' -A' : ''
  let can = ''
  try {
    can = kubectl(`auth can-i list ${resource}${all} ${asUser}`)
  } catch {
    can = 'no'
  }
  if (can !== 'yes') return null
  const out = kubectl(`get ${resource}${all} ${asUser} -o name`)
  return out ? out.split('\n').length : 0
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Number check — dashboard counts as the user may list them', () => {
  let admin = ''
  let roleId = 0
  let userId = 0

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: ROLE, description: 'e2e', permissions: ['menu.dashboard', 'resource.*.read', 'ai.mcp.use', 'ai.tool.get_cluster_overview'] } })
    expect(role.status(), await role.text()).toBe(201)
    roleId = (await role.json()).id
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = ((Array.isArray(roles) ? roles : roles.items || []) as Array<{ id: number; name: string }>).find((r) => r.name.toLowerCase() === 'member')!.id
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E dashboard', email: EMAIL, password: PW, role_id: member } })
    expect(created.status(), await created.text()).toBe(201)
    userId = (await created.json()).id
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: ROLE } })
    expect(grant.ok(), await grant.text()).toBeTruthy()
    // the cluster side: Kubeast may act as the role's group, and the group may list namespaces and services only
    kubectl(`create clusterrole ${ROLE}-imp --verb=impersonate --resource=groups --resource-name=${GROUP}`)
    kubectl(`create clusterrolebinding ${ROLE}-imp --clusterrole=${ROLE}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
    kubectl(`create clusterrole ${ROLE}-list --verb=list,get --resource=namespaces,services`)
    kubectl(`create clusterrolebinding ${ROLE}-list --clusterrole=${ROLE}-list --group=${GROUP}`)
  })

  test.afterAll(async ({ request }) => {
    for (const o of [`clusterrolebinding/${ROLE}-imp`, `clusterrole/${ROLE}-imp`, `clusterrolebinding/${ROLE}-list`, `clusterrole/${ROLE}-list`]) kubectl(`delete ${o} --ignore-not-found`)
    if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a count the identity may not list is not counted; the others are what it lists', async ({ page, request }) => {
    test.setTimeout(180_000)
    const user = await login(request, EMAIL, PW)
    const overview = async () => {
      const res = await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: bearer(user), failOnStatusCode: false })
      return { status: res.status(), body: res.ok() ? await res.json() : null }
    }
    // the bindings take a moment, and the identity's answers are kept 60 s
    await expect.poll(async () => (await overview()).status, { timeout: 90_000, intervals: [3_000] }).toBe(200)

    const want: Record<string, number | null> = { total_namespaces: asTheUser('namespaces', false) }
    for (const k of KINDS) want[k.key] = asTheUser(k.resource, k.namespaced)
    expect(want.total_namespaces, 'the identity lists namespaces').not.toBeNull()
    expect(want.total_services, 'the identity lists services').not.toBeNull()
    expect(want.total_pods, 'the identity may not list pods').toBeNull()

    await expect(async () => {
      const ov = (await overview()).body
      const got: Record<string, number | null> = {}
      for (const k of Object.keys(want)) got[k] = ov[k] ?? null
      expect.soft(got, 'the counts, as kubectl as the identity lists').toEqual(want)
      expect.soft([...(ov.refused ?? [])].sort(), 'refused').toEqual(KINDS.filter((k) => want[k.key] === null).map((k) => k.resource.replace('.apps', '')).sort())
      expect.soft(ov.pod_status ?? null, 'no pod phases without the pods').toBeNull()
    }).toPass({ timeout: 30_000, intervals: [3_000] })

    // the AI's overview: the same answer, a kind the identity may not list not failing the rest
    const mcpConfig = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (mcpConfig.ok() && (await mcpConfig.json()).enabled) {
      const res = await request.post('/api/v1/ai/mcp', {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${user}` },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cluster_overview', arguments: { cluster: CLUSTER } } },
        failOnStatusCode: false,
      })
      expect(res.status(), await res.text()).toBe(200)
      const result = (await res.json()).result
      expect(result.isError, result.content?.[0]?.text).toBeFalsy()
      expect(JSON.parse(result.content[0].text), 'the tool answers what the dashboard reads').toEqual((await overview()).body)
    }

    // the screen: the identity's counts, and "—" with the reason for the others
    await page.context().clearCookies()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(EMAIL)
    await page.locator('input[type="password"]').first().fill(PW)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
    await page.goto(`${DASHBOARD.path}?cluster=${CLUSTER}`)
    await expect(page.getByTestId('stat-value-namespaces')).toHaveText(String(want.total_namespaces), { timeout: 30_000 })
    for (const k of KINDS.filter((x) => x.card)) {
      const n = want[k.key]
      await expect.soft(page.getByTestId(`stat-value-${k.card}`), `${k.card} card`).toHaveText(n === null ? '—' : String(n))
      if (n === null) await expect.soft(page.getByTestId(`stat-${k.card}`), `${k.card} card says why`).toHaveAttribute('title', /may not list|목록을 볼 수 없어/)
    }
  })
})

// The dashboard's smaller numbers, each held to what kubectl lists: the Unknown bar and the window it opens (a pod
// with no phase yet is counted there), the Storage window's status badges (one per status, however many) and the
// Optimization totals (a row without usage kept at its requests, and said so).
test.describe('Number check — the Unknown bar, the storage badges and the optimization totals', () => {
  const NS = `e2e-dash-small-${stamp}`
  const PVS = ['available', 'released', 'failed', 'pending'].map((s) => `${NS}-${s}`)
  let kcB = ''
  const kubectlB = (args: string) => {
    if (!kcB) {
      kcB = path.join(path.dirname(kcPath), 'kubeconfig-b')
      fs.writeFileSync(kcB, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
    }
    return execSync(`kubectl --kubeconfig ${kcB} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  }
  const ensureNamespace = (k: (args: string) => string) => {
    if (!k(`get namespace ${NS} --ignore-not-found -o name`)) k(`create namespace ${NS}`)
  }
  const apply = (k: (args: string) => string, yaml: string) => {
    const file = path.join(path.dirname(kcPath), `apply-${Date.now()}.yaml`)
    fs.writeFileSync(file, yaml)
    k(`apply -f ${file}`)
  }
  // no scheduler takes these pods and no kubelet runs them, so a status written by hand stays
  const runNowhere = (k: (args: string) => string, name: string, cpu: string, mem: string) =>
    k(`run ${name} -n ${NS} --image=registry.k8s.io/pause:3.10 --overrides='${JSON.stringify({ spec: { schedulerName: 'e2e-none', containers: [{ name, image: 'registry.k8s.io/pause:3.10', resources: { requests: { cpu, memory: mem } } }] } })}'`)
  const countBy = (values: string[]) => values.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})
  // the page's formatMillicores and formatBytes
  const fmtM = (m: number) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 2).replace(/0+$/, '').replace(/\.$/, '')}`)
  const fmtB = (b: number) => {
    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
    let v = b
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
    return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')}${units[i]}`
  }

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
    kubectl(`delete pv ${PVS.join(' ')} --ignore-not-found --wait=false`)
    if (kcB) kubectlB(`delete namespace ${NS} --ignore-not-found --wait=false`)
  })

  test('the Unknown bar counts the pods with no phase yet, and its window lists those pods', async ({ page }) => {
    test.setTimeout(120_000)
    ensureNamespace(kubectl)
    runNowhere(kubectl, 'e2e-no-phase', '10m', '8Mi')
    kubectl(`patch pod e2e-no-phase -n ${NS} --subresource=status --type=json -p '[{"op":"remove","path":"/status/phase"}]'`)
    const want = kubectl(`get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{" "}{.status.phase}{"\\n"}{end}'`)
      .split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, phase]) => !phase || phase === 'Unknown').map(([name]) => name).sort()
    expect(want, 'kubectl lists the pod with no phase').toContain(`${NS}/e2e-no-phase`)

    const podCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Pod (status|상태)$/ }) })
    await expect(async () => {
      await page.goto(`${DASHBOARD.path}?cluster=${CLUSTER}`)
      await expect(podCard.locator('svg title').filter({ hasText: /^Unknown:/ })).toHaveText(`Unknown: ${want.length}`, { timeout: 15_000 })
    }).toPass({ timeout: 60_000 })
    await podCard.locator('svg g').filter({ has: page.locator('title', { hasText: /^Unknown:/ }) }).first().click()
    const modal = page.locator('div.fixed.inset-0').filter({ has: page.getByTestId('resource-modal-total') })
    await expect(modal.getByTestId('resource-modal-total')).not.toHaveText(/Loading|불러오는/)
    const listed = async () => (await modal.locator('h3').evaluateAll((els) => els.map((e) => `${e.nextElementSibling?.textContent}/${e.textContent}`))).sort()
    await expect.poll(listed, { message: 'the window lists the pods the bar counts' }).toEqual(want)
  })

  test('the Storage window has a badge for every PV and PVC status, each with its count', async ({ page }) => {
    test.setTimeout(150_000)
    ensureNamespace(kubectl)
    const pv = (name: string, storageClass: string, extra: string) => `apiVersion: v1
kind: PersistentVolume
metadata: {name: ${name}}
spec: {storageClassName: ${storageClass}, capacity: {storage: 1Mi}, accessModes: [ReadWriteOnce], persistentVolumeReclaimPolicy: Retain, hostPath: {path: /e2e-none}${extra}}
`
    // a claim no volume matches, a volume that is free, and two whose claim is gone (Retain keeps them Released)
    apply(kubectl, [
      `apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: e2e-claim, namespace: ${NS}}
spec: {storageClassName: ${NS}-claim, accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Mi}}}
`,
      pv(PVS[0], `${NS}-pv`, ''),
      pv(PVS[1], `${NS}-pv`, `, claimRef: {namespace: ${NS}, name: e2e-gone, uid: 00000000-0000-0000-0000-000000000001}`),
      pv(PVS[2], `${NS}-pv`, `, claimRef: {namespace: ${NS}, name: e2e-gone, uid: 00000000-0000-0000-0000-000000000002}`),
    ].join('---\n'))
    const phase = (name: string) => kubectl(`get pv ${name} -o jsonpath='{.status.phase}'`)
    await expect.poll(() => phase(PVS[2]), { timeout: 60_000 }).toBe('Released')
    // the controller leaves Failed alone under Retain, and a volume promised to a claim of another volume mode as it is
    kubectl(`patch pv ${PVS[2]} --subresource=status --type=merge -p '{"status":{"phase":"Failed"}}'`)
    const uid = kubectl(`get pvc e2e-claim -n ${NS} -o jsonpath='{.metadata.uid}'`)
    apply(kubectl, pv(PVS[3], `${NS}-claim`, `, volumeMode: Block, claimRef: {namespace: ${NS}, name: e2e-claim, uid: ${uid}}`))
    kubectl(`patch pv ${PVS[3]} --subresource=status --type=merge -p '{"status":{"phase":"Pending"}}'`)
    await expect.poll(() => PVS.map(phase), { timeout: 60_000 }).toEqual(['Available', 'Released', 'Failed', 'Pending'])

    const phases = (args: string) => countBy(kubectl(`get ${args} -o jsonpath='{range .items[*]}{.status.phase}{"\\n"}{end}'`).split('\n').filter(Boolean))
    const badges = (page_: typeof page, kind: 'PV' | 'PVC') =>
      page_.locator(`span.badge[title="${kind} Status"], span.badge[title="${kind} 상태"]`).allTextContents()
        .then((texts) => Object.fromEntries(texts.map((t) => t.trim().split(/\s+/)).map(([, status, n]) => [status, Number(n)])))
    await expect(async () => {
      const wantPV = phases('pv')
      const wantPVC = phases('pvc -A')
      expect(Object.keys(wantPV), 'kubectl lists five PV statuses').toHaveLength(5)
      await page.goto(`${DASHBOARD.path}?cluster=${CLUSTER}`)
      await page.locator('button').filter({ hasText: /Storage analysis|스토리지 분석/ }).first().click()
      await expect(page.locator('h2').filter({ hasText: /Storage analysis|스토리지 분석/ })).toBeVisible()
      await expect.poll(() => badges(page, 'PV'), { timeout: 15_000, message: 'a badge per PV status' }).toEqual(wantPV)
      expect(await badges(page, 'PVC'), 'a badge per PVC status').toEqual(wantPVC)
    }).toPass({ timeout: 60_000 })
  })

  test('the Optimization totals keep a row without usage at its requests and say how many there are', async ({ page, request }) => {
    test.setTimeout(300_000)
    try { kubectlB('version') } catch { test.skip(true, 'kind cluster kubeast-b not found') }
    ensureNamespace(kubectlB)
    // one pod the cluster measures, so the namespace has usage, and one that runs nowhere, which never has any
    kubectlB(`run e2e-measured -n ${NS} --image=registry.k8s.io/pause:3.10 --overrides='${JSON.stringify({ spec: { containers: [{ name: 'e2e-measured', image: 'registry.k8s.io/pause:3.10', resources: { requests: { cpu: '50m', memory: '32Mi' } } }] } })}'`)
    runNowhere(kubectlB, 'e2e-unmeasured', '70m', '40Mi')
    kubectlB(`patch pod e2e-unmeasured -n ${NS} --subresource=status --type=merge -p '{"status":{"phase":"Running"}}'`)
    kubectlB(`wait --for=condition=Ready pod/e2e-measured -n ${NS} --timeout=120s`)
    expect(kubectlB(`get pods -n ${NS} -o jsonpath='{.items[*].status.phase}'`).split(' ').filter((p) => p === 'Running'), 'kubectl lists both Running').toHaveLength(2)

    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const table = async () => (await request.get(`/api/v1/cluster/optimization?cluster=default&namespace=${NS}`, { headers: bearer(admin) })).json()
    // Prometheus scrapes every 30 s: the measured pod has usage within a few minutes
    await expect.poll(async () => {
      const t = await table()
      return t.rows?.find((r: { name: string }) => r.name === 'e2e-measured')?.cpu_usage_m != null && t.source !== 'none'
    }, { timeout: 240_000, intervals: [10_000] }).toBe(true)

    await expect(async () => {
      const t = await table()
      const measured = t.rows.find((r: { name: string }) => r.name === 'e2e-measured')
      const unmeasured = t.rows.find((r: { name: string }) => r.name === 'e2e-unmeasured')
      expect(unmeasured.cpu_recommend_m ?? null, 'no usage, no recommendation').toBeNull()
      const want = {
        pods: 2, cpu_request_m: 50 + 70, mem_request_bytes: (32 + 40) << 20, unmeasured_rows: 1,
        cpu_recommend_m: measured.cpu_recommend_m + 70, mem_recommend_bytes: measured.mem_recommend_bytes + (40 << 20),
      }
      expect(Object.fromEntries(Object.keys(want).map((k) => [k, t.totals[k]])), 'the totals, the unmeasured row at its requests').toEqual(want)

      await page.goto('/?cluster=default')
      await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
      await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
      await page.getByRole('button', { name: NS, exact: true }).click()
      const totals = page.getByTestId('optimization-totals')
      await expect(totals).toContainText(`${fmtM(want.cpu_request_m)}`, { timeout: 20_000 })
      await expect(totals, 'the recommended totals count the unmeasured row at its requests').toContainText(`${fmtM(want.cpu_recommend_m)} · ${fmtB(want.mem_recommend_bytes)}`)
      await expect(totals, 'and say so').toContainText(/\(1 row without usage kept at its requests\)|\(사용량 없는 1행은 요청값 그대로\)/)
    }).toPass({ timeout: 90_000 })
  })
})

test.describe('Number check — the Cluster Resource Utilization Pods slot', () => {
  test("default's slot is the pods kubectl lists, of the pods its nodes can take", async ({ page }) => {
    const kcB = path.join(path.dirname(kcPath), 'kubeconfig-b-pods')
    try {
      fs.writeFileSync(kcB, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
    } catch {
      test.skip(true, 'kind cluster kubeast-b not found')
    }
    const kubectlB = (args: string) => execSync(`kubectl --kubeconfig ${kcB} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    await page.goto('/?cluster=default')
    const slot = page.getByTestId('cluster-metric-pods')
    test.skip(!(await slot.waitFor({ timeout: 30_000 }).then(() => true, () => false)), 'no Prometheus card on default')
    // the nodes' allocatable pods, as the slot's second number
    const room = kubectlB(`get nodes -o jsonpath='{range .items[*]}{.status.allocatable.pods}{"\\n"}{end}'`)
      .split('\n').filter(Boolean).reduce((s, n) => s + Number(n), 0)
    await expect.poll(async () => {
      const pods = kubectlB('get pods -A --no-headers').split('\n').filter(Boolean).length
      return `${(await slot.locator('span.font-mono').textContent())?.trim()} | kubectl ${pods} / ${room}`
    }, { timeout: 120_000, intervals: [10_000] }).toMatch(/^(\d+ \/ \d+) \| kubectl \1$/)
  })
})
