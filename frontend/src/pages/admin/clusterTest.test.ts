import { describe, expect, it } from 'vitest'

import { healthChecked, shownTest } from './clusterTest'

describe('a cluster Test result in the Health column', () => {
  const held = { healthy: true, server_version: 'v1.35.0', listAt: 1000 }

  it('stands for the list answer read right after the test', () => {
    expect(shownTest(held, 1000)).toBe(held)
  })

  it('gives way to the server health once a newer answer comes', () => {
    expect(shownTest(held, 2000)).toBeNull()
  })

  it('is nothing before a test', () => {
    expect(shownTest(undefined, 1000)).toBeNull()
  })
})

describe('when a cluster\'s health was last checked', () => {
  it('reads the time the server answered, with the UTC value on hover', () => {
    const got = healthChecked('2026-11-07T02:30:15Z')
    expect(got?.text).toMatch(/^2026-11-0[67] \d{2}:\d{2}:15$/)
    expect(got?.title).toContain('2026-11-07T02:30:15')
  })

  it('is nothing for a cluster never checked', () => {
    expect(healthChecked(undefined)).toBeNull()
    expect(healthChecked('')).toBeNull()
  })
})
