import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// The NetworkPolicy check against what the cluster's network plugin does: kind's kindnet enforces
// NetworkPolicy, so every definite answer Kubeast gives for the fixture below is compared with a real
// connection from the source pod. An ipBlock that covers a pod IP is up to the plugin, so there Kubeast
// must say unknown and why. Then the drawer section and the check window, a namespace-limited user,
// and the same answer through the AI tool over MCP.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-netpol-pass1!'
const CLUSTER = 'self'
const A = 'e2e-netpol-a'
const B = 'e2e-netpol-b'
const IMAGE = 'docker.io/library/busybox:1.38.0'
const MCP = '/api/v1/ai/mcp'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-netpol-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

// A connection from a fixture pod, decided by the cluster: wget ends on its own after 3 s. An allowed
// path may need a moment after a policy or Service changed, so a refusal is tried again.
function connects(ns: string, pod: string, host: string, port: number, tries = 3): boolean {
  for (let i = 0; i < tries; i++) {
    try {
      kubectl(`-n ${ns} exec ${pod} -- wget -q -T 3 -O /dev/null http://${host}:${port}`)
      return true
    } catch {
      // refused or timed out
    }
  }
  return false
}

const SERVE = 'mkdir -p /w && echo ok > /w/index.html && httpd -p 9090 -h /w && exec httpd -f -p 8080 -h /w'
const pod = (ns: string, name: string, labels: string, serve: boolean, ports = '') => `apiVersion: v1
kind: Pod
metadata: {name: ${name}, namespace: ${ns}, labels: {${labels}}}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - name: c
    image: ${IMAGE}
    command: [sh, -c, "${serve ? SERVE : 'exec sleep 3600'}"]
    ${ports}
`

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type Check = { result: string; notes: string[]; checks: Array<{ port: number; result: string; egress?: any; ingress?: any; notes: string[] }>; source: any; destination: any; unevaluated: unknown[] }

