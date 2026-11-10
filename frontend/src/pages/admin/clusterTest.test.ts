import { describe, expect, it } from 'vitest'

import { healthChecked, testOutcome } from './clusterTest'

describe('what a cluster Test found', () => {
  const at = '2026-11-10T04:20:15Z'

  it('is the version the server read when it connected', () => {
    expect(testOutcome({ healthy: true, server_version: 'v1.35.0', server: 'https://10.0.0.1:6443' }, null, at)).toEqual({ healthy: true, detail: 'v1.35.0', at })
  })

  it("is the server's reason when it could not connect (its field is message)", () => {
    expect(testOutcome({ healthy: false, message: 'connection failed: dial tcp 10.0.0.1:6443: i/o timeout' }, null, at))
      .toEqual({ healthy: false, detail: 'connection failed: dial tcp 10.0.0.1:6443: i/o timeout', at })
  })

  it('is why the request failed when there was no answer to read', () => {
    const refused = { response: { status: 403, data: { detail: 'forbidden: admin.clusters.list required' } }, message: 'Request failed with status code 403' }
    expect(testOutcome(null, refused, at)).toEqual({ healthy: false, detail: 'forbidden: admin.clusters.list required', at })
    expect(testOutcome(null, new Error('Network Error'), at)).toEqual({ healthy: false, detail: 'Network Error', at })
  })

  it('is empty-handed, not wrong, when the server gave nothing more', () => {
    expect(testOutcome({ healthy: false }, null, at).detail).toBe('')
    expect(testOutcome({ healthy: true }, null, at).detail).toBe('')
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
