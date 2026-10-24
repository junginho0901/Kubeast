import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendToolBlock, ChatStreamManager, nthToolBlock, resultTarget, withToolAccess, withToolResult } from './chatStreamManager'
import { accessLine, accessSection, requestsBlock } from './toolAccess'

describe('pairing a tool result with its call', () => {
  const calls = [
    { function: 'prometheus_query', call_id: 0, result: '' },
    { function: 'issues', call_id: 1, result: '' },
    { function: 'prometheus_query', call_id: 2, result: '' },
  ]

  it('uses the call number when the server sends one', () => {
    expect(resultTarget(calls, 'prometheus_query', 2)).toBe(2)
    expect(resultTarget(calls, 'prometheus_query', 0)).toBe(0)
  })

  it('falls back to the oldest call of that tool still waiting', () => {
    const old = calls.map(({ call_id: _id, ...rest }) => rest)
    expect(resultTarget(old, 'prometheus_query', undefined)).toBe(0)
    old[0].result = 'done'
    expect(resultTarget(old, 'prometheus_query', undefined)).toBe(2)
    expect(resultTarget(old, 'logsearch', undefined)).toBe(-1)
  })

  it('finds the n-th tool block, so two calls of one tool fill their own blocks', () => {
    const block = (n: string) => `<details>\n<summary>🔧 <strong>${n}</strong></summary>\n\nExecuting...\n\n</details>\n`
    const content = block('prometheus_query') + block('issues') + block('prometheus_query')
    const third = nthToolBlock(content, 2)
    expect(content.slice(third)).toContain('prometheus_query')
    expect(content.slice(0, third).split('<summary>🔧').length - 1).toBe(2)
    expect(nthToolBlock(content, 0)).toBe(content.indexOf('<summary>🔧'))
    expect(nthToolBlock(content, 3)).toBe(-1)
    expect(nthToolBlock(content, -1)).toBe(-1)
  })
})

describe('one answer in the order it came', () => {
  const block = (n: string) => `<details>\n<summary>🔧 <strong>${n}</strong></summary>\n\nExecuting...\n\n</details>\n\n`

  it('puts a tool block on its own line below the text so far', () => {
    expect(appendToolBlock('', block('a'))).toBe(block('a'))
    expect(appendToolBlock('Checking.', block('a'))).toBe('Checking.\n\n' + block('a'))
    expect(appendToolBlock('Checking. \n', block('a'))).toBe('Checking.\n\n' + block('a'))
    expect(appendToolBlock(block('a'), block('b'))).toBe(block('a').trimEnd() + '\n\n' + block('b'))
  })

  it('fills the n-th block with its result and leaves the text around it', () => {
    const content = 'First.\n\n' + block('a') + 'Then.\n\n' + block('a') + 'Executing... is a word here.'
    const filled = withToolResult(content, 1, '```\nsecond\n```')
    expect(filled).toBe('First.\n\n' + block('a') + 'Then.\n\n' + block('a').replace('Executing...', '```\nsecond\n```')
      + 'Executing... is a word here.')
    expect(withToolResult(content, 2, 'x')).toBe(content)
  })
})

