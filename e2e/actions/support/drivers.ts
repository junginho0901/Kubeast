// The action catalogue: one driver per UI action — open the page, do the action through the real UI,
// then verify the outcome against the target cluster (kubectl) or the app's API. Ported from the QA
// sweep runner used for the 2026-10 hardening QA; every key below is one test in actions.spec.ts.
//
// Conventions: the seed (seed/seed.yaml + seed/seed.sh) creates every `qa-*` object the drivers touch,
// so reads and in-place edits run first and deletes last (ORDER at the bottom). Admin-page drivers
// create their own objects with a per-run STAMP and remove them. Drivers that would change the signed-in
// user's own session (password change, logout, registration) run in their own browser context as a
// temporary user, so the shared admin storageState stays valid for the rest of the run.
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { BASE_URL, EXTRA_KIND, NS, NS2, TARGET_CLUSTER, exists, jsonpath, kubectl, sleep, until } from './env'
import {
  acceptConfirm,
  api,
  changePassword,
  clickButton,
  clickTab,
  confirmDialog,
  currentYaml,
  dialog,
  list,
  login,
  openRow,
  pasteInto,
  searchRow,
  uiText,
  type Ctx,
  type Verify,
} from './ui'

export type Driver = {
  /** catalogue id: service:METHOD:path */
  id: string
  /** page to open on the target cluster before ui(); '' = the home page */
  route: string
  ui: (page: Page, ctx: Ctx) => Promise<void>
  verify: (page: Page, ctx: Ctx) => Promise<Verify> | Verify
  /** a reason to skip when the environment lacks something (e.g. the extra kind cluster) */
  precondition?: () => string | null
}

export const D: Record<string, Driver> = {}
const def = (
  key: string,
  id: string,
  route: string,
  ui: Driver['ui'],
  verify: Driver['verify'],
  extra: Partial<Driver> = {},
) => {
  if (D[key]) throw new Error(`duplicate action key ${key}`)
  D[key] = { id, route, ui, verify, ...extra }
}

const STAMP = Date.now().toString(36)
const TEAM = `qa-team-${STAMP}`
const USER_EMAIL = `qa-user-${STAMP}@example.com`
const USER_PASSWORD = 'Qa-user-pass1!'
const QROLE = `qa-role-${STAMP}`
const XCLUSTER = `qa-extra-${STAMP}`
const MODEL = `qa-model-${STAMP}`
const BULK_EMAIL = `qa-bulk-${STAMP}@example.com`
const REG_EMAIL = `qa-register-${STAMP}@example.com`

