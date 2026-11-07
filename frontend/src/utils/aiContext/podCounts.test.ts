import { describe, expect, it } from 'vitest'

import { notRunningFirst, notRunningPods, podCounts, podNeedsALook, podNotRunning } from './podCounts'

const pod = (status: string, phase = 'Running', restart_count = 0) => ({ status, phase, restart_count })

// What a screen tells the floating chat of its pods reads what the screen shows of them: kubectl's STATUS, not the phase.
describe('podNotRunning', () => {
  it('counts a crashing pod, which keeps the phase Running', () => {
    expect(podNotRunning(pod('CrashLoopBackOff'))).toBe(true)
  })

  it('counts a pod being deleted, which keeps the phase Running', () => {
    expect(podNotRunning(pod('Terminating'))).toBe(true)
  })

  it('does not count a finished pod, which is not running and asks nothing', () => {
    expect(podNotRunning(pod('Completed', 'Succeeded'))).toBe(false)
  })

  it('does not count a running pod, ready or not, which kubectl prints Running', () => {
    expect(podNotRunning(pod('Running'))).toBe(false)
  })

  it('reads the phase for a row without a status', () => {
    expect(podNotRunning({ phase: 'Pending' })).toBe(true)
    expect(podNotRunning({ phase: 'Succeeded' })).toBe(false)
  })

  it('says nothing of a row with neither', () => {
    expect(podNotRunning({})).toBe(false)
  })
})

describe('notRunningFirst', () => {
  it('puts the pods that need a look first and keeps the order within each', () => {
    const list = [{ name: 'a', ...pod('Running') }, { name: 'b', ...pod('Error', 'Failed') }, { name: 'c', ...pod('Completed', 'Succeeded') }, { name: 'd', ...pod('ImagePullBackOff', 'Pending') }]
    expect(notRunningFirst(list).map((p) => p.name)).toEqual(['b', 'd', 'a', 'c'])
  })
})

// A Node window's table shows a page of its pods, and the floating chat is told that page too: this says which of the
// rest need a look, from the list the window already holds.
describe('notRunningPods', () => {
  const rows = [
    { name: 'a', namespace: 'x', ready: '1/1', ...pod('Running') },
    { name: 'b', namespace: 'y', ready: '0/1', ...pod('CrashLoopBackOff', 'Running', 7) },
    { name: 'c', namespace: 'x', ready: '0/1', ...pod('Completed', 'Succeeded') },
    { name: 'd', namespace: 'z', ready: '0/1', ...pod('Init:0/1', 'Pending') },
  ]

  it('names each pod that needs a look and what the table says of it', () => {
    expect(notRunningPods(rows, 20)).toEqual({
      items: [
        { name: 'b', namespace: 'y', status: 'CrashLoopBackOff', phase: 'Running', ready: '0/1', restart_count: 7 },
        { name: 'd', namespace: 'z', status: 'Init:0/1', phase: 'Pending', ready: '0/1', restart_count: 0 },
      ],
      cut: 0,
    })
  })

  it('says how many it left out past its limit', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, namespace: 'x', ...pod('Error', 'Failed') }))
    const got = notRunningPods(many, 20)
    expect(got.items.map((p) => p.name)).toEqual(many.slice(0, 20).map((p) => p.name))
    expect(got.cut).toBe(5)
  })

  it('has nothing to say of pods that ask for nothing', () => {
    expect(notRunningPods(rows.filter((p) => !podNotRunning(p)), 20)).toEqual({ items: [], cut: 0 })
  })
})

describe('podCounts', () => {
  const list = [pod('Running'), pod('Running'), pod('CrashLoopBackOff'), pod('Terminating'), pod('Completed', 'Succeeded'), pod('Init:0/1', 'Pending'), pod('Error', 'Failed')]

  it('counts what is not running by what the screen says', () => {
    expect(podCounts(list).notRunning).toBe(4)
  })

  it('keeps the phases, a crashing pod under Running', () => {
    expect(podCounts(list).byPhase).toEqual({ Running: 4, Succeeded: 1, Pending: 1, Failed: 1 })
  })

  it('counts each word the screen shows', () => {
    expect(podCounts(list).byStatus).toEqual({ Running: 2, CrashLoopBackOff: 1, Terminating: 1, Completed: 1, 'Init:0/1': 1, Error: 1 })
  })
})

describe('podNeedsALook', () => {
  it('leaves a finished pod out, which would push a problem off a short list', () => {
    expect(podNeedsALook(pod('Completed', 'Succeeded'))).toBe(false)
  })

  it('takes a pod being deleted, as the list has a card for it', () => {
    expect(podNeedsALook(pod('Terminating'))).toBe(true)
  })

  it('takes a pod that crashes under the phase Running, and one that failed', () => {
    expect(podNeedsALook(pod('CrashLoopBackOff'))).toBe(true)
    expect(podNeedsALook(pod('Error', 'Failed'))).toBe(true)
    expect(podNeedsALook(pod('Pending', 'Pending'))).toBe(true)
  })

  it('takes a running pod that restarted more than five times, and no other', () => {
    expect(podNeedsALook(pod('Running', 'Running', 6))).toBe(true)
    expect(podNeedsALook(pod('Running', 'Running', 5))).toBe(false)
  })
})
