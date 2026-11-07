import { describe, expect, it } from 'vitest'

import { violatingPodCount } from './limitRangeViolations'

// The server lists one row per container and field, so one pod can fill several; the window's "Violating Pods" counts pods.
describe('violatingPodCount', () => {
  const row = (pod: string, container: string, field: string) => ({ pod, namespace: 'ns', container, field, actual: '2', limit: '1' })

  it('counts a pod once however many rows it has', () => {
    expect(violatingPodCount([row('a', 'c1', 'cpu max'), row('a', 'c1', 'memory max'), row('a', 'c2', 'cpu max'), row('b', 'c1', 'cpu max')])).toBe(2)
  })

  it('is zero with no rows', () => {
    expect(violatingPodCount([])).toBe(0)
  })

  it('is the rows when each is a pod of its own', () => {
    expect(violatingPodCount([row('a', 'c', 'cpu max'), row('b', 'c', 'cpu max'), row('c', 'c', 'cpu max')])).toBe(3)
  })
})
