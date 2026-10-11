import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// H3: the node shell runs only allow-listed images, in the dedicated
// privileged namespace, never in the namespace/image the client asks for.
// Re-QA #67: while the debug pod starts the terminal says why it is waiting,
// closing the terminal then deletes the pod at once, and the audit row is one
// per attempt — success once the shell is handed over, failure with the reason
// otherwise. The WebSocket is opened from the app origin so the HttpOnly login
// cookie authenticates it (no token in the URL).
//
// The dev values allow a second image that never resolves
// (registry.invalid/kubeast/e2e-missing:1, deploy/kind/values.yaml); without
// it the waiting test skips.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const SHELL_NS = 'kubeast-node-shell'
const MISSING_IMAGE = 'registry.invalid/kubeast/e2e-missing:1'

type Headers = Record<string, string>
type Row = { Action: string; Result: string; Error: string; TargetID: string; After: Record<string, any> | null }
type Status = { type: 'status'; status: string; reason?: string; message?: string }

async function firstNodeName(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/v1/cluster/nodes')
  expect(res.ok(), 'list nodes').toBeTruthy()
  const body = await res.json()
  const list: any[] = Array.isArray(body) ? body : body.items || body.nodes || []
  expect(list.length, 'at least one node').toBeGreaterThan(0)
  return typeof list[0] === 'string' ? list[0] : list[0].name || list[0].metadata?.name
}

async function adminHeaders(request: APIRequestContext): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// The node's shell rows since `since` for one image (each test uses its own).
async function shellRows(request: APIRequestContext, admin: Headers, node: string, image: string, since: string): Promise<Row[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: admin, params: { cluster: '', limit: '50', action: 'k8s.node.shell', since } })
  expect(res.ok()).toBeTruthy()
  return (((await res.json()).items || []) as Row[]).filter((r) => r.TargetID === node && r.After?.image === image)
}

async function debuggerPods(request: APIRequestContext, namespace: string): Promise<string[]> {
  const res = await request.get(`/api/v1/cluster/namespaces/${namespace}/pods`)
  expect(res.ok(), `list pods in ${namespace}`).toBeTruthy()
  const body = await res.json()
  const items: any[] = Array.isArray(body) ? body : body.items || body.pods || []
  return items.map((p) => (typeof p === 'string' ? p : p.name || p.metadata?.name || '')).filter((n) => n.startsWith('node-debugger-'))
}

// Opens the shell socket and keeps the frames: status frames (JSON text) and
// terminal output (channel 1/2). `act` runs once per frame and may send input
// or close; the promise resolves when the socket closes or after `ms`.
async function shell(page: Page, node: string, opts: { image?: string; ms: number; act: string }): Promise<{ statuses: Status[]; out: string; closedByServer: boolean }> {
  return page.evaluate(
    ({ node, image, ms, act }) =>
      new Promise<{ statuses: Status[]; out: string; closedByServer: boolean }>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const q = new URLSearchParams({ namespace: 'default', ...(image ? { image } : {}) })
        const ws = new WebSocket(`${proto}//${location.host}/api/v1/cluster/nodes/${node}/debug-shell/ws?${q}`)
        ws.binaryType = 'arraybuffer'
        const statuses: Status[] = []
        let out = ''
        let closing = false
        let sent = false
        let exited = false
        const finish = (byServer: boolean) => resolve({ statuses, out, closedByServer: byServer })
        const close = () => { closing = true; ws.close() }
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            try { statuses.push(JSON.parse(ev.data)) } catch { out += ev.data }
          } else {
            const buf = new Uint8Array(ev.data as ArrayBuffer)
            if (buf[0] === 1 || buf[0] === 2) out += new TextDecoder().decode(buf.slice(1))
          }
          const last = statuses[statuses.length - 1]
          if (act === 'hostname') {
            // after the shell answers: print the node's hostname, then leave with exit
            if (!sent && out.length > 0) { sent = true; ws.send('hostname\r') }
            if (sent && !exited && out.lastIndexOf(node) > out.indexOf('hostname')) { exited = true; ws.send('exit\r') }
          } else if (act === 'close-on-pull-error') {
            if (last?.status === 'waiting' && /ErrImagePull|ImagePullBackOff/.test(last.reason || '') && !closing) close()
          }
        }
        ws.onclose = () => finish(!closing)
        ws.onerror = () => finish(!closing)
        setTimeout(() => { close(); finish(false) }, ms)
      }),
    { node, image: opts.image, ms: opts.ms, act: opts.act },
  )
}

