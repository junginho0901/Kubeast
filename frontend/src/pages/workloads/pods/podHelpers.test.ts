import { describe, expect, it } from 'vitest'

import { getStatusColor, runningNotReady } from './podHelpers'

// The words kubectl's STATUS has that the list shows (k8s-service podrow.ListView) keep a state's colour.
describe('getStatusColor', () => {
  it('draws a pod being deleted or held by scheduling gates as a warning', () => {
    expect(getStatusColor('Terminating')).toBe('badge-warning')
    expect(getStatusColor('SchedulingGated')).toBe('badge-warning')
    expect(getStatusColor('NotReady')).toBe('badge-warning')
  })

  it('draws a container that ended badly as an error, and an exit code of 0 as neither', () => {
    expect(getStatusColor('Signal:9')).toBe('badge-error')
    expect(getStatusColor('ExitCode:2')).toBe('badge-error')
    expect(getStatusColor('ExitCode:0')).toBe('badge-info')
    expect(getStatusColor('ContainerStatusUnknown')).toBe('badge-info')
  })

  // the Error card counts these (k8s-service statusNamesError), in an init container too
  it('draws a status naming an error as an error, also while the pod is initialising', () => {
    for (const status of ['Init:Error', 'Init:CrashLoopBackOff', 'Init:ImagePullBackOff', 'Init:ErrImagePull', 'Init:OOMKilled', 'Init:CreateContainerConfigError']) {
      expect(getStatusColor(status), status).toBe('badge-error')
    }
  })

  it('keeps the colours it had', () => {
    expect(getStatusColor('Running')).toBe('badge-success')
    expect(getStatusColor('Completed')).toBe('badge-success')
    expect(getStatusColor('Pending')).toBe('badge-warning')
    expect(getStatusColor('Init:0/1')).toBe('badge-warning')
    expect(getStatusColor('Init:Signal:9')).toBe('badge-warning')
    expect(getStatusColor('CrashLoopBackOff')).toBe('badge-error')
    expect(getStatusColor('Unknown')).toBe('badge-info')
  })
})

// The Pods list keeps kubectl's STATUS (Running) for a pod whose containers are not all ready and draws it yellow
// with the ready count on hover (10-31; it read NotReady before).
describe('runningNotReady', () => {
  it('is a Running pod with fewer ready containers than it has', () => {
    expect(runningNotReady({ status: 'Running', ready: '0/1' })).toBe(true)
    expect(runningNotReady({ status: 'Running', ready: '1/2' })).toBe(true)
  })

  it('is not a ready pod, another status, or a pod without containers counted', () => {
    expect(runningNotReady({ status: 'Running', ready: '2/2' })).toBe(false)
    expect(runningNotReady({ status: 'CrashLoopBackOff', ready: '0/1' })).toBe(false)
    expect(runningNotReady({ status: 'Pending', ready: '0/1' })).toBe(false)
    expect(runningNotReady({ status: 'Running', ready: '0/0' })).toBe(false)
    expect(runningNotReady({ status: 'Running', ready: null })).toBe(false)
  })
})
