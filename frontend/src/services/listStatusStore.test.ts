import { beforeEach, describe, expect, it } from 'vitest'
import { getListStatus, recordListStatus, resetListStatus } from './listStatusStore'

// Re-QA #64 and #37: a list that failed or whose kind is not installed must not
// read as "No … found" — the store keeps that per list segment.
describe('listStatusStore', () => {
  beforeEach(() => resetListStatus())

  it('keeps a failure per segment until a later read of it answers', () => {
    recordListStatus({ url: '/cluster/deployments/all?cluster=self', state: 'error', code: 503 })
    expect(getListStatus('deployments')).toEqual({ state: 'error', code: 503 })
    expect(getListStatus('pods')).toBeUndefined()
    recordListStatus({ url: '/cluster/namespaces/web/deployments', state: 'ok' })
    expect(getListStatus('deployments')).toBeUndefined()
  })

  it('marks a kind the cluster does not serve', () => {
    recordListStatus({ url: '/cluster/namespaces/default/httproutes', state: 'notInstalled' })
    expect(getListStatus('httproutes')).toEqual({ state: 'notInstalled' })
  })

  it('a network failure has no status code', () => {
    recordListStatus({ url: '/cluster/vpas/all', state: 'error' })
    expect(getListStatus('vpas')).toEqual({ state: 'error', code: undefined })
  })

  it('resets with the page', () => {
    recordListStatus({ url: '/cluster/pods/all', state: 'error', code: 500 })
    resetListStatus()
    expect(getListStatus('pods')).toBeUndefined()
  })
})
