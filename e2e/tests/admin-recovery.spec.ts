import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `server reset-admin` gets an account back when its password is lost, it is locked or it lost the Admin role: run in
// the auth-service pod, it sets the account to the DEFAULT_ADMIN_PASSWORD password (the dev admin's, which the suite
// signs in with), the Admin role, clears its locks and ends its sessions, and leaves user.account.recover. A
// throwaway account is the target (--email), so the dev admin is never touched.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubeastKubectl(): ((args: string[]) => string) | null {
  try {
    const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-recover-')), 'kubeconfig')
    fs.writeFileSync(kc, execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8' }), { mode: 0o600 })
    return (args) => execFileSync('kubectl', ['--kubeconfig', kc, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string) {
  return request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })
}

test('reset-admin gives a locked, demoted account the Secret password and the Admin role back', async ({ request }) => {
  const kubectl = kubeastKubectl()
  test.skip(!kubectl, 'no kind cluster kubeast')
  const admin = bearer((await (await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)).json()).access_token)
  const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
  const member = (Array.isArray(roles) ? roles : roles.roles || []).find((r: { name: string }) => r.name === 'Member').id
  const email = `e2e-recover-${Date.now().toString(36)}@kubeast.local`
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E recover', email, password: 'e2e-recover-old-pw', role_id: member } })
  expect(created.status(), await created.text()).toBe(201)
  const id = (await created.json()).id as string
  try {
    for (let i = 0; i < 6; i++) await login(request, email, 'wrong-password')
    expect((await login(request, email, 'e2e-recover-old-pw')).status(), 'locked').toBe(401)

    const out = kubectl!(['-n', 'kubeast', 'exec', 'deploy/auth-service', '--', '/app/server', 'reset-admin', '--email', email])
    expect(out).toContain(`recovered ${email}`)
    expect(out).not.toContain(ADMIN_PASSWORD)

    const res = await login(request, email, ADMIN_PASSWORD)
    expect(res.status(), 'the Secret password signs in').toBe(200)
    const me = await (await request.get('/api/v1/auth/me', { headers: bearer((await res.json()).access_token) })).json()
    expect(me.role?.name).toBe('Admin')
    expect((await login(request, email, 'e2e-recover-old-pw')).status(), 'the old password').toBe(401)

    const rows = await (await request.get('/api/v1/auth/admin/audit-logs?action=user.account.recover&limit=20', { headers: admin })).json()
    const row = (rows.items ?? []).find((r: { TargetEmail?: string }) => r.TargetEmail === email)
    expect(row).toMatchObject({ ActorEmail: 'reset-admin', Result: 'success', TargetID: id })
  } finally {
    await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
  }
})
