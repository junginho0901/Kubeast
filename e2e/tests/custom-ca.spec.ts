import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// customCAs against the kind setup of scripts/kind-private-ca.sh: an HTTPS front in the second cluster whose
// certificate a throwaway CA signed, and Kubeast trusting that CA. k8s-service (Go) searches Loki through the
// front and ai-service (Python) lists the models it serves. Skipped without the setup.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const FRONT = 'https://kubeast-b-control-plane:31443'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function hasDevCA(): boolean {
  try {
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-customca-')), 'kubeconfig')
    fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
    const values = execSync(`helm --kubeconfig ${kcPath} -n kubeast get values kubeast -o json`, { encoding: 'utf8' })
    return JSON.stringify(JSON.parse(values).customCAs ?? []).includes('kubeast-dev-ca')
  } catch {
    return false
  }
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `admin login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('custom CAs', () => {
  test.beforeEach(() => {
    test.skip(!hasDevCA(), 'customCAs is not set to the dev CA — run scripts/kind-logsearch.sh up and scripts/kind-private-ca.sh up')
  })

  test('k8s-service searches Loki behind a certificate the private CA signed', async ({ request }) => {
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    expect(features.logSearch?.clusters).toContain('self')
    const res = await request.get('/api/v1/namespaces/kube-system/logsearch?cluster=self&since=15m&limit=5', { headers: bearer(admin) })
    expect(res.status(), await res.text()).toBe(200)
    expect((await res.json()).lines.length).toBeGreaterThan(0)
  })

  test('ai-service lists the models of an endpoint behind the private CA', async ({ request }) => {
    const admin = await login(request)
    const res = await request.post('/api/v1/ai/model-configs/models', { headers: bearer(admin), data: { provider: 'ollama', base_url: FRONT } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.error ?? '').toBe('')
    expect(body.models).toEqual([{ name: 'private-ca-model' }])
  })
})
