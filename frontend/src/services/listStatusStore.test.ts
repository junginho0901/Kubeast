import { beforeEach, describe, expect, it } from 'vitest'
import { getListStatus, isKindServed, recordListForbidden, recordListStatus, resetListStatus } from './listStatusStore'

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

  // A CRD-backed page's create button waits for the list's first answer: before it, a cluster without the CRD
  // would show the button until the list said "not installed".
  it('serves a kind only once its list answered without "not installed"', () => {
    expect(isKindServed('gateways')).toBe(false)
    recordListStatus({ url: '/cluster/gateways/all', state: 'notInstalled' })
    expect(isKindServed('gateways')).toBe(false)
    recordListStatus({ url: '/cluster/namespaces/web/httproutes', state: 'ok' })
    expect(isKindServed('httproutes')).toBe(true)
    recordListStatus({ url: '/cluster/vpas/all', state: 'error', code: 503 })
    expect(isKindServed('vpas')).toBe(true)
    recordListForbidden('/cluster/namespaces/web/grpcroutes')
    expect(isKindServed('grpcroutes')).toBe(true)
    resetListStatus()
    expect(['gateways', 'httproutes', 'vpas', 'grpcroutes'].map(isKindServed)).toEqual([false, false, false, false])
  })

  it('resets with the page', () => {
    recordListStatus({ url: '/cluster/pods/all', state: 'error', code: 500 })
    resetListStatus()
    expect(getListStatus('pods')).toBeUndefined()
  })
})
