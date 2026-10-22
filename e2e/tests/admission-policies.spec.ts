import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Cluster → Validating / Mutating Admission Policies (admissionregistration.k8s.io/v1, read-only): a policy and its
// binding created with kubectl show up in the list with the kubectl columns plus the binding count, and the drawer
// carries the CEL expression and the binding table. The binding's namespace selector matches no namespace, so the
// policy affects nothing while the test runs. A Read user lists them too (kubeast:cluster-reader).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const stamp = Date.now().toString(36)
const VAP = `e2e-vap-${stamp}`
const MAP = `e2e-map-${stamp}`

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-admission-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const run = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const apply = (manifest: object) => {
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
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

const configmapsOnCreate = { resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE'], resources: ['configmaps'] }] }
const served = (resource: string) => kubectl('api-resources --api-group=admissionregistration.k8s.io -o name').split('\n').includes(`${resource}.admissionregistration.k8s.io`)
const EXPRESSION = "object.metadata.name != 'e2e-forbidden'"
const MUTATION = 'Object{metadata: Object.metadata{labels: {"e2e-map": "x"}}}'

test.describe('admission policies', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let hasVAP = false
  let hasMAP = false

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    hasVAP = served('validatingadmissionpolicies')
    hasMAP = served('mutatingadmissionpolicies')
    if (hasVAP) {
      kubectlApply({
        apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: VAP },
        spec: { failurePolicy: 'Fail', matchConstraints: configmapsOnCreate, validations: [{ expression: EXPRESSION, message: 'e2e: the name e2e-forbidden is reserved' }] },
      })
      kubectlApply({
        apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding', metadata: { name: `${VAP}-binding` },
        spec: { policyName: VAP, validationActions: ['Audit'], matchResources: { namespaceSelector: { matchLabels: { 'e2e-vap': stamp } } } },
      })
    }
    if (hasMAP) {
      kubectlApply({
        apiVersion: 'admissionregistration.k8s.io/v1', kind: 'MutatingAdmissionPolicy', metadata: { name: MAP },
        spec: { failurePolicy: 'Ignore', reinvocationPolicy: 'Never', matchConstraints: configmapsOnCreate, mutations: [{ patchType: 'ApplyConfiguration', applyConfiguration: { expression: MUTATION } }] },
      })
      kubectlApply({
        apiVersion: 'admissionregistration.k8s.io/v1', kind: 'MutatingAdmissionPolicyBinding', metadata: { name: `${MAP}-binding` },
        spec: { policyName: MAP, matchResources: { namespaceSelector: { matchLabels: { 'e2e-map': stamp } } } },
      })
    }
  })

  test.afterAll(() => {
    for (const [kind, name] of [['validatingadmissionpolicybinding', `${VAP}-binding`], ['validatingadmissionpolicy', VAP], ['mutatingadmissionpolicybinding', `${MAP}-binding`], ['mutatingadmissionpolicy', MAP]]) {
      try {
        kubectl(`delete ${kind} ${name} --ignore-not-found`)
      } catch {
        // the kind is not served on this cluster
      }
    }
  })

  test('a validating policy lists with its binding and the drawer shows the expression', async ({ page, request }) => {
    test.skip(!hasVAP, 'the cluster does not serve validatingadmissionpolicies/v1')
    const list = (await (await request.get('/api/v1/cluster/validatingadmissionpolicies?cluster=self', { headers: bearer(admin) })).json()) as any[]
    const row = list.find((p) => p.name === VAP)
    expect(row, JSON.stringify(list.map((p) => p.name))).toBeTruthy()
    expect(row).toMatchObject({ validations_count: 1, bindings_count: 1, bindings: [`${VAP}-binding`], failure_policy: 'Fail', param_kind: '' })
    const desc = await (await request.get(`/api/v1/cluster/validatingadmissionpolicies/${VAP}/describe?cluster=self`, { headers: bearer(admin) })).json()
    expect(desc.spec.validations[0].expression).toBe(EXPRESSION)
    expect(desc.spec.matchConstraints.resourceRules[0].resources).toEqual(['configmaps'])
    expect(desc.bindings[0].name).toBe(`${VAP}-binding`)
    expect(desc.bindings[0].spec.validationActions).toEqual(['Audit'])

    await page.goto('/cluster/validatingadmissionpolicies?cluster=self')
    await page.getByTestId('admission-policies-search').fill(stamp)
    const rows = page.getByTestId('admission-policy-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(VAP)
    await expect(rows.first()).toContainText('Fail')
    await rows.first().click()
    const info = page.getByTestId('admission-policy-info')
    await expect(info).toBeVisible()
    await expect(info.getByTestId('admission-policy-validation')).toContainText(EXPRESSION)
    await expect(info.getByTestId('admission-policy-bindings')).toContainText(`${VAP}-binding`)
    await expect(info.getByTestId('admission-policy-bindings')).toContainText('Audit')
    await expect(info).toContainText('configmaps')
  })

  test('a mutating policy lists with its binding and the drawer shows the mutation', async ({ page, request }) => {
    test.skip(!hasMAP, 'the cluster does not serve mutatingadmissionpolicies/v1')
    const list = (await (await request.get('/api/v1/cluster/mutatingadmissionpolicies?cluster=self', { headers: bearer(admin) })).json()) as any[]
    const row = list.find((p) => p.name === MAP)
    expect(row, JSON.stringify(list.map((p) => p.name))).toBeTruthy()
    expect(row).toMatchObject({ mutations_count: 1, bindings_count: 1, bindings: [`${MAP}-binding`], failure_policy: 'Ignore', reinvocation_policy: 'Never' })
    const desc = await (await request.get(`/api/v1/cluster/mutatingadmissionpolicies/${MAP}/describe?cluster=self`, { headers: bearer(admin) })).json()
    expect(desc.spec.mutations[0].applyConfiguration.expression).toBe(MUTATION)

    await page.goto('/cluster/mutatingadmissionpolicies?cluster=self')
    await page.getByTestId('admission-policies-search').fill(stamp)
    const rows = page.getByTestId('admission-policy-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(MAP)
    await expect(rows.first()).toContainText('Ignore')
    await rows.first().click()
    const info = page.getByTestId('admission-policy-info')
    await expect(info.getByTestId('admission-policy-mutation')).toContainText('ApplyConfiguration')
    await expect(info.getByTestId('admission-policy-mutation')).toContainText('e2e-map')
    await expect(info.getByTestId('admission-policy-bindings')).toContainText(`${MAP}-binding`)
  })

  test('a Read user reads the policies too (kubeast:cluster-reader)', async ({ request }) => {
    test.skip(!hasVAP, 'the cluster does not serve validatingadmissionpolicies/v1')
    const email = `e2e-vap-reader-${stamp}@kubeast.local`
    const password = 'e2e-reader-throwaway'
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E VAP reader', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    try {
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).status()).toBe(200)
      const reader = await login(request, email, password)
      const res = await request.get('/api/v1/cluster/validatingadmissionpolicies?cluster=self', { headers: bearer(reader) })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as { name: string }[]).map((p) => p.name)).toContain(VAP)
      if (hasMAP) expect((await request.get('/api/v1/cluster/mutatingadmissionpolicies?cluster=self', { headers: bearer(reader) })).status()).toBe(200)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
