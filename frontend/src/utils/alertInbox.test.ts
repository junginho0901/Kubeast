import { describe, expect, it } from 'vitest'
import { alertResource, liveStateOf } from './alertInbox'

describe('the object an alert is about', () => {
  it('takes the most specific namespaced label first', () => {
    expect(alertResource({ namespace: 'apps', pod: 'api-1', deployment: 'api', node: 'n1' })).toEqual({ kind: 'Pod', namespace: 'apps', name: 'api-1' })
    expect(alertResource({ namespace: 'apps', deployment: 'api', service: 'kube-state-metrics' })).toEqual({ kind: 'Deployment', namespace: 'apps', name: 'api' })
    expect(alertResource({ namespace: 'batch', job_name: 'nightly' })).toEqual({ kind: 'Job', namespace: 'batch', name: 'nightly' })
  })

  it('a node or volume alert opens the cluster-scoped object; without a match there is nothing to open', () => {
    expect(alertResource({ node: 'n1', instance: '10.0.0.1:9100' })).toEqual({ kind: 'Node', name: 'n1' })
    expect(alertResource({ pod: 'api-1' })).toBeNull() // a pod name without its namespace is not enough
    expect(alertResource({ namespace: 'apps', service: 'api' })).toBeNull()
    expect(alertResource({ alertname: 'Watchdog' })).toBeNull()
  })
})

describe('what the alert store says now', () => {
  const firing = { status: 'firing' as const, fingerprint: 'a' }
  const store = (alerts: { fingerprint: string; state: string }[], truncated = false) => ({ alerts, truncated })

  it('matches the inbox alert by fingerprint', () => {
    expect(liveStateOf(firing, store([{ fingerprint: 'a', state: 'firing' }]))).toBe('firing')
    expect(liveStateOf(firing, store([{ fingerprint: 'a', state: 'silenced' }]))).toBe('silenced')
    expect(liveStateOf(firing, store([{ fingerprint: 'a', state: 'inhibited' }]))).toBe('inhibited')
    expect(liveStateOf({ ...firing, status: 'stale' }, store([]))).toBe('absent')
  })

  it('says nothing without a store, for a resolved alert, or when the list was cut short', () => {
    expect(liveStateOf(firing, undefined)).toBeNull()
    expect(liveStateOf({ ...firing, status: 'resolved' }, store([]))).toBeNull()
    expect(liveStateOf(firing, store([{ fingerprint: 'b', state: 'firing' }], true))).toBeNull()
  })
})
