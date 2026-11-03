import { describe, expect, it } from 'vitest'
import { conditionStatus, conditionSummary, formatParentRef } from './gatewayDetail'

const cond = (type: string, status: string) => ({ type, status })

// The drawers' condition badges print what kubectl's PROGRAMMED and ACCEPTED columns print, not Yes/No: a Gateway the
// controller has not seen yet keeps the CRD's default Unknown, which is not No.
describe('conditionStatus', () => {
  it('is the condition status as written, three values and none', () => {
    const conds = [cond('Accepted', 'True'), cond('Programmed', 'Unknown'), cond('ResolvedRefs', 'False')]
    expect(['Accepted', 'Programmed', 'ResolvedRefs', 'Ready'].map((t) => conditionStatus(conds, t))).toEqual(['True', 'Unknown', 'False', '-'])
    expect(conditionStatus(undefined, 'Accepted')).toBe('-')
  })

  it('pools a route\'s parents: True when one parent says so, else the first parent\'s value', () => {
    expect(conditionStatus([cond('Accepted', 'False'), cond('Accepted', 'True')], 'Accepted')).toBe('True')
    expect(conditionStatus([cond('Accepted', 'Unknown'), cond('Accepted', 'False')], 'Accepted')).toBe('Unknown')
  })
})

// The same cases as gatewayrow's TestSummary: the drawer's Status badge before describe answers is the list's Status.
describe('conditionSummary', () => {
  it('names the conditions as the list pages do', () => {
    expect(conditionSummary([cond('Accepted', 'True'), cond('Programmed', 'True')], 'Programmed', 'Accepted')).toBe('Programmed')
    expect(conditionSummary([cond('Programmed', 'False'), cond('Accepted', 'True')], 'Programmed', 'Accepted')).toBe('Accepted')
    expect(conditionSummary([cond('Ready', 'True')], 'Accepted')).toBe('Ready')
    expect(conditionSummary([cond('Accepted', 'False'), cond('Ready', 'Unknown')], 'Accepted')).toBe('Accepted(False)')
    expect(conditionSummary([], 'Accepted')).toBe('Unknown')
    expect(conditionSummary([cond('Accepted', 'Unknown'), cond('Programmed', 'Unknown')], 'Programmed', 'Accepted')).toBe('Unknown')
  })
})

describe('formatParentRef', () => {
  it('writes Kind.group/name and what narrows it', () => {
    expect(formatParentRef({ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'edge', sectionName: 'http', port: 80 }))
      .toBe('Gateway.gateway.networking.k8s.io/edge (section=http, port=80)')
    expect(formatParentRef({ name: 'edge', namespace: 'infra' })).toBe('-/edge (ns=infra)')
  })
})
