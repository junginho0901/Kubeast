import { describe, expect, it } from 'vitest'
import { customRoleGroup, isBuiltinRole, roleEditEndsSessions, roleGroupSlug, sameGroupRefusal, takenRoleName, takesBuiltinSlug } from './roleGroup'
import SLUG_CASES from './roleGroupSlug.cases.json'

// auth.RoleGroupSlug and the database's role_group_slug run the same table (TestRoleGroupSlugCases,
// TestPostgresRoleNamesOneGroupEach), so the role form refuses what the server and the database refuse.
describe('roleGroupSlug', () => {
  it.each(SLUG_CASES.cases)('$name makes $slug', ({ name, slug }) => {
    expect(roleGroupSlug(name)).toBe(slug)
  })
})

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
  it('maps Read, Write and Admin and their names in other capitals to no custom group', () => {
    for (const r of ['Read', 'write', 'ADMIN', ' Admin ', 'PENDING', '', null, undefined]) {
      expect(customRoleGroup(r)).toBeNull()
    }
    // the built-in Member is no fixed group: a grant of it acts as kubeast:role:member, as impersonation.go has it
    expect(customRoleGroup('Member')).toBe('kubeast:role:member')
  })

  // impersonation.go IsBuiltinRole / TakesBuiltinSlug (TestImpersonation_RoleNamesOfTheBuiltInsInOtherForms)
  it('knows a built-in by its exact name only', () => {
    for (const r of ['Admin', 'Write', 'Read', 'Member', 'Pending']) {
      expect(isBuiltinRole(r)).toBe(true)
      expect(takesBuiltinSlug(r)).toBe(false)
    }
    for (const r of ['ADMIN', 'admin', ' Admin ', 'WRITE', 'write', ' read ', 'PENDING']) {
      expect(isBuiltinRole(r)).toBe(false)
      expect(takesBuiltinSlug(r)).toBe(true)
    }
    for (const r of ['sre-oncall', 'admin-2', '', null]) expect(takesBuiltinSlug(r)).toBe(false)
  })

  it("reads auth-service's role_same_group refusal", () => {
    const err = { response: { data: { code: 'role_same_group', role: 'ADMIN', same_group_as: 'Admin', detail: 'x' } } }
    expect(sameGroupRefusal(err)).toEqual({ role: 'ADMIN', other: 'Admin' })
    expect(sameGroupRefusal({ response: { data: { detail: 'other' } } })).toBeNull()
    expect(sameGroupRefusal(null)).toBeNull()
  })

  it('slugs a custom role the way impersonation.go does', () => {
    expect(customRoleGroup('sre-readonly')).toBe('kubeast:role:sre-readonly')
    expect(customRoleGroup('Infra Manager')).toBe('kubeast:role:infra-manager')
    expect(roleGroupSlug('dev_team.v2')).toBe('dev_team.v2')
    expect(roleGroupSlug('개발자 A')).toBe('~ac1c~bc1c~c790-a')
    expect(roleGroupSlug('a/b:c')).toBe('a-b-c')
    // a lone surrogate reaches Go as U+FFFD (encoding/json), so the form shows the group the server makes
    expect(roleGroupSlug('a\ud800b')).toBe(roleGroupSlug('a\ufffdb'))
  })

  // Korean and other names outside ASCII: two names share a group only when they differ in A-Z letter case, spaces or
  // punctuation, and no ASCII name makes the group of one of them.
  it('gives names outside ASCII a group of their own', () => {
    expect(customRoleGroup('운영팀')).toBe('kubeast:role:~c6b4~c601~d300')
    expect(roleGroupSlug('운영팀')).not.toBe(roleGroupSlug('개발팀'))
    expect(roleGroupSlug('운영 팀')).toBe(roleGroupSlug('운영-팀'))
    expect(roleGroupSlug('OPS팀')).toBe(roleGroupSlug('ops팀'))
    for (const ascii of ['~c6b4~c601~d300', 'uc6b4uc601ud300', '-c6b4-c601-d300']) {
      expect(roleGroupSlug(ascii)).not.toBe(roleGroupSlug('운영팀'))
    }
    const roles = [{ id: 1, name: '운영팀', is_system: false }]
    expect(takenRoleName('개발팀', roles)).toBeNull()
    expect(takenRoleName('운영 팀', roles)).toBeNull()
    expect(takenRoleName('운영팀 ', roles)).toEqual({ role: '운영팀', builtin: false, sameName: true })
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
    // " read " is Read in other capitals, not its name: the server answers same_name false for it too
    expect(takenRoleName(' read ', roles)).toEqual({ role: 'Read', builtin: true, sameName: false })
    expect(takenRoleName('Read ', roles)).toEqual({ role: 'Read', builtin: true, sameName: true })
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
