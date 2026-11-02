import { describe, expect, it } from 'vitest'
import { NODE_READINESS, nodeCordoned, nodeReadiness, nodeStatusBadge, nodeStatusParts } from './nodeStatus'

// The statuses kubectl's printNode writes (and k8s-service's formatNodeSummary with it).
const CASES: [status: string, readiness: string, cordoned: boolean][] = [
  ['Ready', 'Ready', false],
  ['NotReady', 'NotReady', false],
  ['Unknown', 'Unknown', false],
  ['Ready,SchedulingDisabled', 'Ready', true],
  ['NotReady,SchedulingDisabled', 'NotReady', true],
  ['Unknown,SchedulingDisabled', 'Unknown', true],
]

describe('node status', () => {
  it('reads the readiness and the cordon from every status kubectl writes', () => {
    for (const [status, readiness, cordoned] of CASES) {
      expect(nodeReadiness(status), status).toBe(readiness)
      expect(nodeCordoned(status), status).toBe(cordoned)
    }
    expect(nodeReadiness('')).toBe('Unknown')
    expect(nodeReadiness(undefined)).toBe('Unknown')
  })

  it('puts every node in exactly one readiness, so the bars add up to the nodes', () => {
    const counts = NODE_READINESS.map((r) => CASES.filter(([s]) => nodeReadiness(s) === r).length)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(CASES.length)
    expect(counts).toEqual([2, 2, 2])
  })

  it('draws each part as the Nodes list does', () => {
    expect(nodeStatusParts('Ready,SchedulingDisabled').map(nodeStatusBadge)).toEqual(['badge-success', 'badge-warning'])
    expect(nodeStatusParts('NotReady').map(nodeStatusBadge)).toEqual(['badge-error'])
    expect(nodeStatusParts('Unknown,SchedulingDisabled').map(nodeStatusBadge)).toEqual(['badge-error', 'badge-warning'])
  })
})
