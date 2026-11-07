import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A Secret's editor without resource.secret.reveal reads its values as a mask. What the YAML window's save sends for them
// stands for the values: they stay in the cluster, on the screen's save and on the API's, and the edit around them goes
// through. The custom role, its group's RBAC, the user and the namespace are of this run and removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-secret-masks-pass1!'
const CLUSTER = 'self'
const run = Date.now().toString(36)
const NS = `e2e-secmask-${run}`
const ROLE = `e2e-secmask-${run}`
const EMAIL = `e2e-secmask-${run}@kubeast.local`
const SECRET = 'db'
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
const VALUE = `fake-secret-value-${run}`
const OTHER = `fake-other-value-${run}`
const b64 = (s: string) => Buffer.from(s).toString('base64')

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-secmask-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kubeconfig} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const tryKubectl = (args: string) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

// Monaco's end of the text by the system it reads from the page's user agent (the chromium project's is Windows):
// Cmd+Down on a Mac, Ctrl+End elsewhere. ControlOrMeta follows the machine the test runs on instead.
const textEnd = async (page: Page) => ((await page.evaluate(() => navigator.userAgent.includes('Macintosh'))) ? 'Meta+ArrowDown' : 'Control+End')

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type SecretObject = { data: Record<string, string>; metadata: { annotations: Record<string, string>; labels?: Record<string, string> } }
const secret = () => JSON.parse(kubectl(`-n ${NS} get secret ${SECRET} -o json`)) as SecretObject

