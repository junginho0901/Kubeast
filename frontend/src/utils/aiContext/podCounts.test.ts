import { describe, expect, it } from 'vitest'

import { notRunningFirst, podCounts, podNeedsALook, podNotRunning } from './podCounts'

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
