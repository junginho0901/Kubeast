import { describe, expect, it } from 'vitest'
import { aiEnabled } from './features'

describe('aiEnabled', () => {
  it('is off only when the server says so', () => {
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: false } })).toBe(false)
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: true } })).toBe(true)
    expect(aiEnabled({ prometheus: { enabled: false } })).toBe(true)
    expect(aiEnabled(undefined)).toBe(true)
  })
})
