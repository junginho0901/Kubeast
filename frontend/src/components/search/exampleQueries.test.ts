import jsep from 'jsep'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_QUERIES } from './exampleQueries'
import { searchWithExpression } from './searchEngine'

// Each example, searched over two objects of its kind as the page searches a read: the one its description names is
// found, the other is not, and the expression is read and computed (no `unreadable`).
const SAMPLES: Record<string, { kind: string; matches: Record<string, unknown>; misses: Record<string, unknown> }> = {
  podsNotRunning: { kind: 'Pod', matches: { status: { phase: 'Pending' } }, misses: { status: { phase: 'Running' } } },
  labelApp: { kind: 'Service', matches: { metadata: { labels: { app: 'nginx' } } }, misses: { metadata: { labels: { app: 'web' } } } },
  replicasOver3: { kind: 'Deployment', matches: { spec: { replicas: 5 } }, misses: { spec: { replicas: 3 } } },
  restartsOver5: {
    kind: 'Pod',
    matches: { status: { phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 6 }] } },
    misses: { status: { phase: 'Running', containerStatuses: [{ name: 'app', restartCount: 2 }] } },
  },
  configMapWithData: { kind: 'ConfigMap', matches: { data: { 'app.conf': 'port=80' } }, misses: {} },
  completedJobs: {
    kind: 'Job',
    matches: {
      spec: { suspend: false, completions: 3 },
      status: {
        succeeded: 3, completionTime: '2026-11-18T01:00:00Z',
        conditions: [{ type: 'SuccessCriteriaMet', status: 'True' }, { type: 'Complete', status: 'True' }],
      },
    },
    // still running: one of its three completions done, two pods active
    misses: { spec: { suspend: false, completions: 3 }, status: { succeeded: 1, active: 2 } },
  },
  loadBalancerServices: { kind: 'Service', matches: { spec: { type: 'LoadBalancer' } }, misses: { spec: { type: 'ClusterIP' } } },
  pendingPvcs: { kind: 'PersistentVolumeClaim', matches: { status: { phase: 'Pending' } }, misses: { status: { phase: 'Bound' } } },
}

const object = (kind: string, name: string, fields: Record<string, unknown>) => {
  const { metadata, ...rest } = fields as { metadata?: Record<string, unknown> }
  return { kind, metadata: { name, namespace: 'shop', ...metadata }, ...rest }
}

describe('the example queries', () => {
  it('each have two sample objects', () => {
    expect(EXAMPLE_QUERIES.map((ex) => ex.key).sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  for (const ex of EXAMPLE_QUERIES) {
    it(`${ex.key}: ${ex.query} finds what it says, and is read and computed`, async () => {
      expect(() => jsep(ex.query)).not.toThrow()
      const { kind, matches, misses } = SAMPLES[ex.key]
      const found = object(kind, 'found', matches)
      const passed = object(kind, 'passed', misses)
      const searched = await searchWithExpression([found, passed], ex.query, { current: false })
      expect(searched.unreadable).toBeUndefined()
      expect(searched.results).toEqual([found])
    })
  }
})
