import { test, expect, type APIRequestContext } from '@playwright/test'
import { gzipSync } from 'node:zlib'

// Secret values must follow one rule on every read path, not only the
// dedicated /namespaces/{ns}/secrets/{name}/{yaml,describe} endpoints:
//  - without resource.secret.reveal the generic resource paths (list with
//    output=json, search, /resources/json, /resources/yaml,
//    /resources/describe) show "***" for data/stringData
//  - with it the values come back and the read is audited as
//    k8s.secret.reveal with After.via naming the path
//  - a Helm release's manifest/values carry rendered Secrets and chart
//    passwords: without the permission Secret documents are stripped and
//    credential-looking values masked; with it the text is full and the read
//    is audited as helm.release.reveal with After.section
//
// The reader is a Read user (resource.*.read + resource.helm.read, no reveal)
// on the cluster. Its impersonation group kubeast:viewer is bound to
// ClusterRole view, which excludes Secrets, so for the test a RoleBinding in
// the fixture namespace grants the group edit there: the Kubernetes API then
// lets the reader read the Secrets and Kubeast's own rule is what is tested.
// The Helm release is a release Secret written the way Helm stores one (type
// helm.sh/release.v1, gzip+base64 JSON), so the read goes through the real
// Helm SDK path.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = process.env.E2E_CLUSTER || 'self'
const NS = 'default'

const ts = Date.now()
const rbName = `e2e-viewer-secrets-${ts}`
const secretName = `e2e-secret-${ts}`
const secretValue = `e2e-hunter2-${ts}`
const secretValueB64 = Buffer.from(secretValue).toString('base64')
const lastAppliedValue = `e2e-last-applied-${ts}`
const relName = `e2e-rel-${ts}`
const relSecretName = `sh.helm.release.v1.${relName}.v1`
const relSecretValueB64 = Buffer.from(`rel-${secretValue}`).toString('base64')
const relCmPassword = `cm-${secretValue}`
const relCfgPassword = `cfg-${secretValue}`

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function createYAML(request: APIRequestContext, headers: Record<string, string>, yaml: string) {
  const res = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers, data: { yaml, namespace: NS } })
  expect(res.ok(), `yaml create: ${await res.text()}`).toBeTruthy()
}

// A Helm v3 release Secret: data.release = base64(gzip(JSON release)).
function helmReleaseYAML() {
  const now = new Date().toISOString()
  const manifest = [
    '---',
    `# Source: e2e-chart/templates/secret.yaml`,
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${relName}-db`,
    'type: Opaque',
    'data:',
    `  password: ${relSecretValueB64}`,
    '---',
    `# Source: e2e-chart/templates/configmap.yaml`,
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${relName}-config`,
    'data:',
    '  DB_HOST: db.internal',
    `  DB_PASSWORD: ${relCmPassword}`,
    '',
  ].join('\n')
  const release = {
    name: relName,
    namespace: NS,
    version: 1,
    info: { first_deployed: now, last_deployed: now, status: 'deployed', description: 'e2e fixture' },
    chart: { metadata: { apiVersion: 'v2', name: 'e2e-chart', version: '0.1.0', appVersion: '1.0.0' }, templates: [], values: {} },
    config: { replicaCount: 1, password: relCfgPassword, adminPassword: '1234', dbPassword: 5678, DB_PASS: 'fake-short-pass', api_keys: ['fake-plural-key'], password_expiry_days: 90, extraEnv: [{ name: 'DB_PASSWORD', value: 'fake-env-pass' }, { name: 'PWD', value: '/app' }, { name: 'LOG_LEVEL', value: 'debug' }] },
    manifest,
  }
  const encoded = gzipSync(Buffer.from(JSON.stringify(release))).toString('base64')
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${relSecretName}`,
    `  namespace: ${NS}`,
    '  labels:',
    `    name: ${relName}`,
    '    owner: helm',
    '    status: deployed',
    '    version: "1"',
    'type: helm.sh/release.v1',
    'stringData:',
    `  release: ${encoded}`,
    '',
  ].join('\n')
}

