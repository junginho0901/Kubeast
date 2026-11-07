import { describe, expect, it } from 'vitest'

import { getStatusColor } from '@/pages/workloads/pods/podHelpers'

import { namespacePodBadge, namespacePodsLayer } from './namespacePods'

const row = (name: string, status: string, phase = 'Running', ready = '1/1') => ({ name, status, phase, ready, restart_count: 2, node_name: 'n1', created_at: '2026-11-01T00:00:00Z' })

// The Namespace window's Pods table says what the Pods list says of a pod, in its colour.
describe('namespacePodBadge', () => {
  it('draws a crashing pod in red with kubectl\'s word and keeps the phase on hover', () => {
    expect(namespacePodBadge(row('a', 'CrashLoopBackOff', 'Running', '0/1'))).toEqual({ text: 'CrashLoopBackOff', badge: 'badge-error', title: 'Phase: Running' })
  })

  it('has the Pods list\'s colour for every word kubectl prints', () => {
    for (const status of ['Running', 'Completed', 'Succeeded', 'Pending', 'Terminating', 'ContainerCreating', 'Init:0/1', 'Init:CrashLoopBackOff', 'Init:Error', 'ImagePullBackOff', 'ErrImagePull', 'OOMKilled', 'Error', 'Signal:9', 'ExitCode:1', 'NotReady', 'SchedulingGated', 'Unknown']) {
      expect(namespacePodBadge(row('a', status)).badge, status).toBe(getStatusColor(status))
    }
  })

  it('draws a running pod that is not ready yellow, as the Pods list does', () => {
    expect(namespacePodBadge(row('a', 'Running', 'Running', '0/1')).badge).toBe('badge-warning')
    expect(namespacePodBadge(row('a', 'Running', 'Running', '1/1')).badge).toBe('badge-success')
  })

  it('says a dash for a row with no word', () => {
    expect(namespacePodBadge({ name: 'a' }).text).toBe('-')
  })
})

describe('namespacePodsLayer', () => {
  it('tells the floating chat each pod as the table shows it', () => {
    const got = namespacePodsLayer([row('a', 'CrashLoopBackOff', 'Running', '0/1')], 'ns')
    expect(got.items[0]).toEqual({
      name: 'a', status: 'CrashLoopBackOff', phase: 'Running', ready: '0/1', restart_count: 2, node_name: 'n1', created_at: '2026-11-01T00:00:00Z',
      _link: expect.stringContaining('a'),
    })
  })

  it('counts what is not running by the word the table shows', () => {
    const got = namespacePodsLayer([row('a', 'Running'), row('b', 'CrashLoopBackOff'), row('c', 'Completed', 'Succeeded')], 'ns')
    expect(got.notRunning).toBe(1)
    expect(got.byPhase).toEqual({ Running: 2, Succeeded: 1 })
    expect(got.byStatus).toEqual({ Running: 1, CrashLoopBackOff: 1, Completed: 1 })
  })

  it('keeps a pod that needs a look when the list is cut', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`ok-${i}`, 'Running'))
    many.push(row('crash', 'CrashLoopBackOff', 'Running', '0/1'))
    const got = namespacePodsLayer(many, 'ns')
    expect(got.items).toHaveLength(20)
    expect(got.items[0].name).toBe('crash')
  })
})
