import { describe, expect, it } from 'vitest'
import { leaseHolderState, webhookAffected } from './clusterDetail'

// The rules as describe sends them (snake keys, formatWebhookRules): the drawer used to read apiGroups and counted
// every resource in the core group, so one resource name in two groups was one kind.
describe('webhookAffected', () => {
  it('pairs each rule\'s groups with its resources, the core group as ""', () => {
    const got = webhookAffected([
      { rules: [{ api_groups: ['apps', 'extensions'], resources: ['deployments'], operations: ['CREATE', 'UPDATE'] }] },
      { rules: [{ api_groups: [''], resources: ['pods', 'pods/exec'], operations: ['CONNECT'] }, { api_groups: ['apps'], resources: ['deployments'], operations: ['UPDATE'] }] },
    ])
    expect(got).toEqual({
      resources: ['""/pods', '""/pods/exec', 'apps/deployments', 'extensions/deployments'],
      operations: ['CONNECT', 'CREATE', 'UPDATE'],
    })
  })

  it('counts nothing for a configuration without webhooks or rules', () => {
    expect(webhookAffected([])).toEqual({ resources: [], operations: [] })
    expect(webhookAffected([{ rules: null }, {}])).toEqual({ resources: [], operations: [] })
  })

  it('reads a rule without groups as the core group', () => {
    expect(webhookAffected([{ rules: [{ api_groups: [], resources: ['configmaps'], operations: ['*'] }] }]).resources).toEqual(['""/configmaps'])
  })
})

// isLeaseExpired (kubernetes release-1.37, apiserverleasegc and leaderelection): no renew time or duration is expired,
// else expired when renewTime + duration is before now
describe('leaseHolderState', () => {
  const now = Date.parse('2026-11-04T07:00:00Z')
  const held = { holder_identity: 'node-a', renew_time: '2026-11-04T06:59:30Z', lease_duration_seconds: 40 }

  it('is Active while the holder renewed it within its duration, the last second included', () => {
    expect(leaseHolderState(held, now)).toBe('Active')
    expect(leaseHolderState({ ...held, renew_time: '2026-11-04T06:59:20Z' }, now)).toBe('Active')
  })

  it('is Expired once renewTime + duration is past, and without a renew time or duration', () => {
    expect(leaseHolderState({ ...held, renew_time: '2026-11-04T06:59:19Z' }, now)).toBe('Expired')
    expect(leaseHolderState({ ...held, renew_time: undefined }, now)).toBe('Expired')
    expect(leaseHolderState({ ...held, lease_duration_seconds: null }, now)).toBe('Expired')
  })

  it('is None without a holder, also an emptied one (a released lease)', () => {
    expect(leaseHolderState({ ...held, holder_identity: undefined }, now)).toBe('None')
    expect(leaseHolderState({ ...held, holder_identity: '' }, now)).toBe('None')
  })
})
