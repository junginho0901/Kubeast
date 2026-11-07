import { describe, expect, it } from 'vitest'

import { workloadPodsLayer } from './workloadPodsLayer'

const row = (name: string, status: string, phase = 'Running', ready = '1/1') => ({ name, namespace: 'ns', status, phase, ready, restart_count: 2, node_name: 'n1' })
const owned = (pods: Array<Record<string, unknown>>, loaded = true) => ({ pods, podsEnabled: true, podsLoaded: loaded })
const none = { pods: [], podsEnabled: false, podsLoaded: false }

// The floating chat is told the pods the window lists (the Pods list's rows), each with kubectl's STATUS.
describe('workloadPodsLayer', () => {
  it('tells a crashing pod apart from a running one by its status, not its phase', () => {
    const got = workloadPodsLayer({}, owned([row('a', 'Running'), row('b', 'CrashLoopBackOff', 'Running', '0/1')]), 'ns')
    expect(got.total).toBe(2)
    expect(got.notRunning).toBe(1)
    expect(got.items.find((p) => p.name === 'b')).toMatchObject({ status: 'CrashLoopBackOff', phase: 'Running', ready: '0/1', restart_count: 2, node_name: 'n1' })
  })

  it('counts what is not running as the status says it', () => {
    const got = workloadPodsLayer({}, owned([
      row('running', 'Running'),
      row('not-ready', 'Running', 'Running', '0/1'),
      row('done', 'Completed', 'Succeeded', '0/1'),
      row('leaving', 'Terminating'),
      row('starting', 'Init:0/1', 'Pending', '0/1'),
      row('oom', 'OOMKilled'),
    ]), 'ns')
    expect(got.notRunning).toBe(3)
  })

  it('reads the phase for a row without a status', () => {
    expect(workloadPodsLayer({}, owned([{ name: 'a', phase: 'Pending' }, { name: 'b', phase: 'Running' }]), 'ns').notRunning).toBe(1)
  })

  it('lists the pods that need a look first, so a cut list keeps them', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`ok-${i}`, 'Running'))
    many.push(row('crash', 'CrashLoopBackOff', 'Running', '0/1'))
    const got = workloadPodsLayer({}, owned(many), 'ns')
    expect(got.total).toBe(31)
    expect(got.items).toHaveLength(20)
    expect(got.items[0].name).toBe('crash')
  })

  it('gives each pod a link', () => {
    expect(workloadPodsLayer({}, owned([row('a', 'Running')]), 'ns').items[0]._link).toBe('kubest://pod?ns=ns&name=a')
    expect(workloadPodsLayer({}, owned([row('a', 'Running')]), undefined).items[0]._link).toBeUndefined()
  })

  it('reads the describe answer\'s pods until the live list has some, as the window does', () => {
    const got = workloadPodsLayer({ owned_pods: [row('from-describe', 'ImagePullBackOff', 'Pending', '0/1')] }, owned([], false), 'ns')
    expect(got).toMatchObject({ known: true, total: 1, notRunning: 1 })
    expect(got.items[0]).toMatchObject({ name: 'from-describe', status: 'ImagePullBackOff' })
    expect(workloadPodsLayer({ owned_pods: [row('from-describe', 'Running')] }, owned([row('live', 'Running')]), 'ns').items.map((p) => p.name)).toEqual(['live'])
  })

  it('knows a workload with no pods has none, once the list has answered', () => {
    expect(workloadPodsLayer({}, owned([]), 'ns')).toMatchObject({ known: true, total: 0, notRunning: 0, items: [] })
  })

  it('does not claim a number of pods while it has not read any', () => {
    expect(workloadPodsLayer({}, owned([], false), 'ns').known).toBe(false)
    expect(workloadPodsLayer({}, none, 'ns').known).toBe(false)
  })
})
