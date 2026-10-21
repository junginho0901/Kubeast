import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A real Argo CD (scripts/kind-argocd.sh up: the core install on the second cluster, `default`) syncing the
// podinfo chart into e2e-argo as Application e2e-podinfo. gitops-guard.spec.ts and ai-admin-tools.spec.ts check
// hand-made marks and statuses; this checks what Argo CD itself writes: the tracking annotation on the
// Deployment, the refused write with its audit row, the drawer badge, and gitops_status on the live Application.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const APP = 'e2e-podinfo'
const NS = 'e2e-argo'
const DEPLOY = APP // the chart names its objects after the release, which Argo CD names after the Application
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-argocd-'))
const kc = path.join(dir, 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kc} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

// the live Application as kubectl reads it, or null without Argo CD
function application(): any {
  try {
    return JSON.parse(kubectl(`-n argocd get application ${APP} -o json`))
  } catch {
    return null
  }
}

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login ${EMAIL}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('Argo CD (real)', () => {
  test.beforeEach(() => {
    const app = application()
    test.skip(!app, `no Argo CD Application ${APP} on kubeast-b (scripts/kind-argocd.sh up)`)
    test.skip(app.status?.sync?.status !== 'Synced', `Application ${APP} is ${app.status?.sync?.status}, not Synced`)
  })

  test('the Deployment Argo CD synced carries its tracking annotation, and every write to it is refused and recorded', async ({ request }) => {
    const admin = await login(request)
    const deploy = JSON.parse(kubectl(`-n ${NS} get deploy ${DEPLOY} -o json`))
    expect(deploy.metadata.annotations['argocd.argoproj.io/tracking-id']).toBe(`${APP}:apps/Deployment:${NS}/${DEPLOY}`)

    const started = Date.now()
    const base = `/api/v1/cluster/namespaces/${NS}/deployments/${DEPLOY}`
    const del = await request.delete(`${base}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
    expect(del.status(), await del.text()).toBe(409)
    expect((await del.json()).detail).toContain(`managed by Argo CD application ${APP}`)
    const rollback = await request.post(`${base}/rollback?cluster=${CLUSTER}`, { headers: bearer(admin), data: {}, failOnStatusCode: false })
    expect(rollback.status(), await rollback.text()).toBe(409)

    type Row = { TargetID: string; Namespace: string; Cluster: string; Result: string; After: { app?: string; method?: string }; CreatedAt: string }
    await expect.poll(async () => {
      const rows: Row[] = (await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.gitops.refuse&limit=20', { headers: bearer(admin) })).json()).items
      return rows.filter((r) => r.TargetID === DEPLOY && r.Namespace === NS && r.Cluster === CLUSTER && r.After?.app === APP && Date.parse(r.CreatedAt) >= started - 5_000)
        .map((r) => `${r.Result} ${r.After.method}`).sort()
    }, { timeout: 10_000 }).toEqual(['failure DELETE', 'failure POST']) // the delete, the rollback

    const after = JSON.parse(kubectl(`-n ${NS} get deploy ${DEPLOY} -o json`))
    expect([after.metadata.uid, after.metadata.generation]).toEqual([deploy.metadata.uid, deploy.metadata.generation])
  })

  test('the drawer shows the Application badge and no delete for the synced Deployment', async ({ page }) => {
    await page.goto(`/workloads/deployments?cluster=${CLUSTER}`)
    await page.getByPlaceholder(/search/i).first().fill(DEPLOY)
    await page.getByRole('cell', { name: DEPLOY, exact: true }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('argo-badge')).toContainText(APP, { timeout: 15_000 })
    await expect(drawer.getByTestId('argo-blocked-hint')).toBeVisible()
    await expect(drawer.getByRole('button', { name: /^(delete\b|.*삭제$)/i })).toHaveCount(0)
  })

  test('gitops_status reads the live Application as kubectl does', async ({ request }) => {
    const admin = await login(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const res = await request.post('/api/v1/ai/mcp', {
      headers: { ...RPC, Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gitops_status', arguments: { cluster: CLUSTER, namespace: 'argocd', name: APP } } },
    })
    expect(res.status()).toBe(200)
    const result = (await res.json()).result
    expect(result.isError, result.content?.[0]?.text).toBeFalsy()
    const out = JSON.parse(result.content[0].text)
    const app = application()
    type Res = { status?: string; health?: { status?: string } }
    const problems = (app.status.resources as Res[]).filter((r) => !((!r.status || r.status === 'Synced') && (!r.health?.status || r.health.status === 'Healthy'))).length
    expect(out.applications_total).toBe(1)
    expect(out.applications[0]).toMatchObject({
      name: APP,
      namespace: 'argocd',
      project: app.spec.project,
      source: { repo: app.spec.source.repoURL, path: app.spec.source.path, target_revision: app.spec.source.targetRevision },
      sync: { status: app.status.sync.status, revision: app.status.sync.revision.slice(0, 8) }, // a git commit, shortened as the tool does
      health: { status: app.status.health.status },
      destination: { server: app.spec.destination.server, namespace: NS },
      automated: { prune: true, self_heal: true },
      resources: { total: app.status.resources.length, problems },
    })
  })
})
