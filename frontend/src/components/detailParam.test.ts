import { describe, expect, it } from 'vitest'
import { apiParam, fromParam, keyOf, toParam } from './detailParam'

const widget = {
  kind: 'CustomResourceInstance',
  namespace: 'e2e-numbers',
  name: 'num-w1',
  rawJson: { kind: 'Widget', group: 'numbers.kubeast.io', version: 'v1', crd_name: 'widgets.numbers.kubeast.io', scope: 'Namespaced' },
}

describe('detailParam', () => {
  it('names a custom resource instance by its Kind and the resource that serves it', () => {
    expect(toParam(widget)).toBe('Widget/e2e-numbers/num-w1')
    expect(apiParam(widget)).toBe('numbers.kubeast.io/v1/widgets')
  })

  it('opens the same custom resource from the link', () => {
    const t = fromParam('Widget/e2e-numbers/num-w1', 'numbers.kubeast.io/v1/widgets')
    expect(t).toEqual({
      kind: 'CustomResourceInstance',
      namespace: 'e2e-numbers',
      name: 'num-w1',
      rawJson: { kind: 'Widget', group: 'numbers.kubeast.io', version: 'v1', crd_name: 'widgets.numbers.kubeast.io' },
    })
    expect(keyOf(t)).toBe(keyOf(widget))
    // a cluster-scoped one
    expect(fromParam('Gadget/g1', 'numbers.kubeast.io/v1/gadgets')).toEqual({
      kind: 'CustomResourceInstance', name: 'g1',
      rawJson: { kind: 'Gadget', group: 'numbers.kubeast.io', version: 'v1', crd_name: 'gadgets.numbers.kubeast.io' },
    })
  })

  it('keeps every other drawer as it was', () => {
    const pod = { kind: 'Pod', namespace: 'kube-system', name: 'coredns-1' }
    expect([toParam(pod), apiParam(pod)]).toEqual(['Pod/kube-system/coredns-1', ''])
    expect(fromParam('Pod/kube-system/coredns-1', null)).toEqual(pod)
    expect(fromParam('BackendTLSPolicy/web/tls', null)).toEqual({ kind: 'BackendTLSPolicy', namespace: 'web', name: 'tls' })
    expect(fromParam('Widget/web/w', 'numbers.kubeast.io/v1')).toEqual({ kind: 'Widget', namespace: 'web', name: 'w', apiVersion: 'numbers.kubeast.io/v1' })
    // a custom resource opened without its CRD (nothing to name it by) stays as before
    const bare = { kind: 'CustomResourceInstance', name: 'w', namespace: 'web', rawJson: { kind: 'Widget' } }
    expect([toParam(bare), apiParam(bare)]).toEqual(['CustomResourceInstance/web/w', ''])
    expect(keyOf(null)).toBe('|')
  })

  it('refuses a malformed link', () => {
    expect(fromParam('Pod', null)).toBeNull()
    expect(fromParam('Pod/a/b/c', null)).toBeNull()
    expect(fromParam('1Pod/a', null)).toBeNull()
    expect(fromParam(null, 'numbers.kubeast.io/v1/widgets')).toBeNull()
  })
})
