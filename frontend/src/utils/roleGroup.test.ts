import { describe, expect, it } from 'vitest'
import { customRoleGroup, roleEditEndsSessions, roleGroupSlug, takenRoleName } from './roleGroup'

// auth-service tokensEndedBy: only what a token held and no longer may ends a session.
describe('roleEditEndsSessions', () => {
  const role = { name: 'sre ops', permissions: ['resource.*.read', 'resource.pod.exec'] }

  it('a permission taken away ends them', () => {
    expect(roleEditEndsSessions(role, 'sre ops', ['resource.*.read'])).toBe(true)
    expect(roleEditEndsSessions(role, 'sre ops', [])).toBe(true)
  })

  it('a name that makes another group ends them', () => {
    expect(roleEditEndsSessions(role, 'sre-other', role.permissions)).toBe(true)
  })

  it('adding a permission, the same permissions and the description end nothing', () => {
    expect(roleEditEndsSessions(role, 'sre ops', [...role.permissions, 'resource.node.cordon'])).toBe(false)
    expect(roleEditEndsSessions(role, 'sre ops', role.permissions)).toBe(false)
  })

  it('a name of the same group ends nothing', () => {
    expect(roleEditEndsSessions(role, 'SRE-OPS', role.permissions)).toBe(false)
    expect(roleEditEndsSessions(role, ' sre ops ', role.permissions)).toBe(false)
  })

  it('a permission a wider one still covers is not taken away', () => {
    expect(roleEditEndsSessions(role, 'sre ops', ['resource.*.read', 'resource.pod.*'])).toBe(false)
    expect(roleEditEndsSessions({ name: 'r', permissions: ['resource.*.*'] }, 'r', ['resource.*.read'])).toBe(true)
  })

  it('a role with no permissions read yet has none to take away', () => {
    expect(roleEditEndsSessions({ name: 'r' }, 'r', [])).toBe(false)
  })
})

describe('roleGroup', () => {
  it('maps built-in roles to no custom group, case-insensitively', () => {
    for (const r of ['Read', 'write', 'ADMIN', ' Admin ', '', null, undefined]) {
      expect(customRoleGroup(r)).toBeNull()
    }
  })

  it('slugs a custom role the way impersonation.go does', () => {
    expect(customRoleGroup('sre-readonly')).toBe('kubeast:role:sre-readonly')
    expect(customRoleGroup('Infra Manager')).toBe('kubeast:role:infra-manager')
    expect(roleGroupSlug('dev_team.v2')).toBe('dev_team.v2')
    expect(roleGroupSlug('개발자 A')).toBe('----a')
    expect(roleGroupSlug('a/b:c')).toBe('a-b-c')
  })
})

// auth-service roleNameConflict (TestNewRoleNameCannotShareAKubernetesGroup, TestRoleRenameCannotShareAKubernetesGroup).
describe('takenRoleName', () => {
  const roles = [
    { id: 1, name: 'Member', is_system: true },
    { id: 3, name: 'Read', is_system: true },
    { id: 5, name: 'Admin', is_system: true },
    { id: 7, name: 'custom', is_system: false },
    { id: 8, name: 'ADMIN', is_system: false },
    { id: 15, name: 'a b', is_system: false },
  ]

  it('a built-in in other capitals or with spaces is taken by the built-in', () => {
    expect(takenRoleName('admin', roles)).toEqual({ role: 'Admin', builtin: true, sameName: false })
    expect(takenRoleName(' read ', roles)).toEqual({ role: 'Read', builtin: true, sameName: true })
    expect(takenRoleName('MEMBER', roles)).toEqual({ role: 'Member', builtin: true, sameName: false })
  })

  it('another role of the same group takes it, the same name too', () => {
    expect(takenRoleName('custom', roles)).toEqual({ role: 'custom', builtin: false, sameName: true })
    expect(takenRoleName('A!B', roles)).toEqual({ role: 'a b', builtin: false, sameName: false })
  })

  it('a free name, an empty one and a name of its own group are not taken', () => {
    expect(takenRoleName('admin-2', roles)).toBeNull()
    expect(takenRoleName('   ', roles)).toBeNull()
    expect(takenRoleName('CUSTOM', roles, { id: 7, name: 'custom' })).toBeNull()
  })

  it('a stored name sent back as the form sends it stays usable, another form of it does not', () => {
    expect(takenRoleName('ADMIN', roles, { id: 8, name: 'ADMIN' })).toBeNull()
    expect(takenRoleName('admin', roles, { id: 8, name: 'ADMIN' })).toEqual({ role: 'Admin', builtin: true, sameName: false })
  })
})
