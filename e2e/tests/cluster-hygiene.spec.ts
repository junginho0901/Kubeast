import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Cluster hygiene report (Admin → Cluster hygiene): the spec makes a namespace
// on the dev cluster `self` with a pod that breaks several checks and a TLS
// Secret that expires in five days, then reads the report through the API and
// the page, exempts a finding by annotation, exports CSV/JSON, signs off and
// opens the sign-off. Objects are created with kubectl against the kind
// cluster only (refuses any non-kind context) and removed in finally.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const stamp = Date.now().toString(36)
const NS = `e2e-hygiene-${stamp}`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : process.env.KUBECONFIG || ''
function kubectl(args: string[], input?: string): string {
  if (!KUBECONFIG) throw new Error('no kind kubeconfig (.kubeconfig-kind or KUBECONFIG): refusing to run kubectl against the default kubeconfig')
  const run = (a: string[], stdin?: string) =>
    execFileSync('kubectl', a, { env: { ...process.env, KUBECONFIG }, encoding: 'utf8', input: stdin, maxBuffer: 16 << 20 }).trim()
  const ctx = run(['config', 'current-context'])
  if (!ctx.startsWith('kind-')) throw new Error(`refusing to run kubectl against context ${ctx}`)
  return run(args, input)
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type Finding = { check: string; severity: string; kind: string; namespace?: string; name: string; message: string; exempt?: boolean; exempt_reason?: string }

async function report(request: APIRequestContext, admin: string) {
  const res = await request.get(`/api/v1/cluster/hygiene?cluster=${CLUSTER}`, { headers: bearer(admin) })
  expect(res.ok(), `hygiene: ${res.status()} ${await res.text()}`).toBeTruthy()
  return (await res.json()) as { cluster: string; report: { checks: { id: string }[]; findings: Finding[]; collectors: unknown[]; excluded_namespaces: string[] } }
}

function shortLivedCert(dir: string): { crt: string; key: string } {
  const crt = path.join(dir, 'tls.crt')
  const key = path.join(dir, 'tls.key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '5', '-subj', '/CN=e2e-hygiene.example.com', '-keyout', key, '-out', crt], { stdio: 'ignore' })
  return { crt, key }
}

test.describe('cluster hygiene report', () => {
  test('a namespace with problems shows up in the report, an annotation exempts it, export and sign-off work', async ({ page, request }) => {
    test.setTimeout(180_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get(`/api/v1/cluster/hygiene/config?cluster=${CLUSTER}`, { headers: bearer(admin) })
    test.skip(!config.ok() || !(await config.json()).enabled, 'cluster hygiene report is off (features.hygiene.enabled)')
    const since = new Date(Date.now() - 1000).toISOString()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'))
    try {
      await test.step('make a namespace that breaks checks', async () => {
        kubectl(['create', 'namespace', NS])
        kubectl(['apply', '-n', NS, '-f', '-'], JSON.stringify({
          apiVersion: 'v1', kind: 'Pod', metadata: { name: 'untidy', namespace: NS },
          spec: {
            containers: [{ name: 'app', image: 'kubeast/e2e-hygiene-untagged', imagePullPolicy: 'Never', volumeMounts: [{ name: 'host', mountPath: '/host' }] }],
            volumes: [{ name: 'host', hostPath: { path: '/tmp' } }],
          },
        }))
        const { crt, key } = shortLivedCert(dir)
        kubectl(['create', 'secret', 'tls', 'expiring', '-n', NS, `--cert=${crt}`, `--key=${key}`])
      })

      await test.step('the report lists them, and leaves the excluded namespaces out', async () => {
        const body = await report(request, admin)
        expect(body.cluster).toBe(CLUSTER)
        expect(body.report.checks).toHaveLength(17)
        expect(body.report.collectors).toEqual([])
        expect(body.report.excluded_namespaces).toContain('kube-system')
        expect(body.report.findings.some((f) => f.namespace === 'kube-system')).toBeFalsy()
        const mine = body.report.findings.filter((f) => f.namespace === NS || (f.kind === 'Namespace' && f.name === NS))
        const checks = new Set(mine.map((f) => f.check))
        for (const c of ['image.latest', 'resources.memory-limit', 'pss.hostpath', 'pss.restricted', 'ns.pss-label', 'ns.network-policy', 'tls.expiry']) {
          expect(checks.has(c), `${c} in ${JSON.stringify(mine)}`).toBeTruthy()
        }
        const tls = mine.find((f) => f.check === 'tls.expiry')!
        expect(tls.severity).toBe('critical')
        expect(tls.message).toMatch(/expires \d{4}-\d{2}-\d{2} \([45] days\) · e2e-hygiene\.example\.com/)
        expect(JSON.stringify(mine)).not.toContain('PRIVATE KEY')
      })

      await test.step('an exemption needs a reason; with one the finding is marked exempt', async () => {
        kubectl(['annotate', 'pod', 'untidy', '-n', NS, 'kubeast.io/hygiene-exempt=image.latest'])
        let f = (await report(request, admin)).report.findings.find((x) => x.namespace === NS && x.check === 'image.latest')!
        expect(f.exempt ?? false).toBeFalsy()
        expect(f.message).toContain('without kubeast.io/hygiene-exempt-reason')
        kubectl(['annotate', 'pod', 'untidy', '-n', NS, 'kubeast.io/hygiene-exempt-reason=e2e test image'])
        f = (await report(request, admin)).report.findings.find((x) => x.namespace === NS && x.check === 'image.latest')!
        expect(f.exempt).toBeTruthy()
        expect(f.exempt_reason).toBe('e2e test image')
      })

      await test.step('CSV and JSON exports', async () => {
        const csv = await request.get(`/api/v1/cluster/hygiene?cluster=${CLUSTER}&format=csv`, { headers: bearer(admin) })
        expect(csv.ok()).toBeTruthy()
        expect(csv.headers()['content-type']).toContain('text/csv')
        expect(csv.headers()['content-disposition']).toContain(`hygiene-${CLUSTER}-`)
        const text = (await csv.text()).trimStart() // drops the UTF-8 BOM
        expect(text.split('\r\n')[0]).toBe('check,severity,kind,namespace,name,container,pods,message,exempt,exempt_reason,refs,generated_at')
        expect(text).toContain(`tls.expiry,critical,Secret,${NS},expiring`)
        const json = await request.get(`/api/v1/cluster/hygiene?cluster=${CLUSTER}&format=json`, { headers: bearer(admin) })
        expect(json.ok()).toBeTruthy()
        expect((await json.json()).cluster).toBe(CLUSTER)
      })

      await test.step('the page shows the report; sign off and open the sign-off', async () => {
        await page.goto('/admin/cluster-hygiene')
        await expect(page.getByRole('heading', { name: 'Cluster hygiene' })).toBeVisible()
        await expect(page.getByTestId('nav-cluster-hygiene')).toBeVisible()
        await page.getByTestId('hygiene-cluster').click()
        await page.getByTestId(`hygiene-cluster-opt-${CLUSTER}`).click()
        await page.getByPlaceholder(/Namespace/).fill(NS)
        await expect(page.getByTestId('hygiene-finding-row').first()).toBeVisible({ timeout: 30_000 })
        await page.getByTestId('hygiene-card-critical').click()
        await expect(page.getByTestId('hygiene-finding-row').filter({ hasText: 'expiring' })).toBeVisible()
        await page.getByTestId('hygiene-signoff-note').fill(`e2e ${stamp}`)
        await page.getByTestId('hygiene-signoff').click()
        await expect(page.getByTestId('hygiene-signoff-message')).toBeVisible({ timeout: 30_000 })
        await page.getByTestId('hygiene-tab-history').click()
        const row = page.getByTestId('hygiene-history-row').filter({ hasText: `e2e ${stamp}` })
        await expect(row).toBeVisible()
        await row.getByRole('button').click()
        await expect(page.getByTestId('hygiene-snapshot-banner')).toBeVisible()
      })

      await test.step('every step left its audit row', async () => {
        for (const action of ['k8s.hygiene.scan', 'admin.hygiene.export', 'admin.hygiene.signoff', 'admin.hygiene.read']) {
          const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: 50 } })
          expect(res.ok()).toBeTruthy()
          const { items } = (await res.json()) as { items: Array<Record<string, any>> }
          expect(items.length, `${action} audited`).toBeGreaterThan(0)
          // Opening the page scans the header's cluster first, so scan rows may name another cluster too.
          expect(items.some((r) => (r.Cluster ?? r.cluster) === CLUSTER), `${action} carries the cluster`).toBeTruthy()
        }
      })
    } finally {
      try {
        kubectl(['delete', 'namespace', NS, '--wait=false', '--ignore-not-found'])
      } catch {
        /* leave it to the next reset */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a cluster role alone does not open the report', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-hygiene-${stamp}@kubeast.local`
    const password = 'e2e-hygiene-throwaway'
    let userId = ''
    try {
      const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const member = ((Array.isArray(roles) ? roles : roles.items) as Array<{ id: number; name: string }>).find((r) => r.name === 'Member')!
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E hygiene', email, password, role_id: member.id } })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Write' } })
      expect(grant.ok()).toBeTruthy()
      const user = await login(request, email, password)
      for (const path of ['/api/v1/cluster/hygiene', '/api/v1/cluster/hygiene?format=csv', '/api/v1/cluster/hygiene/history']) {
        const res = await request.get(`${path}${path.includes('?') ? '&' : '?'}cluster=${CLUSTER}`, { headers: bearer(user), failOnStatusCode: false })
        expect(res.status(), path).toBe(403)
      }
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
