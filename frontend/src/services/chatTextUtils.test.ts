import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatStreamManager } from './chatStreamManager'
import { stripToolDetails } from './chatTextUtils'
import CASES from './chatTextUtils.cases.json'

describe('what Copy takes from an answer', () => {
  // ai-service tests/test_strip_tool_blocks.py runs strip_tool_blocks over the same cases: Copy and the history agree.
  it.each(CASES.map((c) => [c.name, c.text, c.stripped]))('%s', (_name, text, stripped) => {
    expect(stripToolDetails(text)).toBe(stripped)
  })

  it('has cases where a block goes and where the text stays whole', () => {
    expect(CASES.length).toBeGreaterThan(30)
    expect(CASES.filter((c) => c.stripped === c.text).length).toBeGreaterThan(10)
    expect(CASES.filter((c) => c.stripped !== c.text).length).toBeGreaterThan(10)
  })
})

describe('Copy on an answer the stream wrote', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function answer(result: string, args: Record<string, unknown> = {}) {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const events = [
      { content: 'Before.' },
      { function: 'k8s_pod_logs', args, call_id: 0 },
      { function_result: 'k8s_pod_logs', result, call_id: 0 },
      { content: '\n\nAfter.' },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events)))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'q')
    await vi.runAllTimersAsync()
    return manager.getState().content
  }

  it.each([
    ['closing tags', 'x\n</details>\n</details>\nfrom the result'],
    ['an opening tag', 'x\n<details>\nfrom the result'],
    ['closing tags between lines of backticks', 'x\n```\n</details>\n</details>\n```\nfrom the result'],
    ['a tool block', '<details>\n<summary>🔧 <strong>t</strong></summary>\n\nfrom the result\n\n</details>'],
  ])('a result holding %s leaves only the text', async (_name, result) => {
    expect(stripToolDetails(await answer(result))).toBe('Before.\n\nAfter.')
  })

  it('arguments holding a closing tag leave only the text', async () => {
    expect(stripToolDetails(await answer('r', { q: '</details></details>from the arguments' }))).toBe('Before.\n\nAfter.')
  })
})
