import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// The pod exec socket runs on the cluster named by ?cluster= and is authorized
// as the signed-in user: an admin gets a shell on the pod, a viewer is refused
// by the cluster's RBAC (pods/exec is not in "view"), and a pod that exists only
// on the second cluster is reached there.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'

type Frame = { channel: number; text: string }

// Opens the exec socket from the app origin (login cookie), sends `input` once
// the first output frame arrives, and resolves with the frames seen until the
// socket closes or `until` matches.
async function execFrames(page: Page, path: string, input: string, until: string): Promise<Frame[]> {
  return page.evaluate(
    ({ path, input, until }) =>
      new Promise<Frame[]>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${path}`)
        ws.binaryType = 'arraybuffer'
        const frames: Frame[] = []
        let sent = false
        const finish = () => {
          try { ws.close() } catch { /* ignore */ }
          resolve(frames)
        }
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            frames.push({ channel: 0, text: ev.data })
          } else {
            const buf = new Uint8Array(ev.data as ArrayBuffer)
            frames.push({ channel: buf[0], text: new TextDecoder().decode(buf.slice(1)) })
          }
          const all = frames.map((f) => f.text).join('')
          if (!sent && frames.some((f) => f.channel === 1)) {
            sent = true
            ws.send(input)
          }
          if (all.includes(until)) finish()
        }
        ws.onclose = () => resolve(frames)
        ws.onerror = () => resolve(frames)
        setTimeout(finish, 30_000)
      }),
    { path, input, until },
  )
}

// Opens the exec socket, types `input` once the shell answers, then drops the
// socket without "exit" — a closed tab or a lost network.
async function dropAfter(page: Page, path: string, input: string): Promise<void> {
  await page.evaluate(
    ({ path, input }) =>
      new Promise<void>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${path}`)
        ws.binaryType = 'arraybuffer'
        let sent = false
        ws.onmessage = (ev) => {
          if (sent || typeof ev.data === 'string' || new Uint8Array(ev.data as ArrayBuffer)[0] !== 1) return
          sent = true
          ws.send(input)
          setTimeout(() => { ws.close(); resolve() }, 800)
        }
        ws.onclose = () => resolve()
        ws.onerror = () => resolve()
        setTimeout(() => { ws.close(); resolve() }, 15_000)
      }),
    { path, input },
  )
}

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function kubectl(args: string[]): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KUBECONFIG } })
}

async function firstPod(request: APIRequestContext, cluster: string, namespace: string, prefix: string): Promise<string> {
  const res = await request.get(`/api/v1/cluster/namespaces/${namespace}/pods?cluster=${cluster}`)
  expect(res.ok(), `list pods in ${namespace} on ${cluster}`).toBeTruthy()
  const body = await res.json()
  const items: any[] = Array.isArray(body) ? body : body.items || body.pods || []
  const names = items.map((p) => (typeof p === 'string' ? p : p.name || p.metadata?.name || ''))
  const name = names.find((n: string) => n.startsWith(prefix))
  expect(name, `a ${prefix}* pod in ${namespace} on ${cluster}: ${names}`).toBeTruthy()
  return name as string
}

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function viewerPage(browser: Browser, request: APIRequestContext, admin: Record<string, string>) {
  const email = `e2e-exec-viewer-${Date.now()}@kubeast.local`
  const password = 'e2e-viewer-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E exec viewer', email, password } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
  expect(grant.status()).toBe(200)
  const ctx = await browser.newContext({ baseURL: BASE })
  const login = await ctx.request.post('/api/v1/auth/login', { data: { email, password } })
  expect(login.ok(), 'viewer login').toBeTruthy()
  return { id, ctx, page: await ctx.newPage() }
}

test.describe('pod exec runs as the user on the selected cluster', () => {
  test('admin gets a shell on the self cluster', async ({ page, request }) => {
    const pod = await firstPod(request, 'self', 'kubeast', 'frontend-')
    await page.goto('/')
    const frames = await execFrames(page, `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?cluster=self&command=/bin/sh`, 'hostname\r', pod)
    const out = frames.map((f) => f.text).join('')
    expect(out, `frames: ${JSON.stringify(frames)}`).toContain(pod)
  })

  test('a viewer gets no shell', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const viewer = await viewerPage(browser, request, admin)
    try {
      const pod = await firstPod(request, 'self', 'kubeast', 'frontend-')
      await viewer.page.goto('/')
      const frames = await execFrames(viewer.page, `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?cluster=self&command=/bin/sh`, 'hostname\r', 'never')
      // The Kubeast permission gate refuses the upgrade (no frames at all); a
      // user that passed it but lacks pods/exec on the cluster would see the
      // API server's forbidden message instead. Neither yields shell output.
      expect(frames.some((f) => f.channel === 1), `frames: ${JSON.stringify(frames)}`).toBeFalsy()
      expect(frames.map((f) => f.text).join('')).not.toContain(pod + '\r')
      await viewer.ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${viewer.id}`, { headers: admin })
    }
  })

  test('the exec targets the cluster in ?cluster=', async ({ page, request }) => {
    // kube-proxy pod names differ per cluster: the default cluster's pod does
    // not exist on self, so a socket that ignored ?cluster= would report it
    // missing.
    const pod = await firstPod(request, 'default', 'kube-system', 'kube-proxy-')
    await page.goto('/')
    const frames = await execFrames(page, `/api/v1/cluster/namespaces/kube-system/pods/${pod}/exec/ws?cluster=default&command=/bin/sh`, 'exit\r', 'never')
    const out = frames.map((f) => f.text).join('')
    expect(out, `frames: ${JSON.stringify(frames)}`).not.toMatch(/not found/i)
    expect(out).not.toMatch(/forbidden/i)
  })

  // Re-QA #63: a terminal that went away without "exit" left /bin/sh (and
  // whatever it was running) in the container — the runtime does not end an
  // exec process when its client leaves. The server now hangs the shell up.
  test('a terminal dropped without exit leaves no shell in the container', async ({ page, request }) => {
    const pod = await firstPod(request, 'self', 'kubeast', 'frontend-')
    const left = () =>
      kubectl(['-n', 'kubeast', 'exec', pod, '--', 'ps', '-o', 'args'])
        .split('\n')
        .filter((l) => /^(\/bin\/)?sh$/.test(l.trim()) || l.includes('sleep 4321'))
    const before = left().length
    await page.goto('/')
    for (let i = 0; i < 3; i++) {
      await dropAfter(page, `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?cluster=self&command=/bin/sh`, 'sleep 4321\r')
    }
    await expect.poll(() => left().length, { timeout: 15_000, message: 'shells and their jobs after three dropped terminals' }).toBe(before)
  })
})
