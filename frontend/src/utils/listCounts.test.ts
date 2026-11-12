import { describe, expect, it } from 'vitest'
import { countsOf, NOT_COUNTED } from './listCounts'

describe('countsOf', () => {
  it('a list that was read keeps its counts', () => {
    const counts = { total: 3, ready: 2 }
    expect(countsOf([{}, {}, {}], counts)).toBe(counts)
  })

  it('an empty list that was read counts zeros', () => {
    expect(countsOf([], { total: 0, ready: 0 })).toEqual({ total: 0, ready: 0 })
  })

  it('a list not read says "-" on every card', () => {
    for (const list of [undefined, null, new Error('Request failed with status code 403'), { detail: 'forbidden' }]) {
      expect(countsOf(list, { total: 0, ready: 0 })).toEqual({ total: NOT_COUNTED, ready: NOT_COUNTED })
    }
    expect(NOT_COUNTED).toBe('-')
  })
})
