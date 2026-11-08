import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A release's editor without resource.secret.reveal reads its values masked. A placeholder left where it was shown stands
// for the value, on the Values tab's save and on the API's: the release's values and what they render stay, and the edit
// beside them goes through. Anywhere else it stands for nothing and the upgrade is refused. On `self`, with a release
// Secret the spec writes (one template, no running workload); the custom role, its group's RBAC, the user and the namespace
// are of this run and removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-helm-masks-pass1!'
const CLUSTER = 'self'
const run = Date.now().toString(36)
const NS = `e2e-helmmask-${run}`
const ROLE = `e2e-helmmask-${run}`
const EMAIL = `e2e-helmmask-${run}@kubeast.local`
const RELEASE = 'masked'
const PASSWORD_VALUE = `fake-admin-value-${run}`
const URL_PASSWORD = `fake-url-password-${run}`
const CONFIG = { adminPassword: PASSWORD_VALUE, db: { url: `postgres://app:${URL_PASSWORD}@db.shop:5432/app` }, replicaCount: 2 }
const SECRETS = [PASSWORD_VALUE, URL_PASSWORD]
const API = `/api/v1/helm/releases/${NS}/${RELEASE}`

const kubeconfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-helmmask-')), 'kubeconfig')
fs.writeFileSync(kubeconfig, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kubeconfig} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
const tryKubectl = (args: string) => {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

// Monaco's start and end of the text by the system it reads from the page's user agent (the chromium project's is
// Windows): Cmd+Up and Cmd+Down on a Mac, Ctrl+Home and Ctrl+End elsewhere. ControlOrMeta follows the machine instead.
const textKey = async (page: Page, to: 'start' | 'end') => {
  const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'))
  if (mac) return to === 'start' ? 'Meta+ArrowUp' : 'Meta+ArrowDown'
  return to === 'start' ? 'Control+Home' : 'Control+End'
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const TEMPLATE = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-conf\ndata:\n  replicas: {{ .Values.replicaCount | quote }}\n  sum: {{ .Values.adminPassword | sha256sum | quote }}\n'

function releaseSecret() {
  const now = new Date().toISOString()
  const release = {
    name: RELEASE, namespace: NS, version: 1,
    info: { first_deployed: now, last_deployed: now, status: 'deployed', description: 'e2e fixture' },
    chart: { metadata: { apiVersion: 'v2', name: 'e2e-masks', version: '0.1.0' }, templates: [{ name: 'templates/conf.yaml', data: Buffer.from(TEMPLATE).toString('base64') }], values: {} },
    config: CONFIG, manifest: '',
  }
  return JSON.stringify({
    apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1',
    metadata: { name: `sh.helm.release.v1.${RELEASE}.v1`, namespace: NS, labels: { name: RELEASE, owner: 'helm', status: 'deployed', version: '1' } },
    stringData: { release: gzipSync(Buffer.from(JSON.stringify(release))).toString('base64') },
  })
}

// The values a revision holds, read from its release Secret; null without that revision.
function storedValues(revision: number): Record<string, unknown> | null {
  const data = tryKubectl(`-n ${NS} get secret sh.helm.release.v1.${RELEASE}.v${revision} -o 'jsonpath={.data.release}'`)
  if (!data) return null
  const encoded = Buffer.from(data, 'base64').toString()
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString()).config
}

test.describe('a Helm release editor without reveal', () => {
  let admin = ''
  let roleId = 0
  let userId = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    kubectl(`create namespace ${NS}`)
    kubectl(`-n ${NS} apply -f -`, releaseSecret())

    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: ROLE, description: 'e2e',
      permissions: ['menu.dashboard', 'menu.helm', 'resource.objects.read', 'resource.helm.read', 'resource.helm.upgrade'] } })
    expect(role.status(), await role.text()).toBe(201)
    roleId = (await role.json()).id
    // What auth.impersonation.customRoles renders, done by hand: the service account may act as this group.
    kubectl(`create clusterrole ${ROLE}-imp --verb=impersonate --resource=groups --resource-name=kubeast:role:${ROLE}`)
    kubectl(`create clusterrolebinding ${ROLE}-imp --clusterrole=${ROLE}-imp --serviceaccount=kubeast:k8s-service --serviceaccount=kubeast:tool-server`)
    kubectl(`-n ${NS} create rolebinding ${ROLE} --clusterrole=edit --group=kubeast:role:${ROLE}`)

    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const user = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E helm masks', email: EMAIL, password: PW, role_id: member.id } })
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

  const rows = async (request: APIRequestContext) => {
    const res = await request.get(`/api/v1/auth/admin/audit-logs?action=helm.release.upgrade&actor_email=${encodeURIComponent(EMAIL)}&limit=50`, { headers: bearer(admin) })
    expect(res.ok(), await res.text()).toBeTruthy()
    const body = await res.json()
    return ((Array.isArray(body) ? body : body.items) ?? []) as { Result: string; Error?: string; After: { kept_masked?: string[]; changed_masked?: string[]; values_keys?: string[] } }[]
  }

  test('the values stay on the tab\'s save and on the API\'s, and a placeholder anywhere else is refused', async ({ page, request }) => {
    test.setTimeout(180_000)
    const editor = bearer(await login(request, EMAIL, PW))
    const shown = async () => {
      const res = await request.get(`${API}/values?cluster=${CLUSTER}`, { headers: editor })
      expect(res.status(), await res.text()).toBe(200)
      return (await res.json()).content as string
    }
    const upgrade = (values: string, dryRun: boolean) => request.put(`${API}/values?cluster=${CLUSTER}`, { headers: editor, data: { values, dryRun } })

    await test.step('the editor reads placeholders', async () => {
      const text = await shown()
      expect(text).toContain('adminPassword: <REDACTED:adminPassword>')
      expect(text).toContain('@db.shop:5432/app')
      for (const secret of SECRETS) expect(text).not.toContain(secret)
    })

    await test.step('a placeholder where it stands for nothing: refused with where, no revision', async () => {
      for (const dryRun of [true, false]) {
        const res = await upgrade(`${await shown()}note: <REDACTED:adminPassword>\n`, dryRun)
        expect(res.status(), await res.text()).toBe(400)
        expect(String((await res.json()).detail)).toContain('note')
      }
      expect(storedValues(2), 'no second revision').toBeNull()
      await expect.poll(async () => (await rows(request))[0]?.Result, { timeout: 15_000 }).toBe('failure')
      expect((await rows(request))[0].Error).toContain('note')
    })

    await test.step('the Values tab: the same placeholder is refused in the preview, which says why, with Apply off', async () => {
      await page.context().clearCookies()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(EMAIL)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
      await page.goto(`/helm/releases/${NS}/${RELEASE}?cluster=${CLUSTER}`)
      await page.getByRole('button', { name: /^values$/i }).click({ timeout: 30_000 })
      await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('<REDACTED:adminPassword>', { timeout: 30_000 })
      await page.getByRole('button', { name: /^(edit values|values 편집)$/i }).click()
      await page.locator('.monaco-editor').first().click()
      await page.keyboard.press(await textKey(page, 'end'))
      await page.keyboard.type('note: <REDACTED:adminPassword>')
      await page.getByRole('button', { name: /dry.?run/i }).click()
      await expect(page.getByTestId('helm-upgrade-preview-failed')).toContainText('where it stands for no value (note)', { timeout: 30_000 })
      await expect(page.getByRole('button', { name: /^(apply upgrade|업그레이드 실행)$/i })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('helm-upgrade-preview-failed')).toHaveCount(0)
      await page.getByRole('button', { name: /^(cancel|취소)$/i }).click()
      expect(storedValues(2), 'no second revision').toBeNull()
    })

    await test.step('the Values tab: Edit, a change, Preview says what stays, Apply', async () => {
      await page.getByRole('button', { name: /^(edit values|values 편집)$/i }).click()
      await expect(page.getByTestId('helm-values-masked-note')).toHaveText(/<REDACTED:…>/)
      await page.locator('.monaco-editor').first().click()
      await page.keyboard.press(await textKey(page, 'end'))
      await page.keyboard.type('zeta: 1')
      await page.getByRole('button', { name: /dry.?run/i }).click()
      await expect(page.getByTestId('helm-upgrade-kept-masked')).toHaveText(/adminPassword, db\.url/, { timeout: 30_000 })
      await page.getByRole('button', { name: /^(apply upgrade|업그레이드 실행)$/i }).click()
      await expect.poll(() => storedValues(2), { timeout: 30_000 }).toEqual({ ...CONFIG, zeta: 1 })
    })

    await test.step('what the values render saw the real value', async () => {
      const sum = kubectl(`-n ${NS} get configmap ${RELEASE}-conf -o 'jsonpath={.data.sum}'`)
      const { createHash } = await import('node:crypto')
      expect(sum).toBe(createHash('sha256').update(PASSWORD_VALUE).digest('hex'))
    })

    await test.step('the answer and the row name what stayed, and hold no value', async () => {
      const res = await upgrade(await shown(), false)
      const text = await res.text()
      expect(res.status(), text).toBe(200)
      expect(JSON.parse(text).kept_masked).toEqual(['adminPassword', 'db.url'])
      for (const secret of SECRETS) expect(text).not.toContain(secret)
      expect(storedValues(3)).toEqual({ ...CONFIG, zeta: 1 })
      await expect.poll(async () => (await rows(request))[0]?.After?.kept_masked, { timeout: 15_000 }).toEqual(['adminPassword', 'db.url'])
      const every = JSON.stringify(await rows(request))
      for (const secret of SECRETS) expect(every).not.toContain(secret)
    })

    await test.step('a value written over its placeholder is the new value', async () => {
      const res = await upgrade((await shown()).replace('<REDACTED:adminPassword>', 'fake-new-value'), false)
      expect(res.status(), await res.text()).toBe(200)
      expect(storedValues(4)).toEqual({ ...CONFIG, adminPassword: 'fake-new-value', zeta: 1 })
    })

    await test.step('only a hidden value written over: the preview says where, Apply is open and the value goes in', async () => {
      const newUrl = 'postgres://app:fake-other-password@db.shop:5432/app'
      // the template renders nothing of db.url, so the diff has nothing to show for it
      const preview = await upgrade((await shown()).replace('postgres://app:<REDACTED:password>@db.shop:5432/app', newUrl), true)
      const text = await preview.text()
      expect(preview.status(), text).toBe(200)
      expect(JSON.parse(text).diff ?? '').toBe('')
      expect(JSON.parse(text).changed_masked).toEqual(['db.url'])
      expect(text).not.toContain('fake-other-password')
      for (const secret of SECRETS) expect(text).not.toContain(secret)

      await page.reload()
      await page.getByRole('button', { name: /^values$/i }).click({ timeout: 30_000 })
      await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('<REDACTED:password>', { timeout: 30_000 })
      await page.getByRole('button', { name: /^(edit values|values 편집)$/i }).click()
      await page.locator('.monaco-editor').first().click()
      // line 3 of adminPassword, db, url, replicaCount, zeta
      await page.keyboard.press(await textKey(page, 'start'))
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
      await page.keyboard.type(`url: ${newUrl}`)
      await page.getByRole('button', { name: /dry.?run/i }).click()
      await expect(page.getByTestId('helm-upgrade-changed-masked')).toHaveText(/: db\.url$/, { timeout: 30_000 })
      await expect(page.getByText(/^(No changes will be applied\.|적용될 변경이 없습니다\.)$/)).toHaveCount(0)
      await page.getByRole('button', { name: /^(apply upgrade|업그레이드 실행)$/i }).click()
      await expect.poll(() => storedValues(5), { timeout: 30_000 }).toEqual({ ...CONFIG, adminPassword: 'fake-new-value', db: { url: newUrl }, zeta: 1 })
      await expect.poll(async () => (await rows(request))[0]?.After?.changed_masked, { timeout: 15_000 }).toEqual(['db.url'])
      expect(JSON.stringify(await rows(request))).not.toContain('fake-other-password')
    })

    const current = { ...CONFIG, adminPassword: 'fake-new-value', db: { url: 'postgres://app:fake-other-password@db.shop:5432/app' }, zeta: 1 }

    await test.step('a plain value nothing renders: the preview says the values change, and Apply is open', async () => {
      const preview = await upgrade(`${await shown()}omega: 1\n`, true)
      const text = await preview.text()
      expect(preview.status(), text).toBe(200)
      expect(JSON.parse(text).diff ?? '').toBe('')
      expect(JSON.parse(text).values_changed).toBe(true)
      expect(JSON.parse(text).changed_masked).toBeUndefined()

      await page.reload()
      await page.getByRole('button', { name: /^values$/i }).click({ timeout: 30_000 })
      await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('<REDACTED:adminPassword>', { timeout: 30_000 })
      await page.getByRole('button', { name: /^(edit values|values 편집)$/i }).click()
      await page.locator('.monaco-editor').first().click()
      await page.keyboard.press(await textKey(page, 'end'))
      await page.keyboard.type('omega: 1')
      await page.getByRole('button', { name: /dry.?run/i }).click()
      await expect(page.getByText(/^(No difference shows in the manifest|화면에 보이는 차이는 없지만)/)).toHaveCount(1, { timeout: 30_000 })
      await expect(page.getByText(/^(No changes will be applied\.|적용될 변경이 없습니다\.)$/)).toHaveCount(0)
      await page.getByRole('button', { name: /^(apply upgrade|업그레이드 실행)$/i }).click()
      await expect.poll(() => storedValues(6), { timeout: 30_000 }).toEqual({ ...current, omega: 1 })
    })

    await test.step('a right guess and a wrong one over a placeholder read the same to the byte', async () => {
      // db.url, as the template renders nothing of it
      const masked = 'postgres://app:<REDACTED:password>@db.shop:5432/app'
      const right = await upgrade((await shown()).replace(masked, current.db.url), true)
      const wrong = await upgrade((await shown()).replace(masked, 'postgres://app:fake-wrong-guess@db.shop:5432/app'), true)
      const text = await right.text()
      expect(right.status(), text).toBe(200)
      expect(JSON.parse(text).values_changed).toBe(true)
      expect(JSON.parse(text).changed_masked).toEqual(['db.url'])
      expect(await wrong.text()).toBe(text)
    })

    await test.step('a list item removed: each value stays with its item, and a removal that cannot say which is refused', async () => {
      const first = `fake-first-${run}`
      const second = `fake-second-${run}`
      const withUsers = `${await shown()}users:\n- name: first\n  password: ${first}\n- name: second\n  password: ${second}\n`
      const added = await upgrade(withUsers, false)
      expect(added.status(), await added.text()).toBe(200)
      const read = await shown()
      expect(read).toContain('- name: first\n  password: <REDACTED:password>\n')
      const removed = await upgrade(read.replace('- name: first\n  password: <REDACTED:password>\n', ''), false)
      const text = await removed.text()
      expect(removed.status(), text).toBe(200)
      expect(JSON.parse(text).changed_masked).toEqual(['users[0].password'])
      expect(JSON.parse(text).kept_masked).toContain('users[1].password')
      expect(storedValues(8)).toEqual({ ...current, omega: 1, users: [{ name: 'second', password: second }] })

      const twins = await upgrade(`${await shown()}urls:\n- postgres://app:fake-one-${run}@db.shop/app\n- postgres://app:fake-two-${run}@db.shop/app\n`, false)
      expect(twins.status(), await twins.text()).toBe(200)
      const refused = await upgrade((await shown()).replace('- postgres://app:<REDACTED:password>@db.shop/app\n', ''), false)
      expect(refused.status(), await refused.text()).toBe(400)
      expect(String((await refused.json()).detail)).toContain('urls[0]')
      expect(storedValues(10), 'nothing was written').toBeNull()
    })
  })
})
