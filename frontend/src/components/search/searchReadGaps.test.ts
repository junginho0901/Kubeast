import { describe, expect, it } from 'vitest'
import { searchReadGaps, searchReadGapsText } from './searchReadGaps'

// Advanced Search's toolbar says "N failed" (each type's reason on hover) and "the first N only"; the floating chat was
// told the results as if every object had been read. It is told the same gaps beside the results.

describe('what a read of Advanced Search left out, told to the floating chat', () => {
  it('nothing for a whole read, so the results stand as complete', () => {
    expect(searchReadGaps({ errors: [], cut: [] })).toEqual({})
    expect(searchReadGaps(undefined)).toEqual({})
    expect(searchReadGapsText({ errors: [], cut: [] })).toBe('')
  })

  it('the types that failed, with the reason the notice shows and how many came before a list stopped', () => {
    const read = { errors: [{ type: 'secrets', error: 'secrets is forbidden' }, { type: 'pods', error: 'etcdserver: request timed out', loaded: 500 }], cut: [] }
    expect(searchReadGaps(read)).toEqual({
      complete: false,
      failed_types: [{ type: 'secrets', reason: 'secrets is forbidden' }, { type: 'pods', reason: 'etcdserver: request timed out', read_before_failure: 500 }],
      cut_types: undefined,
    })
    expect(searchReadGapsText(read)).toBe(' · 2개 종류 실패: secrets, pods')
  })

  it('the types cut at the limit, as the first N of how many when the server counted them', () => {
    const read = { errors: [], cut: [{ type: 'pods', limit: 10_000, remaining: 2_500 }, { type: 'events', limit: 10_000 }] }
    expect(searchReadGaps(read)).toEqual({
      complete: false,
      failed_types: undefined,
      cut_types: [{ type: 'pods', first: 10_000, of: 12_500 }, { type: 'events', first: 10_000 }],
    })
    expect(searchReadGapsText(read)).toBe(' · 처음 10000개만 읽은 종류: pods, events')
  })

  it('both at once', () => {
    const read = { errors: [{ type: 'secrets', error: 'secrets is forbidden' }], cut: [{ type: 'pods', limit: 100, remaining: 1 }] }
    expect(searchReadGaps(read)).toMatchObject({ complete: false, failed_types: [{ type: 'secrets' }], cut_types: [{ type: 'pods', first: 100, of: 101 }] })
    expect(searchReadGapsText(read)).toBe(' · 1개 종류 실패: secrets · 처음 100개만 읽은 종류: pods')
  })
})
