import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Log files view (chart features.logFiles): Kubeast lists and reads files
// inside a container with a fixed ls / tail through the user's pods/exec.
// Dev values cover /var/log/app/*.log in namespace default; the fixture
// e2e-logfile-writer on self writes app.log and access.log (and a notes.txt
// the pattern must leave out) and nothing to stdout. Skips when either is
// missing.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const PASSWORD = 'e2e-logfiles-throwaway'
const LINE = /\S+ request \d+ GET \/health 200/

type Headers = Record<string, string>

async function login(request: APIRequestContext, email: string, password: string): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

// The writer pod's name, or null when the feature or the fixture is missing.
async function writerPod(request: APIRequestContext, headers: Headers): Promise<string | null> {
  const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers })).json()
  if (!features.logFiles?.enabled) return null
  const res = await request.get(`/api/v1/cluster/namespaces/default/pods?cluster=${CLUSTER}&label_selector=app%3De2e-logfile-writer`, { headers })
  if (!res.ok()) return null
  const pods = (await res.json()) as Array<{ name: string; status?: string; phase?: string }>
  const running = pods.find((p) => (p.status ?? p.phase) === 'Running') ?? pods[0]
  return running?.name ?? null
}

async function auditRows(request: APIRequestContext, admin: Headers, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: admin, params: { action: 'k8s.pod.logfile.read', since, limit: 100 } })
  expect(res.ok()).toBeTruthy()
  const { items } = (await res.json()) as { items: Array<Record<string, any>> }
  return items.map((r) => {
    const after = r.After ?? r.after
    return {
      result: (r.Result ?? r.result) as string,
      cluster: (r.Cluster ?? r.cluster) as string,
      target: (r.TargetID ?? r.target_id) as string,
      after: (typeof after === 'string' ? JSON.parse(after) : after) as { path: string; lines: number; follow: boolean; container: string },
    }
  })
}

