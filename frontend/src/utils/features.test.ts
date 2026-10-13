import { describe, expect, it } from 'vitest'
import { aiEnabled, costEnabled } from './features'

describe('aiEnabled', () => {
  it('is off only when the server says so', () => {
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: false } })).toBe(false)
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: true } })).toBe(true)
    expect(aiEnabled({ prometheus: { enabled: false } })).toBe(true)
    expect(aiEnabled(undefined)).toBe(true)
  })
})

describe('costEnabled', () => {
  it('is on only when the server says so (an older server has no cost API)', () => {
    expect(costEnabled({ prometheus: { enabled: false }, cost: { enabled: true } })).toBe(true)
    expect(costEnabled({ prometheus: { enabled: false }, cost: { enabled: false } })).toBe(false)
    expect(costEnabled({ prometheus: { enabled: false } })).toBe(false)
    expect(costEnabled(undefined)).toBe(false)
  })
})
