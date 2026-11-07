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
      { name: 'crb-group', role_ref_kind: 'ClusterRole', role_ref_name: 'view', subjects: [{ kind: 'Group', name: 'system:authenticated' }] },
    ]
    const got = serviceAccountBindings(rbs, crbs, 'team', 'bot')
    expect(got).toHaveLength(60)
    expect(got.slice(0, 2).map((b) => b.name)).toEqual(['rb-00', 'rb-01'])
    expect(got.slice(54).map((b) => `${b.kind}/${b.name}`)).toEqual([
      'RoleBinding/rb-54', 'RoleBinding/rb-implicit', 'ClusterRoleBinding/crb-0', 'ClusterRoleBinding/crb-1', 'ClusterRoleBinding/crb-2', 'ClusterRoleBinding/crb-watched',
    ])
  })

  // The subjects the API server takes for a ServiceAccount, as the pod's RBAC tab matches them.
  const binding = (subject: Record<string, unknown>, namespace?: string) => ({ name: 'b', namespace, role_ref_kind: 'ClusterRole', role_ref_name: 'view', subjects: [subject] })
  const applies = (rb: unknown[], crb: unknown[]) => serviceAccountBindings(rb, crb, 'team', 'bot').length

  it.each([
    ['the ServiceAccount itself', { kind: 'ServiceAccount', name: 'bot', namespace: 'team' }],
    ['its user name', { kind: 'User', name: 'system:serviceaccount:team:bot' }],
    ['every ServiceAccount', { kind: 'Group', name: 'system:serviceaccounts' }],
    ['the ServiceAccounts of its namespace', { kind: 'Group', name: 'system:serviceaccounts:team' }],
  ])('counts a binding of %s, in a RoleBinding and a ClusterRoleBinding', (_what, subject) => {
    expect(applies([binding(subject, 'team')], [])).toBe(1)
    expect(applies([], [binding(subject)])).toBe(1)
  })

  it.each([
    ['another ServiceAccount of the name elsewhere', { kind: 'ServiceAccount', name: 'bot', namespace: 'web' }],
    ['another ServiceAccount here', { kind: 'ServiceAccount', name: 'other', namespace: 'team' }],
    ['the user name of another namespace', { kind: 'User', name: 'system:serviceaccount:web:bot' }],
    ['the user name of another ServiceAccount', { kind: 'User', name: 'system:serviceaccount:team:other' }],
    ['a person named like it', { kind: 'User', name: 'bot' }],
    ['the ServiceAccounts of another namespace', { kind: 'Group', name: 'system:serviceaccounts:web' }],
    ['a group named like it', { kind: 'Group', name: 'bot' }],
    ['everyone signed in, which the pod tab counts only when asked', { kind: 'Group', name: 'system:authenticated' }],
    ['a user name under a group kind', { kind: 'Group', name: 'system:serviceaccount:team:bot' }],
    ['a group name under a user kind', { kind: 'User', name: 'system:serviceaccounts' }],
  ])('leaves out a binding of %s', (_what, subject) => {
    expect(applies([binding(subject, 'team')], [])).toBe(0)
    expect(applies([], [binding(subject)])).toBe(0)
  })

  it('reads a ServiceAccount without a namespace as the RoleBinding\'s, and as nobody in a ClusterRoleBinding', () => {
    const subject = { kind: 'ServiceAccount', name: 'bot' }
    expect(applies([binding(subject, 'team')], [])).toBe(1)
    expect(applies([binding(subject, 'web')], [])).toBe(0)
    expect(applies([], [binding(subject)])).toBe(0)
  })

  it('counts a binding once however many of its subjects apply', () => {
    const subjects = [{ kind: 'ServiceAccount', name: 'bot', namespace: 'team' }, { kind: 'Group', name: 'system:serviceaccounts' }]
    expect(applies([{ ...binding({}, 'team'), subjects }], [])).toBe(1)
  })

  it('says what matched a binding the same way the pod tab does', () => {
    const subjects = [{ kind: 'Group', name: 'system:serviceaccounts:team' }, { kind: 'User', name: 'someone' }]
    const [got] = serviceAccountBindings([{ ...binding({}, 'team'), subjects }], [], 'team', 'bot')
    expect(got.matched_by).toEqual(['Group system:serviceaccounts:team'])
    const [own] = serviceAccountBindings([binding({ kind: 'ServiceAccount', name: 'bot', namespace: 'team' }, 'team')], [], 'team', 'bot')
    expect(own.matched_by).toEqual([])
  })
})
