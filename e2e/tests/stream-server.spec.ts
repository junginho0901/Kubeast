import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// streams.enabled: the terminals and followed logs go to k8s-service-stream (SERVER_ROLE stream), the rest to
// k8s-service (SERVER_ROLE api). A replaced stream server ends the followed log at once — the tab reconnects and goes
// on after its last line — and tells the terminal when it closes, then closes it with 1001 server_shutdown and the
// terminal window offers Reconnect. Skips while the dev install has no k8s-service-stream.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const NS = 'default'
const KUBEAST_NS = 'kubeast'
const STAMP = Date.now().toString(36)
const POD = `e2e-stream-${STAMP}`

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-stream-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const streamServer = (): boolean => {
  try {
    return kubectl(`-n ${KUBEAST_NS} get deploy k8s-service-stream -o name`) !== ''
  } catch {
    return false
  }
}

// How long the stream server gives an open terminal, as its Deployment says (streams.drainSeconds).
const drainSeconds = (): number => {
  const env = JSON.parse(kubectl(`-n ${KUBEAST_NS} get deploy k8s-service-stream -o jsonpath={.spec.template.spec.containers[0].env}`)) as { name: string; value?: string }[]
  return Number(env.find((e) => e.name === 'STREAM_DRAIN_SECONDS')?.value ?? '60')
}

const serverLog = (deploy: string, since: string) => kubectl(`-n ${KUBEAST_NS} logs deploy/${deploy} --all-containers --since-time=${since}`)

type Row = { Action: string; TargetID: string; After: Record<string, unknown> | null }

async function auditRows(request: APIRequestContext, action: string, since: string): Promise<Row[]> {
  const login = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.ok(), 'admin login').toBeTruthy()
  const headers = { Authorization: `Bearer ${(await login.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers, params: { cluster: '', limit: '100', action, since } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

type Terminal = { text: string; closed?: { code: number; reason: string } }

// Opens the pod's terminal socket as PodExecTerminal does and keeps what it showed and how it ended on window.
async function openTerminal(page: Page) {
  await page.evaluate(
    ({ ns, pod, cluster }) => {
      const seen: Terminal = { text: '' }
      ;(window as unknown as { __term: Terminal }).__term = seen
      const decoder = new TextDecoder()
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/namespaces/${ns}/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=${cluster}&lang=en`)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (e) => { seen.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
      ws.onclose = (e) => { seen.closed = { code: e.code, reason: e.reason } }
    },
    { ns: NS, pod: POD, cluster: CLUSTER },
  )
}

const terminalOn = (page: Page) => page.evaluate(() => (window as unknown as { __term: Terminal }).__term)

async function openLogsTab(page: Page) {
  await page.goto(`/cluster-view?cluster=${CLUSTER}`)
  await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15_000 })
  await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
  await page.locator('div.card button', { hasText: POD }).first().click()
  const area = page.locator('pre.whitespace-pre-wrap').first()
  await expect(area).toContainText('stream-line-5', { timeout: 20_000 })
  return area
}

