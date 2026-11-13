import { describe, expect, it } from 'vitest'

import { mcpRead, sectionsAnswered } from './accountReady'

const read = (fetched: boolean, failures = 0, asked = true) => ({ asked, fetched, failures })

describe('the Settings sections that appear once the server answers', () => {
  it('wait for every read, so the sections below move once at most', () => {
    expect(sectionsAnswered([read(false), read(true)])).toBe(false)
    expect(sectionsAnswered([read(true), read(false)])).toBe(false)
    expect(sectionsAnswered([read(true), read(true)])).toBe(true)
  })

  it('do not wait for a read that is not asked (the AI service turned off)', () => {
    expect(sectionsAnswered([read(true), read(false, 0, false)])).toBe(true)
  })

  it('do not wait on a read that failed once and is being tried again', () => {
    expect(sectionsAnswered([read(true), read(false, 1)])).toBe(true)
  })
})

describe('the API key card asking ai-service about MCP', () => {
  it('waits while only the features placeholder is there, which says nothing of AI', () => {
    expect(mcpRead({ prometheus: { enabled: true } }, true)).toBe('wait')
  })

  it('does not ask when the features say AI is off, and says so instead', () => {
    expect(mcpRead({ prometheus: { enabled: true }, ai: { enabled: false } }, false)).toBe('aiOff')
  })

  it('asks when AI is on, or when the server does not say (an older server, a features read that failed)', () => {
    expect(mcpRead({ prometheus: { enabled: true }, ai: { enabled: true } }, false)).toBe('ask')
    expect(mcpRead({ prometheus: { enabled: true } }, false)).toBe('ask')
    expect(mcpRead(undefined, false)).toBe('ask')
  })
})
