import { describe, expect, it } from 'vitest'

import { limitRangeViolationsLayer, limitRangeViolationsSummary, violatingPodCount } from './limitRangeViolations'

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

// The floating chat is told what the window shows: the pods, the rows and the rows' cells, and how many of them it was sent.
describe('limitRangeViolationsLayer', () => {
  const row = (pod: string, field = 'cpu max') => ({ pod, namespace: 'ns', container: 'c', field, actual: '2', limit: '1' })

  it('gives the pod count, the row count and each row with a link to its pod', () => {
    expect(limitRangeViolationsLayer([row('a'), row('a', 'memory max'), row('b')])).toEqual({
      violating_pods: 2,
      violation_rows: 3,
      violations_shown: 3,
      violations: [
        { pod: 'a', container: 'c', field: 'cpu max', actual: '2', limit: '1', _link: 'kubest://pod?ns=ns&name=a' },
        { pod: 'a', container: 'c', field: 'memory max', actual: '2', limit: '1', _link: 'kubest://pod?ns=ns&name=a' },
        { pod: 'b', container: 'c', field: 'cpu max', actual: '2', limit: '1', _link: 'kubest://pod?ns=ns&name=b' },
      ],
    })
  })

  it('says how many rows it sends of how many when the list is long', () => {
    const got = limitRangeViolationsLayer(Array.from({ length: 35 }, (_, i) => row(`p-${i}`)))
    expect(got).toMatchObject({ violating_pods: 35, violation_rows: 35, violations_shown: 20 })
    expect(got?.violations).toHaveLength(20)
  })

  it('says none once the list has answered empty', () => {
    expect(limitRangeViolationsLayer([])).toEqual({ violating_pods: 0, violation_rows: 0, violations_shown: 0, violations: [] })
  })

  it('claims nothing before the list has answered', () => {
    expect(limitRangeViolationsLayer(undefined)).toBeUndefined()
  })
})

describe('limitRangeViolationsSummary', () => {
  const row = (pod: string, field = 'cpu max') => ({ pod, namespace: 'ns', container: 'c', field, actual: '2', limit: '1' })

  it('names the pods and rows, with a warning when there are any', () => {
    expect(limitRangeViolationsSummary('caps', 'ns', [row('a'), row('a', 'memory max')])).toBe('⚠️ LimitRange caps (ns) 상세 — 위반 Pod 1개, 위반 행 2개')
  })

  it('says none once the list has answered empty', () => {
    expect(limitRangeViolationsSummary('caps', 'ns', [])).toBe('LimitRange caps (ns) 상세 — 위반 Pod 0개')
  })

  it('claims nothing before the list has answered', () => {
    expect(limitRangeViolationsSummary('caps', 'ns', undefined)).toBe('LimitRange caps (ns) 상세')
  })
})
