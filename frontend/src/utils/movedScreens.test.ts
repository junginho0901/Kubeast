import { describe, expect, it } from 'vitest'
import { movedAddress, MOVED_SCREENS } from './movedScreens'

describe('the addresses of screens that moved', () => {
  it('a bookmark of Node Shell lands on its card on the Account page', () => {
    expect(movedAddress(MOVED_SCREENS.nodeShell.to, '', '')).toBe('/account#node-shell')
  })

  it('a bookmark of Cluster Hygiene lands on the Cluster Hygiene page', () => {
    expect(movedAddress(MOVED_SCREENS.clusterHygiene.to, '', '')).toBe('/cluster/hygiene')
  })

  it('the cluster and an open drawer in the address go along', () => {
    expect(movedAddress(MOVED_SCREENS.clusterHygiene.to, '?cluster=self&detail=Pod%2Fa%2Fb', '')).toBe('/cluster/hygiene?cluster=self&detail=Pod%2Fa%2Fb')
    expect(movedAddress(MOVED_SCREENS.nodeShell.to, '?cluster=self', '')).toBe('/account?cluster=self#node-shell')
  })

  it('a section the old address named stays, where the new one names none', () => {
    expect(movedAddress(MOVED_SCREENS.clusterHygiene.to, '?cluster=self', '#findings')).toBe('/cluster/hygiene?cluster=self#findings')
    expect(movedAddress(MOVED_SCREENS.nodeShell.to, '', '#other')).toBe('/account#node-shell')
  })

  it('names the old addresses the router answers', () => {
    expect(MOVED_SCREENS.nodeShell.from).toBe('admin/node-shell')
    expect(MOVED_SCREENS.clusterHygiene.from).toBe('admin/cluster-hygiene')
  })
})
