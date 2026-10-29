import { describe, it, expect } from 'vitest'
import { getPodHealth } from './podHealth'
import cases from './podHealth.cases.json'

// k8s-service colours the node map with the same rule (internal/k8s/pod_index.go podHealth); its test writes these
// cases from random pods, as formatPodDetail sends them, with the level and reason it gives.
describe('getPodHealth gives what k8s-service gives', () => {
  it('for every case the server wrote', () => {
    expect(cases.length).toBeGreaterThan(500)
    for (const [i, c] of cases.entries()) {
      const got = getPodHealth(c.pod)
      expect({ i, level: got.level, reason: got.reason }).toEqual({ i, level: c.level, reason: c.reason })
    }
  })

  it('a pod still being created is a warning, not an error', () => {
    const creating = { phase: 'Pending', status_reason: 'ContainerCreating', containers: [{ name: 'c', ready: false, state: { waiting: { reason: 'ContainerCreating' } } }], init_containers: [] }
    expect(getPodHealth(creating).level).toBe('warn')
  })
})