test.describe('NetworkPolicy check', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let enforced = false
  let probeIP = ''
  const ips: Record<string, string> = {}

  async function check(request: APIRequestContext, token: string, src: string, dst: string, port = '') {
    const res = await request.get('/api/v1/cluster/networkpolicies/check', { headers: bearer(token), params: { cluster: CLUSTER, src, dst, port }, failOnStatusCode: false })
    return { status: res.status(), body: (await res.json()) as Check & { detail?: string } }
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    // leftovers of an interrupted run
    kubectl(`delete ns ${A} ${B} --ignore-not-found --wait=true --timeout=90s`)
    kubectl(`create ns ${A}`)
    kubectl(`label ns ${A} team=front`)
    kubectl(`create ns ${B}`)
    kubectl(`label ns ${B} team=back`)
    kubectl('apply -f -', [
      pod(A, 'web', 'app: web', true, 'ports: [{name: http, containerPort: 8080}, {name: metrics, containerPort: 9090}]'),
      pod(A, 'client', 'role: client', true, 'ports: [{name: http, containerPort: 8080}]'),
      pod(A, 'other', 'role: other', false),
      pod(B, 'probe', 'app: probe', true, 'ports: [{name: http, containerPort: 8080}]'),
      `apiVersion: v1
kind: Service
metadata: {name: web, namespace: ${A}}
spec: {selector: {app: web}, ports: [{name: http, port: 80, targetPort: http}]}
`,
    ].join('---\n'))
    kubectl(`-n ${A} wait --for=condition=Ready pod/web pod/client pod/other --timeout=120s`)
    kubectl(`-n ${B} wait --for=condition=Ready pod/probe --timeout=120s`)
    for (const [ns, p] of [[A, 'web'], [A, 'client'], [B, 'probe']]) ips[p] = kubectl(`-n ${ns} get pod ${p} -o jsonpath={.status.podIP}`)
    ips.service = kubectl(`-n ${A} get svc web -o jsonpath={.spec.clusterIP}`)
    probeIP = ips.probe
    // Before any policy every connection goes through.
    expect(connects(A, 'client', ips.web, 9090), 'no policy yet').toBe(true)
    kubectl('apply -f -', `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: web-ingress, namespace: ${A}}
spec:
  podSelector: {matchLabels: {app: web}}
  policyTypes: [Ingress]
  ingress:
  - from: [{podSelector: {matchLabels: {role: client}}}]
    ports: [{port: http}]
  - from: [{namespaceSelector: {matchLabels: {team: back}}}]
    ports: [{port: 9090}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: other-deny-egress, namespace: ${A}}
spec: {podSelector: {matchLabels: {role: other}}, policyTypes: [Egress]}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: client-egress, namespace: ${A}}
spec:
  podSelector: {matchLabels: {role: client}}
  policyTypes: [Egress]
  egress:
  - to: [{podSelector: {matchLabels: {app: web}}}]
  - to: [{ipBlock: {cidr: ${probeIP}/32}}]
`)
    // The plugin applies policies a moment later: wait until a connection they deny stops.
    for (let i = 0; i < 10 && !enforced; i++) enforced = !connects(A, 'client', ips.web, 9090, 1)
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
    kubectl(`delete ns ${A} ${B} --ignore-not-found --wait=false`)
  })

  test('every definite answer is what the network plugin does', async ({ request }) => {
    test.skip(!enforced, "the cluster's network plugin does not enforce NetworkPolicy")
    const cases: Array<[string, string, string, string, string, string, number]> = [
      // src, dst, port, expected, then the real connection: from ns/pod to host:port
      [`pod/${A}/client`, `pod/${A}/web`, '8080', 'allowed', A, 'client', 8080],
      [`pod/${A}/client`, `pod/${A}/web`, '9090', 'denied', A, 'client', 9090],
      [`pod/${A}/client`, `service/${A}/web`, '80', 'allowed', A, 'client', 80],
      [`pod/${A}/other`, `pod/${A}/web`, '8080', 'denied', A, 'other', 8080],
      [`pod/${B}/probe`, `pod/${A}/web`, '9090', 'allowed', B, 'probe', 9090],
      [`pod/${B}/probe`, `pod/${A}/web`, '8080', 'denied', B, 'probe', 8080],
      [`pod/${A}/web`, `pod/${A}/client`, '8080', 'allowed', A, 'web', 8080],
    ]
    for (const [src, dst, port, want, ns, from, realPort] of cases) {
      const { status, body } = await check(request, admin, src, dst, port)
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body.result, `${src} -> ${dst}:${port}`).toBe(want)
      const host = dst.startsWith('service/') ? ips.service : ips[dst.split('/')[2]]
      expect(connects(ns, from, host, realPort), `real ${src} -> ${host}:${realPort}`).toBe(want === 'allowed')
    }
    // The Service: port 80 is the pods' named port http = 8080, allowed by web-ingress rule 1.
    const svc = (await check(request, admin, `pod/${A}/client`, `service/${A}/web`)).body
    expect(svc.checks.map((c) => [c.port, c.result])).toEqual([[8080, 'allowed']])
    expect(svc.checks[0].ingress.allowed_by).toEqual([{ policy: 'web-ingress', rule: 0 }])
    // ...but client's egress policy leaves out cluster DNS, so the name does not resolve.
    expect(svc.notes).toEqual(['dns_egress_denied'])
    expect(connects(A, 'client', `web.${A}`, 80), 'by name').toBe(false)
    // other's egress policy has no rules: denied on the way out, whatever web allows.
    const other = (await check(request, admin, `pod/${A}/other`, `pod/${A}/web`, '8080')).body
    expect(other.checks[0].egress).toMatchObject({ isolated: true, result: 'denied', misses: [{ policy: 'other-deny-egress', rule: -1, reason: 'no_rules' }] })
  })

  test('an ipBlock that covers a pod IP is up to the plugin: unknown, and why', async ({ request }) => {
    test.skip(!enforced, "the cluster's network plugin does not enforce NetworkPolicy")
    const { body } = await check(request, admin, `pod/${A}/client`, `pod/${B}/probe`, '8080')
    expect(body.result).toBe('unknown')
    expect(body.checks[0].egress.undecided).toEqual([{ policy: 'client-egress', rule: 1, reason: 'pod_ip_block' }])
    test.info().annotations.push({ type: 'plugin', description: `kindnet lets the pod-IP ipBlock through: ${connects(A, 'client', probeIP, 8080)}` })
  })

  test('the drawer lists the policies on a pod and the check window explains a denial', async ({ page }) => {
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${A}&detail=Pod/${A}/web`)
    const section = page.getByTestId('netpol-section')
    await expect(section).toBeVisible({ timeout: 20_000 })
    await expect(section.getByTestId('netpol-ingress').getByTestId('netpol-isolated')).toContainText('1')
    await expect(section.getByTestId('netpol-policy')).toHaveCount(1)
    await expect(section.getByTestId('netpol-rule')).toHaveText([
      /pods role=client in this namespace\s*—\s*TCP http/,
      /every pod in namespaces team=back\s*—\s*TCP 9090/,
    ])
    await expect(section.getByTestId('netpol-egress').getByTestId('netpol-not-isolated')).toBeVisible()

    await page.getByTestId('netpol-check-open').click()
    const modal = page.getByTestId('netpol-check-modal')
    await page.getByTestId('netpol-check-direction').click()
    await page.getByTestId('netpol-check-direction-opt-in').click()
    await page.getByTestId('netpol-check-name').click()
    await page.getByTestId('netpol-check-name-opt-client').click()
    await page.getByTestId('netpol-check-port').fill('9090')
    await page.getByTestId('netpol-check-run').click()
    await expect(modal.getByTestId('netpol-check-overall')).toHaveText('Denied')
    await expect(modal.getByTestId('netpol-miss')).toHaveText([
      'web-ingress Rule 1: the port or protocol is not in the rule',
      'web-ingress Rule 2: the other end is not one of its peers',
    ])
    // same answer as the API
    const api = await (await page.request.get(`/api/v1/cluster/networkpolicies/check?cluster=${CLUSTER}&src=pod/${A}/client&dst=pod/${A}/web&port=9090`)).json()
    expect(api.result).toBe('denied')

    // The policy link opens the NetworkPolicy drawer, which words its rules the same way.
    await modal.getByRole('button', { name: 'Close' }).last().click()
    await section.getByTestId('netpol-policy').getByRole('button', { name: 'web-ingress' }).click()
    await expect(page.getByTestId('netpol-rule-peers')).toHaveText(['From: pods role=client in this namespace', 'From: every pod in namespaces team=back'])
    await expect(page.getByTestId('netpol-rule-ports')).toHaveText(['Ports: TCP http', 'Ports: TCP 9090'])
    await expect(page.getByText('Affected Pods (1)')).toBeVisible()
  })

  test('a namespace-limited user stays in their namespaces and hears unknown where labels are needed', async ({ request }) => {
    // The operator binds the namespace-limited group in A (docs: namespace-scoped grants) — first to a
    // role that reads pods, Services and NetworkPolicies but not the Namespace object.
    kubectl('apply -f -', `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: e2e-netpol-reader, namespace: ${A}}
rules: [{apiGroups: ["", "networking.k8s.io"], resources: [pods, services, networkpolicies], verbs: [get, list]}]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: e2e-netpol-scoped, namespace: ${A}}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: e2e-netpol-reader}
subjects: [{apiGroup: rbac.authorization.k8s.io, kind: Group, name: "kubeast:role:read"}]
`)
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-netpol-scoped-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E netpol scoped', email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    userIds.push((await created.json()).id)
    const put = await request.put(`/api/v1/auth/admin/users/${userIds[userIds.length - 1]}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [A] } })
    expect(put.ok(), await put.text()).toBeTruthy()
    const token = await login(request, email, PW)

    const outside = await check(request, token, `pod/${B}/probe`, `pod/${A}/web`, '9090')
    expect(outside.status, JSON.stringify(outside.body)).toBe(403)
    expect(outside.body.detail).toContain(`namespace ${B}`)
    // web-ingress rule 2 selects namespaces by team=back, and this user may not read namespace A.
    const narrow = await check(request, token, `pod/${A}/client`, `pod/${A}/web`, '9090')
    expect(narrow.status, JSON.stringify(narrow.body)).toBe(200)
    expect(narrow.body.source.namespace_labels_known).toBe(false)
    expect(narrow.body.result).toBe('unknown')
    expect(narrow.body.checks[0].ingress.undecided).toEqual([{ policy: 'web-ingress', rule: 1, reason: 'namespace_labels_unknown' }])
    // A binding in A to view also lets the user read namespace A itself: the answer is definite again.
    kubectl(`-n ${A} delete rolebinding e2e-netpol-scoped`)
    kubectl('apply -f -', `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: e2e-netpol-scoped-view, namespace: ${A}}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view}
subjects: [{apiGroup: rbac.authorization.k8s.io, kind: Group, name: "kubeast:role:read"}]
`)
    await expect.poll(async () => (await check(request, token, `pod/${A}/client`, `pod/${A}/web`, '9090')).body.result, { timeout: 15_000 }).toBe('denied')
  })

  test('the AI tool gives the same answer over MCP', async ({ request }) => {
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const res = await request.post(MCP, {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_policy_check', arguments: { cluster: CLUSTER, src: `deployment/${A}/missing`, dst: `pod/${A}/web` } } },
    })
    expect(res.status()).toBe(200)
    // a name that does not exist comes back as not found, not as an answer
    expect(((await res.json()).result.content?.[0]?.text ?? '').toLowerCase()).toContain('not found')
    const ok = await request.post(MCP, {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'network_policy_check', arguments: { cluster: CLUSTER, src: `pod/${B}/probe`, dst: `service/${A}/web`, port: '80' } } },
    })
    const result = (await ok.json()).result
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false)
    const answer = JSON.parse(result.content[0].text)
    // probe may reach web only on 9090; the Service sends 80 to 8080
    expect(answer.result).toBe('denied')
    expect(answer.checks[0]).toMatchObject({ port: 8080, service_port: 'http 80/TCP' })
    expect(answer.note).toContain('signed-in user')
  })
})
