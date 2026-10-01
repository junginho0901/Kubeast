import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// The audit database is a precondition for sensitive actions (AUDIT_FAIL_CLOSED,
// default on): while Postgres cannot store the row, a Secret reveal, a pod log
// read, a create and a delete are refused with 503 "audit unavailable" and
// nothing happens on the cluster; lists keep working. When Postgres is back the
// same calls succeed and the reveal is recorded. The outage is real: the dev
// cluster's postgres Deployment is scaled to 0 and back with kubectl.
//
// The admin token is used once before the outage so k8s-service has its
// token-version cached (that check is fail-closed too, with a stale window
// longer than this test).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = process.env.E2E_CLUSTER || 'self'
const NS = 'default'
const KUBEAST_NS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const PG_DEPLOY = process.env.E2E_POSTGRES_DEPLOYMENT || 'postgres'
const STAMP = Date.now().toString(36)
const SECRET = `audit-closed-${STAMP}`
const CONFIGMAP = `audit-closed-cm-${STAMP}`

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function kubectl(args: string[], input?: string): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KUBECONFIG } })
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

const secretYamlUrl = `/api/v1/cluster/namespaces/${NS}/secrets/${SECRET}/yaml?cluster=${CLUSTER}`
const configMapYaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CONFIGMAP}
  namespace: ${NS}
data:
  k: v
`

// Serial: the second test needs the outage of the first. A stopped Postgres
// takes up to its termination grace period to go away, hence the long budget.
test.describe.configure({ mode: 'serial', timeout: 240_000 })

// Stop Postgres: scale to 0 so it stays down, and kill the running pod at once
// so the outage starts now rather than after the grace period.
function stopPostgres() {
  kubectl(['-n', KUBEAST_NS, 'scale', `deploy/${PG_DEPLOY}`, '--replicas=0'])
  kubectl(['-n', KUBEAST_NS, 'delete', 'pod', '-l', `app=${PG_DEPLOY}`, '--grace-period=0', '--force', '--ignore-not-found', '--wait=false'])
}

function startPostgres() {
  kubectl(['-n', KUBEAST_NS, 'scale', `deploy/${PG_DEPLOY}`, '--replicas=1'])
  kubectl(['-n', KUBEAST_NS, 'rollout', 'status', `deploy/${PG_DEPLOY}`, '--timeout=120s'])
}

test.describe('audit database down: sensitive actions are refused, reads continue', () => {
  let headers: Record<string, string> = {}
  let logPod = ''

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: `Bearer ${await adminToken(request)}` }
    kubectl(['-n', NS, 'create', 'secret', 'generic', SECRET, `--from-literal=password=p-${STAMP}`])
    logPod = kubectl(['-n', KUBEAST_NS, 'get', 'pods', '-l', 'app=redis', '-o', 'jsonpath={.items[0].metadata.name}']).trim()
    expect(logPod, 'a redis pod to read logs from').not.toBe('')
    // Baseline + token-version cache warm-up: the reveal works with the database up.
    const warm = await request.get(secretYamlUrl, { headers })
    expect(warm.status(), await warm.text()).toBe(200)
  })

  test.afterAll(async () => {
    // Bring the database back whatever happened, then clean up.
    try { startPostgres() } catch {}
    try { kubectl(['-n', NS, 'delete', 'secret', SECRET, '--ignore-not-found']) } catch {}
    try { kubectl(['-n', NS, 'delete', 'configmap', CONFIGMAP, '--ignore-not-found']) } catch {}
  })

  test('with Postgres gone: reveal, logs, create and delete answer 503; lists still work', async ({ request }) => {
    stopPostgres()
    // The pool's connections die with the pod; the gate sees it on its next ping.
    await expect.poll(async () => (await request.get(secretYamlUrl, { headers })).status(), {
      timeout: 120_000, intervals: [1000],
    }).toBe(503)
    const refused = await request.get(secretYamlUrl, { headers })
    expect((await refused.json()).detail).toMatch(/^audit unavailable/)

    const list = await request.get(`/api/v1/cluster/namespaces?cluster=${CLUSTER}`, { headers })
    expect(list.status(), await list.text()).toBe(200)
    const pods = await request.get(`/api/v1/cluster/namespaces/${KUBEAST_NS}/pods?cluster=${CLUSTER}`, { headers })
    expect(pods.status(), await pods.text()).toBe(200)

    const logs = await request.get(`/api/v1/cluster/namespaces/${KUBEAST_NS}/pods/${logPod}/logs?cluster=${CLUSTER}&tail_lines=5`, { headers })
    expect(logs.status(), await logs.text()).toBe(503)

    const describe = await request.get(`/api/v1/cluster/resources/describe?cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}&resource_name=${SECRET}`, { headers })
    expect(describe.status(), await describe.text()).toBe(503)

    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers, data: { yaml: configMapYaml, namespace: NS } })
    expect(create.status(), await create.text()).toBe(503)
    expect((await create.json()).detail).toMatch(/^audit unavailable/)
    expect(() => kubectl(['-n', NS, 'get', 'configmap', CONFIGMAP])).toThrow()

    const del = await request.delete(`/api/v1/cluster/namespaces/${NS}/secrets/${SECRET}?cluster=${CLUSTER}`, { headers })
    expect(del.status(), await del.text()).toBe(503)
    expect(kubectl(['-n', NS, 'get', 'secret', SECRET, '-o', 'name']).trim()).toBe(`secret/${SECRET}`)
  })

  test('with Postgres back: the same calls succeed and the reveal is recorded', async ({ request }) => {
    startPostgres()
    await expect.poll(async () => (await request.get(secretYamlUrl, { headers })).status(), {
      timeout: 120_000, intervals: [1000],
    }).toBe(200)

    const logs = await request.get(`/api/v1/cluster/namespaces/${KUBEAST_NS}/pods/${logPod}/logs?cluster=${CLUSTER}&tail_lines=5`, { headers })
    expect(logs.status(), await logs.text()).toBe(200)

    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers, data: { yaml: configMapYaml, namespace: NS } })
    expect(create.status(), await create.text()).toBe(200)
    expect(kubectl(['-n', NS, 'get', 'configmap', CONFIGMAP, '-o', 'name']).trim()).toBe(`configmap/${CONFIGMAP}`)

    // The reveal that the poll above made is in the database (auth-service reads it).
    await expect.poll(async () => {
      const audit = await request.get(`/api/v1/auth/admin/audit-logs?action=k8s.secret.reveal&limit=50`, { headers })
      if (!audit.ok()) return 'audit list ' + audit.status()
      const items = ((await audit.json()).items || []) as any[]
      return items.some((e) => e.TargetID === SECRET && e.Result === 'success') ? 'recorded' : 'missing'
    }, { timeout: 30_000, intervals: [1000] }).toBe('recorded')
  })
})
