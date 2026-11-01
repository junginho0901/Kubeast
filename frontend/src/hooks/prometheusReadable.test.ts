import { describe, expect, it } from 'vitest'
import type { ClusterFeatures } from '@/services/api'
import { prometheusReadable } from './usePrometheusQuery'

describe('prometheusReadable', () => {
  it('asks while the toggle is on and the grant covers the whole cluster', () => {
    expect(prometheusReadable({ prometheus: { enabled: true } } as ClusterFeatures)).toBe(true)
    // an older server without the flag, or features not loaded yet: as before
    expect(prometheusReadable(undefined)).toBe(true)
  })

  it('does not ask for a grant limited to namespaces, nor with the toggle off', () => {
    expect(prometheusReadable({ prometheus: { enabled: true, namespaceLimited: true } } as ClusterFeatures)).toBe(false)
    expect(prometheusReadable({ prometheus: { enabled: false } } as ClusterFeatures)).toBe(false)
  })
})
