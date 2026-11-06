import { test, expect } from '@playwright/test'

import { compileRules, flatten, sortCells, type Answer } from './response-compare'

// The comparison on its own: each kind of change must come out as what it is. No browser, no cluster.

const answer = (body: unknown, status = 200): Answer => ({ status, body })
const rows = (...names: string[]) => ({ items: names.map((name) => ({ name, namespace: 'n', phase: 'Running' })) })

test.describe('the response comparison', () => {
  test('nothing differs: no real difference and no noise', () => {
    const a = answer({ a: 1, b: { c: ['x', 'y'] } })
    expect(sortCells(a, a, a)).toMatchObject({ real: [], noise: [] })
  })

  test('a changed value is a real difference, with both values', () => {
    const s = sortCells(answer({ phase: 'Running' }), answer({ phase: 'Failed' }), answer({ phase: 'Running' }))
    expect(s.real).toEqual([{ cell: '$.phase', kind: 'changed', old: '"Running"', new: '"Failed"' }])
  })

  test('a new cell is added and a lost cell is removed', () => {
    const added = sortCells(answer({ a: 1 }), answer({ a: 1, b: 2 }), answer({ a: 1 }))
    expect(added.real).toEqual([{ cell: '$.b', kind: 'added', old: null, new: '2' }])
    const removed = sortCells(answer({ a: 1, b: 2 }), answer({ a: 1 }), answer({ a: 1, b: 2 }))
    expect(removed.real).toEqual([{ cell: '$.b', kind: 'removed', old: '2', new: null }])
  })

  test('another status is a real difference even when the body is the same', () => {
    const s = sortCells(answer({ a: 1 }), answer({ a: 1 }, 403), answer({ a: 1 }))
    expect(s.real).toEqual([{ cell: '$status', kind: 'changed', old: '200', new: '403' }])
  })

  test('the old build differing from itself is noise, whatever the new build says', () => {
    const s = sortCells(answer({ rv: '1', a: 1 }), answer({ rv: '2', a: 1 }), answer({ rv: '3', a: 1 }))
    expect(s.noise).toEqual(['$.rv'])
    expect(s.real).toEqual([])
  })

  test('rows pair by name: one row added at the top is one row of differences, not all of them moved', () => {
    const s = sortCells(answer(rows('a', 'b')), answer(rows('new', 'a', 'b')), answer(rows('a', 'b')))
    const cells = s.real.map((d) => d.cell)
    expect(cells).toContain('$.items.$length')
    expect(cells).toContain('$.items.$order')
    expect(cells.filter((c) => c.startsWith('$.items[/n/new]')).length).toBe(3)
    expect(cells.filter((c) => /\[\/n\/(a|b)\]/.test(c))).toEqual([])
  })

  test('rows in another order are a real difference in the order cell only', () => {
    const s = sortCells(answer(rows('a', 'b')), answer(rows('b', 'a')), answer(rows('a', 'b')))
    expect(s.real.map((d) => d.cell)).toEqual(['$.items.$order'])
  })

  test('plain values in another order are one difference, in the order cell', () => {
    const s = sortCells(answer({ keys: ['a', 'b', 'c'] }), answer({ keys: ['c', 'a', 'b'] }), answer({ keys: ['a', 'b', 'c'] }))
    expect(s.real.map((d) => d.cell)).toEqual(['$.keys.$order'])
    const lost = sortCells(answer({ keys: ['a', 'b'] }), answer({ keys: ['a'] }), answer({ keys: ['a', 'b'] }))
    expect(lost.real.map((d) => d.cell).sort()).toEqual(['$.keys.$length', '$.keys.$order', '$.keys[b]'])
  })

  test('rows with no name pair by position, and rows of one name are its first and second', () => {
    expect([...flatten([{ v: 1 }, { v: 2 }]).keys()]).toContain('$[1].v')
    expect([...flatten([{ name: 'a', v: 1 }, { name: 'a', v: 2 }]).keys()]).toContain('$[//a#2].v')
    expect([...flatten(['x', 'x']).keys()], 'plain values the same twice').toContain('$[1]')
  })

  test('events pair by their object, reason and message, so a row moved within one second is no difference', () => {
    const event = (name: string, count: number) => ({ involved_object: { kind: 'Pod', namespace: 'n', name }, reason: 'Failed', message: 'm', count })
    const moved = sortCells(answer({ events: [event('a', 1), event('b', 1)] }), answer({ events: [event('b', 1), event('a', 1)] }), answer({ events: [event('a', 1), event('b', 1)] }))
    expect(moved.real.map((d) => d.cell)).toEqual(['$.events.$order'])
    const counted = sortCells(answer({ events: [event('a', 1)] }), answer({ events: [event('a', 2)] }), answer({ events: [event('a', 1)] }))
    expect(counted.real).toEqual([{ cell: '$.events[Pod/n/a/Failed/m].count', kind: 'changed', old: '1', new: '2' }])
  })

  test('a rollout\'s revisions are rows of their own', () => {
    const rollout = (revision: number, replicas: number) => ({ name: 'web', namespace: 'n', revision, replicas })
    const s = sortCells(answer([rollout(1, 2), rollout(2, 3)]), answer([rollout(1, 2), rollout(2, 4)]), answer([rollout(1, 2), rollout(2, 3)]))
    expect(s.real).toEqual([{ cell: '$[/n/web/2].replicas', kind: 'changed', old: '3', new: '4' }])
  })

  test('an ignore rule can be for one user\'s answers', () => {
    const match = compileRules([{ route: '^/x$', cell: '.', user: '^nsread$', why: 'because', pr: '#1' }])
    expect(match('/x', '$.a', 'nsread')?.pr).toBe('#1')
    expect(match('/x', '$.a', 'viewer')).toBeNull()
  })

  test('an ignore rule names the route and cell; one with no reason or PR is refused', () => {
    const match = compileRules([{ route: '^/api/v1/x$', cell: '^\\$\\.a', why: 'because', pr: '#1' }])
    expect(match('/api/v1/x', '$.a.b')?.pr).toBe('#1')
    expect(match('/api/v1/x', '$.b')).toBeNull()
    expect(match('/api/v1/y', '$.a')).toBeNull()
    expect(() => compileRules([{ route: 'x', cell: 'y', why: '', pr: '#1' }])).toThrow(/reason and a PR/)
    expect(() => compileRules([{ route: 'x', cell: 'y', why: 'z', pr: '' }])).toThrow(/reason and a PR/)
  })
})
