import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// Audit sinks copy audit rows out of the database. The dev kind install points
// three sinks at the stand-ins in deploy/kind/devtools.yaml: dev-s3 (an
// S3-compatible store with Object Lock, every row), dev-webhook (json, only
// k8s.*.delete / access.request.* / user.apikey.*) and dev-mail (Mailpit,
// only access.request.create). The spec drives real actions through the
// gateway and reads what arrived. Skipped when the dev tools are not there.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const stamp = () => Date.now().toString(36)

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function kubectl(args: string[]): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KUBECONFIG }, maxBuffer: 64 << 20 })
}
function devtoolsReady(): boolean {
  try {
    kubectl(['-n', 'kubeast', 'get', 'configmap', 'kubeast-audit-sinks'])
    return kubectl(['-n', 'kubeast-devtools', 'get', 'deploy', 'receiver', '-o', 'jsonpath={.status.readyReplicas}']).trim() === '1'
  } catch {
    return false
  }
}
function sql(query: string): string {
  const pod = kubectl(['-n', 'kubeast', 'get', 'pod', '-l', 'app=postgres', '-o', 'jsonpath={.items[0].metadata.name}']).trim()
  return kubectl(['-n', 'kubeast', 'exec', pod, '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', query]).trim()
}
function fetchInDevtools(url: string): string {
  return kubectl(['-n', 'kubeast-devtools', 'exec', 'deploy/receiver', '--', 'python', '-c', `import urllib.request;print(urllib.request.urlopen(${JSON.stringify(url)}).read().decode())`])
}
function webhookEvents(): any[] {
  const reqs = JSON.parse(fetchInDevtools('http://127.0.0.1:8080/requests')) as { body: string }[]
  return reqs.flatMap((r) => JSON.parse(r.body).events ?? [])
}
// The S3 stand-in keeps objects as files: find the one whose id range holds id.
function s3EventsHolding(id: number): any[] {
  const keys = kubectl(['-n', 'kubeast-devtools', 'exec', 'deploy/s3', '--', 'find', '/data/objects/kubeast-audit/audit', '-name', '*.ndjson.gz']).trim().split('\n')
  const key = keys.find((k) => {
    const m = k.match(/(\d{12})-(\d{12})\.ndjson\.gz$/)
    return m && Number(m[1]) <= id && id <= Number(m[2])
  })
  if (!key) return []
  const b64 = kubectl(['-n', 'kubeast-devtools', 'exec', 'deploy/s3', '--', 'base64', key]).replace(/\s/g, '')
  return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString().trim().split('\n').map((l) => JSON.parse(l))
}
function auditId(action: string, target: string): number {
  const v = sql(`select coalesce(max(id),0) from auth_audit_logs where action='${action}' and target_id like '%${target}%'`)
  return Number(v)
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return (await res.json()).access_token
}
async function configMap(request: APIRequestContext, admin: string, name: string) {
  const made = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, {
    headers: bearer(admin),
    data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n` },
  })
  expect(made.ok(), `create ${name}`).toBeTruthy()
  const gone = await request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=${CLUSTER}`, { headers: bearer(admin) })
  expect(gone.ok(), `delete ${name}`).toBeTruthy()
}