// ---------- temporary users (admin API with the admin page's session) ----------
async function roleId(page: Page, name: string): Promise<number> {
  const roles = list((await api(page, 'GET', '/api/v1/auth/roles')).body)
  const r = roles.find((x: any) => String(x.name).toLowerCase() === name.toLowerCase()) || roles.find((x: any) => !/admin/i.test(String(x.name)))
  if (!r) throw new Error(`no role named ${name} (roles: ${roles.map((x: any) => x.name).join(',')})`)
  return r.id
}
async function findUser(page: Page, email: string): Promise<any | undefined> {
  return list((await api(page, 'GET', '/api/v1/auth/admin/users')).body).find((u: any) => u.email === email)
}
async function createTempUser(page: Page, email: string, password: string): Promise<void> {
  const r = await api(page, 'POST', '/api/v1/auth/admin/users', { name: 'QA temp', email, password, role_id: await roleId(page, 'Member') })
  if (r.status >= 300) throw new Error(`temp user create → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
}
async function deleteUserByEmail(page: Page, email: string): Promise<boolean> {
  const u = await findUser(page, email)
  if (!u) return false
  await api(page, 'DELETE', `/api/v1/auth/admin/users/${u.id}`)
  return true
}
/** A fresh browser context (no storageState) for drivers that act as another user. */
async function ownSession(page: Page) {
  const browser = page.context().browser()
  if (!browser) throw new Error('no browser for a second context')
  return browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
}
const roleName = (u: any) => ((typeof u?.role === 'string' ? u.role : u?.role?.name) || u?.global_role || '').toString().toLowerCase()

// ---------- k8s-service: reads, in-place changes ----------
def('ns-create', 'k8s-service:POST:/api/v1/namespaces', 'namespaces', async (page) => {
  await clickButton(page, /create|new|추가|생성/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.locator('input').first().fill('qa-ns-created')
  await d.getByRole('button', { name: /^create$|^생성$|submit/i }).first().click()
}, () => ({ ok: kubectl(['get', 'ns', 'qa-ns-created', '-o', 'name']).ok, detail: 'namespace qa-ns-created exists' }))

def('ns-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}', 'namespaces', async (page) => {
  await openRow(page, 'qa-ns-created')
  await clickButton(page, /delete namespace|delete|삭제/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const input = d.locator('input')
  if (await input.count()) await input.first().fill('qa-ns-created')
  await d.getByRole('button', { name: /^delete$|^삭제$/i }).first().click()
}, () => {
  const r = kubectl(['get', 'ns', 'qa-ns-created', '-o', 'jsonpath={.status.phase}'])
  return { ok: !r.ok || r.out === 'Terminating', detail: `namespace: ${r.out || 'gone'}` }
})

def('cm-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/configmaps/{name}', 'configuration/configmaps', async (page) => {
  await openRow(page, 'qa-cm')
  await clickButton(page, /delete configmap|delete|삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
}, () => ({ ok: !exists(['cm', 'qa-cm']), detail: 'configmap qa-cm deleted' }))

def('secret-reveal-yaml', 'k8s-service:GET:/api/v1/namespaces/{namespace}/secrets/{name}/yaml', 'configuration/secrets', async (page, ctx) => {
  await openRow(page, 'qa-secret')
  await clickTab(page, /yaml/i)
  await sleep(1500)
  const body = await page.locator('body').innerText()
  ctx.note = body.includes('qa-pass-123')
    ? 'value visible (decoded stringData)'
    : body.includes('cWEtcGFzcy0xMjM=')
      ? 'value visible (base64)'
      : body.includes('***')
        ? 'masked ***'
        : 'value not visible'
}, (_page, ctx) => ({ ok: /visible|masked/.test(ctx.note || ''), detail: `secret yaml: ${ctx.note}` }))

def('secret-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/secrets/{name}', 'configuration/secrets', async (page) => {
  await openRow(page, 'qa-secret')
  await clickButton(page, /delete secret|delete|삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
}, () => ({ ok: !exists(['secret', 'qa-secret']), detail: 'secret qa-secret deleted' }))

// Logs and the terminal live on the Cluster View page (pod list → tabs Logs / Exec).
def('pod-logs', 'k8s-service:GET:/api/v1/namespaces/{namespace}/pods/{name}/logs', 'cluster-view', async (page, ctx) => {
  await searchRow(page, 'qa-pod')
  await page.getByText('qa-pod', { exact: true }).first().click()
  await clickTab(page, /^logs$|로그/i)
  await sleep(3000)
  ctx.note = (await page.locator('body').innerText()).includes('tick') ? 'log lines visible' : 'no log lines seen'
}, (_page, ctx) => ({ ok: /visible/.test(ctx.note || ''), detail: `pod logs: ${ctx.note}` }))

def('pod-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/pods/{pod_name}', 'workloads/pods', async (page) => {
  await openRow(page, 'qa-pod')
  await clickButton(page, /delete pod|delete|삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
}, () => {
  const r = kubectl(['-n', NS, 'get', 'pod', 'qa-pod', '-o', 'jsonpath={.metadata.deletionTimestamp}'])
  return { ok: !r.ok || r.out !== '', detail: r.ok ? `deletionTimestamp=${r.out || 'none'}` : 'pod gone' }
})

def('deploy-rollback', 'k8s-service:POST:/api/v1/namespaces/{namespace}/deployments/{name}/rollback', 'workloads/deployments', async (page) => {
  kubectl(['-n', NS, 'set', 'env', 'deploy/qa-web', 'QA_REV=2']) // a second revision, so there is something to roll back to
  await sleep(1500)
  await openRow(page, 'qa-web')
  await clickButton(page, /rollback|롤백/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.getByText(/revision 1/i).first().click() // the Rollback button stays disabled until a revision is picked
  await d.getByRole('button', { name: /^rollback$|^롤백$/i }).last().click()
  await until(() => !jsonpath(['deploy', 'qa-web'], '{.spec.template.spec.containers[0].env}').includes('QA_REV'))
}, () => {
  const env = jsonpath(['deploy', 'qa-web'], '{.spec.template.spec.containers[0].env}')
  return { ok: !env.includes('QA_REV'), detail: `env after rollback: ${env || 'none'}` }
})

def('deploy-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/deployments/{deployment_name}', 'workloads/deployments', async (page) => {
  await openRow(page, 'qa-web')
  await clickButton(page, /delete deployment|delete|삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
}, () => ({ ok: !exists(['deploy', 'qa-web']), detail: 'deployment qa-web deleted' }))

def('cronjob-suspend', 'k8s-service:PATCH:/api/v1/namespaces/{namespace}/cronjobs/{name}/suspend', 'workloads/cronjobs', async (page) => {
  await openRow(page, 'qa-cron')
  await clickButton(page, /^suspend$|일시 ?중지/i)
  await sleep(800)
  const d = dialog(page)
  if (await d.isVisible().catch(() => false)) await d.getByRole('button', { name: /suspend|confirm|확인/i }).last().click()
}, () => ({ ok: jsonpath(['cronjob', 'qa-cron'], '{.spec.suspend}') === 'true', detail: `suspend=${jsonpath(['cronjob', 'qa-cron'], '{.spec.suspend}')}` }))

def('cronjob-trigger', 'k8s-service:POST:/api/v1/namespaces/{namespace}/cronjobs/{name}/trigger', 'workloads/cronjobs', async (page) => {
  await openRow(page, 'qa-cron')
  await clickButton(page, /trigger|run now|실행/i)
  const d = dialog(page)
  if (await d.isVisible().catch(() => false)) await d.getByRole('button', { name: /trigger|run|confirm|확인|실행/i }).first().click()
  await sleep(2000)
}, () => {
  const jobs = kubectl(['-n', NS, 'get', 'jobs', '-o', 'jsonpath={.items[*].metadata.name}']).out
  return { ok: /qa-cron/.test(jobs), detail: `jobs: ${jobs}` }
})

const firstNode = () => kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']).out
def('node-cordon', 'k8s-service:POST:/api/v1/nodes/{name}/cordon', 'cluster/nodes', async (page, ctx) => {
  ctx.node = firstNode()
  await openRow(page, ctx.node)
  await clickButton(page, /^cordon$/i)
  const d = dialog(page)
  if (await d.isVisible().catch(() => false)) await d.getByRole('button', { name: /cordon|confirm|확인/i }).first().click()
}, (_page, ctx) => {
  const u = kubectl(['get', 'node', ctx.node, '-o', 'jsonpath={.spec.unschedulable}']).out
  return { ok: u === 'true', detail: `unschedulable=${u}` }
})

def('node-uncordon', 'k8s-service:POST:/api/v1/nodes/{name}/uncordon', 'cluster/nodes', async (page, ctx) => {
  ctx.node = firstNode()
  await openRow(page, ctx.node)
  await clickButton(page, /^uncordon$/i)
  const d = dialog(page)
  if (await d.isVisible().catch(() => false)) await d.getByRole('button', { name: /uncordon|confirm|확인/i }).first().click()
}, (_page, ctx) => ({ ok: kubectl(['get', 'node', ctx.node, '-o', 'jsonpath={.spec.unschedulable}']).out !== 'true', detail: 'schedulable again' }))

// Helm detail page: Rollback lives in the History tab (per revision row); Uninstall in the header.
def('helm-rollback', 'k8s-service:POST:/api/v1/helm/releases/{namespace}/{name}/rollback', `helm/releases/${NS}/qa-release`, async (page) => {
  await clickTab(page, /^history$|이력/i)
  await sleep(1200)
  // the revision-1 row = the row whose first cell is exactly "1" (the row text starts with a status icon)
  const row = page.locator('table tbody tr').filter({ has: page.locator('td:first-child:text-is("1")') }).first()
  const btn = (await row.count()) ? row.getByRole('button', { name: /rollback|롤백/i }).first() : page.getByRole('button', { name: /rollback|롤백/i }).last()
  await btn.click()
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  // with helm-values-upgrade run first the release is at rev 3: pick revision 1 explicitly when offered
  const rev1 = d.getByText(/revision 1\b/i)
  if (await rev1.count()) await rev1.first().click()
  await d.getByRole('button', { name: /apply rollback|^rollback$|롤백/i }).last().click()
  await until(() => kubectl(['-n', NS, 'get', 'cm', 'qa-release-cm', '-o', 'jsonpath={.data.message}']).out === 'rev1')
}, () => {
  const r = kubectl(['-n', NS, 'get', 'cm', 'qa-release-cm', '-o', 'jsonpath={.data.message}'])
  return { ok: r.out === 'rev1', detail: `release message=${r.out} (rev1 expected after rollback)` }
})

def('helm-uninstall', 'k8s-service:DELETE:/api/v1/helm/releases/{namespace}/{name}', `helm/releases/${NS}/qa-release`, async (page) => {
  await clickButton(page, /^uninstall$|제거/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const cb = d.locator('input[type="checkbox"]')
  if (await cb.count()) await cb.first().check()
  const txt = d.locator('input[type="text"]')
  if (await txt.count()) await txt.first().fill('qa-release')
  await d.getByRole('button', { name: /^uninstall$|제거/i }).last().click()
  await sleep(4000)
}, () => ({ ok: !exists(['deploy', 'qa-release']), detail: 'release workload removed' }))

// The create dialog opens a Monaco editor pre-filled with a sample: replace it through the clipboard.
def('yaml-create', 'k8s-service:POST:/api/v1/resources/yaml/create', 'configuration/configmaps', async (page) => {
  await clickButton(page, /create|yaml|새로/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const yaml = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: qa-cm-created\n  namespace: ${NS}\ndata:\n  k: v\n`
  await pasteInto(page, d.locator('.monaco-editor').first(), yaml)
  await d.getByRole('button', { name: /^create$|^apply$|생성|적용/i }).last().click()
  await until(() => exists(['cm', 'qa-cm-created']), 10000)
}, () => ({ ok: exists(['cm', 'qa-cm-created']), detail: 'configmap qa-cm-created exists' }))

def('pod-exec', 'k8s-service:GET:/api/v1/namespaces/{namespace}/pods/{name}/exec/ws', 'workloads/pods', async (page, ctx) => {
  await openRow(page, 'qa-pod')
  await clickButton(page, /^exec$/i)
  await sleep(3000)
  await page.keyboard.type('echo QA-EXEC-OK\n')
  await sleep(2000)
  ctx.note = (await page.locator('body').innerText()).includes('QA-EXEC-OK') ? 'command output seen' : 'no output'
}, (_page, ctx) => ({ ok: ctx.note === 'command output seen', detail: `exec: ${ctx.note}` }))

