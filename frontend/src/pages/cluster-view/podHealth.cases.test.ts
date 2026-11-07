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

  describe('a pod that finished with a sidecar', () => {
    const finished = (side: Record<string, unknown>, app: Record<string, unknown> = { state: { terminated: { reason: 'Completed', exit_code: 0 } } }) => {
      const got = getPodHealth({ phase: 'Succeeded', containers: [{ name: 'app', ...app }], init_containers: [{ name: 'side', started: false, ...side }] })
      return `${got.level} ${got.reason}`
    }
    const sidecar = { restart_policy: 'Always' }

    it('is fine with its sidecar ended on SIGTERM', () => {
      expect(finished({ ...sidecar, state: { terminated: { reason: 'Error', exit_code: 143 } } })).toBe('ok Succeeded')
    })

    it('is fine with its sidecar killed after its grace period', () => {
      expect(finished({ ...sidecar, state: { terminated: { reason: 'Error', exit_code: 137 } } })).toBe('ok Succeeded')
    })

    it('is fine with its sidecar crashing when the containers ended', () => {
      expect(finished({ ...sidecar, state: { waiting: { reason: 'CrashLoopBackOff' } } })).toBe('ok Succeeded')
    })

    it('stays an error when a plain init container failed', () => {
      expect(finished({ state: { terminated: { reason: 'Error', exit_code: 1 } } })).toBe('error Error')
    })

    it('stays an error when its own container says it failed', () => {
      expect(finished({ ...sidecar, state: { terminated: { reason: 'Completed', exit_code: 0 } } }, { state: { terminated: { reason: 'Error', exit_code: 1 } } })).toBe('error Error')
    })
  })

  describe('a pod with a sidecar', () => {
    const health = (side: Record<string, unknown>, app: Record<string, unknown> = { ready: true, state: { running: {} } }) => {
      const got = getPodHealth({ phase: 'Running', containers: [{ name: 'app', ...app }], init_containers: [{ name: 'side', ...side }] })
      return `${got.level} ${got.reason}`
    }
    const sidecar = { restart_policy: 'Always' }

    it('is fine with its sidecar up and ready and its container running', () => {
      expect(health({ ...sidecar, started: true, ready: true, state: { running: {} } })).toBe('ok Running')
    })

    it('warns with its sidecar up but not ready, as READY 1/2 says', () => {
      expect(health({ ...sidecar, started: true, ready: false, state: { running: {} } })).toBe('warn NotReady')
    })

    it('warns with its container not ready beside a ready sidecar', () => {
      expect(health({ ...sidecar, started: true, ready: true, state: { running: {} } }, { ready: false, state: { running: {} } })).toBe('warn NotReady')
    })

    it('is still initializing while its sidecar has not started', () => {
      expect(health({ ...sidecar, started: false, ready: false, state: { running: {} } })).toBe('warn PodInitializing')
      expect(health({ ...sidecar, ready: false, state: { running: {} } })).toBe('warn PodInitializing')
    })

    it('is an error while its sidecar crashes', () => {
      expect(health({ ...sidecar, started: false, ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } })).toBe('error CrashLoopBackOff')
    })

    it('warns with no status of its sidecar yet', () => {
      expect(health(sidecar)).toBe('warn NotReady')
    })

    it('tells a plain init container still running from a sidecar', () => {
      expect(health({ started: true, ready: true, state: { running: {} } })).toBe('warn PodInitializing')
    })
  })
})
