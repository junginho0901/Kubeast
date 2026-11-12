import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A URL field says what the server would refuse before Save, Register or Test sends it (utils/urlField):
// Admin → Clusters → Edit (Prometheus and Loki URLs — http or https with a host, no user, no query), Register (the API
// server URL, host:port too, as a kubeconfig's server) and AI Models (Base URL — the provider's list is not asked for
// such an address). Nothing is saved. An API key's name is counted in characters, as its field counts it, and a role's
// and a team's name are up to 100 characters on the screen and on the server (utils/nameLimits; the made ones removed).
// The API key window says under its field why Issue key waits: a name of spaces only, an expiry the server refuses.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const P = EN.common.urlProblem
const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090/ok/v1'

test.describe('a URL field says what the server would refuse', () => {
  test('Edit cluster: the Prometheus and Loki URLs, with Save waiting', async ({ page }) => {
    const writes: string[] = []
    page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/v1/clusters/')) writes.push(r.url()) })
    await page.goto('/admin/clusters')
    await page.getByTestId('edit-cluster-default').click()
    const save = page.getByTestId('edit-submit')
    const prom = page.getByTestId('edit-prometheus-url')
    const promProblem = page.getByTestId('edit-prometheus-url-problem')
    const stored = await prom.inputValue()

    for (const [typed, said] of [
      ['metrics.example.com/prometheus', P.notHttp],
      ['https://bob:pw@metrics.example.com', P.credentials],
      ['https://metrics.example.com/prometheus?x=1', P.query],
    ]) {
      await prom.fill(typed)
      await expect(promProblem, typed).toHaveText(said)
      await expect(save).toBeDisabled()
    }
    await prom.fill('https://metrics.example.com/prometheus')
    await expect(promProblem).toHaveCount(0)
    await expect(save).toBeEnabled()
    await prom.fill(stored)

    const loki = page.getByTestId('edit-logsearch-url')
    await loki.fill('loki:3100')
    await expect(page.getByTestId('edit-logsearch-url-problem')).toHaveText(P.notHttp)
    await expect(save).toBeDisabled()
    expect(writes).toEqual([])
  })

  test('Register cluster: the API server URL takes host:port and the server says the same', async ({ page }) => {
    await page.goto('/admin/clusters')
    await page.getByTestId('register-cluster-btn').click()
    const api = page.getByTestId('register-api-server')
    const problem = page.getByTestId('register-api-server-problem')
    await api.fill('not an address')
    await expect(problem).toHaveText(P.notHttp)
    await api.fill('bob:pw@10.0.0.1:6443')
    await expect(problem).toHaveText(P.credentials)
    await api.fill('10.0.0.1:6443')
    await expect(problem).toHaveCount(0)

    const res = await page.request.post('/api/v1/clusters', {
      headers: XRW, data: { mode: 'external', display_name: 'e2e-api-url', kubeconfig: 'x', api_server_url: 'not an address' },
    })
    expect([res.status(), (await res.json()).detail]).toEqual([400, 'api_server_url: not a server address (https://host:port, or host:port)'])
  })

  test('AI Models: a Base URL that is no http or https URL asks the provider for nothing and Test waits', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/ai/model-configs/models') asked.push(r.postDataJSON()?.base_url ?? '')
    })
    await page.goto('/admin/ai-models')
    await page.getByRole('button', { name: 'Add Model' }).first().click()
    await page.getByTestId('provider-select').click()
    await page.getByTestId('provider-option-ollama').click()
    const base = page.getByTestId('model-base-url')
    await base.fill('ftp://models.example.com')
    await expect(page.getByTestId('model-base-url-problem')).toHaveText(P.notHttp)
    await expect(page.getByRole('button', { name: /^(Test|연결 테스트)$/ })).toBeDisabled()
    await page.waitForTimeout(1_500) // past the list's 500 ms wait after typing
    expect(asked).not.toContain('ftp://models.example.com')

    await base.fill(STUB)
    await expect(page.getByTestId('model-base-url-problem')).toHaveCount(0)
    await expect.poll(() => asked, { timeout: 15_000 }).toContain(STUB)
  })

  test("API key: a name of 22 Korean letters, which the field takes, is not refused as longer than 64", async ({ page }) => {
    await page.goto('/account')
    const config = await (await page.request.get('/api/v1/auth/api-keys/config', { headers: XRW })).json()
    test.skip(!config.enabled, 'API keys are off on this install')
    const name = '자동화'.repeat(7) + '키' // 22 letters, 66 bytes
    const created = await page.request.post('/api/v1/auth/api-keys', { headers: XRW, data: { name, expires_in_days: 1 } })
    const body = await created.json()
    try {
      expect([created.status(), body.name]).toEqual([201, name])
      const tooLong = await page.request.post('/api/v1/auth/api-keys', { headers: XRW, data: { name: '키'.repeat(65), expires_in_days: 1 } })
      expect([tooLong.status(), (await tooLong.json()).detail]).toEqual([400, 'name is required (up to 64 characters)'])
    } finally {
      if (body.id) expect((await page.request.delete(`/api/v1/auth/api-keys/${body.id}`, { headers: XRW })).status()).toBe(204)
    }
  })

  // Issue key waits on a name of spaces only and on an expiry the server refuses, and the line under that field says
  // why; the server refuses the same days. Nothing is issued.
  test('API key: a name of spaces only and an expiry outside 1 to the most days say so while Issue key waits', async ({ page }) => {
    await page.goto('/account')
    const config = await (await page.request.get('/api/v1/auth/api-keys/config', { headers: XRW })).json()
    test.skip(!config.enabled, 'API keys are off on this install')
    const max: number = config.max_days
    const posts: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/api-keys') posts.push(r.url()) })
    await page.getByTestId('api-key-create-open').click()
    const modal = page.getByTestId('api-key-modal')
    const issue = page.getByTestId('api-key-submit')
    const nameProblem = page.getByTestId('api-key-name-problem')
    const daysProblem = page.getByTestId('api-key-days-problem')
    await expect(modal).toBeVisible()
    await expect(nameProblem, 'an empty name is the window as it opens, not a mistake').toHaveCount(0)

    await page.getByTestId('api-key-name').fill('   ')
    await expect(nameProblem).toHaveText(EN.apiKeys.nameBlank)
    await expect(issue).toBeDisabled()
    await page.getByTestId('api-key-name').fill('e2e input days')
    await expect(nameProblem).toHaveCount(0)

    const said = EN.apiKeys.daysRange.replace('{{max}}', String(max))
    for (const days of ['0', '-1', String(max + 1), '1.5', '']) {
      await page.getByTestId('api-key-days').fill(days)
      await expect(daysProblem, days).toHaveText(said)
      await expect(issue, days).toBeDisabled()
    }
    for (const days of ['1', String(max)]) {
      await page.getByTestId('api-key-days').fill(days)
      await expect(daysProblem, days).toHaveCount(0)
      await expect(issue, days).toBeEnabled()
    }
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(modal).toHaveCount(0)
    expect(posts, 'nothing was sent from the window').toEqual([])

    for (const days of [0, max + 1]) {
      const refused = await page.request.post('/api/v1/auth/api-keys', { headers: XRW, data: { name: 'e2e input days', expires_in_days: days } })
      expect([refused.status(), (await refused.json()).detail], String(days)).toEqual([400, `expires_in_days must be between 1 and ${max}`])
    }
    const keys = await (await page.request.get('/api/v1/auth/api-keys', { headers: XRW })).json()
    expect(keys.map((k: { name: string }) => k.name), 'no key was issued').not.toContain('e2e input days')
  })

  test('Roles and Teams: a name is up to 100 characters, on the field and on the server', async ({ page }) => {
    const run = Date.now().toString(36)
    const name = (n: number) => `e2e-${run}-`.padEnd(n, '가')
    const made: string[] = []
    try {
      await page.goto('/admin/roles')
      await page.getByRole('button', { name: /^(Create Role|역할 생성)$/ }).first().click()
      await expect(page.getByPlaceholder(/InfraManager/)).toHaveAttribute('maxlength', '100')
      const tooLong = await page.request.post('/api/v1/auth/admin/roles', { headers: XRW, data: { name: name(101), permissions: ['menu.dashboard'] } })
      expect([tooLong.status(), (await tooLong.json()).detail]).toEqual([400, 'name: up to 100 characters'])
      const role = await page.request.post('/api/v1/auth/admin/roles', { headers: XRW, data: { name: name(100), permissions: ['menu.dashboard'] } })
      const roleBody = await role.json()
      if (roleBody.id) made.push(`/api/v1/auth/admin/roles/${roleBody.id}`)
      expect([role.status(), roleBody.name]).toEqual([201, name(100)])

      const team = await page.request.post('/api/v1/auth/admin/organizations', { headers: XRW, data: { type: 'team', name: name(101) } })
      expect([team.status(), (await team.json()).detail]).toEqual([400, 'name: up to 100 characters'])
      const kept = await page.request.post('/api/v1/auth/admin/organizations', { headers: XRW, data: { type: 'team', name: name(100) } })
      const teamBody = await kept.json()
      if (teamBody.id) made.push(`/api/v1/auth/admin/organizations/${teamBody.id}`)
      expect([kept.status(), teamBody.name]).toEqual([201, name(100)])
    } finally {
      for (const url of made) expect((await page.request.delete(url, { headers: XRW })).ok(), url).toBe(true)
    }
  })
})
