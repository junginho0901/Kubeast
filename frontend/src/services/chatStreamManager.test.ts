import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendToolBlock, ChatStreamManager, nthToolBlock, resultTarget, withToolResult } from './chatStreamManager'

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
})
