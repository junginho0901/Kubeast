import { describe, expect, it } from 'vitest'
import { customRoleGroup, roleGroupSlug } from './roleGroup'

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
