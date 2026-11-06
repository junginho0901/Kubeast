import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// Two namespaces are guarded on top of what the cluster's RBAC says (services/pkg/protectedns). On `self`, where Kubeast
// runs, its own namespace is for global admins: its Secrets and Helm releases, any change there and terminals in its
// pods are refused to a Write or an Admin grant on that cluster, though the cluster would answer yes, while its pods,
// logs and ConfigMaps stay readable. On any cluster the node shell's namespace takes changes and terminals only from
// those holding resource.node.shell. The same answers come from the API, MCP and the screens, and a namespace of the
// same name on another cluster is ordinary. The users and objects of the run are removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const NS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const SHELL_NS = 'kubeast-node-shell'
const PW = 'E2e-protected-throwaway-1!'
const STAMP = Date.now().toString(36)
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string, vars: Record<string, string> = {}): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-protected-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E protected', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

const on = (p: string, cluster = 'self') => `${p}${p.includes('?') ? '&' : '?'}cluster=${cluster}`
const get = (request: APIRequestContext, token: string, p: string, cluster = 'self') => request.get(`/api/v1/cluster${on(p, cluster)}`, { headers: bearer(token), failOnStatusCode: false })
const createYaml = (request: APIRequestContext, token: string, yaml: string, cluster = 'self') =>
  request.post(`/api/v1/cluster${on('/resources/yaml/create', cluster)}`, { headers: bearer(token), data: { yaml }, failOnStatusCode: false })