async function auditRows(request: APIRequestContext, admin: Record<string, string>, action: string, actorEmail: string) {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&actor_email=${encodeURIComponent(actorEmail)}&limit=100`, { headers: admin })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as any
  const rows: any[] = (Array.isArray(body) ? body : body.items) || []
  return rows.map((r) => ({ ...r, after: typeof r.After === 'string' ? JSON.parse(r.After) : r.After }))
}

test.describe.serial('Secret exposure — generic resource paths and Helm text', () => {
  let admin: Record<string, string>
  let reader: Record<string, string>
  let userId = ''
  const readerEmail = `e2e-secret-reader-${ts}@kubeast.local`
  const readerPassword = 'e2e-reader-throwaway'

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)

    const user = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E secret reader', email: readerEmail, password: readerPassword } })
    expect(user.status(), await user.text()).toBe(201)
    userId = (await user.json()).id
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: admin, data: { role: 'Read' } })
    expect(grant.status(), await grant.text()).toBe(200)

    await createYAML(request, admin, [
      'apiVersion: rbac.authorization.k8s.io/v1',
      'kind: RoleBinding',
      'metadata:',
      `  name: ${rbName}`,
      `  namespace: ${NS}`,
      'roleRef:',
      '  apiGroup: rbac.authorization.k8s.io',
      '  kind: ClusterRole',
      '  name: edit',
      'subjects:',
      '- apiGroup: rbac.authorization.k8s.io',
      '  kind: Group',
      '  name: kubeast:viewer',
      '',
    ].join('\n'))
    await createYAML(request, admin, [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      `  name: ${secretName}`,
      `  namespace: ${NS}`,
      '  annotations:',
      `    kubectl.kubernetes.io/last-applied-configuration: '{"kind":"Secret","stringData":{"conf":"{ value = ${lastAppliedValue} }"}}'`,
      '    e2e-team: shop',
      'type: Opaque',
      'stringData:',
      `  password: ${secretValue}`,
      '  username: app',
      '',
    ].join('\n'))
    await createYAML(request, admin, helmReleaseYAML())

    reader = await login(request, readerEmail, readerPassword)
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    for (const name of [secretName, relSecretName]) {
      await request.delete(`/api/v1/cluster/namespaces/${NS}/secrets/${name}?cluster=${CLUSTER}`, { headers: admin })
    }
    await request.delete(`/api/v1/cluster/namespaces/${NS}/rolebindings/${rbName}?cluster=${CLUSTER}`, { headers: admin })
    if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
  })

  test('the reader sees *** on every generic Secret path and is not audited as a reveal', async ({ request }) => {
    const q = `cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}`

    const list = await request.get(`/api/v1/cluster/resources?${q}&output=json`, { headers: reader })
    expect(list.status(), await list.text()).toBe(200)
    const listed = ((await list.json()).items as any[]).find((i) => i.metadata?.name === secretName)
    expect(listed, 'our Secret is in the list').toBeTruthy()
    expect(listed.data.password).toBe('***')

    const json = await request.get(`/api/v1/cluster/resources/json?${q}&resource_name=${secretName}`, { headers: reader })
    expect(json.status(), await json.text()).toBe(200)
    const obj = await json.json()
    expect(obj.data.password).toBe('***')
    expect(obj.data.username).toBe('***')

    const yaml = await request.get(`/api/v1/cluster/resources/yaml?${q}&resource_name=${secretName}`, { headers: reader })
    expect(yaml.status(), await yaml.text()).toBe(200)
    const yamlText = (await yaml.json()).yaml as string
    expect(yamlText).toContain('***')
    expect(yamlText).not.toContain(secretValueB64)

    const describe = await request.get(`/api/v1/cluster/resources/describe?${q}&resource_name=${secretName}`, { headers: reader })
    expect(describe.status(), await describe.text()).toBe(200)
    const describeText = JSON.stringify(await describe.json())
    expect(describeText).not.toContain(secretValueB64)
    expect(describeText).not.toContain(secretValue)

    expect(await auditRows(request, admin, 'k8s.secret.reveal', readerEmail)).toHaveLength(0)
  })

  test('the drawer shows that annotation as *** to someone who may reveal, and a value only under Show', async ({ page }) => {
    await page.goto(`/configuration/secrets?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`Secret/${NS}/${secretName}`)}`)
    const drawer = page.locator('[class*="max-w-[740px]"]')
    // an annotation tag is its key, ":" and its value (KeyValueTags)
    const tag = (key: string) => drawer.locator('span.rounded-full').filter({ has: page.locator('span.font-mono', { hasText: new RegExp(`^${key.replace(/\./g, '\\.')}$`) }) })
    await expect(tag('kubectl.kubernetes.io/last-applied-configuration').locator('span.truncate').nth(1)).toHaveText('***', { timeout: 30_000 })
    await expect(tag('e2e-team').locator('span.truncate').nth(1)).toHaveText('shop')
    expect(await page.content(), 'the page holds neither the copy nor a value before Show').not.toContain(lastAppliedValue)
    expect(await page.content()).not.toContain(secretValue)

    const row = drawer.locator('div.rounded-sm.border-slate-800').filter({ has: page.locator('span.font-mono', { hasText: /^password$/ }) })
    await row.getByTitle(/^(Show|보기)$/).click()
    await expect(row).toContainText(secretValue)
    expect(await page.content(), 'Show opens the value, never the copy').not.toContain(lastAppliedValue)
  })

  test('the copy kubectl apply keeps in an annotation is masked with the values, and the annotation stays listed', async ({ request }) => {
    const paths = [
      `/api/v1/cluster/resources/yaml?cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}&resource_name=${secretName}`,
      `/api/v1/cluster/resources/describe?cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}&resource_name=${secretName}`,
      `/api/v1/cluster/resources/json?cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}&resource_name=${secretName}`,
      `/api/v1/cluster/namespaces/${NS}/secrets/${secretName}/yaml?cluster=${CLUSTER}`,
      `/api/v1/cluster/namespaces/${NS}/secrets/${secretName}/describe?cluster=${CLUSTER}`,
    ]
    for (const p of paths) {
      const asReader = await request.get(p, { headers: reader })
      expect(asReader.status(), await asReader.text()).toBe(200)
      const text = await asReader.text()
      expect(text, p).not.toContain(lastAppliedValue)
      expect(text, p).toContain('kubectl.kubernetes.io/last-applied-configuration')
      expect(text, p).toContain('e2e-team')

      const asAdmin = await request.get(p, { headers: admin })
      expect(asAdmin.status(), await asAdmin.text()).toBe(200)
      const adminText = await asAdmin.text()
      if (p.includes('/describe')) {
        // the drawer's Info reads a describe: the values it repeats stay under Show there (Codex QA Q13)
        expect(adminText, `${p}: a describe masks it for everyone`).not.toContain(lastAppliedValue)
        expect(adminText, p).toContain('kubectl.kubernetes.io/last-applied-configuration')
        expect(adminText, `${p}: the values come under data_values`).toContain(secretValue)
      } else {
        expect(adminText, `${p}: reveal keeps it`).toContain(lastAppliedValue)
      }
    }
    expect(await auditRows(request, admin, 'k8s.secret.reveal', readerEmail)).toHaveLength(0)

    // another kind's annotation is its own
    const cmName = `${secretName}-cm`
    await createYAML(request, admin, [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${cmName}`,
      `  namespace: ${NS}`,
      '  annotations:',
      `    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"mode":"${lastAppliedValue}"}}'`,
      '',
    ].join('\n'))
    try {
      const cm = await request.get(`/api/v1/cluster/namespaces/${NS}/configmaps/${cmName}/describe?cluster=${CLUSTER}`, { headers: reader })
      expect(cm.status(), await cm.text()).toBe(200)
      expect(await cm.text()).toContain(lastAppliedValue)
    } finally {
      await request.delete(`/api/v1/cluster/namespaces/${NS}/configmaps/${cmName}?cluster=${CLUSTER}`, { headers: admin })
    }
  })

  test('the admin gets the values and each generic read is audited with its path', async ({ request }) => {
    const q = `cluster=${CLUSTER}&resource_type=secrets&namespace=${NS}&resource_name=${secretName}`

    const json = await request.get(`/api/v1/cluster/resources/json?${q}`, { headers: admin })
    expect(json.status(), await json.text()).toBe(200)
    expect((await json.json()).data.password).toBe(secretValueB64)

    const yaml = await request.get(`/api/v1/cluster/resources/yaml?${q}`, { headers: admin })
    expect(yaml.status(), await yaml.text()).toBe(200)
    expect((await yaml.json()).yaml as string).toContain(secretValueB64)

    const describe = await request.get(`/api/v1/cluster/resources/describe?${q}`, { headers: admin })
    expect(describe.status(), await describe.text()).toBe(200)

    const rows = (await auditRows(request, admin, 'k8s.secret.reveal', ADMIN_EMAIL)).filter((r) => r.TargetID === secretName)
    const vias = new Set(rows.map((r) => r.after?.via))
    for (const via of ['generic-json', 'generic-yaml', 'generic-describe']) expect(vias, `audit via ${via}`).toContain(via)
  })

  test('Helm release text: Secrets stripped and credentials masked for the reader, full and audited for the admin', async ({ request }) => {
    const base = `/api/v1/helm/releases/${NS}/${relName}`

    const detail = await request.get(`${base}?cluster=${CLUSTER}`, { headers: reader })
    expect(detail.status(), await detail.text()).toBe(200)
    const rel = await detail.json()
    expect(rel.manifest, 'Secret document values are stripped').not.toContain(relSecretValueB64)
    expect(rel.manifest, 'credential-looking ConfigMap value is masked').not.toContain(relCmPassword)
    expect(rel.manifest, 'the rest of the manifest survives').toContain('DB_HOST: db.internal')
    expect(rel.values.password).not.toBe(relCfgPassword)
    expect(rel.values.replicaCount).toBe(1)
    expect(rel.values.adminPassword).toBe('<REDACTED:adminPassword>')
    expect(rel.values.dbPassword).toBe('<REDACTED:dbPassword>')
    expect(rel.values.DB_PASS).toBe('<REDACTED:DB_PASS>')
    expect(rel.values.api_keys).toEqual(['<REDACTED:api_keys>'])
    expect(rel.values.password_expiry_days).toBe(90)
    expect(rel.values.extraEnv).toEqual([{ name: 'DB_PASSWORD', value: '<REDACTED:DB_PASSWORD>' }, { name: 'PWD', value: '/app' }, { name: 'LOG_LEVEL', value: 'debug' }])

    const manifest = await request.get(`${base}/manifest?cluster=${CLUSTER}`, { headers: reader })
    expect(manifest.status(), await manifest.text()).toBe(200)
    expect((await manifest.json()).content as string).not.toContain(relSecretValueB64)

    const values = await request.get(`${base}/values?cluster=${CLUSTER}`, { headers: reader })
    expect(values.status(), await values.text()).toBe(200)
    expect((await values.json()).content as string).not.toContain(relCfgPassword)

    const revision = await request.get(`${base}/revisions/1/manifest?cluster=${CLUSTER}`, { headers: reader })
    expect(revision.status(), await revision.text()).toBe(200)
    expect((await revision.json()).content as string).not.toContain(relSecretValueB64)

    expect(await auditRows(request, admin, 'helm.release.reveal', readerEmail)).toHaveLength(0)

    const full = await request.get(`${base}?cluster=${CLUSTER}`, { headers: admin })
    expect(full.status(), await full.text()).toBe(200)
    const fullRel = await full.json()
    expect(fullRel.manifest).toContain(relSecretValueB64)
    expect(fullRel.manifest).toContain(relCmPassword)
    expect(fullRel.values.password).toBe(relCfgPassword)

    const fullManifest = await request.get(`${base}/manifest?cluster=${CLUSTER}`, { headers: admin })
    expect(fullManifest.status(), await fullManifest.text()).toBe(200)
    expect((await fullManifest.json()).content as string).toContain(relSecretValueB64)

    const rows = (await auditRows(request, admin, 'helm.release.reveal', ADMIN_EMAIL)).filter((r) => r.TargetID === relName)
    const sections = new Set(rows.map((r) => r.after?.section))
    for (const section of ['detail', 'manifest']) expect(sections, `audit section ${section}`).toContain(section)
  })

  test('the AI path reads the masked Helm text even for someone who may reveal it, and no reveal is recorded', async ({ request }) => {
    const base = `/api/v1/helm/releases/${NS}/${relName}`
    const reveals = async () => (await auditRows(request, admin, 'helm.release.reveal', ADMIN_EMAIL)).filter((r) => r.TargetID === relName).length
    const before = await reveals()

    const manifest = await request.get(`${base}/manifest?cluster=${CLUSTER}&masked=1`, { headers: admin })
    expect(manifest.status(), await manifest.text()).toBe(200)
    expect((await manifest.json()).content as string).not.toContain(relSecretValueB64)
    const detail = await request.get(`${base}?cluster=${CLUSTER}&masked=1`, { headers: admin })
    expect(detail.status(), await detail.text()).toBe(200)
    expect(await detail.text()).not.toContain(relCfgPassword)
    expect(await reveals(), 'masked=1 writes no reveal row').toBe(before)

    const config = await request.get('/api/v1/ai/mcp/config', { headers: admin })
    test.skip(!config.ok() || !(await config.json()).enabled, 'the MCP server is off (mcp.enabled)')
    for (const args of [{ what: 'manifest' }, { what: 'values' }, { what: 'get' }, { what: 'revision', revision: 1, section: 'manifest' }]) {
      const res = await request.post('/api/v1/ai/mcp', {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: admin.Authorization },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'helm_read', arguments: { cluster: CLUSTER, namespace: NS, release: relName, ...args } } },
        failOnStatusCode: false,
      })
      expect(res.status(), await res.text()).toBe(200)
      const text = (await res.json()).result.content[0].text as string
      for (const gone of [relSecretValueB64, relCmPassword, relCfgPassword]) expect(text, JSON.stringify(args)).not.toContain(gone)
    }
    expect(await reveals(), 'helm_read writes no reveal row').toBe(before)
  })
})
