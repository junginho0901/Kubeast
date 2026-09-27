import { test, expect, type APIRequestContext } from '@playwright/test'

// DELETE /api/v1/helm/releases/{ns}/{name} needs ?confirm=<release name> unless
// dryRun=true; the server checks it before looking the release up. Using a
// release that does not exist keeps the cluster untouched: a rejected confirm
// is 400, a passed one reaches the lookup and gets 404.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const NAMESPACE = 'default'
const RELEASE = 'no-such-release-l5'

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

test.describe('helm uninstall needs confirm=<release> (L5)', () => {
  test('missing or wrong confirm is 400 before the lookup; dryRun or a matching confirm reaches it (404)', async ({ request }) => {
    const token = await adminToken(request)
    const del = (params: Record<string, string>) =>
      request.delete(`/api/v1/helm/releases/${NAMESPACE}/${RELEASE}`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
      })

    const none = await del({})
    expect(none.status()).toBe(400)
    expect((await none.json()).detail).toMatch(/confirm/)

    const wrong = await del({ confirm: 'something-else' })
    expect(wrong.status()).toBe(400)
    expect((await wrong.json()).detail).toMatch(/confirm/)

    const dryRun = await del({ dryRun: 'true' })
    expect(dryRun.status()).toBe(404)

    const matching = await del({ confirm: RELEASE })
    expect(matching.status()).toBe(404)
    expect((await matching.json()).detail).toMatch(/not found/i)
  })
})
