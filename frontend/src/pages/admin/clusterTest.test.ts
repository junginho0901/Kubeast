import { describe, expect, it } from 'vitest'

import { shownTest } from './clusterTest'

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
