import { describe, expect, it } from 'vitest'

import { sectionsAnswered } from './accountReady'

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