test.describe('terminals and followed logs on their own server', () => {
  test.beforeAll(() => {
    test.skip(!streamServer(), 'no k8s-service-stream: the dev install runs with streams.enabled false')
    kubectl(`-n ${NS} run ${POD} --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --command -- sh -c 'for i in 1 2 3 4 5; do echo stream-line-$i; done; sleep 3600'`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(() => {
    if (streamServer()) kubectl(`-n ${NS} delete pod ${POD} --ignore-not-found --wait=false`)
  })

  test('a terminal and a followed log reach the stream server, and the lists the api server', async ({ page }) => {
    const since = new Date(Date.now() - 2000).toISOString()
    await openLogsTab(page)
    const term = await page.context().newPage()
    await term.goto('/color-mode.js')
    await openTerminal(term)
    await expect.poll(async () => (await terminalOn(term)).text.length, { timeout: 20_000 }).toBeGreaterThan(0)
    // a list is the API server's: the stream server has no such route
    const list = await page.request.get(`/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`)
    expect(list.status()).toBe(200)

    const attached = new RegExp(`"msg":"pod exec attached"[^\n]*"pod":"${POD}"`)
    const followed = new RegExp(`"msg":"pod logs sse connected"[^\n]*"pod":"${POD}"`)
    await expect.poll(() => serverLog('k8s-service-stream', since), { timeout: 15_000 }).toMatch(attached)
    expect(serverLog('k8s-service-stream', since)).toMatch(followed)
    const apiLog = serverLog('k8s-service', since)
    expect(apiLog).not.toMatch(attached)
    expect(apiLog).not.toMatch(followed)
    await term.close()
  })

  test('a replaced stream server tells the terminal when it closes, closes it with the reason, and the log goes on', async ({ page, request }) => {
    const wait = drainSeconds()
    test.setTimeout((wait + 240) * 1000)
    const since = new Date(Date.now() - 2000).toISOString()
    const area = await openLogsTab(page)

    // the terminal window of the Pod drawer, for the Reconnect button
    const drawer = await page.context().newPage()
    await drawer.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=Pod/${NS}/${POD}`)
    await drawer.getByTitle(/Open terminal|터미널 열기/).first().click()
    await expect(drawer.locator('.xterm-rows')).toContainText(/Connected\.|연결됨\./, { timeout: 20_000 })

    const raw = await page.context().newPage()
    await raw.goto('/color-mode.js')
    await openTerminal(raw)
    await expect.poll(async () => (await terminalOn(raw)).text.length, { timeout: 20_000 }).toBeGreaterThan(0)

    kubectl(`-n ${KUBEAST_NS} rollout restart deploy/k8s-service-stream`)

    // the warning comes once the new server is ready and the old one's preStop is over
    await expect.poll(async () => (await terminalOn(raw)).text, { timeout: 180_000 }).toContain('this terminal closes in')
    await expect.poll(async () => (await terminalOn(raw)).closed, { timeout: (wait + 30) * 1000 }).toEqual({ code: 1001, reason: 'server_shutdown' })
    expect((await terminalOn(raw)).text).toContain('the server was replaced')

    await expect(drawer.getByRole('button', { name: /^(Reconnect|다시 연결)$/ })).toHaveText(/Reconnect|다시 연결/, { timeout: 30_000 })
    await expect(drawer.locator('.xterm-rows')).toContainText(/server was replaced|서버가 교체/)
    await drawer.getByRole('button', { name: /^(Reconnect|다시 연결)$/ }).click()
    await expect(drawer.locator('.xterm-rows')).toContainText(/Connected\.|연결됨\./, { timeout: 20_000 })
    await expect(drawer.getByRole('button', { name: /^(Reconnect|다시 연결)$/ })).toHaveCount(0)

    // a line printed after the old server left reaches the tab, and no line shows twice or is missing
    kubectl(`-n ${KUBEAST_NS} rollout status deploy/k8s-service-stream --timeout=120s`)
    kubectl(`-n ${NS} exec ${POD} -- sh -c 'echo stream-after-${STAMP} > /proc/1/fd/1'`)
    await expect(area).toContainText(`stream-after-${STAMP}`, { timeout: 20_000 })
    const shown = (await area.innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
    expect(new Set(shown).size, `lines shown: ${JSON.stringify(shown)}`).toBe(shown.length)
    const printed = kubectl(`-n ${NS} logs ${POD}`).split('\n').map((l) => l.trim()).filter(Boolean)
    expect(shown.map((l) => l.replace(/^\S+\s/, ''))).toEqual(printed)

    // each end the server made has its row, and the log's reconnect went on after its last line
    const ends = (await auditRows(request, 'k8s.session.end', since)).filter((r) => r.TargetID === POD)
    expect(ends.map((r) => r.After?.reason)).toContain('server_shutdown')
    expect(ends.map((r) => r.After?.stream).sort()).toEqual(expect.arrayContaining(['exec', 'pod-logs']))
    const reads = (await auditRows(request, 'k8s.pod.logs.read', since)).filter((r) => r.TargetID === POD && r.After?.follow === true)
    expect(reads.some((r) => typeof r.After?.resume_from === 'string')).toBe(true)

    await raw.close()
    await drawer.close()
  })
})
