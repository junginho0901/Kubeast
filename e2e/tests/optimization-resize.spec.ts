import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Optimization → "Apply without restart" (chart features.inPlaceResize, server 1.35+): one row's values go to the
// workload's running pods through the pod resize subresource. The pod keeps running (same UID, no restart) with the
// new requests, the Deployment template stays as it was, the call is audited as k8s.pod.resize, a Read user is
// refused, and in the UI the confirm window can be cancelled without touching anything.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-resize-pass1!'
const stamp = Date.now().toString(36)
const NS = `e2e-resize-${stamp}`
const READER = `e2e-resize-reader-${stamp}@example.com`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-resize-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const run = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const apply = (manifest: object) => {
    const file = path.join(dir, `${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(manifest))
    return run(`apply -f ${file}`)
  }
  return { run, apply }
}
const { run: kubectl, apply: kubectlApply } = kubectlFor('kubeast')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E resize', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function grant(request: APIRequestContext, admin: string, userId: string, cluster: string, role: string) {
  const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role } })
  expect(res.ok(), `grant ${role} on ${cluster}`).toBeTruthy()
}

async function auditRows(request: APIRequestContext, admin: string, action: string) {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=50`, { headers: bearer(admin) })
  return ((await res.json()).items ?? []) as any[]
}

const resizeBody = { kind: 'Deployment', name: 'web', container: 'app', cpu_request_m: 75, mem_request_bytes: 48 * 1024 * 1024 }

test.describe('optimization in-place resize', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let readerId = ''
  let podName = ''
  let podUID = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: bearer(admin) })).json()
    test.skip(!features.inPlaceResize?.enabled || !features.inPlaceResize?.serverSupports, 'in-place resize is off (features.inPlaceResize) or the server is older than 1.35')

    // The same image and command as the dev fixture, so nothing has to be pulled.
    const fixture = JSON.parse(kubectl('get deploy e2e-argo-managed -n default -o json')).spec.template.spec.containers[0]
    kubectl(`create namespace ${NS}`)
    kubectlApply({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: NS },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'web' } },
        template: {
          metadata: { labels: { app: 'web' } },
          spec: { containers: [{
            name: 'app', image: fixture.image, imagePullPolicy: fixture.imagePullPolicy, command: fixture.command, args: fixture.args,
            resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
          }] },
        },
      },
    })
    kubectl(`wait --for=condition=Ready pod -l app=web -n ${NS} --timeout=120s`)
    const pod = JSON.parse(kubectl(`get pod -n ${NS} -l app=web -o json`)).items[0]
    podName = pod.metadata.name
    podUID = pod.metadata.uid
  })

  test.afterAll(async ({ request }) => {
    try {
      kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    } catch {
      // the namespace was never created (skipped)
    }
    if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('applies the row to the running pod without a restart, keeps the template and audits it', async ({ request }) => {
    const res = await request.post(`/api/v1/cluster/namespaces/${NS}/optimization/resize?cluster=self`, { headers: bearer(admin), data: resizeBody })
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.pods.map((p: any) => p.pod)).toEqual([podName])
    expect(body.pods[0].result, JSON.stringify(body)).toBe('resized')
    expect(body.resized).toBe(1)

    // The kubelet applies it in place: the same pod, no restart, the new requests in its status.
    await expect.poll(() => kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.status.containerStatuses[0].resources.requests.cpu}`), { timeout: 30000 }).toBe('75m')
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.spec.containers[0].resources.requests.memory}`)).toBe('48Mi')
    // Burstable: the limits stay (both above the new requests).
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.spec.containers[0].resources.limits.cpu}`)).toBe('100m')
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.status.containerStatuses[0].restartCount}`)).toBe('0')
    expect(kubectl(`get pod -n ${NS} -l app=web -o jsonpath={.items[0].metadata.uid}`)).toBe(podUID)
    expect(kubectl(`get deploy web -n ${NS} -o jsonpath={.spec.template.spec.containers[0].resources.requests.cpu}`)).toBe('50m')

    const row = (await auditRows(request, admin, 'k8s.pod.resize')).find((r) => (r.TargetID ?? r.target_id) === 'web' && (r.After ?? r.after)?.namespace === NS)
    expect(row, 'k8s.pod.resize audit row').toBeTruthy()
    const after = row.After ?? row.after
    expect(after.container).toBe('app')
    expect(after.resized).toBe(1)
    expect(after.pods[0].pod).toBe(podName)
    expect(row.Result ?? row.result).toBe('success')
  })

  test('the same values again change nothing', async ({ request }) => {
    const body = await (await request.post(`/api/v1/cluster/namespaces/${NS}/optimization/resize?cluster=self`, { headers: bearer(admin), data: resizeBody })).json()
    expect(body.pods).toEqual([{ pod: podName, result: 'skipped', reason: 'unchanged' }])
    expect(body.skipped).toBe(1)
  })

  test('a Read user is refused and the refusal is audited', async ({ request }) => {
    readerId = await createUser(request, admin, READER)
    await grant(request, admin, readerId, 'self', 'Read')
    const reader = await login(request, READER, PW)
    const res = await request.post(`/api/v1/cluster/namespaces/${NS}/optimization/resize?cluster=self`, { headers: bearer(reader), data: resizeBody, failOnStatusCode: false })
    expect(res.status()).toBe(403)
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.spec.containers[0].resources.requests.cpu}`)).toBe('75m')
    const denied = (await auditRows(request, admin, 'k8s.access.denied')).find((r) => (r.ActorEmail ?? r.actor_email) === READER && (r.TargetID ?? r.target_id) === 'resource.pod.edit')
    expect(denied, 'k8s.access.denied row for the reader').toBeTruthy()
  })

  test('the Optimization modal offers the button on rows with a recommendation and cancelling applies nothing', async ({ page, request }) => {
    const before = (await auditRows(request, admin, 'k8s.pod.resize')).length
    await page.goto('/?cluster=default')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kube-system', exact: true }).click()
    await expect(page.getByTestId('optimization-table')).toBeVisible({ timeout: 20000 })
    const buttons = page.getByTestId('optimization-resize')
    test.skip((await buttons.count()) === 0, 'no kube-system row with a recommendation that differs from its request')
    await buttons.first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(/Apply without restart|재시작 없이 적용/)
    await expect(dialog).toContainText(/\//)
    await dialog.getByRole('button', { name: /Cancel|취소/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('optimization-resize-result')).toHaveCount(0)
    expect((await auditRows(request, admin, 'k8s.pod.resize')).length).toBe(before)
  })
})
