import { describe, expect, it } from 'vitest'
import { applyHelmWatchEvent, helmStreamFrame } from './useHelmWatchList'
import type { HelmReleaseSummary } from './api'
import { clearWatchProblem, getWatchProblem, recordWatchFrame } from './watchProblemStore'

describe('what the Helm releases stream tells the watch problem notice', () => {
  const key = 'c\n/api/v1/helm/releases/stream?cluster=c'
  // as k8s-service's helm_watch.go writes it (helmLimitFrame)
  const limit = '{"limit_scope":"server","message":"max subscriptions reached for the server, cannot create new watch","reason":"limit"}'

  it('says the server\'s limit as a socket\'s refusal does, and clears it once the stream follows', () => {
    recordWatchFrame(key, helmStreamFrame('error', limit)!)
    expect(getWatchProblem()).toBe('server_limit')
    recordWatchFrame(key, helmStreamFrame('following', '{}')!)
    expect(getWatchProblem()).toBeUndefined()
  })

  it('leaves a start failure, plain text, to the log', () => {
    expect(helmStreamFrame('error', 'kubeconfig not loaded')).toBeUndefined()
    expect(helmStreamFrame('error', undefined)).toBeUndefined()
    clearWatchProblem(key)
  })
})

const rel = (name: string, revision: number, status = 'deployed'): HelmReleaseSummary => ({
  name, namespace: 'apps', revision, status, chart: 'web', chartVersion: '1.0.0', appVersion: '1.0', updated: '2026-11-02T00:00:00Z',
})

describe('applyHelmWatchEvent — each revision is its own Secret', () => {
  const shown = [rel('web', 12), rel('api', 3)]

  it('keeps a release when an older revision is pruned (--history-max)', () => {
    expect(applyHelmWatchEvent(shown, { type: 'DELETED', object: rel('web', 2, 'superseded') })).toEqual(shown)
  })

  it('removes a release when the revision on screen is deleted (uninstall)', () => {
    expect(applyHelmWatchEvent(shown, { type: 'DELETED', object: rel('web', 12) })).toEqual([rel('api', 3)])
  })

  it('takes a newer revision and leaves an older one', () => {
    expect(applyHelmWatchEvent(shown, { type: 'ADDED', object: rel('web', 13, 'pending-upgrade') })[0]).toEqual(rel('web', 13, 'pending-upgrade'))
    expect(applyHelmWatchEvent(shown, { type: 'MODIFIED', object: rel('web', 11, 'superseded') })).toEqual(shown)
  })

  it('adds a release it has not seen', () => {
    expect(applyHelmWatchEvent(shown, { type: 'ADDED', object: rel('db', 1) })).toEqual([...shown, rel('db', 1)])
  })
})
