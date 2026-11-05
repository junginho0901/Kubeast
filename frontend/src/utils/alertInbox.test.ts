import { describe, expect, it } from 'vitest'
import { alertResource, liveLineOf, liveStateOf, severityChoices, silenceStart } from './alertInbox'

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

describe('the alert window\'s "Alertmanager now" line', () => {
  const firing = { status: 'firing' as const, fingerprint: 'a' }
  const listed = (n: number) => Array.from({ length: n }, (_, i) => ({ fingerprint: `x${i}`, state: 'firing' }))
  const read = (answer?: { alerts: { fingerprint: string; state: string }[]; total: number; truncated: boolean }, extra: { on?: boolean; failed?: boolean } = {}) =>
    ({ on: true, failed: false, answer, ...extra })

  it('says what the store says when it knows', () => {
    expect(liveLineOf(firing, read({ alerts: [{ fingerprint: 'a', state: 'silenced' }], total: 1, truncated: false }))).toEqual({ state: 'silenced' })
    expect(liveLineOf(firing, read({ alerts: [], total: 0, truncated: false }))).toEqual({ state: 'absent' })
    // found in a cut list: known
    expect(liveLineOf(firing, read({ alerts: [{ fingerprint: 'a', state: 'firing' }, ...listed(99)], total: 105, truncated: true }))).toEqual({ state: 'firing' })
  })

  it('tells a cut list, no answer yet, a failed answer and no store apart', () => {
    expect(liveLineOf(firing, read({ alerts: listed(100), total: 105, truncated: true }))).toEqual({ unknown: 'cut', listed: 100, total: 105 })
    expect(liveLineOf(firing, read(undefined))).toEqual({ unknown: 'loading' })
    expect(liveLineOf(firing, read(undefined, { failed: true }))).toEqual({ unknown: 'failed' })
    expect(liveLineOf(firing, read(undefined, { on: false }))).toEqual({ unknown: 'none' })
    expect(liveLineOf({ ...firing, status: 'resolved' }, read(undefined, { on: false }))).toBeNull()
  })
})

describe('the severity filter', () => {
  it('offers every severity the alerts carry after the usual three, and keeps the one chosen', () => {
    expect(severityChoices(undefined, '')).toEqual(['critical', 'warning', 'info'])
    expect(severityChoices(['error', 'info', 'none'], '')).toEqual(['critical', 'warning', 'info', 'error', 'none'])
    expect(severityChoices([], 'page')).toEqual(['critical', 'warning', 'info', 'page'])
  })
})

describe('where a silence of an alert starts', () => {
  it('takes the name, the namespace and the object, never the cluster label', () => {
    expect(silenceStart({ alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'cart-1', container: 'app', cluster: 'eks-alpha', severity: 'warning' }))
      .toEqual({ alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'cart-1' })
    expect(silenceStart({ alertname: 'NodeDiskFull', node: 'n1', k8s_cluster: 'eks' }, 'k8s_cluster')).toEqual({ alertname: 'NodeDiskFull', node: 'n1' })
    expect(silenceStart({ alertname: 'Watchdog' })).toEqual({ alertname: 'Watchdog' })
    expect(silenceStart({ alertname: 'X', namespace: 'apps' }, 'namespace')).toEqual({ alertname: 'X' }) // a store whose cluster label is namespace
  })
})
