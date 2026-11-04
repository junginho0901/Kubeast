import { describe, expect, it } from 'vitest'
import { referencedByContext, referencingBindings, subjectsText } from './referencedBy'

const pad = (i: number) => String(i).padStart(2, '0')
// a binding as the list API answers it
const listed = (namespace: string, name: string, kind: string, role: string) => ({
  name, namespace, role_ref_kind: kind, role_ref_name: role, subjects_count: 1,
  subjects: [{ kind: 'User', name: `u-${name}`, namespace: '' }],
})

describe('referencingBindings', () => {
  // 35 in team, 25 in team-b, written out of order, plus a RoleBinding of a Role of the same name and one of
  // another ClusterRole, and one as a watch event carries it
  const items = [
    ...Array.from({ length: 35 }, (_, i) => listed('team', `rb-${pad(34 - i)}`, 'ClusterRole', 'view')),
    listed('team', 'rb-role', 'Role', 'view'),
    listed('team', 'rb-edit', 'ClusterRole', 'edit'),
    ...Array.from({ length: 24 }, (_, i) => listed('team-b', `rb-${pad(i)}`, 'ClusterRole', 'view')),
    { metadata: { name: 'rb-watched', namespace: 'team-b' }, roleRef: { kind: 'ClusterRole', name: 'view' }, subjects: [{ kind: 'Group', name: 'g' }] },
  ]

  it('keeps every binding of the ClusterRole, none of a Role of its name, in the API order', () => {
    const got = referencingBindings(items, 'ClusterRole', 'view')
    expect(got).toHaveLength(60)
    // by namespace/name in byte order, as the API lists them: "team-b/" sorts before "team/"
    const keys = got.map((b) => `${b.namespace}/${b.name}`)
    expect(keys.slice(0, 2)).toEqual(['team-b/rb-00', 'team-b/rb-01'])
    expect(keys[24]).toBe('team-b/rb-watched')
    expect(keys[25]).toBe('team/rb-00')
    expect(keys[59]).toBe('team/rb-34')
    expect(keys).not.toContain('team/rb-role')
    expect(keys).not.toContain('team/rb-edit')
  })

  it('keeps the Role path to the Role', () => {
    expect(referencingBindings(items, 'Role', 'view').map((b) => b.name)).toEqual(['rb-role'])
  })
})

describe('subjectsText', () => {
  it('writes Kind/name, or "-"', () => {
    expect(subjectsText([])).toBe('-')
    expect(subjectsText([{ kind: 'User', name: 'a' }, { kind: 'ServiceAccount', name: 'b', namespace: 'ns' }, { name: 'c' }])).toBe('User/a, ServiceAccount/b, ?/c')
  })
})

describe('referencedByContext', () => {
  const bindings = (n: number, ns: string) => referencingBindings(Array.from({ length: n }, (_, i) => listed(ns, `b-${pad(i)}`, 'ClusterRole', 'r')), 'ClusterRole', 'r')

  it('gives the AI every row of both sections and their counts', () => {
    const ctx = referencedByContext({ bindings: bindings(55, '') }, { bindings: bindings(57, 'team') }, null)
    expect(ctx.referenced_by_cluster_role_bindings_count).toBe(55)
    expect(ctx.referenced_by_cluster_role_bindings).toHaveLength(55)
    expect(ctx.referenced_by_role_bindings_count).toBe(57)
    expect(ctx.referenced_by_role_bindings).toHaveLength(57)
    expect((ctx.referenced_by_role_bindings as unknown[])[56]).toEqual({ namespace: 'team', name: 'b-56', subjects: 'User/u-b-56' })
    expect(ctx).not.toHaveProperty('role_bindings_in_other_namespaces')
  })

  it('says the other namespaces are not known for a namespace-scoped grant, and no count for a list it could not read', () => {
    const ctx = referencedByContext({ bindings: [], error: 'Request failed with status code 403' }, { bindings: bindings(2, 'team') }, ['team', 'web'])
    expect(ctx.referenced_by_cluster_role_bindings_count).toBeNull()
    expect(ctx.referenced_by_cluster_role_bindings_error).toBe('Request failed with status code 403')
    expect(ctx.referenced_by_role_bindings_count).toBe(2)
    expect(ctx.role_bindings_read_in_namespaces).toEqual(['team', 'web'])
    expect(ctx.role_bindings_in_other_namespaces).toBe('unknown')
  })
})
