import { describe, expect, it } from 'vitest'
import { instanceListFrom } from './custom_resources'

const row = { name: 'w1', namespace: 'web', kind: 'Widget', group: 'a.example.com', version: 'v1', scope: 'Namespaced', crd_name: 'widgets.a.example.com' }

describe('the custom resource instances answer', () => {
  it('reads a k8s-service from before (the instances alone) as the items, nothing named', () => {
    expect(instanceListFrom([row])).toEqual({ items: [row] })
    expect(instanceListFrom([])).toEqual({ items: [] })
  })

  it('keeps the answer with the kinds it could not list as it came', () => {
    const answer = { items: [row], forbidden_kinds: ['GuardCheck'], failed_kinds: [{ kind: 'Thing', code: 500, error: 'boom' }] }
    expect(instanceListFrom(answer)).toEqual(answer)
  })
})
