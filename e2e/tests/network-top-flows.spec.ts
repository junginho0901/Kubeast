import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Top talkers from the Network Flow Monitor stand-in of deploy/kind/devtools.yaml (nfm-stub), which the dev
// values make cluster self's monitor kubeast-monitor. The spec gives it rows that name this install's own pods —
// gateway and k8s-service both ways, k8s-service to CoreDNS in kube-system across zones, k8s-service to an S3
// address, a host-network flow and a flow of another namespace — and compares what Kubeast shows with the
// cluster: the workloads named as kubectl names the pods' owners, what the stand-in was asked, the audit row, a
// namespace-limited reader refused until the cluster lets it list pods and then seeing peers elsewhere by
// namespace and address only, the drawer and the AI tool over MCP. Skips without the stand-in.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-nfm-pass1!'
const CLUSTER = 'self'
const NS = 'kubeast'
const MCP = '/api/v1/ai/mcp'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function selfKubectl(): ((...args: string[]) => string) | null {
  try {
    const kubeconfig = execFileSync('kind', ['get', 'kubeconfig', '--name', 'kubeast'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nfm-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (...args: string[]) => execFileSync('kubectl', ['--kubeconfig', kcPath, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type End = { namespace?: string; pod?: string; workload?: { kind: string; name: string }; service?: string; ip?: string; az?: string }
type Row = { local: End; remote: End; port?: number; value: number; category: string }

test.describe('Top talkers (Network Flow Monitor)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let ready = false
  let kubectl: ((...args: string[]) => string) | null = null
  const pods = { gateway: '', k8s: '', dns: '', gatewayIP: '', k8sIP: '', dnsIP: '' }
  const owners: Record<string, string> = {}

  // the stand-in, asked from inside its pod
  function stub(method: string, url: string, body?: object): any {
    const py = `import json,urllib.request as u;r=u.Request(${JSON.stringify('http://127.0.0.1:8091' + url)},method=${JSON.stringify(method)},data=${body ? `json.dumps(${JSON.stringify(body)}).encode()` : 'None'});print(u.urlopen(r).read().decode())`
    return JSON.parse(kubectl!('-n', 'kubeast-devtools', 'exec', 'deploy/nfm-stub', '--', 'python', '-c', py))
  }

  // a pod's workload as kubectl reads its owners: ReplicaSet → Deployment
  function owner(namespace: string, pod: string): string {
    const rs = kubectl!('-n', namespace, 'get', 'pod', pod, '-o', 'jsonpath={.metadata.ownerReferences[0].name}')
    return 'Deployment/' + kubectl!('-n', namespace, 'get', 'replicaset', rs, '-o', 'jsonpath={.metadata.ownerReferences[0].name}')
  }

  const row = (cat: string, l: [string, string, string, string], r: [string, string, string, string], port: number, value: number) => {
    const k: Record<string, string> = {}
    if (l[1]) Object.assign(k, { localPodNamespace: l[0], localPodName: l[1] })
    if (r[1]) Object.assign(k, { remotePodNamespace: r[0], remotePodName: r[1] })
    return { destinationCategory: cat, localIp: l[2], localAz: l[3], remoteIp: r[2], remoteAz: r[3], targetPort: port, value, ...(Object.keys(k).length ? { kubernetesMetadata: k } : {}) }
  }

  async function user(request: APIRequestContext, name: string, grant: object): Promise<{ email: string; token: string }> {
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-nfm-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E nfm ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    userIds.push((await created.json()).id)
    const put = await request.put(`/api/v1/auth/admin/users/${userIds[userIds.length - 1]}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  async function top(request: APIRequestContext, token: string, params: Record<string, string>, cluster = CLUSTER) {
    const res = await request.get(`/api/v1/cluster/namespaces/${NS}/networktopflows`, { headers: bearer(token), params: { cluster, ...params }, failOnStatusCode: false })
    return { status: res.status(), body: await res.json() }
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    kubectl = selfKubectl()
    ready = !!kubectl && features?.networkFlowMonitor?.enabled === true && (features.networkFlowMonitor.clusters ?? []).includes(CLUSTER)
    if (!ready) return
    try {
      kubectl!('-n', 'kubeast-devtools', 'rollout', 'status', 'deploy/nfm-stub', '--timeout=60s')
    } catch {
      ready = false
      return
    }
    const first = (namespace: string, selector: string) => kubectl!('-n', namespace, 'get', 'pod', '-l', selector, '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name} {.items[0].status.podIP}').split(' ')
    ;[pods.gateway, pods.gatewayIP] = first(NS, 'app=gateway')
    ;[pods.k8s, pods.k8sIP] = first(NS, 'app=k8s-service')
    ;[pods.dns, pods.dnsIP] = first('kube-system', 'k8s-app=kube-dns')
    owners.gateway = owner(NS, pods.gateway)
    owners.k8s = owner(NS, pods.k8s)
    owners.dns = owner('kube-system', pods.dns)
    const az1 = 'use1-az1'
    const az2 = 'use1-az2'
    stub('PUT', '/_rows', {
      rows: {
        INTRA_AZ: [
          row('INTRA_AZ', [NS, pods.gateway, pods.gatewayIP, az1], [NS, pods.k8s, pods.k8sIP, az1], 8002, 5_000_000),
          row('INTRA_AZ', [NS, pods.k8s, pods.k8sIP, az1], [NS, pods.gateway, pods.gatewayIP, az1], 8002, 4_900_000),
          row('INTRA_AZ', ['', '', '10.244.0.1', az1], ['', '', '10.244.0.2', az1], 10250, 9_999_999),
          row('INTRA_AZ', ['kube-system', pods.dns, pods.dnsIP, az1], ['kube-system', 'other-0', '10.244.0.99', az1], 9153, 7_000_000),
        ],
        INTER_AZ: [row('INTER_AZ', [NS, pods.k8s, pods.k8sIP, az1], ['kube-system', pods.dns, pods.dnsIP, az2], 53, 30_000)],
        AMAZON_S3: [row('AMAZON_S3', [NS, pods.k8s, pods.k8sIP, az1], ['', '', '52.95.1.1', ''], 443, 800)],
      },
    })
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a Read user gets the rows with k8s-service at either end, its peers named as the cluster names them', async ({ request }) => {
    test.skip(!ready, 'no Network Flow Monitor stand-in for cluster self (deploy/kind/devtools.yaml, features.networkFlowMonitor)')
    const reader = await user(request, 'read', { role: 'Read' })
    stub('DELETE', '/_calls')
    const name = owners.k8s.split('/')[1]
    // Kubeast keeps an answer for the rest of its minute: a range of this run's own reaches the stand-in
    const minutes = 30 + (Date.now() % 60)
    const { status, body } = await top(request, reader.token, { kind: 'Deployment', name, range: `${minutes}m` })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ cluster: CLUSTER, monitor: 'kubeast-monitor', metric: 'DATA_TRANSFERRED', unit: 'Bytes', view: 'cluster', truncated: false })
    const rows = body.rows as Row[]
    // largest first; the host-network flow and kube-system's own flow are not k8s-service's
    expect(rows.map((r) => r.value)).toEqual([5_000_000, 4_900_000, 30_000])
    expect(rows[0]).toMatchObject({ category: 'INTRA_AZ', port: 8002, local: { namespace: NS, pod: pods.gateway, ip: pods.gatewayIP }, remote: { namespace: NS, pod: pods.k8s } })
    expect(`${rows[0].local.workload?.kind}/${rows[0].local.workload?.name}`).toBe(owners.gateway)
    expect(`${rows[0].remote.workload?.kind}/${rows[0].remote.workload?.name}`).toBe(owners.k8s)
    expect(rows[2]).toMatchObject({ category: 'INTER_AZ', port: 53, remote: { namespace: 'kube-system', pod: pods.dns, az: 'use1-az2' } })
    expect(`${rows[2].remote.workload?.kind}/${rows[2].remote.workload?.name}`).toBe(owners.dns)

    // what the stand-in was asked: the cluster view's two categories over the range, ending at a minute, signed
    const calls = stub('GET', '/_calls').calls as { destinationCategory: string; metricName: string; limit: number; startTime: string; endTime: string; signed: boolean }[]
    expect(calls.map((c) => c.destinationCategory)).toEqual(['INTRA_AZ', 'INTER_AZ'])
    for (const c of calls) {
      expect(c).toMatchObject({ metricName: 'DATA_TRANSFERRED', limit: 500, signed: true })
      expect(Date.parse(c.endTime) - Date.parse(c.startTime)).toBe(minutes * 60_000)
      expect(Date.parse(c.endTime) % 60_000).toBe(0)
    }

    // the audit row says what was asked and how many rows came back, not the rows
    let entry: any
    await expect.poll(async () => {
      const res = await request.get('/api/v1/auth/admin/audit-logs?action=k8s.networkflows.query&limit=20', { headers: bearer(admin) })
      entry = ((await res.json()).items ?? []).find((r: any) => (r.ActorEmail ?? r.actor_email) === reader.email)
      return !!entry
    }, { timeout: 15_000 }).toBe(true)
    expect(entry.TargetType ?? entry.target_type).toBe('deployment')
    const after = entry.After ?? entry.after
    expect(after).toMatchObject({ provider: 'nfm', monitor: 'kubeast-monitor', metric: 'DATA_TRANSFERRED', view: 'cluster', range_seconds: minutes * 60, rows: 3 })
    expect(JSON.stringify(after)).not.toContain(pods.gateway)
  })

  test('a namespace-limited reader needs the cluster to let it list pods, and sees peers elsewhere by namespace and address only', async ({ request }) => {
    test.skip(!ready, 'no Network Flow Monitor stand-in for cluster self (deploy/kind/devtools.yaml, features.networkFlowMonitor)')
    // a namespace-limited grant acts as kubeast:role:read, which this cluster does not bind: refused before any read
    const scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    stub('DELETE', '/_calls')
    const refused = await top(request, scoped.token, { kind: 'Pod', name: pods.k8s })
    expect(refused.status, JSON.stringify(refused.body)).toBe(403)
    expect(refused.body.detail).toContain(`list pods in ${NS}`)
    expect(stub('GET', '/_calls').calls).toEqual([])

    // bound to view in this namespace only, it reads; the CoreDNS end in kube-system keeps its namespace and address
    const binding = `e2e-nfm-read-${id}`
    kubectl!('-n', NS, 'create', 'rolebinding', binding, '--clusterrole=view', '--group=kubeast:role:read')
    try {
      const { status, body } = await top(request, scoped.token, { kind: 'Pod', name: pods.k8s })
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body.redacted).toBe(true)
      const dns = (body.rows as Row[]).find((r) => r.category === 'INTER_AZ')!
      expect(dns.remote).toEqual({ namespace: 'kube-system', ip: pods.dnsIP, az: 'use1-az2' })
      expect((body.rows as Row[]).find((r) => r.category === 'INTRA_AZ')!.local.pod).toBe(pods.gateway)
    } finally {
      kubectl!('-n', NS, 'delete', 'rolebinding', binding, '--ignore-not-found')
    }
    // a cluster without a monitor
    const other = await top(request, admin, {}, 'default')
    expect(other.status, JSON.stringify(other.body)).toBe(404)
    expect(other.body.detail).toContain('not configured')
  })

  test('the drawer lists the same peers, and the view and metric choices reach the monitor', async ({ page }) => {
    test.skip(!ready, 'no Network Flow Monitor stand-in for cluster self (deploy/kind/devtools.yaml, features.networkFlowMonitor)')
    const name = owners.k8s.split('/')[1]
    await page.goto(`/workloads/deployments?cluster=${CLUSTER}&namespace=${NS}&detail=Deployment/${NS}/${name}`)
    const section = page.getByTestId('toptalkers-section')
    await expect(section).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('toptalkers-load').click()
    await expect(section.getByTestId('toptalkers-row')).toHaveCount(3, { timeout: 20_000 })
    await expect(section.getByTestId('toptalkers-peer')).toHaveText([owners.gateway, owners.gateway, `kube-system/${owners.dns}`])
    await expect(section.getByTestId('toptalkers-value').first()).toHaveText('4.8 MB')
    await expect(section.getByTestId('toptalkers-category')).toHaveText(['same zone', 'same zone', 'across zones'])

    // the choices go into the read: AWS services, then retransmissions (the stand-in's rows are the same for each metric)
    const read = (view: string, metric: string) =>
      page.waitForResponse((r) => r.url().includes('/networktopflows') && r.url().includes(`view=${view}`) && r.url().includes(`metric=${metric}`))
    const aws = read('aws', 'DATA_TRANSFERRED')
    await page.getByTestId('toptalkers-view').click()
    await page.getByTestId('toptalkers-view-opt-aws').click()
    expect(await (await aws).json()).toMatchObject({ view: 'aws', metric: 'DATA_TRANSFERRED', unit: 'Bytes' })
    await expect(section.getByTestId('toptalkers-row')).toHaveCount(1, { timeout: 20_000 })
    await expect(section.getByTestId('toptalkers-peer')).toHaveText('52.95.1.1')
    await expect(section.getByTestId('toptalkers-category')).toHaveText('Amazon S3')
    const retrans = read('aws', 'RETRANSMISSIONS')
    await page.getByTestId('toptalkers-metric').click()
    await page.getByTestId('toptalkers-metric-opt-RETRANSMISSIONS').click()
    expect(await (await retrans).json()).toMatchObject({ view: 'aws', metric: 'RETRANSMISSIONS', unit: 'Count' })
    await expect(section.getByTestId('toptalkers-value')).toHaveText('800', { timeout: 20_000 })
  })

  test('the AI tool reads the same rows over MCP', async ({ request }) => {
    test.skip(!ready, 'no Network Flow Monitor stand-in for cluster self (deploy/kind/devtools.yaml, features.networkFlowMonitor)')
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const call = async (cluster: string) => {
      const res = await request.post(MCP, {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_top_flows', arguments: { cluster, namespace: NS, pod: pods.gateway, since: '1h' } } },
      })
      expect(res.status()).toBe(200)
      return (await res.json()).result
    }
    const result = await call(CLUSTER)
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false)
    const answer = JSON.parse(result.content[0].text)
    expect((answer.rows as Row[]).map((r) => r.value)).toEqual([5_000_000, 4_900_000])
    expect(answer.unit).toBe('Bytes')
    expect(answer.note).toContain('once from each end')
    // the second cluster has no monitor: the tool is not offered there
    const list = await request.post(MCP, {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_clusters', arguments: {} } },
    })
    const clusters = JSON.parse((await list.json()).result.content[0].text).clusters as { id: string; tools: string[] }[]
    expect(clusters.find((c) => c.id === CLUSTER)?.tools).toContain('network_top_flows')
    expect(clusters.find((c) => c.id === 'default')?.tools ?? []).not.toContain('network_top_flows')
  })
})
