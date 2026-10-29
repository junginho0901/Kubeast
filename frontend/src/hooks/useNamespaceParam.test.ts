import { describe, expect, it } from 'vitest'

import { withNamespace } from './useNamespaceParam'

describe('the list namespace in the address', () => {
  it('sets, replaces and drops ?namespace= and keeps the other parameters', () => {
    const at = new URLSearchParams('cluster=self&detail=Pod/kube-system/coredns-1')
    expect(withNamespace(at, 'kube-system').toString()).toBe('cluster=self&detail=Pod%2Fkube-system%2Fcoredns-1&namespace=kube-system')
    const chosen = new URLSearchParams('cluster=self&namespace=kube-system')
    expect(withNamespace(chosen, 'default').get('namespace')).toBe('default')
    expect(withNamespace(chosen, 'all').toString()).toBe('cluster=self')
    expect(withNamespace(chosen, '').has('namespace')).toBe(false)
    // an updater gets the namespace now in the address, 'all' when none
    expect(withNamespace(chosen, (prev) => `${prev}-x`).get('namespace')).toBe('kube-system-x')
    expect(withNamespace(new URLSearchParams(), (prev) => prev).has('namespace')).toBe(false)
    // the address the page was opened with is left as it was
    expect(chosen.get('namespace')).toBe('kube-system')
  })
})
