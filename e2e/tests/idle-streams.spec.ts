import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A terminal and the Cluster View Logs tab left quiet past 60 s (nginx's and AWS ALB's idle cut) through the kind
// gateway: both still work afterwards, the tab shows each line once and as kubectl logs prints it, and the followed
// log was opened (and recorded) once. The server pings the terminal and writes comment lines into the quiet stream.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const NS = 'default'
const STAMP = Date.now().toString(36)
const POD = `e2e-idle-${STAMP}`
const QUIET_MS = 75_000

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-idle-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

type Row = { Action: string; TargetID: string; After: Record<string, unknown> | null }

async function auditRows(request: APIRequestContext, action: string, since: string): Promise<Row[]> {
  const login = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.ok(), 'admin login').toBeTruthy()
  const headers = { Authorization: `Bearer ${(await login.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers, params: { cluster: '', limit: '100', action, since } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

type Terminal = { text: string; closed?: { code: number; at: number } }

// Opens the pod's terminal socket as PodExecTerminal does and keeps what it showed and how it ended on window.
async function openTerminal(page: Page) {
  await page.evaluate(
    ({ ns, pod, cluster }) => {
      const seen: Terminal = { text: '' }
      ;(window as unknown as { __term: Terminal; __ws: WebSocket }).__term = seen
      const decoder = new TextDecoder()
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/namespaces/${ns}/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=${cluster}&lang=en`)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (e) => { seen.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
      ws.onclose = (e) => { seen.closed = { code: e.code, at: Date.now() } }
      ;(window as unknown as { __ws: WebSocket }).__ws = ws
    },
    { ns: NS, pod: POD, cluster: CLUSTER },
  )
}

const terminalOn = (page: Page) => page.evaluate(() => (window as unknown as { __term: Terminal }).__term)

test.describe('quiet terminals and followed logs stay open', () => {
  test.beforeAll(() => {
    kubectl(`-n ${NS} run ${POD} --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --command -- sh -c 'for i in 1 2 3 4 5; do echo idle-line-$i; done; sleep 3600'`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`-n ${NS} delete pod ${POD} --ignore-not-found --wait=false`)
  })

  test('a terminal and the Logs tab quiet past 60 s still work and show no line twice', async ({ page, request }) => {
    test.setTimeout(QUIET_MS + 120_000)
    const since = new Date(Date.now() - 2000).toISOString()

    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15_000 })
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
    await page.locator('div.card button', { hasText: POD }).first().click()
    const area = page.locator('pre.whitespace-pre-wrap').first()
    await expect(area).toContainText('idle-line-5', { timeout: 20_000 })

    const term = await page.context().newPage()
    await term.goto('/color-mode.js')
    await openTerminal(term)
    // the shell answered (its prompt) before the quiet time starts
    await expect.poll(async () => (await terminalOn(term)).text.length, { timeout: 20_000 }).toBeGreaterThan(0)
    const quietFrom = Date.now()

    await page.waitForTimeout(QUIET_MS)

    const before = await terminalOn(term)
    expect(before.closed, `the terminal closed ${before.closed ? Math.round((before.closed.at - quietFrom) / 1000) : 0} s into the quiet time`).toBeUndefined()
    const marker = `idle-ok-${STAMP}`
    await term.evaluate((line) => (window as unknown as { __ws: WebSocket }).__ws.send(`echo ${line}\r`), marker)
    await expect.poll(async () => /(^|\n)idle-ok-[a-z0-9]+\r?\n/.test((await terminalOn(term)).text), { timeout: 15_000 }).toBe(true)
    expect((await terminalOn(term)).text).toContain(`\n${marker}`)

    // A line the pod prints after the quiet time reaches the tab over the same stream.
    kubectl(`-n ${NS} exec ${POD} -- sh -c 'echo idle-after-${STAMP} > /proc/1/fd/1'`)
    await expect(area).toContainText(`idle-after-${STAMP}`, { timeout: 15_000 })

    // Every line once, and as kubectl prints them (the tab shows the kubelet's stamp in front).
    const shown = (await area.innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
    expect(new Set(shown).size, `lines shown: ${JSON.stringify(shown)}`).toBe(shown.length)
    const printed = kubectl(`-n ${NS} logs ${POD}`).split('\n').map((l) => l.trim()).filter(Boolean)
    expect(shown.map((l) => l.replace(/^\S+\s/, ''))).toEqual(printed)

    // The stream was never opened again, so the followed log has its one row.
    const rows = (await auditRows(request, 'k8s.pod.logs.read', since)).filter((r) => r.TargetID === POD && r.After?.follow === true)
    expect(rows.map((r) => r.After)).toEqual([{ container: POD, follow: true, tail_lines: 100 }])

    await term.evaluate(() => (window as unknown as { __ws: WebSocket }).__ws.close())
    await term.close()
  })
})
