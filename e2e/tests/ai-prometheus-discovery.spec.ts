import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI's Prometheus discovery tools — prometheus_metrics, prometheus_labels, prometheus_rules,
// prometheus_targets — driven through the MCP endpoint so the checks are exact. Cluster `default` reads its
// own Prometheus (the second kind cluster's, with the rules of deploy/kind/second-cluster.yaml); cluster
// `self` is pointed at that Prometheus as a shared store, once with this cluster's label value and once with
// a value nothing carries, so only the right cluster's series, alerts and targets come back; and through
// Grafana's data source proxy when scripts/kind-grafana.sh has run.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-promdisc-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSecond = kubectlFor('kubeast-b')
// The second cluster's Prometheus asked directly (its NodePort, from the kind node), to compare with what the tools return.
const promAPI = (p: string) =>
  JSON.parse(execSync(`docker exec kubeast-b-control-plane curl -sf 'http://127.0.0.1:30090${p}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })).data

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}
const tool = async (request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) =>
  JSON.parse((await call(request, token, name, args)).text)

type Rule = { name: string; type: string; state?: string; query: string; for_seconds?: number; alerts?: { labels: Record<string, string>; state: string }[] }
const ruleNamed = (rules: Rule[], name: string) => rules.find((r) => r.name === name) as Rule

test.describe('AI Prometheus discovery tools', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  let token = ''
  let nodeIP = ''

  test.beforeAll(async ({ request }) => {
    token = await login(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const st = await (await request.get('/api/v1/cluster/prometheus/status?cluster=default', { headers: bearer(token) })).json()
    test.skip(st.source !== 'proxy', 'cluster default does not read its own Prometheus (deploy/kind/second-cluster.yaml)')
    try {
      promAPI('/api/v1/rules?rule_name[]=KubeastE2EPrometheusUp')
    } catch {
      test.skip(true, 'the second cluster Prometheus has no e2e rules — re-apply deploy/kind/second-cluster.yaml')
    }
    nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
  })

  test.afterAll(async ({ request }) => {
    if (!token) return
    for (const id of ['self', 'default']) {
      await request.patch(`/api/v1/clusters/${id}`, {
        headers: bearer(token), data: { prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } },
      })
    }
  })

  test("on the cluster's own Prometheus: names with metadata, label values, rules with state, targets", async ({ request }) => {
    const metrics = await tool(request, token, 'prometheus_metrics', { cluster: 'default', pattern: 'memory_working' })
    const ws = metrics.metrics.find((m: { name: string }) => m.name === 'container_memory_working_set_bytes')
    expect(ws, JSON.stringify(metrics)).toMatchObject({ type: 'gauge', help: expect.stringMatching(/working set/i) })
    expect(metrics.metrics.every((m: { name: string }) => m.name.includes('memory_working'))).toBe(true)
    expect(metrics.total).toBe(metrics.metrics.length)

    // Every namespace label value is one that Prometheus, asked directly, holds for the series (a namespace another spec
    // deleted within the hour is still there), and the ones with long-lived pods are there.
    const labels = await tool(request, token, 'prometheus_labels', { cluster: 'default', selector: 'container_memory_working_set_bytes', label: 'namespace' })
    const held = promAPI(`/api/v1/label/namespace/values?match[]=container_memory_working_set_bytes&start=${Math.floor(Date.now() / 1000) - 7200}`) as string[]
    expect(labels.values.length).toBeGreaterThan(1)
    for (const v of labels.values) expect(held, v).toContain(v)
    expect(labels.values).toEqual(expect.arrayContaining(['kube-system', 'monitoring']))
    const names = await tool(request, token, 'prometheus_labels', { cluster: 'default', selector: 'kube_pod_info' })
    expect(names.names).toEqual(expect.arrayContaining(['namespace', 'pod', 'node']))

    const rules = (await tool(request, token, 'prometheus_rules', { cluster: 'default' })).rules as Rule[]
    const up = ruleNamed(rules, 'KubeastE2EPrometheusUp')
    expect(up).toMatchObject({ type: 'alerting', state: 'firing' })
    expect(up.alerts?.[0].labels.cluster).toBe('kubeast-b')
    expect(ruleNamed(rules, 'KubeastE2ENeverFires')).toMatchObject({ state: 'inactive', for_seconds: 300 })
    expect(ruleNamed(rules, 'kubeast_e2e:up:sum')).toMatchObject({ type: 'recording', query: 'sum by (job) (up)' })
    const active = await tool(request, token, 'prometheus_rules', { cluster: 'default', rule: 'kubeaste2e', active_only: true })
    expect(active.rules.map((r: Rule) => r.name)).toEqual(['KubeastE2EPrometheusUp'])
    expect(active.states.inactive).toBe(1)

    // The targets the tool reports are the ones Prometheus has, health included.
    const targets = await tool(request, token, 'prometheus_targets', { cluster: 'default' })
    expect(targets.source).toBe('targets_api')
    const direct = promAPI('/api/v1/targets?state=active').activeTargets as { labels: Record<string, string>; health: string }[]
    const key = (t: { job: string; instance: string; health: string }) => `${t.job} ${t.instance} ${t.health}`
    expect(targets.targets.map(key).sort()).toEqual(direct.map((t) => key({ job: t.labels.job, instance: t.labels.instance, health: t.health })).sort())

    const bad = await call(request, token, 'prometheus_labels', { cluster: 'default', selector: 'sum(up)' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/not a series selector/)
  })

  test('a shared store answers for this cluster only, by its label value', async ({ request }) => {
    const store = (value: string) => request.patch('/api/v1/clusters/self', {
      headers: bearer(token), data: { prometheus_url: `http://${nodeIP}:30090`, prometheus_cluster_label: value, prometheus_auth: { type: 'none' } },
    })
    expect((await store('kubeast-b')).status()).toBe(200)
    const mine = await tool(request, token, 'prometheus_metrics', { cluster: 'self', pattern: 'container_memory_working_set_bytes' })
    expect(mine.total).toBe(1)
    const mineRules = await tool(request, token, 'prometheus_rules', { cluster: 'self', rule: 'KubeastE2EPrometheusUp' })
    expect(mineRules.scope).toMatch(/shared store/)
    expect(mineRules.rules[0]).toMatchObject({ state: 'firing' })
    const mineTargets = await tool(request, token, 'prometheus_targets', { cluster: 'self' })
    expect(mineTargets.source).toBe('up_metric')
    const upSeries = promAPI(`/api/v1/query?query=${encodeURIComponent('up{cluster="kubeast-b"}')}`).result as unknown[]
    expect(mineTargets.total).toBe(upSeries.length)

    // A label value no series carries: the same store has nothing for this cluster.
    expect((await store('elsewhere')).status()).toBe(200)
    const none = await tool(request, token, 'prometheus_metrics', { cluster: 'self', pattern: 'container_memory_working_set_bytes' })
    expect(none.total).toBe(0)
    expect(none.hint).toMatch(/No metric name contains/)
    const noneRules = await tool(request, token, 'prometheus_rules', { cluster: 'self', rule: 'KubeastE2EPrometheusUp' })
    expect(noneRules.rules[0]).toMatchObject({ state: 'inactive' })
    expect(noneRules.rules[0].alerts ?? []).toEqual([])
    const noneLabels = await tool(request, token, 'prometheus_labels', { cluster: 'self', label: 'namespace' })
    expect(noneLabels.values).toEqual([])
    expect((await tool(request, token, 'prometheus_targets', { cluster: 'self' })).total).toBe(0)
    expect((await request.patch('/api/v1/clusters/self', {
      headers: bearer(token), data: { prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } },
    })).status()).toBe(200)
  })

  test("through Grafana's data source proxy the tools give the same answers; a store error is a 502", async ({ request }) => {
    let grafanaToken = ''
    try {
      grafanaToken = Buffer.from(kubectlSecond('-n grafana get secret kubeast-reader -o jsonpath={.data.token}'), 'base64').toString()
    } catch {
      test.skip(true, 'no Grafana in the second kind cluster — run scripts/kind-grafana.sh up')
    }
    const via = (tokenValue: string) => request.patch('/api/v1/clusters/default', {
      headers: bearer(token),
      data: { prometheus_url: `http://${nodeIP}:31300/api/datasources/proxy/uid/prometheus`, prometheus_cluster_label: 'kubeast-b', prometheus_auth: { type: 'bearer', token: tokenValue } },
    })
    expect((await via(grafanaToken)).status()).toBe(200)
    const metrics = await tool(request, token, 'prometheus_metrics', { cluster: 'default', pattern: 'container_memory_working_set_bytes' })
    expect(metrics.metrics[0]).toMatchObject({ name: 'container_memory_working_set_bytes', type: 'gauge' })
    const rules = (await tool(request, token, 'prometheus_rules', { cluster: 'default' })).rules as Rule[]
    expect(ruleNamed(rules, 'KubeastE2EPrometheusUp')).toMatchObject({ state: 'firing' })
    const labels = await tool(request, token, 'prometheus_labels', { cluster: 'default', label: 'job' })
    expect(labels.values).toEqual(expect.arrayContaining(['kubelet', 'prometheus']))

    expect((await via('glsa_wrong_token')).status()).toBe(200)
    const q = await request.get('/api/v1/cluster/prometheus/query?cluster=default&query=up', { headers: bearer(token) })
    expect(q.status()).toBe(502)
    expect(await q.text()).toContain('status 401')
    const refused = await call(request, token, 'prometheus_metrics', { cluster: 'default' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/502/)
  })

  test('a cluster without Prometheus answers unavailable with the alternative', async ({ request }) => {
    const st = await (await request.get('/api/v1/cluster/prometheus/status?cluster=self', { headers: bearer(token) })).json()
    test.skip(st.source !== 'none', `cluster self reads a Prometheus here (${st.source})`)
    for (const name of ['prometheus_metrics', 'prometheus_labels', 'prometheus_rules', 'prometheus_targets']) {
      const out = await tool(request, token, name, { cluster: 'self' })
      expect(out, name).toMatchObject({ status: 'unavailable', feature: 'prometheus' })
      expect(out.alternative).toMatch(/get_pod_metrics/)
    }
  })
})