// Every "open the row → Delete <Kind> → confirm" delete route, generated from one table:
// key, catalogue path, page route, seed object (kubectl kind/name), namespaced?
const DELETES: Array<[string, string, string, string, boolean]> = [
  ['sts-delete', '/api/v1/namespaces/{namespace}/statefulsets/{name}', 'workloads/statefulsets', 'statefulset/qa-sts', true],
  ['ds-delete', '/api/v1/namespaces/{namespace}/daemonsets/{name}', 'workloads/daemonsets', 'daemonset/qa-ds', true],
  ['job-delete', '/api/v1/namespaces/{namespace}/jobs/{name}', 'workloads/jobs', 'job/qa-job', true],
  ['cronjob-delete', '/api/v1/namespaces/{namespace}/cronjobs/{name}', 'workloads/cronjobs', 'cronjob/qa-cron', true],
  ['hpa-delete', '/api/v1/namespaces/{namespace}/hpas/{name}', 'workloads/hpas', 'hpa/qa-web', true],
  ['pdb-delete', '/api/v1/namespaces/{namespace}/pdbs/{name}', 'workloads/pdbs', 'pdb/qa-pdb', true],
  ['svc-delete', '/api/v1/namespaces/{namespace}/services/{name}', 'network/services', 'service/qa-web', true],
  ['ingress-delete', '/api/v1/namespaces/{namespace}/ingresses/{name}', 'network/ingresses', 'ingress/qa-web', true],
  ['netpol-delete', '/api/v1/namespaces/{namespace}/networkpolicies/{name}', 'network/networkpolicies', 'networkpolicy/qa-np', true],
  ['endpoints-delete', '/api/v1/namespaces/{namespace}/endpoints/{name}', 'network/endpoints', 'endpoints/qa-web', true],
  ['sa-delete', '/api/v1/namespaces/{namespace}/serviceaccounts/{name}', 'security/serviceaccounts', 'serviceaccount/qa-sa', true],
  ['k8srole-delete', '/api/v1/namespaces/{namespace}/roles/{name}', 'security/roles', 'role/qa-role', true], // distinct from the auth-service 'role-delete'
  ['rolebinding-delete', '/api/v1/namespaces/{namespace}/rolebindings/{name}', 'security/rolebindings', 'rolebinding/qa-rb', true],
  ['quota-delete', '/api/v1/namespaces/{namespace}/resourcequotas/{name}', 'cluster/resourcequotas', 'resourcequota/qa-quota', true],
  ['limitrange-delete', '/api/v1/namespaces/{namespace}/limitranges/{name}', 'cluster/limitranges', 'limitrange/qa-limits', true],
  ['lease-delete', '/api/v1/namespaces/{namespace}/leases/{name}', 'cluster/leases', 'lease/qa-lease', true],
  ['pvc-delete', '/api/v1/namespaces/{namespace}/pvcs/{name}', 'storage?tab=pvcs', 'pvc/qa-pvc', true],
  ['priorityclass-delete', '/api/v1/priorityclasses/{name}', 'cluster/priorityclasses', 'priorityclass/qa-priority', false],
  ['runtimeclass-delete', '/api/v1/runtimeclasses/{name}', 'cluster/runtimeclasses', 'runtimeclass/qa-runtime', false],
  ['storageclass-delete', '/api/v1/storageclasses/{name}', 'storage?tab=storageclasses', 'storageclass/qa-storage', false],
  ['ingressclass-delete', '/api/v1/ingressclasses/{name}', 'network/ingressclasses', 'ingressclass/qa-ingressclass', false],
  ['pv-delete', '/api/v1/pvs/{name}', 'storage?tab=pvs', 'pv/qa-pv', false],
  ['mutatingwebhook-delete', '/api/v1/mutatingwebhookconfigurations/{name}', 'cluster/mutatingwebhookconfigurations', 'mutatingwebhookconfiguration/qa-mutating', false],
  ['validatingwebhook-delete', '/api/v1/validatingwebhookconfigurations/{name}', 'cluster/validatingwebhookconfigurations', 'validatingwebhookconfiguration/qa-validating', false],
  ['crd-instance-delete', '/api/v1/custom-resources/{group}/{version}/{plural}/{namespace}/{name}', 'custom-resources/instances', 'widget/qa-widget', true],
  ['crd-delete', '/api/v1/crds/{name}', 'custom-resources/groups', 'crd/widgets.qa.example.com', false],
  // cluster RBAC, Gateway API (CRDs v1.3.0 experimental on the target), VPA, DRA (resource.k8s.io/v1 on K8s ≥ 1.34)
  ['clusterrole-delete', '/api/v1/clusterroles/{name}', 'security/clusterroles', 'clusterrole/qa-clusterrole', false],
  ['clusterrolebinding-delete', '/api/v1/clusterrolebindings/{name}', 'security/clusterrolebindings', 'clusterrolebinding/qa-crb', false],
  ['gatewayclass-delete', '/api/v1/gatewayclasses/{name}', 'gateway/gatewayclasses', 'gatewayclass/qa-gatewayclass', false],
  ['gateway-delete', '/api/v1/namespaces/{namespace}/gateways/{name}', 'gateway/gateways', 'gateway/qa-gateway', true],
  ['httproute-delete', '/api/v1/namespaces/{namespace}/httproutes/{name}', 'gateway/httproutes', 'httproute/qa-httproute', true],
  ['grpcroute-delete', '/api/v1/namespaces/{namespace}/grpcroutes/{name}', 'gateway/grpcroutes', 'grpcroute/qa-grpcroute', true],
  ['referencegrant-delete', '/api/v1/namespaces/{namespace}/referencegrants/{name}', 'gateway/referencegrants', 'referencegrant/qa-refgrant', true],
  ['backendtlspolicy-delete', '/api/v1/namespaces/{namespace}/backendtlspolicies/{name}', 'gateway/backendtlspolicies', 'backendtlspolicy/qa-btls', true],
  ['vpa-delete', '/api/v1/namespaces/{namespace}/vpas/{name}', 'workloads/vpas', 'vpa/qa-vpa', true],
  ['deviceclass-delete', '/api/v1/deviceclasses/{name}', 'gpu/deviceclasses', 'deviceclass/qa-deviceclass', false],
  ['resourceclaim-delete', '/api/v1/namespaces/{namespace}/resourceclaims/{name}', 'gpu/resourceclaims', 'resourceclaim/qa-claim', true],
  ['resourceclaimtemplate-delete', '/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}', 'gpu/resourceclaimtemplates', 'resourceclaimtemplate/qa-claim-template', true],
  ['resourceslice-delete', '/api/v1/resourceslices/{name}', 'gpu/resourceslices', 'resourceslice/qa-slice', false],
]
for (const [key, p, route, obj, namespaced] of DELETES) {
  const [kind, name] = obj.split('/')
  if (key === 'endpoints-delete') {
    // The endpoints controller recreates the Endpoints of a live Service right away: deleted = new uid.
    def(key, `k8s-service:DELETE:${p}`, route, async (page, ctx) => {
      ctx.uid = jsonpath(['endpoints', name], '{.metadata.uid}')
      await openRow(page, name)
      await clickButton(page, /^delete\b|^삭제/i)
      await confirmDialog(page, /^delete$|^삭제$/i)
      await until(() => jsonpath(['endpoints', name], '{.metadata.uid}') !== ctx.uid, 10000)
    }, (_page, ctx) => {
      const uid = jsonpath(['endpoints', name], '{.metadata.uid}')
      return { ok: uid !== ctx.uid, detail: uid === ctx.uid ? 'same object (not deleted)' : 'deleted — recreated by the endpoints controller (new uid)' }
    })
    continue
  }
  def(key, `k8s-service:DELETE:${p}`, route, async (page) => {
    await openRow(page, name)
    await clickButton(page, /^delete\b|^삭제/i) // the drawer header's only Delete button reads "Delete <Kind>"
    await confirmDialog(page, /^delete$|^삭제$/i, name)
  }, () => {
    const base = namespaced ? ['-n', NS, 'get', kind, name] : ['get', kind, name]
    const r = kubectl([...base, '-o', 'name'])
    const terminating = r.ok && kubectl([...base, '-o', 'jsonpath={.metadata.deletionTimestamp}']).out !== ''
    return { ok: !r.ok || terminating, detail: r.ok ? (terminating ? `${obj} terminating` : `${obj} still present`) : `${obj} deleted` }
  })
}

// ---------- auth-service admin pages (teams, users, roles, clusters) ----------
def('team-add', 'auth-service:POST:/admin/organizations', 'admin/organizations', async (page) => {
  await page.getByPlaceholder(/enter name|이름/i).first().fill(TEAM)
  await clickButton(page, /^add$|추가/i)
  await sleep(800)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/auth/organizations?type=team')
  const ok = list(r.body).some((o: any) => o.name === TEAM)
  return { ok, detail: ok ? `team ${TEAM} listed` : `team not listed (${r.status})` }
})

