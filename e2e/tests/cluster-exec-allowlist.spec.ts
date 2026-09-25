import { test, expect, type APIRequestContext } from '@playwright/test'

// A registered kubeconfig's exec credential plugin runs inside the k8s-service
// and tool-server pods, so registration only accepts allow-listed commands
// (default: aws-iam-authenticator) and no static AWS keys. API-client path
// (Bearer), so the project's session cookie is dropped.
test.use({ storageState: { cookies: [], origins: [] } })

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

function kubeconfigWithExec(command: string, env?: { name: string; value: string }): string {
  const envBlock = env ? `      env:\n      - name: ${env.name}\n        value: ${env.value}\n` : ''
  return `apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: ${command}
      args: [token, -i, prod]
      interactiveMode: Never
${envBlock}`
}

test.describe('cluster registration — exec credential plugin allow-list', () => {
  let auth: Record<string, string>

  test.beforeAll(async ({ request }) => {
    auth = { Authorization: `Bearer ${await login(request)}` }
  })

  test('a kubeconfig whose exec command is not allow-listed is refused before any dial', async ({ request }) => {
    const started = Date.now()
    const res = await request.post('/api/v1/clusters/validate', {
      headers: auth,
      data: { mode: 'external', kubeconfig: kubeconfigWithExec('/bin/sh') },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).detail).toContain('not allowed')
    expect(Date.now() - started, 'rejected statically, no connection attempt').toBeLessThan(5000)
  })

  test('static AWS credentials in the exec env are refused', async ({ request }) => {
    const res = await request.post('/api/v1/clusters/validate', {
      headers: auth,
      data: {
        mode: 'external',
        kubeconfig: kubeconfigWithExec('aws-iam-authenticator', { name: 'AWS_SECRET_ACCESS_KEY', value: 'x' }),
      },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).detail).toContain('AWS_SECRET_ACCESS_KEY')
  })

  test('registration with a disallowed exec command is refused too', async ({ request }) => {
    const res = await request.post('/api/v1/clusters', {
      headers: auth,
      data: { mode: 'external', display_name: 'E2E Exec Probe', kubeconfig: kubeconfigWithExec('/bin/sh') },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).detail).toContain('not allowed')
  })

  test('an allow-listed plugin is executed by k8s-service (fails on missing cloud credentials, not on a missing binary)', async ({ request }) => {
    const res = await request.post('/api/v1/clusters/validate', {
      headers: auth,
      data: { mode: 'external', kubeconfig: kubeconfigWithExec('aws-iam-authenticator') },
      failOnStatusCode: false,
    })
    // The probe runs the plugin; without AWS credentials in the pod it cannot
    // mint a token, so the result is unhealthy with the plugin's own error —
    // never "executable file not found".
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.healthy).toBe(false)
    expect(body.message).not.toContain('executable file not found')
    expect(body.message).not.toContain('not allowed')
  })
})
