import { describe, expect, it } from 'vitest'
import { replicaSetOwner } from './replicaSetHelpers'

describe('ReplicaSet Owner column', () => {
  it('names a Deployment owner by its name, another controller as kind/name, none as "-"', () => {
    expect(replicaSetOwner({ owner_deployment: 'web', owner_references: [{ kind: 'Deployment', name: 'web', controller: true }] })).toBe('web')
    expect(replicaSetOwner({ owner_deployment: '', owner_references: [{ kind: 'Rollout', name: 'web', controller: true }] })).toBe('Rollout/web')
    // the controller reference first, whatever order the references come in
    expect(replicaSetOwner({ owner_references: [{ kind: 'ConfigMap', name: 'cm' }, { kind: 'Rollout', name: 'api', controller: true }] })).toBe('Rollout/api')
    expect(replicaSetOwner({ owner_deployment: '', owner_references: [] })).toBe('-')
    // a row without references (an older server) keeps the name it has
    expect(replicaSetOwner({ owner_deployment: 'web' })).toBe('web')
  })
})