test.describe('a Secret editor without reveal', () => {
  let admin = ''
  let roleId = 0
  let userId = ''
  let lastApplied = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    kubectl(`create namespace ${NS}`)
    // kubectl apply keeps the values in the annotation
    kubectl(`-n ${NS} apply -f -`, JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: SECRET }, type: 'Opaque', stringData: { password: VALUE, user: OTHER } }))
    lastApplied = secret().metadata.annotations[LAST_APPLIED]
    expect(lastApplied, 'the fixture keeps its values in the annotation').toContain(VALUE)

    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: ROLE, description: 'e2e',
      permissions: ['menu.dashboard', 'menu.configuration', 'resource.*.read', 'resource.*.edit', 'resource.*.create'] } })
    expect(role.status(), await role.text()).toBe(201)
    roleId = (await role.json()).id
    // What auth.impersonation.customRoles renders, done by hand: the service account may act as this group.
    kubectl(`create clusterrole ${ROLE}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:${ROLE}`)
    kubectl(`create clusterrolebinding ${ROLE}-imp --clusterrole=${ROLE}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
    kubectl(`-n ${NS} create rolebinding ${ROLE} --clusterrole=edit --group=kubeast:role:${ROLE}`)

    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const user = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E secret masks', email: EMAIL, password: PW, role_id: member.id } })
    expect(user.status(), await user.text()).toBe(201)
    userId = (await user.json()).id
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: ROLE } })
    expect(grant.ok(), await grant.text()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: bearer(admin), failOnStatusCode: false })
    tryKubectl(`delete clusterrolebinding ${ROLE}-imp --ignore-not-found`)
    tryKubectl(`delete clusterrole ${ROLE}-imp --ignore-not-found`)
    tryKubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
  })

  const wantValuesKept = () => {
    const s = secret()
    expect({ password: s.data.password, user: s.data.user, annotation: s.metadata.annotations[LAST_APPLIED] })
      .toEqual({ password: b64(VALUE), user: b64(OTHER), annotation: lastApplied })
  }

  const keptInRows = async (request: APIRequestContext) => {
    const res = await request.get(`/api/v1/auth/admin/audit-logs?action=k8s.yaml.apply&actor_email=${encodeURIComponent(EMAIL)}&limit=100`, { headers: bearer(admin) })
    expect(res.ok(), await res.text()).toBeTruthy()
    const body = await res.json()
    const rows = (Array.isArray(body) ? body : body.items ?? []) as { After?: unknown }[]
    return rows.map((r) => (typeof r.After === 'string' ? JSON.parse(r.After) : r.After) as { kept_masked?: string[]; yaml_len?: number })
  }

  test('the values stay on the screen\'s save and on the API\'s, and what was changed is written', async ({ page, request }) => {
    test.setTimeout(180_000)
    const editor = bearer(await login(request, EMAIL, PW))
    const apply = (yaml: string) => request.post(`/api/v1/cluster/resources/yaml/apply?cluster=${CLUSTER}`, { headers: editor, data: { resource_type: 'secrets', namespace: NS, name: SECRET, yaml } })
    const shown = async () => {
      const res = await request.get(`/api/v1/cluster/namespaces/${NS}/secrets/${SECRET}/yaml?cluster=${CLUSTER}`, { headers: editor })
      expect(res.status(), await res.text()).toBe(200)
      return (await res.json()).yaml as string
    }

    await test.step('the editor reads masks', async () => {
      const yaml = await shown()
      expect(yaml).toContain("password: '***'")
      expect(yaml).toContain(`${LAST_APPLIED}: '***'`)
      expect(yaml).not.toContain(b64(VALUE))
      expect(yaml).not.toContain(VALUE)
    })

    await test.step('the YAML window: Edit, a change, Apply', async () => {
      await page.context().clearCookies()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(EMAIL)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
      await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Secret/${NS}/${SECRET}`)}`)
      const drawer = page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()
      await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 30_000 })
      await expect(drawer.locator('.monaco-editor .view-lines').first()).toContainText('***', { timeout: 30_000 })
      await expect(drawer.getByTestId('yaml-editor-note'), 'the window says what a save does to a masked value').toHaveText(/\*\*\*.*(when you save|저장해도)/)
      await drawer.getByRole('button', { name: /^edit$/i }).click()
      await drawer.locator('.monaco-editor').first().click()
      await page.keyboard.press(await textEnd(page))
      await page.keyboard.type('# edited in the window')
      await drawer.getByRole('button', { name: /^apply$/i }).click()
      await expect.poll(async () => (await keptInRows(request)).length, { timeout: 30_000 }).toBeGreaterThan(0)
      wantValuesKept()
      expect((await keptInRows(request))[0].kept_masked?.sort()).toEqual(['data.password', 'data.user', `metadata.annotations.${LAST_APPLIED}`].sort())
      await expect(drawer.getByText(/(Hidden values left as they were: 3|숨겨진 값은 그대로 두었습니다: 3개)/), 'and after it, how many stayed').toBeVisible({ timeout: 10_000 })
      await drawer.getByRole('button', { name: /^(info|정보)$/i }).click()
      await expect(drawer.getByText(/resource\.secret\.reveal/), 'the Data section says who reads values').toBeVisible({ timeout: 10_000 })
    })

    await test.step('data taken out of the YAML: the annotation stays as it is', async () => {
      const yaml = (await shown()).replace(/^data:\n( +.*\n)+/m, '')
      expect(yaml).not.toMatch(/^data:/m)
      const res = await apply(yaml)
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).kept_masked).toEqual([`metadata.annotations.${LAST_APPLIED}`])
      wantValuesKept()
    })

    await test.step('a label added and one value changed beside a mask', async () => {
      const changed = (await shown())
        .replace(/^( +)password: '\*\*\*'$/m, `$1password: ${b64('fake-new-value')}`)
        .replace(/^metadata:\n/m, 'metadata:\n    labels:\n        e2e-edited: "yes"\n')
      const res = await apply(changed)
      expect(res.status(), await res.text()).toBe(200)
      const s = secret()
      expect({ password: s.data.password, user: s.data.user, annotation: s.metadata.annotations[LAST_APPLIED], label: s.metadata.labels?.['e2e-edited'] })
        .toEqual({ password: b64('fake-new-value'), user: b64(OTHER), annotation: lastApplied, label: 'yes' })
      const reread = await shown()
      expect(reread).not.toContain(b64('fake-new-value'))
      expect(reread).toContain("password: '***'")
    })

    await test.step('a new Secret with a mask is refused with why, and not made', async () => {
      const res = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: editor, data: { namespace: NS,
        yaml: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: made\nstringData:\n  password: '***'\n` } })
      expect(res.status(), await res.text()).toBe(400)
      expect(String((await res.json()).detail)).toContain('***')
      expect(tryKubectl(`-n ${NS} get secret made -o name`)).toBeNull()
    })

    await test.step('the rows name what was kept and hold no value', async () => {
      const rows = await keptInRows(request)
      const text = JSON.stringify(rows)
      for (const leak of [VALUE, OTHER, b64(VALUE), b64(OTHER)]) expect(text).not.toContain(leak)
    })
  })

  // Whoever may read the values sees their letters in the window, and a save of something else leaves their bytes alone.
  test('a save in the window of one who reads the values keeps every value byte for byte', async ({ page }) => {
    test.setTimeout(120_000)
    const name = 'bytes'
    const data = {
      korean: b64('가짜애비밀번호'),
      spaces: b64('  fake value  '),
      tab: b64('\tfake\t'),
      quoted: b64("'fake-value'"),
      hash: b64('fake #value'),
      colon: b64('key: value'),
      lines: b64('line one\nline two\n'),
      pipe: b64('|'),
      mask: b64('***'),
      binary: Buffer.from([0x00, 0xff, 0xfe, 0x66]).toString('base64'),
      empty: '',
    }
    kubectl(`-n ${NS} create -f -`, JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name }, type: 'Opaque', data }))
    await page.goto(`/?cluster=${CLUSTER}&detail=${encodeURIComponent(`Secret/${NS}/${name}`)}`)
    const drawer = page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()
    await drawer.getByRole('button', { name: 'YAML', exact: true }).click({ timeout: 30_000 })
    await expect(drawer.locator('.monaco-editor .view-lines').first()).toContainText('stringData', { timeout: 30_000 })
    await expect(drawer.locator('.monaco-editor .view-lines').first(), 'Korean reads as its letters').toContainText('가짜애비밀번호')
    await expect(drawer.getByTestId('yaml-editor-note'), 'no note for one who reads the values').toHaveCount(0)
    await drawer.getByRole('button', { name: /^edit$/i }).click()
    await drawer.locator('.monaco-editor').first().click()
    await page.keyboard.press(await textEnd(page))
    await page.keyboard.type('# edited in the window')
    await drawer.getByRole('button', { name: /^apply$/i }).click()
    await expect(drawer.getByRole('button', { name: /^edit$/i }), 'the save ended').toBeVisible({ timeout: 30_000 })
    expect((JSON.parse(kubectl(`-n ${NS} get secret ${name} -o json`)) as SecretObject).data).toEqual(data)
  })
})
