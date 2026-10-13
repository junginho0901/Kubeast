import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Pod drawer → container card → "Adjust resources": the dialog is prefilled with the container's requests, a new
// CPU request goes to that one pod through the resize subresource (no restart, template unchanged, audited as
// k8s.pod.resize), and a Read user does not get the button.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-podresize-pass1!'
const stamp = Date.now().toString(36)
const NS = `e2e-podresize-${stamp}`
const READER = `e2e-podresize-reader-${stamp}@example.com`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-podresize-'))
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
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E pod resize', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function loginUI(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
}

async function auditRows(request: APIRequestContext, admin: string, action: string) {
  // limit well above the rows this action accumulates on a dev database: the count below is "before + 1".
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=1000`, { headers: bearer(admin) })
  return ((await res.json()).items ?? []) as any[]
}

test.describe('pod drawer container resize', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let readerId = ''
  let podName = ''
  let podUID = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: bearer(admin) })).json()
    test.skip(!features.inPlaceResize?.enabled || !features.inPlaceResize?.serverSupports, 'in-place resize is off (features.inPlaceResize) or the server is older than 1.35')
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
      // never created
    }
    if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('the dialog is prefilled, applies a new CPU request to the running pod and the result is audited', async ({ page, request }) => {
    const before = (await auditRows(request, admin, 'k8s.pod.resize')).length
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=Pod/${NS}/${podName}`)
    await page.getByTestId('pod-resize-app').click({ timeout: 20000 })
    const modal = page.getByTestId('pod-resize-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('pod-resize-cpu')).toHaveValue('50')
    await expect(page.getByTestId('pod-resize-memory')).toHaveValue('32')
    // Nothing changed yet: the button stays off; a non-integer is refused too.
    await expect(page.getByTestId('pod-resize-submit')).toBeDisabled()
    await page.getByTestId('pod-resize-cpu').fill('75.5')
    await expect(page.getByTestId('pod-resize-submit')).toBeDisabled()
    await page.getByTestId('pod-resize-cpu').fill('75')
    await page.getByTestId('pod-resize-submit').click()
    await expect(page.getByTestId('pod-resize-result')).toHaveAttribute('data-result', 'resized', { timeout: 20000 })

    // The kubelet applied it in place: same pod, no restart, the new request in the status; the template is untouched.
    await expect.poll(() => kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.status.containerStatuses[0].resources.requests.cpu}`), { timeout: 30000 }).toBe('75m')
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.spec.containers[0].resources.requests.memory}`)).toBe('32Mi')
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.status.containerStatuses[0].restartCount}`)).toBe('0')
    expect(kubectl(`get pod -n ${NS} -l app=web -o jsonpath={.items[0].metadata.uid}`)).toBe(podUID)
    expect(kubectl(`get deploy web -n ${NS} -o jsonpath={.spec.template.spec.containers[0].resources.requests.cpu}`)).toBe('50m')

    await page.getByTestId('pod-resize-close').click()
    await expect(modal).toHaveCount(0)
    // The card shows the new request after the refetch.
    await expect(page.getByText('cpu=75m').first()).toBeVisible({ timeout: 10000 })

    const rows = await auditRows(request, admin, 'k8s.pod.resize')
    expect(rows.length).toBe(before + 1)
    const row = rows.find((r) => (r.TargetID ?? r.target_id) === podName && (r.After ?? r.after)?.namespace === NS)
    expect(row, 'k8s.pod.resize audit row for the pod').toBeTruthy()
    expect((row.After ?? row.after).kind).toBe('Pod')
    expect((row.After ?? row.after).resized).toBe(1)
  })

  test('a Read user does not get the button', async ({ page, request }) => {
    readerId = await createUser(request, admin, READER)
    expect((await request.put(`/api/v1/auth/admin/users/${readerId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
    await loginUI(page, READER, PW)
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=Pod/${NS}/${podName}`)
    // The drawer's Containers section is up (the card for "app" is rendered) and carries no resize button.
    await expect(page.getByText('Containers', { exact: true }).first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('cpu=75m').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('pod-resize-app')).toHaveCount(0)
    expect(kubectl(`get pod ${podName} -n ${NS} -o jsonpath={.spec.containers[0].resources.requests.cpu}`)).toBe('75m')
  })
})