const configMap = (name: string, namespace: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\n`
const pod = (name: string, namespace: string) =>
  `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nspec:\n  containers:\n  - name: c\n    image: registry.invalid/never:1\n`
// every Secret the cluster has, as namespace/name
function clusterSecrets(): string[] {
  // names only: a Helm release's Secret alone can pass the output limit of a read in this process
  return kubectl('get secrets -A --no-headers -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name')
    .split('\n').map((line) => line.trim().split(/\s+/).join('/')).sort()
}

async function deniedRow(request: APIRequestContext, admin: string, email: string, namespace: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs?action=k8s.access.denied&limit=50', { headers: bearer(admin) })
  const items = ((await res.json()).items ?? []) as Record<string, unknown>[]
  return items.find((r) => (r.ActorEmail ?? r.actor_email) === email && (r.TargetID ?? r.target_id) === namespace)
}

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
  return page
}

test.describe.serial('the guarded namespaces', () => {
  let admin = ''
  let writer = ''
  let clusterAdmin = ''
  let writerId = ''
  let clusterAdminId = ''
  let writerEmail = ''
  let clusterAdminEmail = ''
  let aPod = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    writerEmail = `e2e-protected-w-${STAMP}@kubeast.local`
    clusterAdminEmail = `e2e-protected-a-${STAMP}@kubeast.local`
    writerId = await createUser(request, admin, writerEmail)
    clusterAdminId = await createUser(request, admin, clusterAdminEmail)
    for (const cluster of ['self', 'default']) {
      expect((await request.put(`/api/v1/auth/admin/users/${writerId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role: 'Write' } })).ok()).toBeTruthy()
      expect((await request.put(`/api/v1/auth/admin/users/${clusterAdminId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: { role: 'Admin' } })).ok()).toBeTruthy()
    }
    writer = await login(request, writerEmail, PW)
    clusterAdmin = await login(request, clusterAdminEmail, PW)
    aPod = kubectl(`-n ${NS} get pods -l app=frontend -o jsonpath={.items[0].metadata.name}`) || kubectl(`-n ${NS} get pods -o jsonpath={.items[0].metadata.name}`)
  })

  test.afterAll(async ({ request }) => {
    for (const id of [writerId, clusterAdminId]) {
      if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
    kubectl(`-n ${NS} delete configmap e2e-protected-${STAMP}-a e2e-protected-${STAMP}-b --ignore-not-found`)
    kubectl(`-n default delete configmap e2e-protected-${STAMP}-a e2e-protected-${STAMP}-b --ignore-not-found`)
  })

  test('a Write or Admin grant on the cluster reads no Secret of Kubeast\'s namespace, however it asks', async ({ request }) => {
    // the cluster itself would answer yes: this is Kubeast's refusal, not RBAC's
    expect(kubectl(`auth can-i get secrets -n ${NS} --as ${writerEmail} --as-group kubeast:authenticated --as-group kubeast:operator`)).toBe('yes')
    for (const token of [writer, clusterAdmin]) {
      for (const p of [
        `/namespaces/${NS}/secrets`,
        `/namespaces/${NS}/secrets/kubeast-secrets/describe`,
        `/namespaces/${NS}/secrets/kubeast-secrets/yaml`,
        `/resources?resource_type=secrets&namespace=${NS}`,
        `/resources?resource_type=secret&namespace=${NS}&output=json`,
        `/resources/yaml?resource_type=secrets&resource_name=kubeast-secrets&namespace=${NS}`,
        `/resources/json?resource_type=secrets&resource_name=kubeast-secrets&namespace=${NS}`,
        `/resources/describe?resource_type=Secret&resource_name=kubeast-secrets&namespace=${NS}`,
      ]) {
        const res = await get(request, token, p)
        const body = await res.json()
        expect(res.status(), p).toBe(403)
        expect(body.reason, p).toBe('protected_namespace')
        expect(body.detail, p).toContain(`namespace ${NS}`)
      }
    }
  })

  test('its Helm release is closed to them, and a list across namespaces leaves it out', async ({ request }) => {
    for (const p of [`/helm/releases/${NS}/kubeast`, `/helm/releases/${NS}/kubeast/values`, `/helm/releases/${NS}/kubeast/manifest`, `/helm/releases/${NS}/kubeast/history`, `/helm/releases?namespace=${NS}`]) {
      const res = await request.get(`/api/v1/${on(p.slice(1))}`, { headers: bearer(writer), failOnStatusCode: false })
      expect(res.status(), p).toBe(403)
    }
    const res = await request.get('/api/v1/helm/releases?cluster=self', { headers: bearer(writer), failOnStatusCode: false })
    expect(res.status()).toBe(200)
    const rows = ((await res.json()).items ?? []) as { namespace: string }[]
    expect(rows.filter((r) => r.namespace === NS)).toEqual([])
    const asAdmin = await request.get('/api/v1/helm/releases?cluster=self', { headers: bearer(admin) })
    expect(((await asAdmin.json()).items ?? []).filter((r: { namespace: string }) => r.namespace === NS).length, 'a global admin still lists it').toBeGreaterThan(0)
  })

  test('a list of every namespace\'s Secrets is the cluster\'s without Kubeast\'s, and a global admin\'s is whole', async ({ request }) => {
    const all = clusterSecrets()
    const others = all.filter((s) => !s.startsWith(`${NS}/`))
    expect(all.length, 'Kubeast has Secrets of its own').toBeGreaterThan(others.length)
    const rows = async (token: string, p: string) => {
      const res = await get(request, token, p)
      expect(res.status(), p).toBe(200)
      return ((await res.json()) as { namespace: string; name: string }[]).map((s) => `${s.namespace}/${s.name}`).sort()
    }
    expect(await rows(writer, '/secrets/all')).toEqual(others)
    expect(await rows(writer, '/resources?resource_type=secrets')).toEqual(others)
    expect(await rows(admin, '/secrets/all')).toEqual(all)
  })

  test('nothing changes there and no terminal opens: the refusal is a failure row and nothing is left', async ({ request }) => {
    const name = `e2e-protected-${STAMP}-a`
    const ways: [string, () => Promise<{ status(): number; json(): Promise<any> }>][] = [
      ['a YAML document', () => createYaml(request, writer, configMap(name, NS))],
      ['the default namespace of a create', () => request.post(`/api/v1/cluster${on('/resources/yaml/create')}`, { headers: bearer(writer), data: { namespace: NS, yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ' + name + '\n' }, failOnStatusCode: false })],
      ['a second document', () => createYaml(request, writer, `${configMap(`e2e-protected-${STAMP}-b`, 'default')}---\n${configMap(name, NS)}`)],
      ['a pod', () => createYaml(request, writer, pod(name, NS))],
      ['an apply', () => request.post(`/api/v1/cluster${on('/resources/yaml/apply')}`, { headers: bearer(writer), data: { resource_type: 'configmaps', name: 'kube-root-ca.crt', namespace: NS, yaml: 'metadata:\n  labels:\n    e2e: protected\n' }, failOnStatusCode: false })],
      ['a delete', () => request.delete(`/api/v1/cluster${on(`/namespaces/${NS}/pods/${aPod}`)}`, { headers: bearer(writer), failOnStatusCode: false })],
      ['a Secret delete', () => request.delete(`/api/v1/cluster${on(`/namespaces/${NS}/secrets/kubeast-secrets`)}`, { headers: bearer(clusterAdmin), failOnStatusCode: false })],
      ['the namespace itself', () => request.delete(`/api/v1/cluster${on(`/namespaces/${NS}`)}`, { headers: bearer(clusterAdmin), failOnStatusCode: false })],
      ['a terminal', () => get(request, clusterAdmin, `/namespaces/${NS}/pods/${aPod}/exec/ws?command=/bin/sh`)],
      ['a log file', () => get(request, clusterAdmin, `/namespaces/${NS}/pods/${aPod}/logfiles`)],
    ]
    for (const [what, send] of ways) {
      const res = await send()
      expect(res.status(), what).toBe(403)
      expect((await res.json()).reason, what).toBe('protected_namespace')
    }
    expect(kubectl(`-n ${NS} get configmap ${name} --ignore-not-found -o name`), 'nothing made there').toBe('')
    expect(kubectl(`-n default get configmap e2e-protected-${STAMP}-b --ignore-not-found -o name`), 'a create with one document refused makes none').toBe('')
    expect(kubectl(`-n ${NS} get pod ${aPod} -o name`), 'the pod is still there').toBe(`pod/${aPod}`)
    await expect.poll(async () => {
      const row = await deniedRow(request, admin, writerEmail, NS)
      const after = (row?.After ?? row?.after) as { permission?: string } | undefined
      return after?.permission
    }).toBe('protected namespace')
  })

  test('what they may see there stays: pods, logs, ConfigMaps, and elsewhere nothing changes', async ({ request }) => {
    const pods = await get(request, writer, `/namespaces/${NS}/pods`)
    expect(pods.status()).toBe(200)
    const listed = ((await pods.json()) as { name: string }[]).map((p) => p.name).sort()
    expect(listed).toEqual(kubectl(`-n ${NS} get pods -o name`).split('\n').map((p) => p.replace('pod/', '')).sort())
    expect((await get(request, writer, `/namespaces/${NS}/pods/${aPod}/logs?tail_lines=1`)).status()).toBe(200)
    const configmaps = await get(request, writer, `/namespaces/${NS}/configmaps`)
    expect(configmaps.status()).toBe(200)
    expect(((await configmaps.json()) as { name: string }[]).map((c) => c.name)).toContain('kube-root-ca.crt')

    const name = `e2e-protected-${STAMP}-a`
    expect((await createYaml(request, writer, configMap(name, 'default'))).status(), 'a write in another namespace').toBe(200)
    expect(kubectl(`-n default get configmap ${name} -o name`)).toBe(`configmap/${name}`)
    const made = await request.get('/api/v1/auth/admin/audit-logs?action=k8s.yaml.create&limit=20', { headers: bearer(admin) })
    const row = ((await made.json()).items as Record<string, any>[]).find((r) => (r.ActorEmail ?? r.actor_email) === writerEmail && r.Result === 'success')
    expect(row?.After, 'the row names what the create made').toMatchObject({ objects: [{ kind: 'ConfigMap', name, namespace: 'default' }], objects_total: 1 })
    expect(row?.After?.yaml_len, 'and its length').toBeGreaterThan(0)
  })

  test('a global admin keeps all of it', async ({ request }) => {
    expect((await get(request, admin, `/namespaces/${NS}/secrets/kubeast-secrets/describe`)).status()).toBe(200)
    expect((await get(request, admin, `/resources/yaml?resource_type=secrets&resource_name=kubeast-secrets&namespace=${NS}`)).status()).toBe(200)
    const name = `e2e-protected-${STAMP}-b`
    expect((await createYaml(request, admin, configMap(name, NS))).status()).toBe(200)
    expect(kubectl(`-n ${NS} get configmap ${name} -o name`)).toBe(`configmap/${name}`)
    expect((await request.delete(`/api/v1/cluster${on(`/namespaces/${NS}/configmaps/${name}`)}`, { headers: bearer(admin) })).status()).toBe(200)
  })

  test('on another cluster a namespace of that name is ordinary', async ({ request }) => {
    const list = await get(request, writer, `/namespaces/${NS}/secrets`, 'default')
    expect(list.status(), 'the cluster answers: that cluster has no such namespace').toBe(200)
    expect(await list.json()).toEqual([])
    const yes = await get(request, writer, `/can-i?verb=get&resource=secrets&namespace=${NS}`, 'default')
    expect((await yes.json()).allowed).toBe(true)
    const create = await createYaml(request, writer, configMap(`e2e-protected-${STAMP}-a`, NS), 'default')
    expect(create.status(), 'the cluster\'s own "namespace not found", not a refusal').toBe(404)
    expect((await create.json()).reason).toBeUndefined()
  })

  test('/can-i says no where the action would be refused, so the buttons go with it', async ({ request }) => {
    const ask = async (token: string, q: string, cluster = 'self') => (await (await get(request, token, `/can-i?${q}`, cluster)).json()).allowed as boolean
    expect(await ask(writer, `verb=get&resource=secrets&namespace=${NS}`)).toBe(false)
    expect(await ask(writer, `verb=delete&resource=pods&namespace=${NS}&name=${aPod}`)).toBe(false)
    expect(await ask(clusterAdmin, `verb=create&resource=pods&subresource=exec&namespace=${NS}`)).toBe(false)
    expect(await ask(clusterAdmin, `verb=delete&resource=namespaces&namespace=${NS}&name=${NS}`)).toBe(false)
    expect(await ask(writer, `verb=get&resource=pods&namespace=${NS}`)).toBe(true)
    expect(await ask(clusterAdmin, 'verb=create&resource=pods&subresource=exec&namespace=default')).toBe(true)
    expect(await ask(admin, `verb=get&resource=secrets&namespace=${NS}`)).toBe(true)
    expect(await ask(admin, `verb=create&resource=pods&subresource=exec&namespace=${NS}`)).toBe(true)
    for (const cluster of ['self', 'default']) {
      expect(await ask(writer, `verb=create&resource=pods&namespace=${SHELL_NS}`, cluster), `node shell's on ${cluster}`).toBe(false)
      expect(await ask(writer, `verb=create&resource=pods&subresource=exec&namespace=${SHELL_NS}`, cluster), `node shell's on ${cluster}`).toBe(false)
      expect(await ask(writer, `verb=list&resource=pods&namespace=${SHELL_NS}`, cluster), `node shell's on ${cluster}`).toBe(true)
    }
  })

  test('the node shell\'s namespace takes no pod and no terminal without the node shell, on any cluster', async ({ request }) => {
    const name = `e2e-protected-${STAMP}-shell`
    for (const cluster of ['self', 'default']) {
      const made = await createYaml(request, writer, pod(name, SHELL_NS), cluster)
      expect(made.status(), cluster).toBe(403)
      const body = await made.json()
      expect(body.reason, cluster).toBe('protected_namespace')
      expect(body.detail, cluster).toContain('resource.node.shell')
      const exec = await get(request, writer, `/namespaces/${SHELL_NS}/pods/${name}/exec/ws?command=/bin/sh`, cluster)
      expect(exec.status(), cluster).toBe(403)
    }
    expect(kubectl(`-n ${SHELL_NS} get pod ${name} --ignore-not-found -o name`), 'nothing made').toBe('')
    await expect.poll(async () => deniedRow(request, admin, writerEmail, SHELL_NS).then((r) => (r?.Result ?? r?.result))).toBe('failure')
    // reading what is there stays
    expect((await get(request, writer, `/namespaces/${SHELL_NS}/pods`)).status()).toBe(200)
  })

  test('someone holding the node shell on one cluster, and no global admin, still opens it', async ({ browser }) => {
    test.setTimeout(150_000)
    const page = await signIn(browser, clusterAdminEmail)
    const node = kubectl('get nodes -o jsonpath={.items[0].metadata.name}')
    try {
      const out = await page.evaluate(({ node, ms }) => new Promise<{ statuses: string[]; text: string }>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}/api/v1/cluster/nodes/${node}/debug-shell/ws?cluster=self`)
        ws.binaryType = 'arraybuffer'
        const statuses: string[] = []
        let text = ''
        let sent = false
        const finish = () => resolve({ statuses, text })
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            try { statuses.push(JSON.parse(ev.data).status) } catch { text += ev.data }
          } else {
            const buf = new Uint8Array(ev.data as ArrayBuffer)
            if (buf[0] === 1 || buf[0] === 2) text += new TextDecoder().decode(buf.slice(1))
          }
          if (!sent && text.length > 0) { sent = true; ws.send('hostname\r') }
          if (sent && text.lastIndexOf(node) > text.indexOf('hostname')) ws.send('exit\r')
        }
        ws.onclose = finish
        ws.onerror = finish
        setTimeout(() => { ws.close(); finish() }, ms)
      }), { node, ms: 120_000 })
      expect(out.statuses, 'the debug pod came up').toContain('starting')
      expect(out.text, 'the shell answers on the node').toContain(node)
    } finally {
      await page.context().close()
    }
  })

  test('over MCP it is the same: Kubeast\'s Secrets refused, others listed without them', async ({ request }) => {
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const keyRes = await request.post('/api/v1/auth/api-keys', { headers: bearer(writer), data: { name: `e2e protected ${STAMP}`, expires_in_days: 1, cluster_ids: ['self'], role_ceiling: 'Write' } })
    expect(keyRes.status(), 'issue key').toBe(201)
    const key = (await keyRes.json()).key as string
    const call = async (name: string, args: object) => {
      const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${key}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cluster: 'self', ...args } } }, failOnStatusCode: false })
      return (await res.json()).result as { isError?: boolean; content: { text: string }[] }
    }
    for (const [tool, args] of [
      ['k8s_get_resources', { resource_type: 'secrets', namespace: NS }],
      ['k8s_get_resource_yaml', { resource_type: 'secret', resource_name: 'kubeast-secrets', namespace: NS }],
      ['k8s_describe_resource', { resource_type: 'secret', resource_name: 'kubeast-secrets', namespace: NS }],
    ] as [string, object][]) {
      const refused = await call(tool, args)
      expect(refused.isError, tool).toBe(true)
      expect(refused.content[0].text, tool).toContain(`namespace ${NS}`)
    }
    const wide = await call('k8s_get_resources', { resource_type: 'secrets', all_namespaces: true })
    expect(wide.isError, wide.content?.[0]?.text).toBeFalsy()
    expect(wide.content[0].text).not.toContain('kubeast-secrets')
    expect(wide.content[0].text).not.toContain('kubeast-auth-keys')
    const pods = await call('k8s_get_resources', { resource_type: 'pods', namespace: NS })
    expect(pods.isError, pods.content?.[0]?.text).toBeFalsy()
    expect(pods.content[0].text).toContain(aPod)
  })

  test('the screens say why and show no button for what would be refused', async ({ browser }) => {
    test.setTimeout(120_000)
    const page = await signIn(browser, writerEmail)
    try {
      await page.goto(`/configuration/secrets?cluster=self&namespace=${NS}`)
      await expect(page.getByTestId('secrets-forbidden')).toHaveText(tr('secretsPage.protected'), { timeout: 20_000 })

      await page.goto(`/helm/releases/${NS}/kubeast?cluster=self`)
      await expect(page.getByTestId('helm-release-forbidden')).toContainText(tr('helmReleaseDetail.error.protected'), { timeout: 20_000 })

      await page.goto(`/helm/releases?cluster=self&namespace=${NS}`)
      await expect(page.getByTestId('helm-forbidden')).toHaveText(tr('helmReleases.protected'), { timeout: 20_000 })

      await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${aPod}`)}`)
      const drawer = page.locator(DRAWER).last()
      await expect(drawer.getByText(aPod).first(), 'the pod opens').toHaveCount(1, { timeout: 20_000 })
      await page.waitForResponse((r) => r.url().includes('/can-i'), { timeout: 5_000 }).catch(() => undefined)
      await expect(drawer.getByRole('button', { name: tr('common.deleteKind', { kind: 'Pod' }), exact: true })).toHaveCount(0)
    } finally {
      await page.context().close()
    }

    // an Admin of this cluster: the terminal goes with the namespace, not with the permission
    const adminPage = await signIn(browser, clusterAdminEmail)
    try {
      const openTerminal = tr('pods.exec.openExec')
      await adminPage.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${aPod}`)}`)
      const drawer = adminPage.locator(DRAWER).last()
      await expect(drawer.getByText(aPod).first()).toHaveCount(1, { timeout: 20_000 })
      await adminPage.waitForResponse((r) => r.url().includes('subresource=exec'), { timeout: 5_000 }).catch(() => undefined)
      await expect(drawer.getByTitle(openTerminal)).toHaveCount(0)

      const elsewhere = kubectl('-n kube-system get pods -l k8s-app=kube-dns -o jsonpath={.items[0].metadata.name}')
      await adminPage.goto(`/workloads/pods?cluster=self&namespace=kube-system&detail=${encodeURIComponent(`Pod/kube-system/${elsewhere}`)}`)
      await expect(adminPage.locator(DRAWER).last().getByTitle(openTerminal).first(), 'elsewhere it stays').toHaveCount(1, { timeout: 20_000 })
    } finally {
      await adminPage.context().close()
    }
  })
})
