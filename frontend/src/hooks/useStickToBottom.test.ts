import { describe, expect, it } from 'vitest'
import { distanceFromBottom, isNearBottom } from './useStickToBottom'

describe('useStickToBottom: who is at the bottom', () => {
  it('measures the gap under the view and counts a short reach as the bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 })).toBe(0)
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 })).toBe(true)
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1320, clientHeight: 600 })).toBe(true)   // 80 px up: still following
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1319, clientHeight: 600 })).toBe(false)  // further up: the reader left
  })

  it('treats a list shorter than its box as at the bottom', () => {
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 })).toBe(true)
  })
})
