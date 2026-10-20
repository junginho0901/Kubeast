import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The Alerts inbox (features.alertInvestigation on in the dev values): every alert the webhook gets, one row per alert
// (cluster + fingerprint + startsAt), firing or resolved, for whoever reads the cluster as a whole. The alerts here
// are severity info, which the investigator filters out, so no model runs. The last test goes through the second
// cluster's Alertmanager (NodePort 31093, features.alertStore): an alert it holds shows as firing, then silenced; one
// it does not hold shows "Not in Alertmanager". Those are labelled kubeast_e2e="store", which the dev route sends to no
// receiver, so Alertmanager itself posts nothing.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-inbox-pass1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-inbox-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

// the second cluster's Alertmanager, asked from its node (the laptop does not reach the kind network)
function am(method: 'GET' | 'POST' | 'DELETE', urlPath: string, body?: unknown): string {
  const data = body === undefined ? '' : `-H 'Content-Type: application/json' --data-binary @-`
  return execSync(`docker exec -i kubeast-b-control-plane curl -sf -X ${method} ${data} 'http://127.0.0.1:31093${urlPath}'`, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type Item = { id: string; alertname: string; status: string; received_count: number; resolved_at: string | null; starts_at: string; acknowledged: boolean; assignee: string; done: boolean; note?: string }

test.describe('Alerts inbox', () => {
  test.describe.configure({ mode: 'serial' })
  const id = Date.now().toString(36)
  const name = `E2EInbox${id}`
  const userIds: string[] = []
  const silenceIds: string[] = []
  let admin = ''
  let reader = ''
  let scoped = ''
  let token = ''
  let ready = false

  const post = (request: APIRequestContext, cluster: string, alerts: object[]) =>
    request.post(`/api/v1/alerts/webhook?cluster=${cluster}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { version: '4', groupKey: `{}:{alertname="${name}"}`, status: 'firing', receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093', alerts },
    })
  const alert = (status: string, startsAt: string, extra: Record<string, unknown> = {}) => ({
    status,
    labels: { alertname: name, severity: 'info', namespace: 'default', deployment: 'e2e-unschedulable' },
    annotations: { summary: `no ready replica ${id}` },
    startsAt,
    generatorURL: 'http://prometheus.e2e/graph',
    fingerprint: `inbox-${id}`,
    ...extra,
  })
  const list = async (request: APIRequestContext, as: string, cluster = 'self'): Promise<Item[]> => {
    const res = await request.get('/api/v1/alerts/inbox', { headers: bearer(as), params: { cluster, limit: 200 } })
    expect(res.status(), await res.text()).toBe(200)
    return ((await res.json()).items as Item[]).filter((i) => i.alertname.endsWith(id))
  }

  async function user(request: APIRequestContext, label: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-inbox-${label}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E inbox ${label}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.alertInvestigation?.enabled) return
    token = Buffer.from(kubectlFor('kubeast')('-n kubeast get secret kubeast-secrets -o jsonpath={.data.ALERT_WEBHOOK_TOKEN}').trim(), 'base64').toString()
    reader = await user(request, 'read', { role: 'Read' })
    scoped = await user(request, 'scoped', { role: 'Read', namespaces: ['default'] })
    ready = true
  })

  test.afterAll(async ({ request }) => {
    for (const s of silenceIds) {
      try {
        am('DELETE', `/api/v2/silence/${s}`)
      } catch { /* expired already */ }
    }
    if (!admin) return
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!ready, 'alert investigation (the webhook) is off')
  })

  test('one alert is one row: a repeat counts, resolved closes it, firing again is a new row', async ({ request }) => {
    const t0 = new Date(Date.now() - 10 * 60_000).toISOString()
    const first = await post(request, 'self', [alert('firing', t0)])
    expect(await first.json()).toMatchObject({ stored: 1, filtered: 1, accepted: 0 }) // info: kept, not investigated
    let rows = await list(request, reader)
    expect(rows.map((r) => [r.status, r.received_count])).toEqual([['firing', 1]])

    await post(request, 'self', [alert('firing', t0)])
    expect((await list(request, reader))[0].received_count).toBe(2)

    const endsAt = new Date(Date.now() - 60_000).toISOString()
    expect(await (await post(request, 'self', [alert('resolved', t0, { endsAt })])).json()).toMatchObject({ stored: 1, resolved: 1 })
    rows = await list(request, reader)
    expect(rows.map((r) => [r.status, r.received_count])).toEqual([['resolved', 3]])
    expect(Date.parse(rows[0].resolved_at ?? '')).toBe(Date.parse(endsAt))

    const t1 = new Date().toISOString()
    await post(request, 'self', [alert('firing', t1)])
    rows = await list(request, reader)
    expect(rows.map((r) => r.status)).toEqual(['firing', 'resolved']) // firing first
    expect(Date.parse(rows[0].starts_at)).toBe(Date.parse(t1))

    // alerts cover the whole cluster: a grant limited to namespaces gets no inbox
    const refused = await request.get('/api/v1/alerts/inbox', { headers: bearer(scoped), params: { cluster: 'self' } })
    expect(refused.status()).toBe(403)
    expect((await request.patch(`/api/v1/alerts/inbox/${rows[0].id}`, { headers: bearer(scoped), data: { done: true } })).status()).toBe(404)
  })

  test('the screen: tabs, the object opens its drawer, the marks are kept and audited', async ({ page, request }) => {
    const rows = await list(request, admin)
    const row = rows.find((r) => r.status === 'firing')!
    const closed = rows.find((r) => r.status === 'resolved')!
    await page.goto('/alerts?cluster=self')
    await expect(page.getByTestId('nav-alerts')).toHaveAttribute('href', '/alerts')
    await page.getByTestId('alert-tab-firing').click()
    const line = page.getByTestId(`alert-row-${row.id}`)
    await expect(line.getByTestId('alert-status')).toHaveText(/Firing|울리는 중/)
    await expect(page.getByTestId(`alert-row-${closed.id}`)).toHaveCount(0)
    await page.getByTestId('alert-tab-resolved').click()
    await expect(page.getByTestId(`alert-row-${closed.id}`).getByTestId('alert-status')).toHaveText(/Resolved|해결됨/)
    await expect(line).toHaveCount(0)
    await page.getByTestId('alert-tab-firing').click()

    await line.getByTestId('alert-object').click()
    await expect(page).toHaveURL(/detail=Deployment(%2F|\/)default(%2F|\/)e2e-unschedulable/)
    await expect(page.getByText('e2e-unschedulable', { exact: true }).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/detail=/)

    await line.getByText(`no ready replica ${id}`).click() // the row, not its object link, opens the alert
    const detail = page.getByTestId('alert-detail')
    await expect(detail).toContainText(`no ready replica ${id}`)
    await detail.getByTestId('alert-ack').click()
    await expect(detail.getByTestId('alert-ack')).toHaveText(/Undo acknowledge|확인 취소/)
    await detail.getByTestId('alert-assign').click()
    await expect(detail.getByTestId('alert-assignee')).toContainText(ADMIN_EMAIL)
    await detail.getByTestId('alert-note').fill(`restarted the rollout ${id}`)
    await detail.getByTestId('alert-note-save').click()
    await expect(detail.getByTestId('alert-note-save')).toBeDisabled()
    await detail.getByTestId('alert-done').click()
    await expect(detail.getByTestId('alert-done')).toHaveText(/Reopen|다시 열기/)

    const saved = await (await request.get(`/api/v1/alerts/inbox/${row.id}`, { headers: bearer(admin) })).json()
    expect(saved).toMatchObject({ acknowledged: true, done: true, note: `restarted the rollout ${id}` })
    expect(saved.assignee).toContain(ADMIN_EMAIL)
    const logs = await (await request.get('/api/v1/auth/admin/audit-logs?action=alert.inbox.update&limit=50', { headers: bearer(admin) })).json()
    const mine = (Array.isArray(logs) ? logs : logs.items || []).filter((i: any) => (i.TargetID ?? i.target_id) === row.id)
    expect(mine.length).toBe(4) // acknowledged, assignee, note, done — one row each

    // after a reload the window opens again with what was kept; the list shows the marks
    await page.reload()
    await expect(page.getByTestId('alert-detail').getByTestId('alert-note')).toHaveValue(`restarted the rollout ${id}`)
    await page.keyboard.press('Escape')
    await expect(line.getByTestId('alert-handling')).toContainText(/Done|조치 완료/)
  })

  test("Alertmanager's view: firing, then silenced; an alert it does not hold is called out", async ({ page, request }) => {
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.alertStore?.clusters?.includes('default'), 'no alert store for cluster default')
    try {
      am('GET', '/-/ready')
    } catch {
      test.skip(true, 'no Alertmanager on NodePort 31093')
    }
    const live = `E2EInboxLive${id}`
    const gone = `E2EInboxGone${id}`
    const labels = { alertname: live, cluster: 'kubeast-b', severity: 'info', namespace: 'default', kubeast_e2e: 'store', e2e_run: id }
    const startsAt = new Date().toISOString()
    am('POST', '/api/v2/alerts', [{ labels, annotations: { summary: `held ${id}` }, startsAt, endsAt: new Date(Date.now() + 15 * 60_000).toISOString() }])
    let fingerprint = ''
    await expect.poll(() => {
      const held = JSON.parse(am('GET', `/api/v2/alerts?filter=e2e_run%3D%22${id}%22`)) as { fingerprint: string }[]
      fingerprint = held[0]?.fingerprint ?? ''
      return fingerprint
    }, { timeout: 30_000 }).not.toBe('')
    await post(request, 'default', [
      { status: 'firing', labels, annotations: { summary: `held ${id}` }, startsAt, fingerprint },
      { status: 'firing', labels: { ...labels, alertname: gone }, annotations: {}, startsAt, fingerprint: `gone-${id}` },
    ])
    const rows = await list(request, admin, 'default')
    const heldRow = rows.find((r) => r.alertname === live)!
    const goneRow = rows.find((r) => r.alertname === gone)!

    await page.goto('/alerts?cluster=default')
    await expect(page.getByTestId(`alert-row-${goneRow.id}`).getByTestId('alert-live')).toHaveText(/Not in Alertmanager|Alertmanager에 없음/)
    await expect(page.getByTestId(`alert-row-${heldRow.id}`).getByTestId('alert-status')).toHaveText(/Firing|울리는 중/)
    await expect(page.getByTestId(`alert-row-${heldRow.id}`).getByTestId('alert-live')).toHaveCount(0) // firing in Alertmanager too

    silenceIds.push(JSON.parse(am('POST', '/api/v2/silences', {
      matchers: [{ name: 'alertname', value: live, isRegex: false, isEqual: true }, { name: 'cluster', value: 'kubeast-b', isRegex: false, isEqual: true }],
      startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdBy: 'e2e', comment: `inbox ${id}`,
    })).silenceID as string)
    await expect.poll(() => (JSON.parse(am('GET', `/api/v2/alerts?filter=e2e_run%3D%22${id}%22&active=false`)) as unknown[]).length, { timeout: 30_000 }).toBe(1)
    await page.reload()
    await expect(page.getByTestId(`alert-row-${heldRow.id}`).getByTestId('alert-live')).toHaveText(/Silenced|무음 중/)
  })

  test('a silence from the alert window mutes it in Alertmanager for this cluster only, and ends from the Silences tab', async ({ page, request }) => {
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.alertStore?.clusters?.includes('default') || !features.alertStore?.silences, 'no alert store with silences for cluster default')
    const mute = `E2EInboxMute${id}`
    const labels = { alertname: mute, cluster: 'kubeast-b', severity: 'info', namespace: 'default', kubeast_e2e: 'store', e2e_run: `${id}-mute` }
    const startsAt = new Date().toISOString()
    am('POST', '/api/v2/alerts', [{ labels, annotations: { summary: `mute ${id}` }, startsAt, endsAt: new Date(Date.now() + 15 * 60_000).toISOString() }])
    let fingerprint = ''
    await expect.poll(() => {
      fingerprint = (JSON.parse(am('GET', `/api/v2/alerts?filter=e2e_run%3D%22${id}-mute%22`)) as { fingerprint: string }[])[0]?.fingerprint ?? ''
      return fingerprint
    }, { timeout: 30_000 }).not.toBe('')
    await post(request, 'default', [{ status: 'firing', labels, annotations: { summary: `mute ${id}` }, startsAt, fingerprint }])
    const row = (await list(request, admin, 'default')).find((r) => r.alertname === mute)!

    // the server adds the cluster condition and refuses one the user sets; a Read user may not silence
    const refused = await request.post('/api/v1/alertstore/silences?cluster=default', {
      headers: bearer(admin), data: { matchers: [{ name: 'cluster', value: 'kubeast', isRegex: false, isEqual: true }], durationMinutes: 60, comment: 'x' },
    })
    expect(refused.status()).toBe(400)
    const asReader = await request.post('/api/v1/alertstore/silences?cluster=self', {
      headers: bearer(reader), data: { matchers: [{ name: 'alertname', value: mute, isRegex: false, isEqual: true }], durationMinutes: 60, comment: 'x' },
    })
    expect(asReader.status()).toBe(403)

    await page.goto(`/alerts?cluster=default&alert=${row.id}`)
    const detail = page.getByTestId('alert-detail')
    await detail.getByTestId('alert-silence').click()
    const modal = page.getByTestId('silence-modal')
    await expect(modal.getByTestId('silence-matcher')).toHaveCount(2) // alertname and namespace; the cluster is added by the server
    await expect(modal.getByTestId('silence-preview-count')).toHaveText(/^1 /)
    await modal.getByTestId('silence-comment').fill(`e2e window ${id}`)
    await modal.getByTestId('silence-create').click()
    await expect(modal).toHaveCount(0)

    type AmSilence = { id: string; createdBy: string; comment: string; status: { state: string }; matchers: { name: string; value: string; isEqual: boolean; isRegex: boolean }[] }
    let made: AmSilence | undefined
    await expect.poll(() => {
      made = (JSON.parse(am('GET', '/api/v2/silences')) as AmSilence[]).find((x) => x.comment === `e2e window ${id}`)
      return made?.status.state
    }, { timeout: 15_000 }).toBe('active')
    silenceIds.push(made!.id)
    expect(made!.createdBy).toContain(ADMIN_EMAIL)
    expect(made!.matchers.map((m) => `${m.name}=${m.value}`).sort()).toEqual([`alertname=${mute}`, 'cluster=kubeast-b', 'namespace=default'])
    await expect.poll(() => (JSON.parse(am('GET', `/api/v2/alerts?filter=e2e_run%3D%22${id}-mute%22&active=false`)) as unknown[]).length, { timeout: 30_000 }).toBe(1)

    await page.goto('/alerts?cluster=default')
    await page.getByTestId('alert-tab-silences').click()
    const silenceRow = page.getByTestId(`silence-row-${made!.id}`)
    await expect(silenceRow).toContainText(`e2e window ${id}`)
    await silenceRow.getByTestId('silence-expire').click()
    await page.getByRole('button', { name: /^(End now|지금 끝내기)$/ }).last().click()
    await expect(silenceRow).toHaveCount(0)
    expect((JSON.parse(am('GET', `/api/v2/silence/${made!.id}`)) as AmSilence).status.state).toBe('expired')

    const logs = await (await request.get('/api/v1/auth/admin/audit-logs?limit=100', { headers: bearer(admin) })).json()
    const rows = (Array.isArray(logs) ? logs : logs.items || []).filter((i: any) => (i.TargetID ?? i.target_id) === made!.id)
    expect(rows.map((i: any) => i.Action ?? i.action).sort()).toEqual(['alert.silence.create', 'alert.silence.expire'])
  })
})
