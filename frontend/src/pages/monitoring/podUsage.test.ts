import { describe, expect, it } from 'vitest'
import { usageTone } from './podUsage'

describe('usageTone', () => {
  it('colours from 60% and 80% of the limit, and not without one', () => {
    expect(usageTone(null)).toBe('text-white')
    expect(usageTone(59.9)).toBe('text-white')
    expect(usageTone(60)).toBe('text-yellow-400')
    expect(usageTone(80)).toBe('text-red-400')
  })
})
