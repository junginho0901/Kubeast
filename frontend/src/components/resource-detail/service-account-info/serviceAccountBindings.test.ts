import { describe, expect, it } from 'vitest'
import { serviceAccountBindings } from './useEffectivePermissions'

const pad = (i: number) => String(i).padStart(2, '0')
const sa = (name: string, namespace?: string) => ({ kind: 'ServiceAccount', name, namespace })

describe('serviceAccountBindings', () => {
  it('keeps every RoleBinding and ClusterRoleBinding of the ServiceAccount, RoleBindings first', () => {
    const rbs = [
      ...Array.from({ length: 55 }, (_, i) => ({ name: `rb-${pad(i)}`, namespace: 'team', role_ref_kind: 'Role', role_ref_name: 'r', subjects: [{ kind: 'User', name: 'u' }, sa('bot', 'team')] })),
      // the same name in another namespace, and a subject without a namespace (the binding's)
      { name: 'rb-other', namespace: 'team', role_ref_kind: 'Role', role_ref_name: 'r', subjects: [sa('bot', 'web')] },
      { name: 'rb-implicit', namespace: 'team', role_ref_kind: 'ClusterRole', role_ref_name: 'view', subjects: [sa('bot')] },
    ]
    const crbs = [
      ...Array.from({ length: 3 }, (_, i) => ({ name: `crb-${i}`, role_ref_kind: 'ClusterRole', role_ref_name: 'view', subjects: [sa('bot', 'team')] })),
      { metadata: { name: 'crb-watched' }, roleRef: { kind: 'ClusterRole', name: 'edit' }, subjects: [sa('bot', 'team')] },
      { name: 'crb-group', role_ref_kind: 'ClusterRole', role_ref_name: 'view', subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }] },
    ]
    const got = serviceAccountBindings(rbs, crbs, 'team', 'bot')
    expect(got).toHaveLength(60)
    expect(got.slice(0, 2).map((b) => b.name)).toEqual(['rb-00', 'rb-01'])
    expect(got.slice(54).map((b) => `${b.kind}/${b.name}`)).toEqual([
      'RoleBinding/rb-54', 'RoleBinding/rb-implicit', 'ClusterRoleBinding/crb-0', 'ClusterRoleBinding/crb-1', 'ClusterRoleBinding/crb-2', 'ClusterRoleBinding/crb-watched',
    ])
  })
})