test.describe('audit sinks', () => {
  test.beforeEach(() => {
    test.skip(!devtoolsReady(), 'dev audit sinks or deploy/kind/devtools.yaml not present')
  })

  test('a delete reaches the filtered webhook and the S3 archive; the create only the archive', async ({ request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const name = `e2e-sink-${stamp()}`
    await configMap(request, admin, name)
    await expect.poll(() => auditId('k8s.configmap.delete', name), { timeout: 15_000 }).toBeGreaterThan(0)
    const del = auditId('k8s.configmap.delete', name)

    await expect.poll(() => webhookEvents().some((e) => e.id === del), { timeout: 45_000, message: 'webhook received the delete' }).toBe(true)
    const ev = webhookEvents().find((e) => e.id === del)
    expect(ev).toMatchObject({ action: 'k8s.configmap.delete', result: 'success', actor_email: ADMIN_EMAIL, cluster: CLUSTER })
    expect(webhookEvents().some((e) => e.action === 'k8s.yaml.apply' && String(e.target_id ?? '').includes(name)), 'the create is filtered out of the webhook').toBe(false)

    await expect.poll(() => s3EventsHolding(del).some((e) => e.id === del), { timeout: 45_000, message: 'S3 object holds the delete' }).toBe(true)
    const archived = s3EventsHolding(del)
    expect(archived.every((e, i) => i === 0 || e.id > archived[i - 1].id), 'ids ascend within an object').toBe(true)
  })

  test('an access request reaches the mail sink', async ({ request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
    test.skip(!(await cfg.json()).enabled, 'access requests are off on this installation')
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const roles = Array.isArray(raw) ? raw : raw.roles || raw.items || []
    const member = roles.find((r: any) => r.name === 'Member')
    const email = `e2e-sink-${stamp()}@example.com`
    const pw = 'E2e-sink-pass1!'
    let userId = ''
    try {
      const made = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E sink', email, password: pw, role_id: member.id } })
      expect(made.status()).toBe(201)
      userId = (await made.json()).id
      await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      const user = await login(request, email, pw)
      const req = await request.post('/api/v1/auth/access-requests', {
        headers: bearer(user),
        data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason: 'e2e audit sink' },
      })
      expect(req.status()).toBe(201)
      await expect
        .poll(() => fetchInDevtools('http://mailpit:8025/api/v1/messages?limit=20').includes(email), { timeout: 45_000, message: 'Mailpit received the mail' })
        .toBe(true)
      const msgs = JSON.parse(fetchInDevtools('http://mailpit:8025/api/v1/messages?limit=20')).messages as any[]
      const mail = msgs.find((m) => JSON.stringify(m).includes(email))
      expect(mail.Subject).toContain('access.request.create')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('a receiver outage holds the cursor and the event arrives after recovery', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    try {
      kubectl(['-n', 'kubeast-devtools', 'scale', 'deploy/receiver', '--replicas=0'])
      kubectl(['-n', 'kubeast-devtools', 'wait', '--for=delete', 'pod', '-l', 'app=receiver', '--timeout=60s'])
      const name = `e2e-sink-outage-${stamp()}`
      await configMap(request, admin, name)
      await expect.poll(() => auditId('k8s.configmap.delete', name), { timeout: 15_000 }).toBeGreaterThan(0)
      const del = auditId('k8s.configmap.delete', name)
      await expect
        .poll(() => Number(sql(`select failures from audit_sink_cursors where sink_name='dev-webhook'`)), { timeout: 90_000, message: 'the send failure is recorded' })
        .toBeGreaterThan(0)
      expect(Number(sql(`select last_id from audit_sink_cursors where sink_name='dev-webhook'`)), 'cursor stays before the undelivered event').toBeLessThan(del)
      await expect.poll(() => Number(sql(`select last_id from audit_sink_cursors where sink_name='dev-s3'`)), { timeout: 45_000, message: 'the other sinks keep going' }).toBeGreaterThanOrEqual(del)

      kubectl(['-n', 'kubeast-devtools', 'scale', 'deploy/receiver', '--replicas=1'])
      kubectl(['-n', 'kubeast-devtools', 'rollout', 'status', 'deploy/receiver', '--timeout=90s'])
      await expect.poll(() => webhookEvents().some((e) => e.id === del), { timeout: 120_000, message: 'delivered after recovery' }).toBe(true)
      expect(Number(sql(`select failures from audit_sink_cursors where sink_name='dev-webhook'`))).toBe(0)
    } finally {
      kubectl(['-n', 'kubeast-devtools', 'scale', 'deploy/receiver', '--replicas=1'])
      kubectl(['-n', 'kubeast-devtools', 'rollout', 'status', 'deploy/receiver', '--timeout=90s'])
    }
  })
})
