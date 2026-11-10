import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The query tools shrink a list before it reaches the model (k8s_jq_query, k8s_tabular_query, k8s_count) and
// k8s_diff previews a manifest with a server dry run — nothing applied, offered only to users who may write.
// Driven through the MCP endpoint as the admin and a temporary Read user, checked against kubectl.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-query-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-query-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, allowFail = false) => {
    try {
      return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    } catch (e) {
      if (allowFail) return ''
      throw e
    }
  }
}
const kubectl = kubectlFor('kubeast')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createReadUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E query', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id as string
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
  expect(grant.ok(), 'grant Read on self').toBeTruthy()
  return id
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

async function mcpOn(request: APIRequestContext, token: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && (await config.json()).enabled
}

const json = (text: string) => JSON.parse(text)

test.describe('AI query tools: jq, tabular, count, and the k8s_diff preview', () => {
  test.setTimeout(180_000)

  test('k8s_jq_query, k8s_tabular_query and k8s_count read what kubectl reads, shrunk', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const running = kubectl(`-n kubeast get pods --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean).sort()
    expect(running.length).toBeGreaterThan(0)
    const all = Number(kubectl(`-n kubeast get pods -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean).length)

    const jq = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[] | select(.status.phase == "Running") | .metadata.name' })).text)
    expect(jq.scope).toBe('kubeast')
    expect(jq.total_items_processed).toBe(all)
    expect(jq.matches_found).toBe(running.length)
    expect([...jq.results].sort()).toEqual(running)

    const shaped = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[] | {name: .metadata.name, node: .spec.nodeName}', limit: 2 })).text)
    expect(shaped.results.length).toBe(2)
    expect(shaped.truncated).toBe(all > 2)
    expect(shaped.results[0]).toEqual({ name: expect.any(String), node: expect.any(String) })

    const badJq = await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '.items[ | ' })
    expect(badJq.isError).toBe(true)
    expect(badJq.text).toMatch(/jq:/)
    // No environment leaks into the program.
    const env = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: 'env | length' })).text)
    expect(env.results).toEqual([0])

    const table = (await call(request, token, 'k8s_tabular_query', { resource_type: 'pods', namespace: 'kubeast', columns: 'NAME:.metadata.name,PHASE:.status.phase', sort_by: '.metadata.name', limit: 3 })).text
    const lines = table.split('\n')
    expect(lines[0]).toMatch(new RegExp(`^# pods in kubeast: ${all} rows`))
    expect(lines[1]).toMatch(/^NAME\s+PHASE$/)
    expect(lines.length).toBe(2 + Math.min(3, all))
    const names = lines.slice(2).map((l) => l.split(/\s+/)[0])
    expect([...names]).toEqual([...names].sort())

    const count = json((await call(request, token, 'k8s_count', { resource_type: 'pods', namespace: 'kubeast', group_by: '.status.phase' })).text)
    expect(count.count).toBe(all)
    const runningGroup = count.groups.find((g: { key: string }) => g.key === 'Running')
    expect(runningGroup?.count).toBe(running.length)
    const nodes = json((await call(request, token, 'k8s_count', { resource_type: 'nodes' })).text)
    expect(nodes.count).toBe(Number(kubectl(`get nodes -o name`).split('\n').filter(Boolean).length))
  })

  test('a few large objects are counted as few: a page past the tool output is read again smaller', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')
    const ns = `e2e-big-cm-${stamp()}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-big-cm-'))
    const file = path.join(dir, 'value')
    fs.writeFileSync(file, 'x'.repeat(600 << 10))
    kubectl(`create namespace ${ns}`)
    try {
      for (const name of ['big-a', 'big-b']) {
        kubectl(`-n ${ns} create configmap ${name} --from-file=value=${file}`)
        kubectl(`-n ${ns} label configmap ${name} app=e2e-big`)
      }
      const inCluster = kubectl(`-n ${ns} get configmaps -l app=e2e-big -o name`).split('\n').filter(Boolean)
      expect(inCluster).toEqual(['configmap/big-a', 'configmap/big-b'])

      const counted = json((await call(request, token, 'k8s_count', { resource_type: 'configmaps', namespace: ns, label_selector: 'app=e2e-big' })).text)
      expect(counted.count).toBe(inCluster.length)
      expect(counted.count_at_least).toBeUndefined()
      const table = (await call(request, token, 'k8s_tabular_query', { resource_type: 'configmaps', namespace: ns, label_selector: 'app=e2e-big', columns: 'NAME:.metadata.name' })).text
      expect(table).not.toContain('too_large')
      expect(table.split('\n').slice(2).map((l) => l.trim()).sort()).toEqual(['big-a', 'big-b'])
    } finally {
      kubectl(`delete namespace ${ns} --wait=false`, true)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a jq program that builds more than a run may hold is refused for its memory, and tool-server keeps running', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')
    const pods = () => kubectl(`-n kubeast get pods -l app=tool-server -o jsonpath='{range .items[*]}{.metadata.name}={.status.containerStatuses[0].restartCount}{" "}{end}'`).replace(/'/g, '').trim()
    const before = pods()
    expect(before).toMatch(/=\d+/)

    for (const program of ['[range(6000000)] | length', 'reduce range(27) as $i ("a"; . + .) | length', '"a" * 200000000 | length']) {
      const refused = await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: program })
      expect(refused.isError, program).toBe(true)
      expect(refused.text, program).toMatch(/jq: the expression needed more memory than a run may hold/)
    }
    const after = json((await call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq: '[.items[].metadata.name] | length' })).text)
    expect(after.results).toEqual([Number(kubectl(`-n kubeast get pods -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean).length)])
    // the same pods with the same restart counts: no container was killed for the programs' memory
    expect(pods()).toBe(before)
  })

  test('jq programs asked at once each get their own answer: they take turns, and one past its memory is refused alone', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')
    const pods = () => kubectl(`-n kubeast get pods -l app=tool-server -o jsonpath='{range .items[*]}{.metadata.name}={.status.containerStatuses[0].restartCount}{" "}{end}'`).replace(/'/g, '').trim()
    const before = pods()
    expect(before).toMatch(/=\d+/)
    const names = kubectl(`-n kubeast get pods -o jsonpath='{.items[*].metadata.name}'`).replace(/'/g, '').split(/\s+/).filter(Boolean)

    const programs = ['"a" * 200000000 | length', ...Array.from({ length: 5 }, () => '[.items[].metadata.name] | length')]
    const answers = await Promise.all(programs.map((jq) => call(request, token, 'k8s_jq_query', { resource_type: 'pods', namespace: 'kubeast', jq })))
    expect(answers[0].isError, answers[0].text).toBe(true)
    expect(answers[0].text).toMatch(/jq: the expression needed more memory than a run may hold/)
    for (const a of answers.slice(1)) {
      expect(a.isError, a.text).toBe(false)
      expect(json(a.text).results).toEqual([names.length])
    }
    expect(pods()).toBe(before)
  })

  test('a Secret answers every query tool without its values, a ConfigMap read the same way keeps them, and k8s_diff names keys only', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const ns = `e2e-secval-${stamp()}`
    const value = `fake-value-${stamp()}`
    const newValue = `fake-new-${stamp()}`
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    const inBraces = `{ conf = ${value} }`
    const configValue = `plain-config-${stamp()}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-secval-'))
    const secretYaml = (key: string) => `apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\n  namespace: ${ns}\ntype: Opaque\nstringData:\n  conf: "${inBraces}"\n  tls.key: ${key}\n`
    const file = path.join(dir, 'objects.yaml')
    // kubectl apply: the last-applied annotation holds stringData in the clear
    fs.writeFileSync(file, `${secretYaml(value)}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: ${ns}\ndata:\n  mode: ${configValue}\n`)
    kubectl(`create namespace ${ns}`)
    try {
      kubectl(`apply -f ${file}`)
      const gone = [value, b64(value), inBraces, b64(inBraces)]
      const clean = (text: string, what: string) => {
        for (const g of gone) expect(text, what).not.toContain(g)
      }

      // whatever the output and however the kind is written
      const outputs: Record<string, unknown>[] = [
        { resource_type: 'secrets', output: 'jsonpath={.items[*].data}' },
        { resource_type: 'secret', output: 'jsonpath-as-json={.items[*].data}' },
        { resource_type: 'Secret', output: 'go-template={{range .items}}{{.data}}{{end}}' },
        { resource_type: 'secrets,configmaps', output: 'custom-columns=V:.data' },
        { resource_type: 'secrets', resource_name: 'app', output: 'jsonpath={.metadata.annotations}' },
      ]
      for (const args of outputs) {
        const res = json((await call(request, admin, 'k8s_get_resources', { namespace: ns, ...args })).text)
        expect(res.status, JSON.stringify(args)).toBe('forbidden')
        expect(res.hint).toContain('k8s_describe_resource')
      }
      const table = json((await call(request, admin, 'k8s_tabular_query', { resource_type: 'secrets', namespace: ns, columns: 'V:.data.conf' })).text)
      expect(table.status).toBe('forbidden')
      const sorted = json((await call(request, admin, 'k8s_tabular_query', { resource_type: 'secrets,configmaps', namespace: ns, sort_by: '.data.conf' })).text)
      expect(sorted.status).toBe('forbidden')
      const grouped = json((await call(request, admin, 'k8s_count', { resource_type: 'secrets', namespace: ns, group_by: '.data.conf' })).text)
      expect(grouped.status).toBe('forbidden')

      for (const kind of ['secrets', 'secrets,configmaps', 'all']) {
        for (const jq of ['.items[].data', '.items[].metadata.annotations', '.items[]', '[.items[] | .data // {} | to_entries[] | .value]']) {
          clean((await call(request, admin, 'k8s_jq_query', { resource_type: kind, namespace: ns, jq })).text, `${kind} ${jq}`)
        }
      }
      // a program that fails on the value does not quote it either
      clean((await call(request, admin, 'k8s_jq_query', { resource_type: 'secrets', namespace: ns, jq: '.items[0].data.conf | .missing' })).text, 'runtime error')
      for (const output of ['json', 'yaml']) clean((await call(request, admin, 'k8s_get_resources', { resource_type: 'secrets', namespace: ns, output })).text, output)
      clean((await call(request, admin, 'k8s_get_resource_yaml', { resource_type: 'secret', resource_name: 'app', namespace: ns })).text, 'yaml')
      clean((await call(request, admin, 'k8s_describe_resource', { resource_type: 'secret', resource_name: 'app', namespace: ns })).text, 'describe')

      // what needs no value stays: key names, how many, of which type
      const keys = json((await call(request, admin, 'k8s_jq_query', { resource_type: 'secrets', namespace: ns, jq: '.items[] | select(.metadata.name == "app") | .data | keys' })).text)
      const realKeys = Object.keys(JSON.parse(kubectl(`-n ${ns} get secret app -o json`)).data).sort()
      expect(keys.results).toEqual([realKeys])
      const howMany = kubectl(`-n ${ns} get secrets -o name`).split('\n').filter(Boolean).length
      expect(json((await call(request, admin, 'k8s_count', { resource_type: 'secrets', namespace: ns })).text).count).toBe(howMany)
      const types = json((await call(request, admin, 'k8s_count', { resource_type: 'secrets', namespace: ns, group_by: '.type' })).text)
      expect(types.groups.map((g: { key: string }) => g.key)).toContain('Opaque')

      // the same calls on a ConfigMap answer with its values
      const jqValue = json((await call(request, admin, 'k8s_jq_query', { resource_type: 'configmaps', namespace: ns, jq: '.items[] | select(.metadata.name == "cfg") | .data.mode' })).text)
      expect(jqValue.results).toEqual([configValue])
      const mixed = await call(request, admin, 'k8s_jq_query', { resource_type: 'secrets,configmaps', namespace: ns, jq: '.items[] | .data' })
      expect(mixed.text).toContain(configValue)
      clean(mixed.text, 'a list of both')
      expect((await call(request, admin, 'k8s_tabular_query', { resource_type: 'configmaps', namespace: ns, columns: 'V:.data.mode' })).text).toContain(configValue)
      expect((await call(request, admin, 'k8s_get_resources', { resource_type: 'configmaps', namespace: ns, output: 'jsonpath={.items[*].data.mode}' })).text).toContain(configValue)
      const byMode = json((await call(request, admin, 'k8s_count', { resource_type: 'configmaps', namespace: ns, group_by: '.data.mode' })).text)
      expect(byMode.groups.map((g: { key: string }) => g.key)).toContain(configValue)
      expect((await call(request, admin, 'k8s_tabular_query', { resource_type: 'all', namespace: ns, columns: 'NAME:.metadata.name' })).text).not.toContain('"status":"forbidden"')

      // k8s_diff of a Secret: the key that changes, no value on either side, nothing applied
      const same = json((await call(request, admin, 'k8s_diff', { yaml_content: secretYaml(value) })).text)
      expect(same.status).toBe('unchanged')
      const changed = await call(request, admin, 'k8s_diff', { yaml_content: secretYaml(newValue) })
      clean(changed.text, 'diff')
      expect(changed.text).not.toContain(b64(newValue))
      expect(changed.text).not.toContain(newValue)
      const preview = json(changed.text)
      expect(preview).toMatchObject({ status: 'changed', kind: 'Secret', lines_added: 1, lines_removed: 1 })
      expect(preview.diff).toContain('"tls.key"')
      expect(preview.diff).not.toMatch(/^[-+] +"conf"/m)
      expect(JSON.parse(kubectl(`-n ${ns} get secret app -o json`)).data['tls.key']).toBe(b64(value))
    } finally {
      kubectl(`delete namespace ${ns} --wait=false`, true)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('k8s_diff previews created, changed and unchanged without applying; a Read user is not offered it', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const name = `e2e-diff-${stamp()}`
    const manifest = (a: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  a: "${a}"\n`
    let readerId = ''
    try {
      // Not there yet: the preview says created, and nothing is created.
      const created = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') })).text)
      expect(created).toMatchObject({ status: 'created', kind: 'ConfigMap', name, namespace: 'default', lines_removed: 0 })
      expect(created.lines_added).toBeGreaterThan(3)
      expect(created.diff).toContain(`+    "a": "1"`)
      expect(kubectl(`-n default get configmap ${name} -o name`, true)).toBe('')

      kubectl(`-n default create configmap ${name} --from-literal=a=1`)
      const changed = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('2') })).text)
      expect(changed).toMatchObject({ status: 'changed', lines_added: 1, lines_removed: 1 })
      expect(changed.diff).toContain(`-    "a": "1"`)
      expect(changed.diff).toContain(`+    "a": "2"`)
      expect(changed.note).toMatch(/nothing was applied/)
      expect(kubectl(`-n default get configmap ${name} -o jsonpath='{.data.a}'`).replace(/'/g, '')).toBe('1')

      const unchanged = json((await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') })).text)
      expect(unchanged.status).toBe('unchanged')
      expect(unchanged.diff).toBe('')

      const multi = await call(request, admin, 'k8s_diff', { yaml_content: manifest('1') + '---\n' + manifest('2') })
      expect(multi.isError).toBe(true)
      expect(multi.text).toMatch(/one object per call/)

      // The admin's cluster list offers the preview; a Read user's does not, and a direct call is refused.
      const adminClusters = json((await call(request, admin, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      expect(adminClusters.find((c) => c.id === 'self')!.tools).toContain('k8s_diff')
      const email = `e2e-query-r-${stamp()}@kubeast.local`
      readerId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const readClusters = json((await call(request, reader, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      const readSelf = readClusters.find((c) => c.id === 'self')!
      expect(readSelf.tools).not.toContain('k8s_diff')
      expect(readSelf.tools).toContain('k8s_jq_query')
      expect(readSelf.tools).toContain('k8s_count')
      const refused = await call(request, reader, 'k8s_diff', { yaml_content: manifest('3') })
      expect(refused.isError).toBe(true)
      // A Read user still gets the shrinking tools, as the cluster lets them read.
      const readCount = json((await call(request, reader, 'k8s_count', { resource_type: 'pods', namespace: 'kubeast' })).text)
      expect(readCount.count).toBeGreaterThan(0)
    } finally {
      kubectl(`-n default delete configmap ${name} --ignore-not-found`, true)
      if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin) })
    }
  })
})
