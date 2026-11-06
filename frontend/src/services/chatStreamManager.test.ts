import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendToolBlock, ChatStreamManager, resultTarget, withToolAccess, withToolResult } from './chatStreamManager'
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

})

describe('one answer in the order it came', () => {
  const block = (n: string) => `<details>\n<summary>🔧 <strong>${n}</strong></summary>\n\nExecuting...\n\n</details>\n\n`

  it('puts a tool block on its own line below the text so far', () => {
    expect(appendToolBlock('', block('a'))).toBe(block('a'))
    expect(appendToolBlock('Checking.', block('a'))).toBe('Checking.\n\n' + block('a'))
    expect(appendToolBlock('Checking. \n', block('a'))).toBe('Checking.\n\n' + block('a'))
    expect(appendToolBlock(block('a'), block('b'))).toBe(block('a').trimEnd() + '\n\n' + block('b'))
  })

  it('fills the block at a position with its result and leaves the text around it', () => {
    const content = 'First.\n\n' + block('a') + 'Then.\n\n' + block('a') + 'Executing... is a word here.'
    const second = ('First.\n\n' + block('a') + 'Then.\n\n').length
    const filled = withToolResult(content, second, '```\nsecond\n```')
    expect(filled).toBe('First.\n\n' + block('a') + 'Then.\n\n' + block('a').replace('Executing...', '```\nsecond\n```')
      + 'Executing... is a word here.')
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

  // The same text as ai-service tests/test_tool_result_fence.py: the saved answer and the live one must match.
  it.each([
    ['no backticks', 'pod-a Running', '```\npod-a Running\n```'],
    ['one or two backticks', 'a `b` ``c``', '```\na `b` ``c``\n```'],
    ['a line of three', 'a\n```\nb', '````\na\n```\nb\n````'],
    ['a line of five, and three', 'a\n`````\nb\n```\nc', '``````\na\n`````\nb\n```\nc\n``````'],
    ['a line of three, indented', 'a\n   ```\nb', '````\na\n   ```\nb\n````'],
    ['three in the middle of a line', 'a ``` b', '````\na ``` b\n````'],
  ])('a code block outlasts the backticks in its result: %s', async (_name, result, block) => {
    const state = await run([{ function: 'k8s_pod_logs', args: {}, call_id: 0 }, { function_result: 'k8s_pod_logs', result, call_id: 0 }, '[DONE]'])
    expect(state.content).toContain(`<summary><strong>📊 Results</strong></summary>\n\n${block}\n\n</details>`)
  })

  it('a longer code block keeps its language', async () => {
    const json = await run([{ function: 't', args: {}, call_id: 0 }, { function_result: 't', result: '```', is_json: true, call_id: 0 }, '[DONE]'])
    expect(json.content).toContain('````json\n```\n````')
    const yaml = await run([{ function: 't', args: {}, call_id: 0 }, { function_result: 't', result: '```', is_yaml: true, call_id: 0 }, '[DONE]'])
    expect(yaml.content).toContain('````yaml\n```\n````')
    const display = await run([{ function: 't', args: {}, call_id: 0 }, { function_result: 't', result: '{}', is_json: true, display: 'a\n```\nb', call_id: 0 }, '[DONE]'])
    expect(display.content).toContain('````\na\n```\nb\n````')
  })

  it('a result is put in word for word, whatever dollar signs it holds', async () => {
    const result = "cost $' and $` and $& and $$ and $1"
    const state = await run([{ function: 't', args: { a: 1 }, call_id: 0 }, { function_result: 't', result, call_id: 0 }, { content: 'After.' }, '[DONE]'])
    expect(state.content).toContain(`\`\`\`\n${result}\n\`\`\`\n\n</details>`)
    expect(state.content.split('📋 Arguments').length - 1).toBe(1)
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

describe('how an answer ends', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

  async function ended(response: Response | (() => Response)) {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async () => (typeof response === 'function' ? response() : response)))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'how many?')
    await vi.runAllTimersAsync()
    return manager.getState()
  }

  it('an answer that ends with [DONE] is complete, with no error', async () => {
    const state = await ended(new Response(sse({ content: 'Two clusters.' }, '[DONE]')))
    expect(state).toMatchObject({ status: 'completed', isStreaming: false, content: 'Two clusters.', error: null, errorKey: null, streamingPhase: null })
  })

  it('a [DONE] on the last line without its line end is still the end', async () => {
    const state = await ended(new Response(`${sse({ content: 'Two clusters.' })}data: [DONE]`))
    expect(state).toMatchObject({ status: 'completed', content: 'Two clusters.', error: null })
  })

  it('a refused request is an error that says the status and the reason', async () => {
    const state = await ended(new Response('{"detail":"audit unavailable"}', { status: 503 }))
    expect(state).toMatchObject({
      status: 'error',
      isStreaming: false,
      streamingPhase: null,
      content: '',
      userMessage: 'how many?',
      error: 'HTTP 503: audit unavailable',
      errorKey: 'streamHttp',
      errorArgs: { status: 503, detail: 'audit unavailable' },
    })
  })

  it.each([
    ['a page from a proxy', '<html><body>Bad Gateway</body></html>', 502],
    ['no body', '', 500],
    ['a detail that is no sentence', '{"detail":[{"loc":["body"],"msg":"x"}]}', 422],
  ])('a refused request with %s says the status alone', async (_name, body, status) => {
    const state = await ended(new Response(body, { status }))
    expect(state).toMatchObject({ status: 'error', error: `HTTP ${status}`, errorKey: 'streamHttpStatus', errorArgs: { status } })
  })

  it('a long reason is cut', async () => {
    const state = await ended(new Response(JSON.stringify({ detail: 'x'.repeat(5000) }), { status: 500 }))
    expect(state.errorArgs).toEqual({ status: 500, detail: 'x'.repeat(300) })
  })

  it('a stream that closes without [DONE] is an error and keeps every letter it brought', async () => {
    const state = await ended(new Response(sse({ content: 'partial ' }, { content: 'answer' })))
    expect(state).toMatchObject({ status: 'error', isStreaming: false, streamingPhase: null, content: 'partial answer', userMessage: 'how many?', errorKey: 'streamCut' })
    expect(state.error).toContain('before the answer finished')
  })

  it('a stream that closes while a tool runs keeps the block', async () => {
    const state = await ended(new Response(sse({ content: 'Checking.' }, { function: 'list_clusters', args: {}, call_id: 0 })))
    expect(state).toMatchObject({ status: 'error', errorKey: 'streamCut' })
    expect(state.content.startsWith('Checking.\n\n<details>')).toBe(true)
    expect(state.content).toContain('<strong>list_clusters</strong>')
    expect(state.toolCalls.map((tc) => tc.function)).toEqual(['list_clusters'])
  })

  it.each([
    ['an empty body', ''],
    ['only the model and usage lines', sse({ model_info: { provider: 'p', model: 'm' } }, { usage: { total_tokens: 1 } })],
    ['a line that is no event', 'hello\n\n'],
    ['half an event', 'data: {"content":"par'],
    ['a sign-in page answered with 200', '<!doctype html><html></html>'],
  ])('a 200 with %s is an error, not an empty answer', async (_name, body) => {
    const state = await ended(new Response(body))
    expect(state).toMatchObject({ status: 'error', isStreaming: false, content: '', errorKey: 'streamEmpty' })
    expect(state.error).toContain('without an answer')
  })

  it("a server's refusal keeps its own text and the letters before it", async () => {
    const state = await ended(new Response(sse({ content: 'Checking.' }, { error: 'AI model call failed', error_key: 'modelCall', error_args: { provider: 'p', detail: 'd' } }, '[DONE]')))
    expect(state).toMatchObject({ status: 'error', content: 'Checking.', error: 'AI model call failed', errorKey: 'modelCall', errorArgs: { provider: 'p', detail: 'd' } })
  })

  it('a connection that breaks part way keeps the letters', async () => {
    let reads = 0
    const state = await ended(new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(sse({ content: 'partial' })))
        else controller.error(new TypeError('network error'))
      },
    })))
    expect(state).toMatchObject({ status: 'error', isStreaming: false, content: 'partial', error: 'TypeError: network error', errorKey: null })
  })

  it('a stopped answer stays stopped, with no error, also when the stream ends right after', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ content: 'part of it' })))
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    }))))
    const manager = new ChatStreamManager({ bodyJson: true })
    const running = manager.startSessionChat('s1', 'how many?')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.getState().status).toBe('streaming')
    await manager.stop()
    await running
    await vi.runAllTimersAsync()
    expect(manager.getState()).toMatchObject({ status: 'aborted', isStreaming: false, content: 'part of it', error: null, errorKey: null })
  })

  it('a refusal whose body is still coming when the answer is stopped stays stopped', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    }), { status: 503 })))
    const manager = new ChatStreamManager({ bodyJson: true })
    const running = manager.startSessionChat('s1', 'how many?')
    await vi.advanceTimersByTimeAsync(0)
    await manager.stop()
    await running
    expect(manager.getState()).toMatchObject({ status: 'aborted', isStreaming: false, error: null })
  })

  it('the next question starts clean after a failed one', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const answers = [new Response('{"detail":"audit unavailable"}', { status: 503 }), new Response(sse({ content: 'Two clusters.' }, '[DONE]'))]
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift()))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'how many?')
    await vi.runAllTimersAsync()
    expect(manager.getState().status).toBe('error')
    await manager.startSessionChat('s1', 'and now?')
    await vi.runAllTimersAsync()
    expect(manager.getState()).toMatchObject({ status: 'completed', content: 'Two clusters.', userMessage: 'and now?', error: null, errorKey: null, errorArgs: null })
  })
})