describe('the stream manager keeps text and tool blocks in arrival order', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function sseResponse(events: unknown[]) {
    const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }))
  }

  async function run(events: unknown[]) {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'how many?')
    await vi.runAllTimersAsync()
    return manager.getState()
  }

  it('text, a call, more text, a call whose result comes late, and the last text', async () => {
    const state = await run([
      { content: 'Checking ' }, { content: 'the clusters.' },
      { function: 'list_clusters', args: {}, call_id: 0 },
      { function_result: 'list_clusters', result: '["self"]', is_json: true, call_id: 0 },
      { content: 'Now the pods.' },
      { function: 'k8s_get_resources', args: { kind: 'pods' }, call_id: 1 },
      { content: '\n\nAll running.' },
      { function_result: 'k8s_get_resources', result: 'pod-a Running', call_id: 1 },
      '[DONE]',
    ])
    expect(state.status).toBe('completed')
    const c = state.content
    const order = ['Checking the clusters.', '<strong>list_clusters</strong>', '["self"]', 'Now the pods.',
      '<strong>k8s_get_resources</strong>', 'pod-a Running', 'All running.'].map((s) => c.indexOf(s))
    expect(order.every((at) => at !== -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(c.startsWith('Checking the clusters.\n\n<details>')).toBe(true)
    expect(c).toContain('Now the pods.\n\n<details>')
    expect(c).not.toContain('Executing...')
    expect(state.toolCalls.map((tc) => tc.result)).toEqual(['["self"]', 'pod-a Running'])
  })

  it('an answer without tools is its text', async () => {
    const state = await run([{ content: 'Two clusters.' }, '[DONE]'])
    expect(state.content).toBe('Two clusters.')
  })

  it('puts the identity a call reached the cluster as under its name, and none on a call that reached no cluster', async () => {
    const access = { cluster: 'self', kind: 'person', user: 'a@example.com', groups: ['kubeast:authenticated', 'kubeast:viewer'], role: 'Read', impersonation: true, mode: 'read' }
    const requests = { requests: [{ source: 'api', verb: 'list', resource: 'pods', namespace: 'kube-system', status: 200, audit_id: 'kubeast-1', echoed: true }], total: 1 }
    const state = await run([
      { function: 'k8s_get_resources', args: { kind: 'pods' }, call_id: 0 },
      { function: 'list_clusters', args: {}, call_id: 1 },
      { function_result: 'list_clusters', result: '["self"]', call_id: 1 },
      { function_result: 'k8s_get_resources', result: 'pod-a Running', call_id: 0, access, requests },
      '[DONE]',
    ])
    const c = state.content
    expect(c.split('🔐 Ran as:').length - 1).toBe(1)
    expect(c).toContain(`<summary>🔧 <strong>k8s_get_resources</strong></summary>\n\n${accessLine(access)}\n\n${requestsBlock(requests)}\n\n<details>`)
    expect(c.indexOf('🔐')).toBeLessThan(c.indexOf('<strong>list_clusters</strong>'))
    expect(state.toolCalls.map((tc) => tc.access ?? null)).toEqual([access, null])
    expect(state.toolCalls.map((tc) => tc.requests ?? null)).toEqual([requests, null])
  })
})

describe('the 🔐 line', () => {
  const read = { cluster: 'prod', kind: 'person', user: 'a@example.com', groups: ['kubeast:authenticated', 'kubeast:viewer'], role: 'Read', impersonation: true }

  // The same cases and text as ai-service tests/test_tool_access.py: the saved answer and the live one must match.
  it.each([
    [{ ...read, mode: 'read' },
      '<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> <code>kubeast:viewer</code> · role Read · whole cluster · read-only</p>'],
    [{ ...read, role: 'Write', groups: ['kubeast:authenticated', 'kubeast:role:write'], namespaces: ['shop', 'payments'], mode: 'write' },
      '<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> <code>kubeast:role:write</code> · role Write · namespaces shop, payments · write</p>'],
    [{ ...read, role: '*', groups: ['kubeast:admin', 'kubeast:authenticated'] },
      '<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:admin</code> <code>kubeast:authenticated</code> · global admin · whole cluster · read-only</p>'],
    [{ ...read, kind: 'api_key', api_key: 'k-1' },
      '<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> (API key) · groups <code>kubeast:authenticated</code> <code>kubeast:viewer</code> · role Read · whole cluster · read-only</p>'],
    [{ cluster: 'prod', kind: 'investigator', user: 'kubeast:investigator', groups: ['kubeast:investigator'], impersonation: true },
      '<p><strong>🔐 Ran as:</strong> <code>kubeast:investigator</code> · groups <code>kubeast:investigator</code> · alert investigator · read-only</p>'],
    [{ cluster: 'prod', kind: 'person', role: 'Read', impersonation: false },
      "<p><strong>🔐 Ran as:</strong> ⚠️ Kubeast's own credential, not this user's permissions (impersonation is off) · role Read · whole cluster · read-only</p>"],
    [{ ...read, role: '' },
      '<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> <code>kubeast:viewer</code> · no role in this cluster · whole cluster · read-only</p>'],
  ])('%#', (access, want) => {
    expect(accessLine(access)).toBe(want)
  })

  it('escapes what the token carries and is empty without an identity', () => {
    const out = accessLine({ ...read, user: '<b>x</b>', role: '<img src=x>', namespaces: ['<s>'] })
    expect(out).not.toMatch(/<b>|<img|<s>/)
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(accessLine(null)).toBe('')
  })

  it('goes under the n-th block name only', () => {
    const block = (n: string) => `<details>\n<summary>🔧 <strong>${n}</strong></summary>\n\n<p>args</p>\n\n</details>\n\n`
    const content = block('a') + block('b')
    expect(withToolAccess(content, 1, '<p>L</p>')).toBe(block('a') + block('b').replace('</summary>\n', '</summary>\n\n<p>L</p>\n'))
    expect(withToolAccess(content, 2, '<p>L</p>')).toBe(content)
    expect(withToolAccess(content, 0, '')).toBe(content)
  })
})