test.describe('Log files view', () => {
  test('API: list, last lines, refusals, and an audit row per read', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pod = await writerPod(request, admin)
    test.skip(!pod, 'features.logFiles is off or the e2e-logfile-writer fixture is missing')
    const since = new Date(Date.now() - 1000).toISOString()
    const base = `/api/v1/cluster/namespaces/default/pods/${pod}/logfiles`
    const get = (path: string, params: Record<string, string | number>) =>
      request.get(path, { headers: admin, params: { cluster: CLUSTER, container: 'app', ...params }, failOnStatusCode: false })

    await test.step('the list holds the matching files only', async () => {
      const res = await get(base, {})
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.files.map((f: { path: string }) => f.path)).toEqual(['/var/log/app/access.log', '/var/log/app/app.log'])
      expect(body.patterns).toEqual(['/var/log/app/*.log'])
    })

    await test.step('content returns exactly the asked lines, capped at the maximum', async () => {
      const res = await get(`${base}/content`, { path: '/var/log/app/app.log', lines: 3 })
      expect(res.status()).toBe(200)
      const body = await res.json()
      const lines = (body.content as string).trimEnd().split('\n')
      expect(lines).toHaveLength(3)
      for (const l of lines) expect(l).toMatch(LINE)
      const capped = await (await get(`${base}/content`, { path: '/var/log/app/app.log', lines: 999999 })).json()
      expect(capped.lines).toBe(2000)
    })

    await test.step('paths outside the patterns, a missing file and an unlisted namespace are refused', async () => {
      for (const [path, status, reason] of [
        ['/etc/passwd', 400, 'path'],
        ['/var/log/app/../../../etc/passwd', 400, 'path'],
        ['/var/log/app/notes.txt', 400, 'path'], // exists, not covered
        ['/var/log/app/missing.log', 404, 'no_file'],
      ] as const) {
        const res = await get(`${base}/content`, { path })
        expect(res.status(), path).toBe(status)
        expect((await res.json()).reason, path).toBe(reason)
      }
      const stream = await get(`${base}/stream`, { path: '/var/log/app/missing.log' })
      expect(stream.status(), 'a stream of a missing file is a plain 404, not an event stream').toBe(404)
      const sys = await (await request.get(`/api/v1/cluster/namespaces/kube-system/pods?cluster=${CLUSTER}`, { headers: admin })).json()
      const sysPod = (sys as Array<{ name: string }>)[0]?.name
      expect(sysPod).toBeTruthy()
      const res = await request.get(`/api/v1/cluster/namespaces/kube-system/pods/${sysPod}/logfiles`, { headers: admin, params: { cluster: CLUSTER }, failOnStatusCode: false })
      expect(res.status(), 'kube-system is not in features.logFiles.namespaces').toBe(403)
      expect((await res.json()).reason).toBe('namespace')
    })

    await test.step('each read left a row: success for the content, failure for each refusal, none for the list', async () => {
      const rows = (await auditRows(request, admin, since)).filter((r) => r.target === pod)
      expect(rows.every((r) => r.cluster === CLUSTER)).toBeTruthy()
      const ok = rows.filter((r) => r.result === 'success')
      expect(ok.some((r) => r.after.path === '/var/log/app/app.log' && r.after.lines === 3 && r.after.follow === false)).toBeTruthy()
      const failed = rows.filter((r) => r.result === 'failure').map((r) => r.after.path)
      for (const p of ['/etc/passwd', '/var/log/app/notes.txt', '/var/log/app/missing.log']) expect(failed, p).toContain(p)
    })
  })

  test('roles: Read reads in a listed namespace, a role without the permission gets 403', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pod = await writerPod(request, admin)
    test.skip(!pod, 'features.logFiles is off or the e2e-logfile-writer fixture is missing')
    const ts = Date.now()
    const email = `e2e-logfiles-${ts}@kubeast.local`
    let userId = ''
    let customRoleId: number | undefined
    try {
      const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      const member = ((Array.isArray(roles) ? roles : roles.items) as Array<{ id: number; name: string }>).find((r) => r.name === 'Member')
      const created = await request.post('/api/v1/auth/admin/users', {
        headers: admin,
        data: { name: 'E2E log files', email, password: PASSWORD, role_id: member!.id },
      })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id as string
      const grant = async (role: string) => {
        const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: admin, data: { role } })
        expect(res.ok(), `grant ${role}: ${await res.text()}`).toBeTruthy()
        return login(request, email, PASSWORD)
      }
      const content = (headers: Headers) =>
        request.get(`/api/v1/cluster/namespaces/default/pods/${pod}/logfiles/content`, {
          headers,
          params: { cluster: CLUSTER, container: 'app', path: '/var/log/app/app.log', lines: 2 },
          failOnStatusCode: false,
        })

      // Read: the permission is in the role, and the chart's RoleBinding gives
      // kubeast:viewer pods/exec in default — the read goes through.
      const read = await grant('Read')
      const res = await content(read)
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()).content as string).trimEnd().split('\n')).toHaveLength(2)

      // A custom role with every read but not resource.pod.logfile: refused by Kubeast before any exec.
      const role = await request.post('/api/v1/auth/admin/roles', {
        headers: admin,
        data: { name: `e2e-logfiles-${ts}`, description: 'e2e', permissions: ['menu.workloads', 'resource.*.read'] },
      })
      expect(role.status(), await role.text()).toBe(201)
      customRoleId = (await role.json()).id as number
      const custom = await grant(`e2e-logfiles-${ts}`)
      const refused = await content(custom)
      expect(refused.status()).toBe(403)
      expect((await refused.json()).detail).toContain('resource.pod.logfile')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
      if (customRoleId) await request.delete(`/api/v1/auth/admin/roles/${customRoleId}`, { headers: admin, failOnStatusCode: false })
    }
  })

  // Highest request number on screen: the writer counts up every 2 s.
  async function lastRequestNumber(page: Page): Promise<number> {
    const text = await page.getByTestId('logfile-output').innerText()
    const nums = [...text.matchAll(/request (\d+) GET/g)].map((m) => Number(m[1]))
    return nums.length ? Math.max(...nums) : 0
  }

  test('UI: the cluster view Logs tab switches to log files, reads and follows', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pod = await writerPod(request, admin)
    test.skip(!pod, 'features.logFiles is off or the e2e-logfile-writer fixture is missing')

    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15000 })
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('e2e-logfile-writer')
    await page.locator('div.card button', { hasText: 'e2e-logfile-writer' }).first().click()

    // Container output of this app is empty — the reason the view exists. Once
    // connected the tab says so instead of loading forever.
    await expect(page.getByTestId('log-source-stdout')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('pre.whitespace-pre-wrap').first()).toContainText(/로그가 없습니다|No logs available/, { timeout: 15000 })
    await page.getByTestId('log-source-files').click()
    await expect(page.getByTestId('log-source-files')).toHaveAttribute('aria-pressed', 'true')

    // The first listed file is chosen; switch to app.log and read it.
    await expect(page.getByTestId('logfile-select')).toContainText('/var/log/app/access.log')
    await page.getByTestId('logfile-select').click()
    await page.getByRole('button', { name: '/var/log/app/app.log' }).click()
    const output = page.getByTestId('logfile-output')
    await expect(output).toContainText(LINE, { timeout: 15000 })
    await expect(page.getByText(/마스킹 없이|without masking/)).toBeVisible()
    // The newest lines are in view: the output is scrolled to its end.
    await expect
      .poll(() => output.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 5000 })
      .toBeLessThan(2)

    // Follow: new lines arrive without pressing anything.
    await page.getByTestId('logfile-follow').click()
    await expect(page.getByTestId('logfile-follow')).toHaveAttribute('aria-pressed', 'true')
    await expect(output).toContainText(LINE, { timeout: 15000 })
    const first = await lastRequestNumber(page)
    await expect.poll(() => lastRequestNumber(page), { timeout: 15000 }).toBeGreaterThan(first)
    await page.getByTestId('logfile-follow').click()
    await expect(page.getByTestId('logfile-follow')).toHaveAttribute('aria-pressed', 'false')

    // Back to container output: the stdout stream is used again.
    await page.getByTestId('log-source-stdout').click()
    await expect(page.getByTestId('logfile-output')).toHaveCount(0)
  })

  test('UI: the Pod drawer Logs section offers the same switch', async ({ page, request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const pod = await writerPod(request, admin)
    test.skip(!pod, 'features.logFiles is off or the e2e-logfile-writer fixture is missing')

    await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
    const row = page.locator('tbody:not([aria-hidden="true"]) tr', { hasText: pod! }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.click()
    await expect(page.getByTestId('pod-logs-container')).toBeVisible({ timeout: 20000 })
    await page.getByTestId('log-source-files').click()
    await expect(page.getByTestId('logfile-select')).toContainText('/var/log/app/access.log')
    await expect(page.getByTestId('logfile-output')).toContainText(/access \d+/, { timeout: 15000 })
  })
})