describe('each tool result and 🔐 line goes to its own block', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const access = { cluster: 'self', kind: 'person', user: 'a@example.test', groups: [], role: 'Read', impersonation: true, mode: 'read' }
  const line = accessLine(access)
  const HEAD = '<summary>🔧 <strong>written</strong></summary>\n'

  async function run(events: unknown[]) {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const body = [...events, '[DONE]'].map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'q')
    await vi.runAllTimersAsync()
    return manager.getState().content
  }

  // the block of a tool as the stream fills it, from its name to its closing tag
  const blockOf = (content: string, name: string) => {
    const start = content.indexOf(`<details>\n<summary>🔧 <strong>${name}</strong>`)
    expect(start).not.toBe(-1)
    return content.slice(start, content.indexOf('</details>\n\n</details>', start))
  }

  it("a tool's name in an earlier result does not take the next call's 🔐 line", async () => {
    const earlier = `a log line\n${HEAD}another line`
    const c = await run([
      { function: 'first', args: {}, call_id: 0 },
      { function_result: 'first', result: earlier, call_id: 0 },
      { function: 'second', args: {}, call_id: 1 },
      { function_result: 'second', result: 'its result', call_id: 1, access },
    ])
    expect(blockOf(c, 'first')).toContain(`\`\`\`\n${earlier}\n\`\`\``)
    expect(blockOf(c, 'first')).not.toContain('🔐')
    expect(blockOf(c, 'second')).toContain(`<summary>🔧 <strong>second</strong></summary>\n\n${line}\n`)
    expect(blockOf(c, 'second')).toContain('```\nits result\n```')
    expect(c).not.toContain('Executing...')
  })

  it("a tool's name in the answer's own text does not take the first call's 🔐 line", async () => {
    const text = `Looking for ${HEAD}in the logs.`
    const c = await run([
      { content: text },
      { function: 'first', args: {}, call_id: 0 },
      { function_result: 'first', result: 'its result', call_id: 0, access },
    ])
    expect(c.startsWith(`${text}\n\n<details>`)).toBe(true)
    expect(blockOf(c, 'first')).toContain(`<summary>🔧 <strong>first</strong></summary>\n\n${line}\n`)
    expect(c.split('🔐').length - 1).toBe(1)
  })

  it("the answer's text after a call does not move the later blocks", async () => {
    const c = await run([
      { function: 'first', args: {}, call_id: 0 },
      { content: `Then ${HEAD}more.` },
      { function: 'second', args: {}, call_id: 1 },
      { function_result: 'second', result: `second result ${HEAD}`, call_id: 1, access },
      { function_result: 'first', result: `first result ${HEAD}`, call_id: 0, access: { ...access, user: 'b@example.test' } },
    ])
    expect(blockOf(c, 'first')).toContain('<code>b@example.test</code>')
    expect(blockOf(c, 'first')).toContain(`first result ${HEAD}`)
    expect(blockOf(c, 'second')).toContain('<code>a@example.test</code>')
    expect(blockOf(c, 'second')).toContain(`second result ${HEAD}`)
    expect(c.split('🔐').length - 1).toBe(2)
    expect(c).not.toContain('Executing...')
  })

  it('a result for no call leaves the answer alone', async () => {
    const c = await run([{ content: 'Text.' }, { function_result: 'nothing', result: 'x', access }])
    expect(c).toBe('Text.')
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

  it('goes under the name of the block at a position only', () => {
    const block = (n: string) => `<details>\n<summary>🔧 <strong>${n}</strong></summary>\n\n<p>args</p>\n\n</details>\n\n`
    const content = block('a') + block('b')
    expect(withToolAccess(content, block('a').length, '<p>L</p>')).toBe(block('a') + block('b').replace('</summary>\n', '</summary>\n\n<p>L</p>\n'))
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
