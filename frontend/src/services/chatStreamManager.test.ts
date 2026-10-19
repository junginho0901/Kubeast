import { describe, expect, it } from 'vitest'
import { nthToolBlock, resultTarget } from './chatStreamManager'

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