def('team-delete', 'auth-service:DELETE:/admin/organizations/{id}', 'admin/organizations', async (page) => {
  const row = page.locator('li, tr, div').filter({ hasText: TEAM }).last()
  await row.getByRole('button').last().click() // the trash button
  await acceptConfirm(page)
  await sleep(800)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/auth/organizations?type=team')
  const ok = !list(r.body).some((o: any) => o.name === TEAM)
  return { ok, detail: ok ? 'team gone' : 'team still listed' }
})

def('user-add', 'auth-service:POST:/admin/users', 'admin/users', async (page) => {
  await clickButton(page, /add user|사용자 추가/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.locator('input[type="text"], input:not([type])').first().fill('QA user')
  await d.locator('input[type="email"], input[name="email"], input[placeholder*="@"]').first().fill(USER_EMAIL)
  await d.locator('input[type="password"]').first().fill(USER_PASSWORD)
  // "Select role" is the shared CustomDropdown (trigger data-testid=create-user-role, options = buttons)
  const roleSel = d.locator('select').last()
  if (await roleSel.count()) await roleSel.selectOption({ label: 'MEMBER' }).catch(() => roleSel.selectOption({ index: 1 }))
  else {
    await d.locator('[data-testid="create-user-role"]').click()
    await sleep(300)
    const member = d.getByRole('button', { name: /^member$/i })
    if (await member.count()) await member.first().click()
    else await d.locator('[data-testid="create-user-role"] ~ * button, [data-testid="create-user-role"] + * button').last().click()
  }
  await d.getByRole('button', { name: /^create$|^add$|^save$|생성|추가|저장/i }).last().click()
  await sleep(1500)
}, async (page) => {
  const u = await findUser(page, USER_EMAIL)
  return { ok: !!u, detail: u ? `user ${USER_EMAIL} listed` : 'user not listed' }
})

// The users table paginates: walk the pages until the row is on screen.
async function userRow(page: Page, email: string) {
  for (let i = 0; i < 8; i++) {
    const row = page.locator('tr').filter({ hasText: email }).first()
    if (await row.count()) return row
    const next = page.getByRole('button', { name: /^next$|다음/i }).first()
    if (!(await next.count()) || (await next.isDisabled())) break
    await next.click()
    await sleep(600)
  }
  return page.locator('tr').filter({ hasText: email }).first()
}

// Admin users: Bulk upload modal → CSV file (name,email,password,role,team) → created count. Cleans up through the API.
def('users-bulk-upload', 'auth-service:POST:/admin/users/bulk', 'admin/users', async (page, ctx) => {
  await clickButton(page, /bulk upload|일괄/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const csv = `name,email,password,role,team\nQA bulk,${BULK_EMAIL},Qa-bulk-pass1!,Member,\n`
  await d.locator('input[type="file"]').first().setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await sleep(3000)
  ctx.note = (await d.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
  await page.keyboard.press('Escape').catch(() => {})
}, async (page) => {
  const created = await deleteUserByEmail(page, BULK_EMAIL)
  return { ok: created, detail: created ? 'bulk user created (removed afterwards)' : 'bulk user not listed' }
})

// Cluster access modal: grant Write on the target cluster to the temporary user (the "add a user" row —
// a user without a grant is not listed yet), then revoke it from its row.
async function tempUserClusterRole(page: Page): Promise<string | undefined> {
  const u = await findUser(page, USER_EMAIL)
  const body = (await api(page, 'GET', `/api/v1/auth/admin/users/${u?.id}/cluster-roles`)).body
  // GET …/cluster-roles answers a map {cluster_id: role}; a list [{cluster_id, role}] is handled too
  return Array.isArray(body)
    ? body.find((x: any) => (x.cluster_id || x.cluster) === TARGET_CLUSTER)?.role
    : body && typeof body === 'object'
      ? (body[TARGET_CLUSTER] ?? body.roles?.[TARGET_CLUSTER])
      : undefined
}
async function openAccessModal(page: Page) {
  const row = page.locator('tr').filter({ hasText: TARGET_CLUSTER }).first()
  await row.locator('button').filter({ hasText: /^\s*access\s*$|접근/i }).first().click()
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.getByTestId('cluster-access-list').waitFor({ state: 'visible', timeout: 10000 })
  await sleep(800)
  return d
}
def('cluster-access', 'auth-service:PUT:/admin/users/{user_id}/cluster-roles/{cluster_id}', 'admin/clusters', async (page, ctx) => {
  const u = await findUser(page, USER_EMAIL)
  if (!u) throw new Error(`temp user ${USER_EMAIL} missing (user-add must run first)`)
  const d = await openAccessModal(page)
  await d.getByTestId('cluster-access-add-user').click()
  await d.getByTestId(`cluster-access-add-user-opt-${u.id}`).click()
  await d.getByTestId('cluster-access-add-role').click()
  await d.getByTestId('cluster-access-add-role-opt-Write').click()
  await d.getByTestId('cluster-access-add-btn').click()
  await d.getByTestId(`cluster-access-role-${u.id}`).waitFor({ state: 'visible', timeout: 10000 })
  ctx.note = (await d.getByTestId('cluster-access-list').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
}, async (page) => {
  const role = await tempUserClusterRole(page)
  return { ok: /write/i.test(role || ''), detail: `temp user role on ${TARGET_CLUSTER}=${role || '?'}` }
})

def('cluster-access-revoke', 'auth-service:DELETE:/admin/users/{user_id}/cluster-roles/{cluster_id}', 'admin/clusters', async (page, ctx) => {
  const u = await findUser(page, USER_EMAIL)
  if (!u) throw new Error(`temp user ${USER_EMAIL} missing (user-add must run first)`)
  const d = await openAccessModal(page)
  await d.getByTestId(`cluster-access-revoke-${u.id}`).click()
  await d.getByTestId(`cluster-access-role-${u.id}`).waitFor({ state: 'hidden', timeout: 10000 })
  ctx.note = (await d.getByTestId('cluster-access-list').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)
}, async (page) => {
  const role = await tempUserClusterRole(page)
  return { ok: !role, detail: role ? `grant still ${role}` : 'grant revoked' }
})

def('user-reset-password', 'auth-service:POST:/admin/users/{user_id}/reset-password', 'admin/users', async (page, ctx) => {
  const row = await userRow(page, USER_EMAIL)
  await row.locator('button').filter({ hasText: /reset (pw|password)|비밀번호/i }).first().click()
  await acceptConfirm(page)
  await sleep(2000)
  ctx.note = (await uiText(page)).join(' | ').slice(0, 160)
}, async (page, ctx) => {
  // the old password must be refused once the admin reset it
  const r = await page.request.post('/api/v1/auth/login', { data: { email: USER_EMAIL, password: USER_PASSWORD } })
  return { ok: r.status() === 401, detail: `old password after reset → ${r.status()}; ${ctx.note || ''}` }
})

def('user-role-change', 'auth-service:PATCH:/admin/users/{user_id}', 'admin/users', async (page) => {
  const row = await userRow(page, USER_EMAIL)
  // the role cell is a custom dropdown: open it on this row, then pick ADMIN (inside the row first, page-wide as a fallback)
  await row.getByText(/^(member|read|write|pending)$/i).first().click()
  await sleep(600)
  const inRow = row.getByText(/^admin$/i)
  if (await inRow.count()) await inRow.first().click()
  else await page.locator('[role="menu"], [role="listbox"], ul, div').filter({ hasText: /^(\s*(pending|member|admin|read|write)\s*)+$/i }).last().getByText(/^admin$/i).first().click()
  await sleep(1500)
}, async (page) => {
  const role = roleName(await findUser(page, USER_EMAIL))
  return { ok: role === 'admin', detail: `role=${role || '?'}` }
})

def('user-delete', 'auth-service:DELETE:/admin/users/{user_id}', 'admin/users', async (page) => {
  const row = await userRow(page, USER_EMAIL)
  await row.getByRole('button', { name: /delete|삭제/i }).first().click()
  await acceptConfirm(page)
  await sleep(1000)
}, async (page) => {
  const u = await findUser(page, USER_EMAIL)
  return { ok: !u, detail: u ? 'user still listed' : 'user gone' }
})

def('role-create', 'auth-service:POST:/admin/roles', 'admin/roles', async (page) => {
  await clickButton(page, /create role|역할 (생성|추가)/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  const inputs = d.locator('input[type="text"], input:not([type]), textarea')
  await inputs.nth(0).fill(QROLE)
  if ((await inputs.count()) > 1) await inputs.nth(1).fill('QA sweep role')
  const cb = d.locator('input[type="checkbox"]')
  if (await cb.count()) await cb.first().check()
  await d.getByRole('button', { name: /^create$|^save$|생성|저장/i }).last().click()
  await sleep(1000)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/auth/roles')
  const ok = list(r.body).some((x: any) => x.name === QROLE)
  return { ok, detail: ok ? `role ${QROLE} listed` : `role not listed (${r.status})` }
})

// Admin roles: pencil button on the row → Edit Role modal → description → Save.
def('role-edit', 'auth-service:PUT:/admin/roles/{id}', 'admin/roles', async (page) => {
  const row = page.locator('tr, li, div').filter({ hasText: QROLE }).filter({ has: page.locator('button[title="Edit"]') }).last()
  await row.locator('button[title="Edit"]').first().click()
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.getByPlaceholder(/infrastructure team lead|설명/i).first().fill('edited by qa')
  await d.getByRole('button', { name: /^save$|^update$|저장|수정/i }).last().click()
  await sleep(1500)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/auth/roles')
  const me = list(r.body).find((x: any) => x.name === QROLE)
  const ok = me?.description === 'edited by qa'
  return { ok, detail: ok ? 'description updated' : `description=${me?.description ?? '?'} (${r.status})` }
})

def('role-delete', 'auth-service:DELETE:/admin/roles/{id}', 'admin/roles', async (page) => {
  const row = page.locator('tr').filter({ hasText: QROLE }).first()
  const trash = row.locator('button[title="Delete"]')
  if (await trash.count()) {
    await trash.first().click() // custom roles have a trash button
    await acceptConfirm(page)
  } else {
    await row.locator('button[title="Edit"]').first().click() // pencil → edit dialog → Delete
    const d = dialog(page)
    await d.waitFor({ state: 'visible', timeout: 10000 })
    await d.getByRole('button', { name: /delete|삭제/i }).first().click()
  }
  await sleep(1000)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/auth/roles')
  const ok = !list(r.body).some((x: any) => x.name === QROLE)
  return { ok, detail: ok ? 'role gone' : 'role still listed' }
})

def('cluster-test', 'auth-service:POST:/api/v1/clusters/{id}/test', 'admin/clusters', async (page, ctx) => {
  const row = page.locator('tr').filter({ hasText: TARGET_CLUSTER }).first()
  await row.locator('button').filter({ hasText: /^\s*test\s*$|테스트/i }).first().click()
  await sleep(4000)
  ctx.note = (await uiText(page)).join(' | ').slice(0, 120)
}, async (page) => {
  const c = list((await api(page, 'GET', '/api/v1/clusters')).body).find((x: any) => x.id === TARGET_CLUSTER)
  return { ok: /healthy/i.test(c?.health_status || ''), detail: `health_status=${c?.health_status}` }
})

def('cluster-edit', 'auth-service:PATCH:/api/v1/clusters/{id}', 'admin/clusters', async (page) => {
  const row = page.locator('tr').filter({ hasText: TARGET_CLUSTER }).first()
  await row.locator('button').filter({ hasText: /^\s*edit\s*$|편집/i }).first().click()
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.locator('input[type="text"], input:not([type])').first().fill(`${TARGET_CLUSTER} (qa)`)
  await d.getByRole('button', { name: /^save$|저장|update|수정/i }).last().click()
  await sleep(2000)
}, async (page) => {
  const c = list((await api(page, 'GET', '/api/v1/clusters')).body).find((x: any) => x.id === TARGET_CLUSTER)
  const ok = (c?.display_name || '') === `${TARGET_CLUSTER} (qa)`
  if (ok) await api(page, 'PATCH', `/api/v1/clusters/${TARGET_CLUSTER}`, { display_name: TARGET_CLUSTER })
  return { ok, detail: `display_name=${c?.display_name} (restored afterwards)` }
})

// A cluster is deduplicated by its UID, so the extra registration uses another kind cluster (EXTRA_KIND).
const kindClusters = () => {
  try {
    return execFileSync('kind', ['get', 'clusters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map((s) => s.trim())
  } catch {
    return [] as string[]
  }
}
const needExtraKind = () => (kindClusters().includes(EXTRA_KIND) ? null : `kind cluster ${EXTRA_KIND} not found (E2E_ACTIONS_EXTRA_KIND)`)
let registeredExtra = false
def('cluster-register', 'auth-service:POST:/api/v1/clusters', 'admin/clusters', async (page) => {
  const kc = execFileSync('kind', ['get', 'kubeconfig', '--name', EXTRA_KIND, '--internal'], { encoding: 'utf8' })
  await clickButton(page, /register cluster|클러스터 등록/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.locator('input[type="text"], input:not([type])').first().fill(XCLUSTER)
  const ta = d.locator('textarea').first()
  if (await ta.count()) await ta.fill(kc)
  // Register stays disabled until "Test connection" succeeds (the probe runs in k8s-service)
  const test = d.getByRole('button', { name: /test connection|연결 테스트/i })
  if (await test.count()) {
    await test.click()
    await sleep(6000)
  }
  await d.getByRole('button', { name: /^register$|등록/i }).last().click()
  await sleep(6000)
}, async (page) => {
  const c = list((await api(page, 'GET', '/api/v1/clusters')).body).find((x: any) => x.display_name === XCLUSTER || x.id === XCLUSTER)
  registeredExtra = !!c
  return { ok: !!c, detail: c ? `cluster ${c.id} ${c.health_status}` : 'not registered' }
}, { precondition: needExtraKind })

def('cluster-delete', 'auth-service:DELETE:/api/v1/clusters/{id}', 'admin/clusters', async (page) => {
  const row = page.locator('tr').filter({ hasText: XCLUSTER }).first()
  await row.getByRole('button', { name: /delete|삭제/i }).first().click()
  const d = dialog(page)
  if (await d.isVisible().catch(() => false)) {
    const input = d.locator('input[type="text"]')
    if (await input.count()) await input.first().fill(XCLUSTER)
    await d.getByRole('button', { name: /^delete$|^remove$|삭제/i }).last().click()
  }
  await sleep(2000)
}, async (page) => {
  if (!registeredExtra) return { ok: false, detail: 'nothing to delete (register did not land)' }
  const ok = !list((await api(page, 'GET', '/api/v1/clusters')).body).some((x: any) => x.display_name === XCLUSTER || x.id === XCLUSTER)
  return { ok, detail: ok ? 'cluster gone' : 'cluster still listed' }
}, { precondition: needExtraKind })

// ---------- in-place edits, Helm upgrade/test, node drain ----------
// Drawer → YAML tab → Edit → paste a changed document → Apply (k8s.yaml.apply)
def('cm-yaml-apply', 'k8s-service:POST:/api/v1/resources/yaml/apply', 'configuration/configmaps', async (page) => {
  await openRow(page, 'qa-cm')
  await clickTab(page, /yaml/i)
  await sleep(1200)
  const yaml = (await currentYaml(page, 'configmaps', NS, 'qa-cm')).replace(/greeting: hello/, 'greeting: edited')
  await clickButton(page, /^edit$|편집/i)
  await pasteInto(page, page.locator('.monaco-editor').first(), yaml)
  await clickButton(page, /^apply$|적용/i)
  await until(() => jsonpath(['cm', 'qa-cm'], '{.data.greeting}') === 'edited', 10000)
}, () => ({ ok: jsonpath(['cm', 'qa-cm'], '{.data.greeting}') === 'edited', detail: `greeting=${jsonpath(['cm', 'qa-cm'], '{.data.greeting}')}` }))

const addLabel = (yaml: string) => yaml.replace(/^( +)labels:\n( +)/m, (_m, a, b) => `${a}labels:\n${b}qa-sweep/touched: "yes"\n${b}`)
def('node-yaml-apply', 'k8s-service:POST:/api/v1/nodes/{name}/yaml/apply', 'cluster/nodes', async (page, ctx) => {
  ctx.node = firstNode()
  await openRow(page, ctx.node)
  await clickTab(page, /yaml/i)
  await sleep(1200)
  const yaml = addLabel(await currentYaml(page, 'nodes', '', ctx.node)) // the YAML is dumped with 4-space indents: keep the file's indent
  await clickButton(page, /^edit$|편집/i)
  await pasteInto(page, page.locator('.monaco-editor').first(), yaml, ctx)
  await clickButton(page, /^apply$|적용/i)
  await until(() => kubectl(['get', 'node', ctx.node, '-o', 'jsonpath={.metadata.labels.qa-sweep/touched}']).out === 'yes', 10000)
}, (_page, ctx) => ({ ok: kubectl(['get', 'node', ctx.node, '-o', 'jsonpath={.metadata.labels.qa-sweep/touched}']).out === 'yes', detail: 'node label qa-sweep/touched' }))

// Namespace drawer → YAML → Edit → Apply goes through its own route (applyNamespaceYaml).
def('ns-yaml-apply', 'k8s-service:POST:/api/v1/namespaces/{namespace}/yaml/apply', 'namespaces', async (page, ctx) => {
  await openRow(page, NS2)
  await clickTab(page, /yaml/i)
  await sleep(1200)
  const yaml = addLabel(await currentYaml(page, 'namespaces', '', NS2))
  await clickButton(page, /^edit$|편집/i)
  await pasteInto(page, page.locator('.monaco-editor').first(), yaml, ctx)
  await clickButton(page, /^apply$|적용/i)
  await until(() => kubectl(['get', 'ns', NS2, '-o', 'jsonpath={.metadata.labels.qa-sweep/touched}']).out === 'yes', 10000)
}, () => ({ ok: kubectl(['get', 'ns', NS2, '-o', 'jsonpath={.metadata.labels.qa-sweep/touched}']).out === 'yes', detail: 'namespace label qa-sweep/touched' }))

def('cronjob-resume', 'k8s-service:PATCH:/api/v1/namespaces/{namespace}/cronjobs/{name}/suspend', 'workloads/cronjobs', async (page) => {
  await openRow(page, 'qa-cron')
  await clickButton(page, /^resume$|재개/i)
  await until(() => jsonpath(['cronjob', 'qa-cron'], '{.spec.suspend}') !== 'true', 10000)
}, () => ({ ok: jsonpath(['cronjob', 'qa-cron'], '{.spec.suspend}') !== 'true', detail: `suspend=${jsonpath(['cronjob', 'qa-cron'], '{.spec.suspend}') || 'false'}` }))

def('helm-values-upgrade', 'k8s-service:PUT:/api/v1/helm/releases/{namespace}/{name}/values', `helm/releases/${NS}/qa-release`, async (page, ctx) => {
  await clickTab(page, /^values$/i)
  await sleep(1200)
  await clickButton(page, /^edit|편집/i)
  await sleep(800)
  await pasteInto(page, page.locator('.monaco-editor').first(), 'replicas: 1\nmessage: rev3\n', ctx)
  await clickButton(page, /preview|upgrade|업그레이드/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 15000 })
  await d.getByRole('button', { name: /apply upgrade|업그레이드/i }).last().click()
  await until(() => kubectl(['-n', NS, 'get', 'cm', 'qa-release-cm', '-o', 'jsonpath={.data.message}']).out === 'rev3', 20000)
}, () => {
  const r = kubectl(['-n', NS, 'get', 'cm', 'qa-release-cm', '-o', 'jsonpath={.data.message}'])
  return { ok: r.out === 'rev3', detail: `release message=${r.out}` }
})

def('helm-test', 'k8s-service:POST:/api/v1/helm/releases/{namespace}/{name}/test', `helm/releases/${NS}/qa-release`, async (page, ctx) => {
  await clickButton(page, /run tests|테스트 실행/i)
  await sleep(4000)
  ctx.note = (await uiText(page)).join(' | ').slice(0, 120)
}, (_page, ctx) => ({ ok: true, detail: `chart has no tests — screen: ${ctx.note || '(no dialog/toast text)'}` }))

// Helm History → click the superseded revision → RevisionDetailModal → "Diff vs current" tab (POST …/diff).
def('helm-revision-diff', 'k8s-service:POST:/api/v1/helm/releases/{namespace}/{name}/diff', `helm/releases/${NS}/qa-release`, async (page, ctx) => {
  await clickTab(page, /^history$|이력/i)
  await sleep(1200)
  const rows = page.locator('table tbody tr')
  const row = rows.filter({ has: page.getByRole('button', { name: /rollback|롤백/i }) }).first()
  await ((await row.count()) ? row.locator('td').first() : rows.last().locator('td').first()).click()
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await sleep(800)
  const tab = d.getByRole('button', { name: /diff/i }).first()
  if (await tab.count()) await tab.click()
  else await d.getByText(/diff/i).first().click()
  await sleep(2500)
  const txt = (await d.innerText().catch(() => '')).replace(/\s+/g, ' ')
  ctx.note = /rev1|rev2|message/.test(txt) ? 'diff shows the message change' : txt.slice(0, 120)
  await page.keyboard.press('Escape').catch(() => {})
}, (_page, ctx) => ({ ok: /diff shows/.test(ctx.note || ''), detail: ctx.note || '' }))

def('node-drain', 'k8s-service:POST:/api/v1/nodes/{name}/drain', 'cluster/nodes', async (page, ctx) => {
  ctx.node = firstNode()
  await openRow(page, ctx.node)
  await clickButton(page, /^drain$/i)
  const d = dialog(page)
  await d.waitFor({ state: 'visible', timeout: 10000 })
  await d.getByRole('button', { name: /^drain$|확인/i }).last().click()
  await sleep(8000)
  ctx.note = (await uiText(page)).join(' | ').slice(0, 160)
  ctx.unschedulable = kubectl(['get', 'node', ctx.node, '-o', 'jsonpath={.spec.unschedulable}']).out
  ctx.evicted = kubectl(['-n', NS, 'get', 'pod', 'qa-pod', '-o', 'name']).ok ? 'qa-pod still there' : 'qa-pod evicted'
  kubectl(['uncordon', ctx.node]) // leave the single node usable for the rest of the run
}, (_page, ctx) => ({ ok: ctx.unschedulable === 'true', detail: `cordoned by drain=${ctx.unschedulable}; ${ctx.evicted}; uncordoned afterwards` }))

// DaemonSet / StatefulSet rollback: same dialog as the Deployment, same "env added in rev 2 must disappear" check.
for (const [key, kind, short, route, name] of [
  ['ds-rollback', 'daemonsets', 'ds', 'workloads/daemonsets', 'qa-ds'],
  ['sts-rollback', 'statefulsets', 'sts', 'workloads/statefulsets', 'qa-sts'],
] as const) {
  def(key, `k8s-service:POST:/api/v1/namespaces/{namespace}/${kind}/{name}/rollback`, route, async (page) => {
    kubectl(['-n', NS, 'set', 'env', `${short}/${name}`, 'QA_REV=2'])
    await sleep(2500)
    await openRow(page, name)
    await clickButton(page, /rollback|롤백/i)
    const d = dialog(page)
    await d.waitFor({ state: 'visible', timeout: 10000 })
    await d.getByText(/revision 1/i).first().click()
    await d.getByRole('button', { name: /^rollback$|^롤백$/i }).last().click()
    await until(() => !jsonpath([short, name], '{.spec.template.spec.containers[0].env}').includes('QA_REV'))
  }, () => {
    const env = jsonpath([short, name], '{.spec.template.spec.containers[0].env}')
    return { ok: !env.includes('QA_REV'), detail: `env after rollback: ${env || 'none'}` }
  })
}

// ReplicaSet / EndpointSlice names are generated: resolve them at run time; both are recreated by their
// controller, so "deleted" = the original uid is gone.
def('replicaset-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/replicasets/{name}', 'workloads/replicasets', async (page, ctx) => {
  ctx.name = kubectl(['-n', NS, 'get', 'rs', '-l', 'app=qa-web', '-o', 'jsonpath={.items[0].metadata.name}']).out
  ctx.uid = jsonpath(['rs', ctx.name], '{.metadata.uid}')
  await openRow(page, ctx.name)
  await clickButton(page, /^delete\b|^삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
  await until(() => jsonpath(['rs', ctx.name], '{.metadata.uid}') !== ctx.uid, 10000)
}, (_page, ctx) => {
  const uid = jsonpath(['rs', ctx.name], '{.metadata.uid}')
  return { ok: uid !== ctx.uid, detail: uid === ctx.uid ? `${ctx.name} same object (not deleted)` : `${ctx.name} deleted — recreated by the Deployment` }
})

def('endpointslice-delete', 'k8s-service:DELETE:/api/v1/namespaces/{namespace}/endpointslices/{name}', 'network/endpointslices', async (page, ctx) => {
  ctx.name = kubectl(['-n', NS, 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=qa-web', '-o', 'jsonpath={.items[0].metadata.name}']).out
  ctx.uid = jsonpath(['endpointslice', ctx.name], '{.metadata.uid}')
  await openRow(page, ctx.name)
  await clickButton(page, /^delete\b|^삭제/i)
  await confirmDialog(page, /^delete$|^삭제$/i)
  await until(() => jsonpath(['endpointslice', ctx.name], '{.metadata.uid}') !== ctx.uid, 10000)
}, (_page, ctx) => {
  const uid = jsonpath(['endpointslice', ctx.name], '{.metadata.uid}')
  return { ok: uid !== ctx.uid, detail: uid === ctx.uid ? `${ctx.name} same object (not deleted)` : `${ctx.name} deleted — the endpointslice controller recreates one` }
})

// ---------- ai-service model configs (admin) ----------
// The model form is an inline panel ("New Model"), not a modal.
def('model-config-create', 'ai-service:POST:/api/v1/ai/model-configs', 'admin/ai-models', async (page) => {
  await clickButton(page, /new model|add|create|추가|생성/i)
  await page.getByPlaceholder(/my-gpt4/i).waitFor({ state: 'visible', timeout: 10000 })
  await page.getByPlaceholder(/my-gpt4/i).fill(MODEL)
  const custom = page.getByText(/custom model name/i)
  if (await custom.count()) await custom.first().click()
  const model = page.getByPlaceholder(/gpt-4o-mini/i)
  if (await model.count()) await model.first().fill('gpt-4o-mini')
  const keyEnv = page.getByPlaceholder(/OPENAI_API_KEY/i)
  if (await keyEnv.count()) await keyEnv.first().fill('KUBEAST_AI_KEY_QA')
  await page.getByRole('button', { name: /^create$|생성/i }).last().click()
  await sleep(2500)
}, async (page) => {
  const r = await api(page, 'GET', '/api/v1/ai/model-configs')
  const ok = list(r.body).some((m: any) => m.name === MODEL)
  return { ok, detail: ok ? `model config ${MODEL} listed` : `not listed (${r.status})` }
})

const modelCard = (page: Page) => page.locator('div').filter({ has: page.locator('button[title="Edit"]') }).filter({ hasText: MODEL }).last()
def('model-config-update', 'ai-service:PATCH:/api/v1/ai/model-configs/{config_id}', 'admin/ai-models', async (page) => {
  await modelCard(page).locator('button[title="Edit"]').first().click()
  await page.getByPlaceholder(/my-gpt4/i).waitFor({ state: 'visible', timeout: 10000 })
  const custom = page.getByText(/custom model name/i)
  if (await custom.count()) await custom.first().click()
  const model = page.getByPlaceholder(/gpt-4o-mini/i)
  if (await model.count()) await model.first().fill('gpt-4.1-mini')
  await page.getByRole('button', { name: /^save$|^update$|저장|수정/i }).last().click()
  await sleep(2500)
}, async (page) => {
  const m = list((await api(page, 'GET', '/api/v1/ai/model-configs')).body).find((x: any) => x.name === MODEL)
  return { ok: m?.model === 'gpt-4.1-mini', detail: `model=${m?.model}` }
})

def('model-config-delete', 'ai-service:DELETE:/api/v1/ai/model-configs/{config_id}', 'admin/ai-models', async (page) => {
  await modelCard(page).locator('button[title="Delete"], button[title*="elete"]').first().click()
  await acceptConfirm(page)
  await sleep(2000)
}, async (page) => {
  const ok = !list((await api(page, 'GET', '/api/v1/ai/model-configs')).body).some((m: any) => m.name === MODEL)
  return { ok, detail: ok ? 'model config gone' : 'still listed' }
})

// ---------- own-session drivers: a temporary user in a second browser context ----------
const PW_EMAIL = `qa-pw-${STAMP}@example.com`
const PW0 = 'Qa-temp-pass1!'
const PW1 = 'Qa-temp-pass2!'
def('account-password-change', 'auth-service:POST:/change-password', '', async (page, ctx) => {
  await createTempUser(page, PW_EMAIL, PW0)
  const c = await ownSession(page)
  try {
    const p = await c.newPage()
    await login(p, PW_EMAIL, PW0)
    await p.goto('/account')
    await changePassword(p, PW0, PW1)
    await sleep(2500)
    // change-password rotates the session cookie (token_version bump + a fresh cookie), so the user stays signed in
    ctx.bounced = p.url().includes('/login')
    ctx.meAfter = (await p.request.get('/api/v1/auth/me')).status()
    ctx.newLogin = (await p.request.post('/api/v1/auth/login', { data: { email: PW_EMAIL, password: PW1 } })).status()
    ctx.oldLogin = (await p.request.post('/api/v1/auth/login', { data: { email: PW_EMAIL, password: PW0 } })).status()
  } finally {
    await c.close()
  }
}, async (page, ctx) => {
  await deleteUserByEmail(page, PW_EMAIL)
  const ok = ctx.newLogin === 200 && ctx.oldLogin === 401 && ctx.meAfter === 200 && !ctx.bounced
  return { ok, detail: `new password login ${ctx.newLogin}, old ${ctx.oldLogin}, /auth/me after change ${ctx.meAfter}, bounced to /login: ${ctx.bounced}` }
})

const LOGOUT_EMAIL = `qa-logout-${STAMP}@example.com`
def('logout', 'auth-service:POST:/logout', '', async (page, ctx) => {
  await createTempUser(page, LOGOUT_EMAIL, PW0)
  const c = await ownSession(page)
  try {
    const p = await c.newPage()
    await login(p, LOGOUT_EMAIL, PW0)
    ctx.meBefore = (await p.request.get('/api/v1/auth/me')).status()
    await clickButton(p, /log ?out|로그아웃/i)
    await sleep(1500)
    ctx.me = (await p.request.get('/api/v1/auth/me')).status()
    ctx.onLogin = p.url().includes('/login')
  } finally {
    await c.close()
  }
}, async (page, ctx) => {
  await deleteUserByEmail(page, LOGOUT_EMAIL)
  return { ok: ctx.meBefore === 200 && ctx.me === 401, detail: `/auth/me before ${ctx.meBefore} → after logout ${ctx.me}; on /login: ${ctx.onLogin}` }
})

// Self-registration from the login page ("Create account"): with ALLOW_REGISTRATION off the server reports
// registration=false and the page shows no switch at all; otherwise the new account lands as Pending.
def('register', 'auth-service:POST:/register', '', async (page, ctx) => {
  ctx.registration = (await api(page, 'GET', '/api/v1/auth/oidc/config')).body?.registration
  const c = await ownSession(page)
  try {
    const p = await c.newPage()
    await p.goto('/login')
    await p.waitForSelector('input[type="password"]', { timeout: 15000 })
    await sleep(1500) // the login page reads /auth/oidc/config before deciding whether to offer registration
    const sw = p.getByRole('button', { name: /create account|sign up|register|회원가입|계정 만들기/i })
    ctx.switchShown = (await sw.count()) > 0
    if (!ctx.switchShown) {
      ctx.note = 'registration switch hidden'
      return
    }
    await sw.first().click()
    await sleep(600)
    const name = p.getByPlaceholder(/jane doe|이름/i).first()
    if (await name.count()) await name.fill('QA register')
    await p.locator('input[autocomplete="email"], input[type="email"], input[name="email"]').first().fill(REG_EMAIL)
    const pws = p.locator('input[type="password"]')
    await pws.nth(0).fill('Qa-register-pass1!')
    if ((await pws.count()) > 1) await pws.nth(1).fill('Qa-register-pass1!')
    const team = p.locator('select').first()
    if (await team.count()) await team.selectOption({ index: 1 }).catch(() => {})
    await p.locator('button[type="submit"]').first().click()
    await sleep(2500)
    ctx.note = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').match(/(registration|disabled|pending|approval|created|success|error|failed|not allowed)[^.]{0,80}/i)?.[0] || ''
  } finally {
    await c.close()
  }
}, async (page, ctx) => {
  const u = await findUser(page, REG_EMAIL)
  if (u) await api(page, 'DELETE', `/api/v1/auth/admin/users/${u.id}`)
  if (ctx.registration === false) return { ok: !ctx.switchShown && !u, detail: `registration disabled → switch hidden: ${!ctx.switchShown}, no account created: ${!u}` }
  return { ok: !!u, detail: u ? `registered as ${u.role?.name || u.role || '?'} (removed afterwards)` : `not registered — ${ctx.note}` }
})

// ---------- run order ----------
// Reads and in-place changes first, namespace create/delete, then every delete (a deleted seed object cannot
// be read afterwards), helm uninstall, admin pages, and the own-session drivers last. pod-delete runs before
// node-drain: the drain evicts the bare qa-pod.
// ---------- access requests (temporary role grants; needs ACCESS_REQUESTS_ENABLED on the installation) ----------
const AR_EMAIL = `qa-access-${STAMP}@example.com`
let arEnabled: boolean | null = null
async function accessRequestsOn(page: Page): Promise<boolean> {
  if (arEnabled === null) arEnabled = (await api(page, 'GET', '/api/v1/auth/access-requests/config')).body?.enabled === true
  return arEnabled
}
const arPrecondition = () => (process.env.E2E_ACCESS_REQUESTS === '0' ? 'E2E_ACCESS_REQUESTS=0' : null)

def('access-request-create', 'auth-service:POST:/access-requests', '', async (page, ctx) => {
  if (!(await accessRequestsOn(page))) { ctx.skipped = 'access requests are off on this installation'; return }
  await createTempUser(page, AR_EMAIL, PW0)
  const users = list((await api(page, 'GET', '/api/v1/auth/admin/users?limit=500')).body)
  const u = users.find((x: any) => x.email === AR_EMAIL)
  await api(page, 'PUT', `/api/v1/auth/admin/users/${u.id}/cluster-roles/${TARGET_CLUSTER}`, { role: 'Read' })
  const c = await ownSession(page)
  try {
    const p = await c.newPage()
    await login(p, AR_EMAIL, PW0)
    await p.goto('/account')
    await p.getByTestId(`access-request-open-${TARGET_CLUSTER}`).click()
    await p.getByTestId('access-request-reason').fill('qa: temporary write for the action sweep')
    await p.getByTestId('access-request-submit').click()
    await p.getByTestId('access-request-notice').waitFor({ state: 'visible', timeout: 10000 })
  } finally {
    await c.close()
  }
}, async (page, ctx) => {
  if (ctx.skipped) return { ok: true, detail: String(ctx.skipped) }
  const pending = list((await api(page, 'GET', '/api/v1/auth/admin/access-requests?status=pending')).body)
  const mine = pending.find((r: any) => r.user_email === AR_EMAIL && r.cluster_id === TARGET_CLUSTER)
  return { ok: !!mine, detail: mine ? `request ${mine.id} pending (${mine.role}, ${mine.duration_minutes} min)` : 'no pending request for the temp user' }
}, { precondition: arPrecondition })

def('access-request-decide', 'auth-service:POST:/admin/access-requests/{id}/approve', 'admin/access-requests', async (page, ctx) => {
  if (!(await accessRequestsOn(page))) { ctx.skipped = 'access requests are off on this installation'; return }
  const pending = list((await api(page, 'GET', '/api/v1/auth/admin/access-requests?status=pending')).body)
  const mine = pending.find((r: any) => r.user_email === AR_EMAIL)
  if (!mine) throw new Error('access-request-create left no pending request')
  ctx.requestId = mine.id
  await page.getByTestId(`access-request-note-${mine.id}`).fill('qa ok')
  await page.getByTestId(`access-request-approve-${mine.id}`).click()
  await page.getByTestId(`access-request-row-${mine.id}`).waitFor({ state: 'detached', timeout: 10000 })
}, async (page, ctx) => {
  if (ctx.skipped) return { ok: true, detail: String(ctx.skipped) }
  const users = list((await api(page, 'GET', '/api/v1/auth/admin/users?limit=500')).body)
  const u = users.find((x: any) => x.email === AR_EMAIL)
  const grants = u ? (await api(page, 'GET', `/api/v1/auth/admin/clusters/${TARGET_CLUSTER}/user-roles`)).body : []
  const g = list(grants).find((x: any) => x.user_id === u?.id)
  const all = list((await api(page, 'GET', '/api/v1/auth/admin/access-requests')).body)
  const r = all.find((x: any) => x.id === ctx.requestId)
  await deleteUserByEmail(page, AR_EMAIL) // cascades the grant and the request
  const ok = r?.status === 'approved' && g?.role === 'Write' && !!g?.expires_at
  return { ok, detail: `request ${r?.status}, grant ${g?.role ?? 'none'} until ${g?.expires_at ?? '-'}` }
}, { precondition: arPrecondition })

const ADMIN = [
  'team-add', 'team-delete',
  'user-add', 'users-bulk-upload', 'cluster-access', 'cluster-access-revoke', 'user-reset-password', 'user-role-change', 'user-delete',
  'role-create', 'role-edit', 'role-delete',
  'cluster-test', 'cluster-edit', 'cluster-register', 'cluster-delete',
  'model-config-create', 'model-config-update', 'model-config-delete',
  'access-request-create', 'access-request-decide',
  'account-password-change', 'logout', 'register',
]
const EDITS = ['cm-yaml-apply', 'node-yaml-apply', 'ns-yaml-apply', 'cronjob-resume', 'helm-values-upgrade', 'helm-test', 'helm-revision-diff', 'node-drain', 'ds-rollback', 'sts-rollback']
const reads = Object.keys(D).filter((k) => !/-delete$|^ns-|rollback|uninstall/.test(k) && !ADMIN.includes(k) && !EDITS.includes(k))
export const ORDER: string[] = [
  ...reads,
  'cm-yaml-apply', 'node-yaml-apply', 'ns-yaml-apply', 'cronjob-resume', 'helm-values-upgrade', 'helm-test', 'helm-revision-diff',
  'helm-rollback', 'deploy-rollback', 'ds-rollback', 'sts-rollback', 'pod-delete', 'node-drain',
  'ns-create', 'ns-delete',
  'endpoints-delete', 'endpointslice-delete', 'replicaset-delete',
  ...Object.keys(D).filter((k) => /-delete$/.test(k) && !/^(endpoints|endpointslice|replicaset)-delete$/.test(k) && !ADMIN.includes(k)),
  'helm-uninstall',
  ...ADMIN,
].filter((k, i, a) => D[k] && a.indexOf(k) === i)

const missing = Object.keys(D).filter((k) => !ORDER.includes(k))
if (missing.length) throw new Error(`drivers not in ORDER: ${missing.join(', ')}`)
