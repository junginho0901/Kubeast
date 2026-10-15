import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The read tools answer a miss with a result the model can act on instead of a kubectl error:
// {"status":"not_found","similar":[...]}, unknown_kind, unavailable, container_required. k8s_find_resource
// searches by a name fragment or label across kinds, k8s_explain hands back the API schema, and pod logs /
// events take the kubectl flags (previous, since, grep, field selectors). Driven through the MCP endpoint,
// which calls the same tool-server as the chat without a model in between, so the checks are exact.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tools-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cluster: 'self', ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

const json = (text: string) => JSON.parse(text)

test.describe('AI read tools: misses are results, not errors', () => {
  test.setTimeout(180_000)

  test('a missing pod answers not_found with similar names; a wrong kind answers unknown_kind', async ({ request }) => {
    const token = await login(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: { Authorization: `Bearer ${token}` } })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')

    const realPod = kubectl(`-n kubeast get pods -l app=auth-service -o jsonpath='{.items[0].metadata.name}'`).replace(/'/g, '')
    expect(realPod).toMatch(/auth-service/)

    // The owner's name, not the pod's: kubectl get says NotFound, the tool says which pods are close.
    // (kubectl describe matches a name prefix, so it is asked with a name that is not a prefix.)
    const miss = await call(request, token, 'k8s_get_resources', { resource_type: 'pods', resource_name: 'auth-service', namespace: 'kubeast' })
    expect(miss.isError).toBeFalsy()
    const body = json(miss.text)
    expect(body.status).toBe('not_found')
    expect(body.namespace_exists).toBe(true)
    expect(body.searched).toBe('all namespaces')
    expect(body.similar.map((s: { name: string }) => s.name)).toContain(realPod)
    expect(body.hint).toMatch(/hash suffix/)
    const described = json((await call(request, token, 'k8s_describe_resource', { resource_type: 'pods', resource_name: 'kubeast-auth-service', namespace: 'kubeast' })).text)
    expect(described.status).toBe('not_found')
    expect(described.similar.map((s: { name: string }) => s.name)).toContain(realPod)

    // A namespace that does not exist is said so.
    const noNs = await call(request, token, 'k8s_get_resources', { resource_type: 'pods', resource_name: realPod, namespace: 'no-such-namespace' })
    expect(json(noNs.text)).toMatchObject({ status: 'not_found', namespace_exists: false })

    // A misspelled kind lists the kinds the cluster does serve.
    const kind = await call(request, token, 'k8s_get_resources', { resource_type: 'deploymnets' })
    const k = json(kind.text)
    expect(k.status).toBe('unknown_kind')
    expect(k.similar_kinds.join(' ')).toMatch(/deployments/)

    // A real object still comes back as kubectl prints it.
    const hit = await call(request, token, 'k8s_get_resources', { resource_type: 'pods', resource_name: realPod, namespace: 'kubeast', output: 'wide' })
    expect(hit.isError).toBeFalsy()
    expect(hit.text).toContain(realPod)
    expect(() => json(hit.text)).toThrow()
  })

  test('k8s_find_resource searches kinds and namespaces by fragment and by label', async ({ request }) => {
    const token = await login(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: { Authorization: `Bearer ${token}` } })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')

    const byName = json((await call(request, token, 'k8s_find_resource', { query: 'auth-service' })).text)
    const kinds = new Set(byName.matches.map((m: { kind: string }) => m.kind))
    expect(kinds.has('pods') && kinds.has('deployments') && kinds.has('services'), JSON.stringify(byName)).toBe(true)
    expect(byName.matches.every((m: { namespace: string }) => m.namespace === 'kubeast')).toBe(true)
    expect(byName.searched.namespaces).toBe('all namespaces')

    const byLabel = json((await call(request, token, 'k8s_find_resource', { query: 'app=auth-service', kinds: ['pods'], namespace: 'kubeast' })).text)
    const podNames = kubectl(`-n kubeast get pods -l app=auth-service -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean)
    expect(podNames.length).toBeGreaterThan(0)
    expect(byLabel.matches.map((m: { name: string }) => m.name).sort()).toEqual(podNames.sort())

    const nothing = json((await call(request, token, 'k8s_find_resource', { query: 'no-such-thing-anywhere', kinds: ['pods', 'services'] })).text)
    expect(nothing.matches).toEqual([])
    expect(nothing.hint).toMatch(/Stop searching/)

    const bad = await call(request, token, 'k8s_find_resource', { query: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/name fragment/)
  })

  test('k8s_explain returns the schema; pod logs and events take the kubectl flags', async ({ request }) => {
    const token = await login(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: { Authorization: `Bearer ${token}` } })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')

    const explain = await call(request, token, 'k8s_explain', { resource: 'deployments.spec.replicas' })
    expect(explain.isError).toBeFalsy()
    expect(explain.text).toMatch(/KIND:\s+Deployment/)
    expect(explain.text).toMatch(/replicas/)
    const field = json((await call(request, token, 'k8s_explain', { resource: 'deployments.spec.noSuchField' })).text)
    expect(field.status).toBe('unknown_field')

    const pod = kubectl(`-n kubeast get pods -l app=auth-service -o jsonpath='{.items[0].metadata.name}'`).replace(/'/g, '')
    // A container that never restarted has no previous log — the tool says so instead of failing.
    const restarts = Number(kubectl(`-n kubeast get pod ${pod} -o jsonpath='{.status.containerStatuses[0].restartCount}'`).replace(/'/g, '') || '0')
    const previous = await call(request, token, 'k8s_get_pod_logs', { pod_name: pod, namespace: 'kubeast', previous: true, tail_lines: 5 })
    expect(previous.isError).toBeFalsy()
    if (restarts === 0) expect(json(previous.text).status).toBe('no_previous')
    else expect(previous.text.length).toBeGreaterThan(0)

    // grep keeps matching lines and reports the count; a nonsense needle matches nothing.
    const grep = await call(request, token, 'k8s_get_pod_logs', { pod_name: pod, namespace: 'kubeast', grep: 'zz-no-such-text-zz', since: '24h' })
    expect(grep.isError).toBeFalsy()
    expect(grep.text).toMatch(/^# grep "zz-no-such-text-zz": 0 of \d+ lines matched$/)

    // Events narrowed to one object: every row is about it (or there are none yet).
    const events = json((await call(request, token, 'k8s_get_events', { namespace: 'kubeast', kind: 'pods', name: pod })).text)
    expect(Array.isArray(events)).toBe(true)
    for (const ev of events) expect(ev.object).toEqual({ kind: 'Pod', name: pod })
    const warnings = json((await call(request, token, 'k8s_get_events', { all_namespaces: true, field_selector: 'type=Warning' })).text)
    expect(Array.isArray(warnings)).toBe(true)
    for (const ev of warnings) expect(ev.type).toBe('Warning')
    const badSelector = await call(request, token, 'k8s_get_events', { namespace: 'kubeast', field_selector: 'spec.nodeName=x' })
    expect(badSelector.isError).toBe(true)
  })
})
