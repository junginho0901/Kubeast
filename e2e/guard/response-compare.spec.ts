import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

import { addsRow, clusterOf, compileRules, flatten, rowsLeftOut, sortCells, tailCopies, type Answer, type Difference, type IgnoreRule } from './response-compare'

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

  test('a catalog\'s groups pair by their category, so a group inserted in the middle is that group only', () => {
    const group = (category: string, ...keys: string[]) => ({ category, permissions: keys.map((key) => ({ key, description: key })) })
    const old = answer([group('All', '*'), group('Pod', 'resource.pod.exec'), group('Admin', 'admin.*')])
    const fresh = answer([group('All', '*'), group('Cluster', 'resource.hygiene.scan'), group('Pod', 'resource.pod.exec'), group('Admin', 'admin.*')])
    const cells = sortCells(old, fresh, old).real.map((d) => d.cell)
    expect(cells.filter((c) => !c.startsWith('$[Cluster]')).sort()).toEqual(['$.$length', '$.$order'])
    expect(cells).toContain('$[Cluster].permissions[resource.hygiene.scan].key')
  })

  test('discovery lists pair by their groupVersion: the same lists in another order are the order cell only', () => {
    const list = (groupVersion: string, ...kinds: string[]) =>
      ({ groupVersion, resources: kinds.map((kind) => ({ name: `${kind.toLowerCase()}s`, kind, namespaced: true, verbs: ['get', 'list'] })) })
    const old = answer([list('apps/v1', 'Deployment'), list('v1', 'Pod', 'Service')])
    const moved = sortCells(old, answer([list('v1', 'Pod', 'Service'), list('apps/v1', 'Deployment')]), old)
    expect(moved.real.map((d) => d.cell)).toEqual(['$.$order'])
    const changed = sortCells(old, answer([list('v1', 'Pod'), list('apps/v1', 'Deployment')]), old)
    expect(changed.real.map((d) => d.cell).sort()).toEqual([
      '$.$order',
      '$[v1].resources.$length',
      '$[v1].resources.$order',
      '$[v1].resources[Service//services].kind',
      '$[v1].resources[Service//services].name',
      '$[v1].resources[Service//services].namespaced',
      '$[v1].resources[Service//services].verbs.$length',
      '$[v1].resources[Service//services].verbs.$order',
      '$[v1].resources[Service//services].verbs[get]',
      '$[v1].resources[Service//services].verbs[list]',
    ])
  })

  test('a rollout\'s revisions are rows of their own', () => {
    const rollout = (revision: number, replicas: number) => ({ name: 'web', namespace: 'n', revision, replicas })
    const s = sortCells(answer([rollout(1, 2), rollout(2, 3)]), answer([rollout(1, 2), rollout(2, 4)]), answer([rollout(1, 2), rollout(2, 3)]))
    expect(s.real).toEqual([{ cell: '$[/n/web/2].replicas', kind: 'changed', old: '3', new: '4' }])
  })

  test('an ignore rule can be for one user\'s answers', () => {
    const match = compileRules([{ route: '^/x$', cell: '^\\$\\.a', user: '^nsread$', why: 'because', pr: '#1' }])
    expect(match('/x', '$.a', 'nsread')?.pr).toBe('#1')
    expect(match('/x', '$.a', 'viewer')).toBeNull()
  })

  test('a rule may be for one cluster: the same answer on another cluster stays a real difference', () => {
    const match = compileRules([{ route: '^/x$', cell: '^\\$status$', cluster: '^self$', newStatus: '^404$', why: 'no metrics-server there', pr: '#1' }])
    expect(match('/x', '$status', 'viewer', '404', clusterOf('/x?cluster=self'))?.pr).toBe('#1')
    expect(match('/x', '$status', 'viewer', '404', clusterOf('/x?cluster=default'))).toBeNull()
    expect(match('/x', '$status', 'viewer', '404', clusterOf('/x'))).toBeNull()
    expect(clusterOf('live test2 /apis/apps/v1/deployments?namespace=a')).toBe('test2')
    expect(clusterOf('/api/v1/cluster/metrics/pods?namespace=web&cluster=self')).toBe('self')
  })

  test('a rule with rowsLeftOut takes an answer that is the old one with rows left out, and no other', () => {
    const event = (reason: string, count = 1) => ({ type: 'Normal', reason, message: `${reason} m`, source: 'kubelet', count })
    const old = answer([event('RegisteredNode'), event('Starting'), event('Rebooted'), event('NodeHasSufficientMemory', 8)])
    const kept = (fresh: Answer, old2: Answer = old) => rowsLeftOut(old, fresh, old2)
    expect(kept(answer([event('RegisteredNode'), event('Rebooted')]))).toBe(true)
    expect(kept(answer([]))).toBe(true)
    expect(kept(answer([event('Rebooted'), event('RegisteredNode')])), 'rows in another order').toBe(false)
    expect(kept(answer([event('RegisteredNode'), event('Rebooted', 2)])), 'a kept row changed').toBe(false)
    expect(kept(answer([event('RegisteredNode'), event('NodeReady')])), 'a row the old answers lack').toBe(false)
    expect(kept(answer([event('RegisteredNode'), event('Rebooted')]), answer([event('RegisteredNode')])), 'a row one old answer lacks').toBe(false)
    expect(kept(answer({ detail: 'failed' }, 500)), 'no list').toBe(false)

    const match = compileRules([{ route: '^/x$', cell: '^\\$(\\.\\$length$|\\[[0-9]+\\]\\.)', rowsLeftOut: true, why: 'fewer rows', pr: '#1' }])
    const real = (fresh: Answer) => {
      const leftOut = rowsLeftOut(old, fresh, old)
      return sortCells(old, fresh, old).real.filter((d) => !match('/x', d.cell, '', String(fresh.status), '', leftOut)).map((d) => d.cell)
    }
    expect(real(answer([event('RegisteredNode'), event('Rebooted')]))).toEqual([])
    expect(real(answer([event('RegisteredNode'), event('Rebooted', 2)]))).toContain('$[1].count')
    expect(match('/x', '$.$length')).toBeNull()
  })

  test('a rule with tailCopies takes the later events of a lease that one side holds past the other, and compares the ones both hold', () => {
    const lease = (name: string, i: number, holder = 'h') => ({ name, namespace: 'kube-system', holder_identity: holder, watchEvent: i ? 'MODIFIED' : 'ADDED' })
    const frame = (...leases: [string, number, string?][]) =>
      ({ status: 'live', body: { items: leases.flatMap(([name, count, holder]) => Array.from({ length: count }, (_, i) => lease(name, i, i === 2 && holder ? holder : 'h'))) } }) as Answer
    const match = compileRules([{ route: '^leases$', cell: '^\\$\\.items\\[/[^\\]#]+#[0-9]+\\]\\.', tailCopies: true, why: 'renewals in the frame', pr: '#1' }])
    const real = (old: Answer, fresh: Answer, old2: Answer = old) => {
      const tail = tailCopies(old, fresh, old2)
      return sortCells(old, fresh, old2).real.filter((d) => !match('leases', d.cell, '', 'live', '', false, tail(d.cell)))
        .map((d) => d.cell.replace(/\]\..*$/, ']')).filter((c, i, all) => all.indexOf(c) === i && !c.endsWith('$length') && !c.endsWith('$order'))
    }
    const s = 'kube-scheduler'
    expect(real(frame([s, 9]), frame([s, 8])), 'the old frames hold a ninth event').toEqual([])
    expect(real(frame([s, 8]), frame([s, 9])), 'the new frame holds a ninth event').toEqual([])
    expect(real(frame([s, 9]), frame([s, 7])), 'two events past the new frame\'s last').toEqual([])
    expect(real(frame([s, 3, 'old']), frame([s, 3, 'new'])), 'a third event all frames hold, changed').toEqual(['$.items[/kube-system/kube-scheduler#3]'])
    expect(real(frame([s, 3, 'old']), frame([s, 4, 'new'])), 'the same with a fourth in the new frame').toEqual(['$.items[/kube-system/kube-scheduler#3]'])
    expect(real(frame([s, 2]), frame()), 'a lease the new frame lacks').toEqual(['$.items[/kube-system/kube-scheduler]', '$.items[/kube-system/kube-scheduler#2]'])
    expect(real(frame([s, 3]), frame([s, 2]), frame([s, 2])), 'the old frames disagree: noise, not a tail').toEqual([])
    expect(match('leases', '$.items[/kube-system/kube-scheduler#9].name', '', 'live', '', false, false)).toBeNull()
  })

  test('the lease rules of the ignore list take a later event past the other side\'s last and keep one both sides hold compared', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'response-diff-ignore.json'), 'utf8')) as { rules: IgnoreRule[] }
    const match = compileRules(file.rules)
    const route = 'live /apis/coordination.k8s.io/v1/leases'
    const frame = (count: number, third = 'h') => ({ status: 'live', body: { items: Array.from({ length: count }, (_, i) =>
      ({ name: 'kyverno', namespace: 'kyverno', holder_identity: i === 2 ? third : 'h', watchEvent: i ? 'MODIFIED' : 'ADDED' })) } }) as Answer
    const real = (old: Answer, fresh: Answer) => {
      const tail = tailCopies(old, fresh, old)
      return sortCells(old, fresh, old).real.filter((d) => !match(route, d.cell, 'global-admin', 'live', 'default', false, tail(d.cell))).map((d) => d.cell)
    }
    expect(real(frame(8), frame(9)).filter((c) => c.includes('#9')), 'a ninth event the new frame holds').toEqual([])
    expect(real(frame(9), frame(8)).filter((c) => c.includes('#9')), 'a ninth event the old frames hold').toEqual([])
    expect(real(frame(9, 'a'), frame(9, 'b')), 'a third event all frames hold, changed').toEqual(['$.items[/kyverno/kyverno#3].holder_identity'])
  })

  test('a rule for a route the old build did not have keeps a server error of the new build a real difference', () => {
    const rules = compileRules([{ route: '^/api/v1/cluster/pods/page$', cell: '.', newStatus: '^200$', why: 'new route', pr: '#1' }])
    const known = (fresh: Answer) => {
      const sorted = sortCells(answer({ detail: 'Not Found' }, 404), fresh, answer({ detail: 'Not Found' }, 404))
      return sorted.real.filter((d) => !rules('/api/v1/cluster/pods/page', d.cell, '', String(fresh.status))).map((d) => d.cell).sort()
    }
    expect(known(answer({ detail: 'database unavailable' }, 500))).toEqual(['$.detail', '$status'])
    expect(known(answer({ items: [], total: 0 }))).toEqual([])
  })

  test('a rule with addedRow takes one row the new build adds to a list, and no other row, order or loss', () => {
    const difference = (cell: string, kind: Difference['kind'], old: string | null, fresh: string | null): Difference => ({ cell, kind, old, new: fresh })
    expect(addsRow(difference('$.l[b].key', 'added', null, '"b"'), 'b')).toBe(true)
    expect(addsRow(difference('$.l[c].key', 'added', null, '"c"'), 'b'), 'another row').toBe(false)
    expect(addsRow(difference('$.l[b].key', 'changed', '"b"', '"B"'), 'b'), 'a row both builds have').toBe(false)
    expect(addsRow(difference('$.l[b].key', 'removed', '"b"', null), 'b'), 'a row the new build lost').toBe(false)
    expect(addsRow(difference('$.l.$length', 'changed', '2', '3'), 'b')).toBe(true)
    expect(addsRow(difference('$.l.$length', 'changed', '2', '4'), 'b'), 'two more').toBe(false)
    expect(addsRow(difference('$.l.$length', 'changed', '3', '2'), 'b'), 'one less').toBe(false)
    expect(addsRow(difference('$.l.$length', 'added', null, '1'), 'b'), 'a list neither old answer has').toBe(false)
    expect(addsRow(difference('$.l.$order', 'changed', 'a c', 'a b c'), 'b')).toBe(true)
    expect(addsRow(difference('$.l.$order', 'changed', 'a c', 'b a c'), 'b'), 'wherever the row stands').toBe(true)
    expect(addsRow(difference('$.l.$order', 'changed', 'a c', 'c b a'), 'b'), 'the others in another order').toBe(false)
    expect(addsRow(difference('$.l.$order', 'changed', 'a c', 'a b b#2 c'), 'b'), 'the row twice').toBe(false)
    expect(addsRow(difference('$.l.$order', 'changed', 'a c', 'a b c d'), 'b'), 'another row beside it').toBe(false)
    expect(addsRow(difference('$.l.$order', 'changed', 'a b c', 'a c'), 'b'), 'the row lost').toBe(false)

    const match = compileRules([{ route: '^/x$', cell: '^\\$\\.l', addedRow: 'b', why: 'a new row', pr: '#1' }])
    expect(match('/x', '$.l[b].key', '', '200', '', false, false, difference('$.l[b].key', 'added', null, '"b"'))?.pr).toBe('#1')
    expect(match('/x', '$.l[b].key'), 'nothing said of the difference').toBeNull()
  })

  test('a rule that takes in $status names the status the new build answers, or it is refused', () => {
    expect(() => compileRules([{ route: 'x', cell: '.', why: 'z', pr: '#1' }])).toThrow(/names newStatus/)
    expect(() => compileRules([{ route: 'x', cell: '^\\$status$', why: 'z', pr: '#1' }])).toThrow(/names newStatus/)
    expect(() => compileRules([{ route: 'x', cell: '^\\$\\.a', why: 'z', pr: '#1' }])).not.toThrow()
  })

  test('the ignore list of the response comparison compiles', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'response-diff-ignore.json'), 'utf8')) as { rules: IgnoreRule[] }
    expect(() => compileRules(file.rules)).not.toThrow()
    expect(file.rules.length).toBeGreaterThan(0)
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
