import { describe, expect, it } from 'vitest'
import { replicaSetOwner, replicaSetToWorkloadRawJson } from './replicaSetHelpers'
import { normalizeWatchReplicaSetObject } from './replicaSetWatchNormalize'

// A list row carries no labels, so what its window starts from cannot say the ReplicaSet has none.
describe('a ReplicaSet opened from its row', () => {
  const row = { name: 'web-1', namespace: 'ns', replicas: 1, current_replicas: 1, ready_replicas: 1, available_replicas: 1, image: 'x', selector: {}, created_at: '', status: 'Healthy' }

  it('says nothing of labels the row did not bring', () => {
    expect(replicaSetToWorkloadRawJson(row).metadata).not.toHaveProperty('labels')
    expect(normalizeWatchReplicaSetObject({ metadata: { name: 'web-1', namespace: 'ns' }, spec: {}, status: {} })).not.toHaveProperty('labels.app')
    expect(normalizeWatchReplicaSetObject({ metadata: { name: 'web-1', namespace: 'ns' }, spec: {}, status: {} }).labels).toBeUndefined()
  })

  it('keeps labels a raw object brought', () => {
    expect(normalizeWatchReplicaSetObject({ metadata: { name: 'web-1', namespace: 'ns', labels: { app: 'web' } }, spec: {}, status: {} }).labels).toEqual({ app: 'web' })
    expect(replicaSetToWorkloadRawJson({ ...row, labels: { app: 'web' } }).metadata).toHaveProperty('labels', { app: 'web' })
  })
})

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
