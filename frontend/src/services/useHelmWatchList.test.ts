import { describe, expect, it } from 'vitest'
import { applyHelmWatchEvent } from './useHelmWatchList'
import type { HelmReleaseSummary } from './api'

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