describe('the cluster requests under the 🔐 line', () => {
  const LIST = { source: 'api', verb: 'list', resource: 'pods', namespace: 'shop', status: 200, audit_id: 'kubeast-1', echoed: true }
  const SSAR = { source: 'api', verb: 'create', group: 'authorization.k8s.io', resource: 'selfsubjectaccessreviews', status: 201, audit_id: 'kubeast-2', echoed: true }
  const EXEC = { source: 'api', verb: 'create', resource: 'pods', subresource: 'exec', namespace: 'shop', name: 'web-1', status: 101, audit_id: 'kubeast-3' }
  const CACHE = { source: 'cache', cache: 'cache cluster_overview' }
  const VERSION = { source: 'api', verb: 'get', path: '/version', status: 200, audit_id: 'kubeast-4', echoed: true }

  // The same cases and text as ai-service tests/test_tool_access.py test_requests_block.
  it('lists each request with its Audit-ID, cache answers and the rest as a count', () => {
    expect(requestsBlock({ requests: [LIST, SSAR, EXEC, CACHE, VERSION], total: 7 })).toBe(
      '<details>\n<summary><strong>🧾 Cluster requests (7)</strong></summary>\n\n<ul>\n' +
      '<li>list pods in shop → 200 · Audit-ID <code>kubeast-1</code> ✓</li>\n' +
      '<li>create authorization.k8s.io/selfsubjectaccessreviews → 201 · Audit-ID <code>kubeast-2</code> ✓</li>\n' +
      '<li>create pods/exec web-1 in shop → 101 · Audit-ID <code>kubeast-3</code> (not echoed)</li>\n' +
      "<li>answered from Kubeast's own store (cache cluster_overview), no cluster request</li>\n" +
      '<li>get /version → 200 · Audit-ID <code>kubeast-4</code> ✓</li>\n' +
      '<li>and 2 more</li>\n</ul>\n\n</details>')
    expect(requestsBlock(null)).toBe('')
    expect(requestsBlock({ requests: [], total: 0 })).toBe('')
    expect(requestsBlock({ requests: [{ ...LIST, namespace: '<x>' }], total: 1 })).toContain('&lt;x&gt;')
  })

  it('goes under the 🔐 line, live as in the saved answer', () => {
    const access = { cluster: 'prod', kind: 'person', user: 'a@example.com', groups: ['kubeast:authenticated'], role: 'Read', impersonation: true, mode: 'read' }
    const both = accessSection(access, { requests: [LIST], total: 1 })
    expect(both).toBe(`${accessLine(access)}\n\n${requestsBlock({ requests: [LIST], total: 1 })}`)
    expect(accessSection(null, null)).toBe('')
  })
})
