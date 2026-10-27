import { test, expect, type APIRequestContext } from '@playwright/test'

// Log search on screen (features.logSearch, kind setup of scripts/kind-logsearch.sh): the Pod drawer's
// Logs switch gets "Search history", and a Job drawer's "Log search" section searches the Job's pods.
// A Job prints a unique line first. Skipped while log search is off for cluster self.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const NS = 'default'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `admin login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('log search UI', () => {
  let admin = ''
  const job = `e2e-logsearch-ui-${Date.now().toString(36)}`
  const marker = `${job}-marker`
  let pod = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.logSearch?.clusters?.includes(CLUSTER)) return
    const yaml = [
      'apiVersion: batch/v1',
      'kind: Job',
      `metadata: {name: ${job}, namespace: ${NS}}`,
      'spec:',
      '  backoffLimit: 0',
      '  template:',
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: say',
      '          image: docker.io/library/busybox:1.38.0',
      `          command: [sh, -c, "echo ${marker} alpha; echo ${marker} beta"]`,
    ].join('\n')
    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: bearer(admin), data: { yaml, namespace: NS } })
    expect(create.ok(), await create.text()).toBeTruthy()
    await expect.poll(async () => {
      const res = await request.get(`/api/v1/namespaces/${NS}/logsearch?cluster=${CLUSTER}&q=${marker}`, { headers: bearer(admin) })
      const lines = res.ok() ? (await res.json()).lines : []
      pod = lines[0]?.pod ?? ''
      return lines.length
    }, { timeout: 120_000, intervals: [3000] }).toBe(2)
  })

  test.afterAll(async ({ request }) => {
    if (admin) await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!pod, 'log search is off for cluster self — run scripts/kind-logsearch.sh up')
  })

  test('the Pod drawer searches the pod history and marks the matches', async ({ page }) => {
    await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
    const row = page.locator('tbody:not([aria-hidden="true"]) tr', { hasText: pod }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.click()
    await expect(page.getByTestId('pod-logs-container')).toBeVisible({ timeout: 20000 })
    await page.getByTestId('log-source-search').click()
    await expect(page.getByTestId('log-source-search')).toHaveAttribute('aria-pressed', 'true')

    const output = page.getByTestId('logsearch-output')
    await expect(output).toContainText(`${marker} alpha`, { timeout: 20000 })
    await expect(page.getByTestId('logsearch-line')).toHaveCount(2)

    await page.getByTestId('logsearch-text').fill('BETA')
    await page.getByTestId('logsearch-submit').click()
    await expect(page.getByTestId('logsearch-line')).toHaveCount(1)
    await expect(output.locator('mark')).toHaveText('beta')
    await expect(page.getByTestId('logsearch-summary')).toContainText(/\b1 line\b|1줄/)
  })

  test("a Job drawer searches the Job's pods once the section is opened", async ({ page }) => {
    await page.goto(`/workloads/jobs?cluster=${CLUSTER}`)
    const row = page.locator('tbody:not([aria-hidden="true"]) tr', { hasText: job }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.click()
    const toggle = page.getByTestId('workload-logsearch-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 20000 })
    await expect(page.getByTestId('logsearch-view')).toHaveCount(0)

    await toggle.click()
    await expect(page.getByTestId('logsearch-output')).toContainText(`${marker} beta`, { timeout: 20000 })
    await expect(page.getByTestId('logsearch-line-pod').first()).toHaveText(pod)
  })
})
