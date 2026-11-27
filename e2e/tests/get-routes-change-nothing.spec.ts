import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect } from '@playwright/test'
import { sessionToken } from './session-token'
import { getRoutes } from './get-routes'

// Every GET route, called by an admin, leaves the cluster's objects, the database's row counts and the audit log's writes as they were.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const UA = 'kubeast-e2e-get-routes'
const NS = `e2e-getroutes-${Date.now().toString(36)}`

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-getroutes-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim()
const tryKubectl = (args: string[]) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])
const quote = (s: string) => `'${s.split("'").join("''")}'`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The sensitive reads, which write their row by design (docs/audit-log-plan.md D1), and the refusals of one.
const READ_ROWS = new Set([
  'admin.audit.read', 'admin.audit.export', 'admin.review.read', 'admin.review.export', 'admin.oidc.groups.read', 'admin.session.read',
  'admin.hygiene.read', 'admin.hygiene.export', 'k8s.hygiene.scan', 'k8s.secret.reveal', 'helm.release.reveal', 'k8s.pod.logs.read',
  'k8s.pod.logs.search', 'k8s.pod.logs.logql', 'k8s.traces.query', 'k8s.networkflows.query', 'k8s.pod.logfile.read', 'ai.investigation.view',
  'k8s.cluster.kubeconfig.read', 'k8s.access.denied', 'admin.access.denied',
])

const FIXTURE = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: e2e-getroutes, namespace: ${NS}}
spec:
  podSelector: {matchLabels: {app: e2e-getroutes}}
  policyTypes: [Ingress]
`

function fixture() {
  kubectl(['create', 'namespace', NS])
  kubectl(['-n', NS, 'create', 'configmap', 'e2e-getroutes', '--from-literal=a=1'])
  kubectl(['-n', NS, 'create', 'secret', 'generic', 'e2e-getroutes', '--from-literal=b=2'])
  kubectl(['-n', NS, 'create', 'serviceaccount', 'e2e-getroutes'])
  kubectl(['-n', NS, 'create', 'role', 'e2e-getroutes', '--verb=get', '--resource=configmaps'])
  kubectl(['-n', NS, 'create', 'rolebinding', 'e2e-getroutes', '--role=e2e-getroutes', `--serviceaccount=${NS}:e2e-getroutes`])
  kubectl(['-n', NS, 'create', 'deployment', 'e2e-getroutes', '--image=docker.io/library/busybox:1.38.0', '--', 'sleep', '3600'])
  kubectl(['-n', NS, 'create', 'service', 'clusterip', 'e2e-getroutes', '--tcp=80:80'])
  kubectl(['apply', '-f', '-'], FIXTURE)
  kubectl(['-n', NS, 'rollout', 'status', 'deployment/e2e-getroutes', '--timeout=180s'])
}

type Snapshot = { objects: Map<string, string>; rows: Map<string, string> }

function objects(): Map<string, string> {
  const out = new Map<string, string>()
  const add = (json: string | null, from: string) => {
    if (json === null) return out.set(from, 'unreadable')
    const body = JSON.parse(json)
    for (const o of body.items ?? [body]) out.set(`${o.kind}/${o.metadata.namespace ?? ''}/${o.metadata.name}`, o.metadata.resourceVersion)
  }
  add(tryKubectl(['-n', NS, 'get', 'configmaps,secrets,serviceaccounts,roles,rolebindings,services,networkpolicies,deployments,replicasets,pods', '-o', 'json']), NS)
  add(tryKubectl(['get', 'namespace', NS, '-o', 'json']), `namespace ${NS}`)
  add(tryKubectl(['-n', 'kubeast', 'get', 'configmaps,secrets', '-o', 'json']), 'kubeast')
  add(tryKubectl(['get', 'modelconfigs.ai.kubeast.io', '-A', '-o', 'json']), 'modelconfigs')
  return out
}

function rows(): Map<string, string> {
  const tables = psql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'auth_audit_logs' ORDER BY 1`).split('\n').filter(Boolean)
  const counts = psql(tables.map((t) => `SELECT ${quote(t)}, count(*) FROM "${t}"`).join(' UNION ALL '))
  return new Map(counts.split('\n').filter(Boolean).map((l) => l.split('|') as [string, string]))
}

const snapshot = (): Snapshot => ({ objects: objects(), rows: rows() })

function changed(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => `${k}: ${a.get(k) ?? 'none'} -> ${b.get(k) ?? 'none'}`)
}

test.afterAll(() => {
  tryKubectl(['delete', 'namespace', NS, '--wait=false'])
})

test('every GET route answers without changing the objects, the row counts or the audit log', async ({ request }, testInfo) => {
  test.setTimeout(900_000)
  const login = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.ok(), `login ${ADMIN_EMAIL}`).toBeTruthy()
  const headers = { Authorization: `Bearer ${sessionToken(login)}`, 'User-Agent': UA }
  fixture()
  const { called, leftOut } = getRoutes(NS)
  expect(called.length, 'GET routes read from the services').toBeGreaterThan(150)

  const quiet = snapshot()
  await sleep(15_000)
  const before = snapshot()
  const noisy = new Set([...changed(quiet.objects, before.objects), ...changed(quiet.rows, before.rows)].map((c) => c.split(': ')[0]))
  const auditFrom = Number(psql('SELECT coalesce(max(id), 0) FROM auth_audit_logs'))

  const statuses: Record<string, number | string> = {}
  for (const route of called) {
    try {
      const res = await request.get(route, { headers, failOnStatusCode: false, maxRedirects: 0, timeout: 30_000 })
      statuses[route] = res.status()
      await res.dispose()
    } catch (e) {
      statuses[route] = `no answer: ${String(e).split('\n')[0]}`
    }
  }
  await sleep(5_000)
  const after = snapshot()

  const objectChanges = changed(before.objects, after.objects).filter((c) => !noisy.has(c.split(': ')[0]))
  const rowChanges = changed(before.rows, after.rows).filter((c) => !noisy.has(c.split(': ')[0]))
  const auditRows = psql(`SELECT id, action, result, coalesce(path, '') FROM auth_audit_logs WHERE id > ${auditFrom} AND (user_agent = ${quote(UA)} OR actor_email = ${quote(ADMIN_EMAIL)}) ORDER BY id`)
    .split('\n').filter(Boolean).map((l) => l.split('|'))
  const writes = auditRows.filter(([, action]) => !READ_ROWS.has(action)).map((r) => r.join(' '))
  await testInfo.attach('get-routes.json', {
    body: JSON.stringify({ namespace: NS, statuses, leftOut, noisy: [...noisy], audit: auditRows.map((r) => r.join(' ')) }, null, 2),
    contentType: 'application/json',
  })

  const answered = Object.values(statuses).filter((s) => typeof s === 'number' && s >= 200 && s < 300).length
  expect(statuses['/api/v1/auth/me?cluster=self'], 'the admin is signed in').toBe(200)
  expect(answered, `routes answered 2xx of ${called.length}`).toBeGreaterThan(called.length / 2)
  expect(objectChanges, 'objects whose resourceVersion moved').toEqual([])
  expect(rowChanges, 'tables whose row count moved').toEqual([])
  expect(writes, 'audit rows of an action that is not a read').toEqual([])
})
