import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Terminal session recording: with sessionRecording on (the dev kind install
// records into the S3 stand-in), a pod exec prints a "recorded" notice with
// the recording id, the output lands in an asciicast that admins replay or
// read as text — each read audited — and the exec audit row carries the id.
// Non-admins cannot list or read recordings.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const stamp = () => Date.now().toString(36)

type Frame = { channel: number; text: string }

// Opens the exec socket from the app origin (login cookie), sends each input
// after the previous `until` text shows up, and resolves when the last one
// shows up or the socket closes.
async function execSession(page: Page, path: string, steps: { send: string; until: string }[]): Promise<Frame[]> {
  return page.evaluate(
    ({ path, steps }) =>
      new Promise<Frame[]>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${path}`)
        ws.binaryType = 'arraybuffer'
        const frames: Frame[] = []
        let step = -1
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
          if (step === -1 && frames.some((f) => f.channel === 1)) {
            step = 0
            ws.send(steps[0].send)
            return
          }
          if (step >= 0 && all.split(steps[step].until).length > 2) {
            // the text appears twice: the echoed command and its output
            step++
            if (step >= steps.length) return finish()
            ws.send(steps[step].send)
          }
        }
        ws.onclose = () => resolve(frames)
        ws.onerror = () => resolve(frames)
        setTimeout(finish, 30_000)
      }),
    { path, steps },
  )
}

async function firstPod(request: APIRequestContext, namespace: string, prefix: string): Promise<string> {
  const res = await request.get(`/api/v1/cluster/namespaces/${namespace}/pods?cluster=self`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const items: any[] = Array.isArray(body) ? body : body.items || body.pods || []
  const name = items.map((p) => (typeof p === 'string' ? p : p.name || p.metadata?.name || '')).find((n: string) => n.startsWith(prefix))
  expect(name, `a ${prefix}* pod`).toBeTruthy()
  return name as string
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return (await res.json()).access_token
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Requested-With': 'XMLHttpRequest' })

async function recordingOn(request: APIRequestContext): Promise<boolean> {
  const res = await request.get('/api/v1/cluster/recordings/config')
  return res.ok() && !!(await res.json()).enabled
}

// One recorded exec shared by the tests below (serial suite).
let recordingId = ''
let marker = ''

test.describe.serial('session recording', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await recordingOn(request)), 'session recording is off on this installation')
  })

  test('an exec is recorded: notice, uploaded asciicast, transcript, audit rows', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pod = await firstPod(request, 'kubeast', 'frontend-')
    marker = `kubeast-rec-${stamp()}`
    await page.goto('/')
    const frames = await execSession(page, `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?cluster=self&command=/bin/sh&cols=100&rows=30`, [
      { send: `echo ${marker}\r`, until: marker },
    ])
    const out = frames.map((f) => f.text).join('')
    const m = out.match(/This session is recorded \(([0-9a-f-]{36})\)/)
    expect(m, `notice in: ${out.slice(0, 300)}`).toBeTruthy()
    recordingId = m![1]

    // the session ended with the socket: the rest is uploaded right away
    await expect
      .poll(async () => (await (await request.get(`/api/v1/cluster/recordings/${recordingId}`, { headers: bearer(admin) })).json()).status, { timeout: 30_000 })
      .toBe('uploaded')
    const meta = await (await request.get(`/api/v1/cluster/recordings/${recordingId}`, { headers: bearer(admin) })).json()
    expect(meta).toMatchObject({ kind: 'exec', cluster: 'self', namespace: 'kubeast', target: pod, user_email: ADMIN_EMAIL, storage: 's3' })
    expect(meta.parts).toBeGreaterThan(0)

    const cast = await request.get(`/api/v1/cluster/recordings/${recordingId}/cast`, { headers: bearer(admin) })
    expect(cast.status()).toBe(200)
    expect(cast.headers()['content-type']).toContain('application/x-asciicast')
    const lines = (await cast.text()).trim().split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 100, height: 30 })
    expect(lines.slice(1).every((l) => Array.isArray(JSON.parse(l)))).toBe(true)
    expect(lines.join('\n')).toContain(marker)

    const text = await (await request.get(`/api/v1/cluster/recordings/${recordingId}/cast?format=text`, { headers: bearer(admin) })).text()
    expect(text).toContain(`echo ${marker}`)
    expect(text).not.toContain('\u001b[')

    const audit = async (action: string) =>
      ((await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=20`, { headers: bearer(admin) })).json()).items ?? []) as any[]
    const exec = (await audit('k8s.pod.exec')).find((i) => (i.After ?? i.after)?.recording_id === recordingId)
    expect(exec, 'k8s.pod.exec row carries the recording id').toBeTruthy()
    const reads = (await audit('admin.session.read')).filter((i) => (i.TargetID ?? i.target_id) === recordingId)
    expect(reads.length, 'cast + text reads are audited').toBeGreaterThanOrEqual(2)
    expect(reads.some((i) => (i.After ?? i.after)?.format === 'text')).toBe(true)
  })

  test('Admin → Session recordings lists it and replays it; the audit row links to it', async ({ page }) => {
    test.skip(!recordingId, 'needs the recording from the previous test')
    await page.goto('/admin/session-recordings')
    const row = page.getByTestId(`recording-row-${recordingId}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await page.getByTestId(`recording-play-${recordingId}`).click()
    const modal = page.getByTestId('recording-player-modal')
    await expect(modal).toBeVisible()
    await expect(modal.locator('.ap-player, .ap-wrapper').first()).toBeVisible({ timeout: 15_000 })
    // Playback, not just the player: the terminal is WebAssembly and only runs when the gateway's CSP lets it compile.
    await expect(modal.locator('.ap-overlay-start')).toHaveCount(0, { timeout: 15_000 })
    await expect(modal.locator('.ap-timer')).toHaveText(/\d\d:\d\d/, { timeout: 15_000 })
    await expect(page.getByTestId('recording-download-text')).toHaveAttribute('href', new RegExp(`${recordingId}/cast\\?format=text`))
    await page.keyboard.press('Escape')

    await page.goto('/admin/audit')
    const play = page.getByTestId(`audit-play-${recordingId}`)
    await expect(play).toBeVisible({ timeout: 15_000 })
    await play.click()
    await expect(page.getByTestId('recording-player-modal')).toBeVisible()
  })

  test('a non-admin cannot list or read recordings', async ({ request }) => {
    test.skip(!recordingId, 'needs the recording from the previous test')
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-rec-reader-${stamp()}@example.com`
    const pw = 'E2e-rec-pass1!'
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const roles = Array.isArray(raw) ? raw : raw.roles || raw.items || []
    const member = roles.find((r: any) => r.name === 'Member')
    const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E rec reader', email, password: pw, role_id: member.id } })
    expect(made.status()).toBe(201)
    const userId = (await made.json()).id
    try {
      await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Write' } })
      const user = await login(request, email, pw)
      expect((await request.get('/api/v1/cluster/recordings', { headers: bearer(user) })).status()).toBe(403)
      expect((await request.get(`/api/v1/cluster/recordings/${recordingId}/cast`, { headers: bearer(user) })).status()).toBe(403)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