test.describe('node shell', () => {
  test('rejects an image that is not on the allow list, as a failure row', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const node = await firstNodeName(request)
    const since = new Date(Date.now() - 2000).toISOString()
    await page.goto('/')
    const { statuses } = await shell(page, node, { image: 'evil.example/rootkit:latest', ms: 15_000, act: 'none' })
    expect(statuses.map((s) => s.status), JSON.stringify(statuses)).toEqual(['image-rejected'])
    expect(statuses[0].message).toContain('not on the node shell allow list')
    await expect
      .poll(async () => (await shellRows(request, admin, node, 'evil.example/rootkit:latest', since)).map((r) => `${r.Result}:${r.Error.includes('not on the node shell allow list')}`), { timeout: 10_000 })
      .toEqual(['failure:true'])
  })

  test('opens a shell on the node in the dedicated namespace, then the pod goes', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await adminHeaders(request)
    const node = await firstNodeName(request)
    const since = new Date(Date.now() - 2000).toISOString()
    await page.goto('/')
    const { statuses, out, closedByServer } = await shell(page, node, { ms: 100_000, act: 'hostname' })
    const seen = statuses.map((s) => s.status)
    expect(seen[0], JSON.stringify(statuses)).toBe('waiting')
    expect(seen, JSON.stringify(statuses)).toContain('starting')
    // hostNetwork: the debug pod's hostname is the node's
    expect(out, 'the command ran on the node').toContain(node)
    expect(closedByServer, '"exit" ends the shell and the server closes the socket').toBeTruthy()

    const rows = await shellRows(request, admin, node, 'docker.io/library/busybox:1.38.0', since)
    expect(rows.map((r) => r.Result), 'one success row for the attempt').toEqual(['success'])

    await expect.poll(() => debuggerPods(request, SHELL_NS), { timeout: 15_000, message: 'debug pod deleted after exit' }).toEqual([])
    expect(await debuggerPods(request, 'default'), 'never in the namespace the client asked for').toEqual([])
  })

  test('says why the pod is waiting, and closing deletes it at once', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await adminHeaders(request)
    const node = await firstNodeName(request)
    const since = new Date(Date.now() - 2000).toISOString()
    await page.goto('/')
    const { statuses } = await shell(page, node, { image: MISSING_IMAGE, ms: 80_000, act: 'close-on-pull-error' })
    test.skip(statuses.some((s) => s.status === 'image-rejected'), `${MISSING_IMAGE} is not on this cluster's allow list (deploy/kind/values.yaml)`)
    const pull = statuses.filter((s) => s.status === 'waiting' && /ErrImagePull|ImagePullBackOff/.test(s.reason || ''))
    expect(pull.length, `a pull error reason before the 80 s cut: ${JSON.stringify(statuses)}`).toBeGreaterThan(0)
    expect(pull[0].message).toContain('e2e-missing')

    // closed while waiting: the pod goes now, not when the 90 s start limit runs out
    await expect.poll(() => debuggerPods(request, SHELL_NS), { timeout: 10_000, message: 'debug pod deleted when the terminal closed' }).toEqual([])
    await expect
      .poll(async () => (await shellRows(request, admin, node, MISSING_IMAGE, since)).map((r) => `${r.Result}:${r.Error}`), { timeout: 10_000 })
      .toEqual(['failure:closed before the shell opened'])
  })
})
