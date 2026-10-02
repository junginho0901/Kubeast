import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Deployment rollback replaces the whole pod template with the target
// revision's (kubectl rollout undo semantics): a field the newer revision
// added disappears, and rolling back to the revision the template already
// matches is reported, not silently accepted.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'test2'
const NS = 'e2e-rollback'
const NAME = 'web'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

function kubectlFor(cluster: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${cluster}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rollback-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) =>
    execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] }).trim()
}

const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: ${NAME}, namespace: ${NS} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${NAME} } }
  template:
    metadata: { labels: { app: ${NAME} } }
    spec:
      containers:
        - name: web
          image: registry.k8s.io/pause:3.10
          resources: { requests: { cpu: 5m, memory: 8Mi }, limits: { cpu: 50m, memory: 32Mi } }
`

test.describe('deployment rollback (whole-template replace)', () => {
  test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')

  test('an env var added in revision 2 is gone after rolling back to 1; rolling back to the current template is refused', async ({ request }) => {
    test.setTimeout(120_000)
    const kubectl = kubectlFor(CLUSTER)
    kubectl('apply -f -', manifest)
    try {
      const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
      const rollback = (revision: number) => request.post(
        `/api/v1/cluster/namespaces/${NS}/deployments/${NAME}/rollback?cluster=${CLUSTER}`,
        { headers: admin, data: { revision }, failOnStatusCode: false },
      )
      const env = () => kubectl(`-n ${NS} get deploy ${NAME} -o jsonpath={.spec.template.spec.containers[0].env}`)

      // revision 1 is the current template: nothing to do → 409, template untouched
      const same = await rollback(1)
      expect(same.status(), await same.text()).toBe(409)
      expect((await same.json()).detail).toContain('already')

      // revision 2 adds an env var
      kubectl(`-n ${NS} set env deploy/${NAME} E2E_REV=2`)
      await expect.poll(env, { timeout: 30_000 }).toContain('E2E_REV')

      // back to revision 1: the env var the newer template added must disappear
      const undo = await rollback(1)
      expect(undo.status(), await undo.text()).toBe(200)
      expect(await undo.json()).toMatchObject({ rolled_back: true, revision: 1 })
      await expect.poll(env, { timeout: 30_000 }).not.toContain('E2E_REV')
    } finally {
      kubectl(`delete ns ${NS} --ignore-not-found --wait=false`)
    }
  })
})
