import { describe, expect, it } from 'vitest'

import { getStatusColor } from '@/pages/workloads/pods/podHelpers'
import { podWindowAIFields, podWindowBadge } from './podWindowBadge'

// The Pods window is chosen by phase (a bar of the dashboard's chart), but each row says what the Pods list says of the
// pod, so a crashing pod in the Running bar is not a green Running. The phase that put it there stays on hover.
describe('podWindowBadge', () => {
  const crash = { phase: 'Running', status: 'CrashLoopBackOff', ready: '0/1' }

  it('names a crashing pod in the Running bar and draws it red', () => {
    expect(podWindowBadge(crash)).toMatchObject({ text: 'CrashLoopBackOff', badge: 'badge-error', level: 'error', title: 'Phase: Running' })
  })

  it('draws a pod running and ready green', () => {
    expect(podWindowBadge({ phase: 'Running', status: 'Running', ready: '2/2' })).toMatchObject({ text: 'Running', badge: 'badge-success', level: 'ok' })
  })

  it('keeps Running for a pod not ready and draws it yellow, as the Pods list does', () => {
    expect(podWindowBadge({ phase: 'Running', status: 'Running', ready: '1/2' })).toMatchObject({ text: 'Running', badge: 'badge-warning', level: 'warn', notReady: true })
  })

  it('names a pod that finished as kubectl does, green', () => {
    expect(podWindowBadge({ phase: 'Succeeded', status: 'Completed', ready: '0/1' })).toMatchObject({ text: 'Completed', badge: 'badge-success', level: 'ok', title: 'Phase: Succeeded' })
  })

  it('draws a pod that failed red', () => {
    expect(podWindowBadge({ phase: 'Failed', status: 'Error', ready: '0/1' })).toMatchObject({ text: 'Error', badge: 'badge-error', level: 'error' })
  })

  it('draws a pod waiting or leaving yellow', () => {
    expect(podWindowBadge({ phase: 'Pending', status: 'Init:0/1', ready: '0/1' })).toMatchObject({ text: 'Init:0/1', badge: 'badge-warning', level: 'warn' })
    expect(podWindowBadge({ phase: 'Running', status: 'Terminating', ready: '1/1' })).toMatchObject({ text: 'Terminating', badge: 'badge-warning', level: 'warn' })
  })

  it('reads the phase for a row without a status, and says nothing when it has neither', () => {
    expect(podWindowBadge({ phase: 'Pending' })).toMatchObject({ text: 'Pending', badge: 'badge-warning' })
    expect(podWindowBadge({}).text).toBe('-')
    expect(podWindowBadge({}).title).toBeUndefined()
  })

  it('has the Pods list colour for every status', () => {
    for (const status of ['Running', 'Completed', 'Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'OOMKilled', 'Terminating', 'Unknown', 'Signal:9', 'ExitCode:2']) {
      expect(podWindowBadge({ phase: 'Running', status, ready: '1/1' }).badge, status).toBe(getStatusColor(status))
    }
  })
})

describe('podWindowAIFields', () => {
  it('tells the floating chat the word on the badge and the phase that put the pod in this window', () => {
    const crash = { phase: 'Running', status: 'CrashLoopBackOff', ready: '0/1' }
    expect(podWindowAIFields(crash)).toEqual({ status: podWindowBadge(crash).text, phase: 'Running', ready: '0/1' })
    expect(podWindowAIFields(crash).status).toBe('CrashLoopBackOff')
  })

  it('says the same as the badge for a row with an empty status', () => {
    expect(podWindowAIFields({ phase: 'Pending', status: '' }).status).toBe('Pending')
  })
})
