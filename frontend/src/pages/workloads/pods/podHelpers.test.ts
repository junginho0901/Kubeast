import { describe, expect, it } from 'vitest'

import { runningNotReady } from './podHelpers'

// The Pods list keeps kubectl's STATUS (Running) for a pod whose containers are not all ready and draws it yellow
// with the ready count on hover (10-31; it read NotReady before).
describe('runningNotReady', () => {
  it('is a Running pod with fewer ready containers than it has', () => {
    expect(runningNotReady({ status: 'Running', ready: '0/1' })).toBe(true)
    expect(runningNotReady({ status: 'Running', ready: '1/2' })).toBe(true)
  })

  it('is not a ready pod, another status, or a pod without containers counted', () => {
    expect(runningNotReady({ status: 'Running', ready: '2/2' })).toBe(false)
    expect(runningNotReady({ status: 'CrashLoopBackOff', ready: '0/1' })).toBe(false)
    expect(runningNotReady({ status: 'Pending', ready: '0/1' })).toBe(false)
    expect(runningNotReady({ status: 'Running', ready: '0/0' })).toBe(false)
    expect(runningNotReady({ status: 'Running', ready: null })).toBe(false)
  })
})
