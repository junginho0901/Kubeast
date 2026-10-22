import { test, expect, type APIRequestContext } from '@playwright/test'

// A Helm rollback preview (dryRun) shows a manifest diff, which can carry Secret data: it follows the revision
// diff's rules — in full only with resource.secret.reveal, and then recorded as helm.release.reveal with the
// section "rollback dry-run" (without that permission the diff of the masked manifests, unit-tested). The release
// is this install itself (kubeast in namespace kubeast on cluster self); a preview changes nothing.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test('a rollback preview is a recorded reveal and leaves the release as it is', async ({ request }) => {
  const admin = await login(request)
  const release = '/api/v1/helm/releases/kubeast/kubeast'
  const detail = await request.get(`${release}?cluster=self`, { headers: bearer(admin), failOnStatusCode: false })
  test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
  const { revision } = await detail.json()
  test.skip(revision < 2, 'the release has one revision: nothing to roll back to')

  const started = Date.now()
  const preview = await request.post(`${release}/rollback?cluster=self`, {
    headers: bearer(admin), data: { revision: revision - 1, dryRun: true }, failOnStatusCode: false,
  })
  expect(preview.status(), await preview.text()).toBe(200)
  const body = await preview.json()
  expect(body).toMatchObject({ dryRun: true, fromRevision: revision, toRevision: revision - 1 })

  type Row = { Action: string; TargetID: string; Namespace: string; After: { section?: string }; CreatedAt: string }
  await expect.poll(async () => {
    const rows: Row[] = (await (await request.get('/api/v1/auth/admin/audit-logs?action=helm.release.reveal&limit=20', { headers: bearer(admin) })).json()).items
    return rows.some((r) => r.TargetID === 'kubeast' && r.Namespace === 'kubeast' && r.After?.section === 'rollback dry-run'
      && Date.parse(r.CreatedAt) >= started - 5_000)
  }, { timeout: 15_000 }).toBe(!!body.diff)

  const after = await (await request.get(`${release}?cluster=self`, { headers: bearer(admin) })).json()
  expect(after.revision).toBe(revision) // a preview does not roll back
})

test('the rollback window names the release it rolls back', async ({ page, request }) => {
  const admin = await login(request)
  const detail = await request.get('/api/v1/helm/releases/kubeast/kubeast?cluster=self', { headers: bearer(admin), failOnStatusCode: false })
  test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
  test.skip((await detail.json()).revision < 2, 'the release has one revision: nothing to roll back to')

  await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
  await page.getByRole('button', { name: /^(history|이력)$/i }).click()
  await page.getByRole('button', { name: /^(rollback|롤백)$/i }).first().click()
  const subtitle = page.getByText(/^kubeast\/kubeast — /)
  await expect(subtitle).toHaveText(/^kubeast\/kubeast — (review the diff|변경 내용을 미리)/)
  await expect(page.getByText(/helmReleaseDetail\./)).toHaveCount(0)
  // the preview compares two revisions of one release: one file, not a rename
  await expect(page.locator('.helm-diff2html').or(page.getByText(/^(No changes will be applied\.|적용될 변경이 없습니다\.)$/))).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.d2h-moved-tag')).toHaveCount(0)
  if (await page.locator('.helm-diff2html').count()) {
    await expect(page.locator('.helm-diff2html .d2h-file-name').first()).toHaveText(/^kubeast\/kubeast @\d+ → @\d+$/)
  }
  await page.getByRole('button', { name: /^(cancel|취소)$/i }).click()
  await expect(subtitle).toHaveCount(0)
})
