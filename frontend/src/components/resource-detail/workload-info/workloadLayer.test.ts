import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'
import { cronJobDrawerInfo } from '@/pages/workloads/cronjobs/cronJobHelpers'
import { formatDuration, jobDurationSeconds } from '@/pages/workloads/jobs/jobHelpers'
import WorkloadKindInfo from './WorkloadKindInfo'
import WorkloadOwnedResources from './WorkloadOwnedResources'
import WorkloadStrategySection from './WorkloadStrategySection'
import { ownedDisplayJobs, workloadLayer, workloadReplicaView, workloadSettingsInfo } from './workloadLayer'

vi.mock('../ResourceLink', () => ({ ResourceLink: ({ name }: { name: string }) => createElement('a', null, name) }))

const NOW = '2026-11-07T04:00:00Z'
const noPods = { pods: [], podsEnabled: false, podsLoaded: false }

// The describe answers as k8s-service writes them.
const DEPLOYMENT = {
  replicas: 3, ready_replicas: 2, updated_replicas: 3, available_replicas: 2, unavailable_replicas: 1,
  replicas_status: { desired: 3, current: 3, ready: 2, updated: 3, available: 2 },
  strategy: { type: 'RollingUpdate', rolling_update: { max_unavailable: '25%', max_surge: '1' } },
  paused: true, min_ready_seconds: 5, progress_deadline_seconds: 600, revision_history_limit: 10, revision: '7',
  uid: 'uid-1', resource_version: '42', generation: 4, observed_generation: 3, created_at: '2026-01-01T00:00:00Z',
}
const STATEFUL_SET = {
  replicas: 2, ready_replicas: 1,
  replicas_status: { desired: 2, current: 2, ready: 1, updated: 1, available: 1 },
  update_strategy: { type: 'RollingUpdate', rolling_update: { partition: 1 } },
  service_name: 'db-headless', pod_management_policy: 'OrderedReady', min_ready_seconds: 3, revision_history_limit: 10,
  current_revision: 'db-1', update_revision: 'db-2', collision_count: 0,
}
const DAEMON_SET = {
  desired: 3, current: 3, ready: 2, updated: 3, available: 2, misscheduled: 1, unavailable: 1,
  daemonset_status: { desired: 3, current: 3, ready: 2, updated: 3, available: 2, misscheduled: 1, unavailable: 1 },
  update_strategy: { type: 'RollingUpdate', rolling_update: { max_unavailable: '1' } },
  min_ready_seconds: 2, revision_history_limit: 10, collision_count: 0,
}
const REPLICA_SET = {
  replicas: 2, current_replicas: 2, ready_replicas: 2, available_replicas: 2, fully_labeled_replicas: 2,
  replicas_status: { desired: 2, current: 2, ready: 2, available: 2 },
  owner_references: [{ kind: 'Deployment', name: 'web', controller: true }], revision: '3', min_ready_seconds: 4,
}
const CRONJOB = {
  schedule: '0 3 * * *', suspend: false, concurrency_policy: 'Forbid', starting_deadline_seconds: 120,
  successful_jobs_history_limit: 3, failed_jobs_history_limit: 1, time_zone: 'Asia/Seoul', active: 1,
  last_schedule_time: '2026-11-06T18:00:00Z', last_successful_time: '2026-11-05T18:00:00Z', created_at: '2026-01-01T00:00:00Z',
}

function layer(kind: string, describe: Record<string, unknown> | undefined, more: Record<string, unknown> = {}) {
  return workloadLayer({
    kind, name: 'w', namespace: 'ns', describe, spec: {}, status: {}, selector: {}, owned: noPods, ownedJobs: undefined,
    controllerZone: 'the controller zone', ...more,
  } as Parameters<typeof workloadLayer>[0])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what the CronJob window shows and tells the floating chat', () => {
  it('heads the layer with its schedule, not replicas it does not have', () => {
    const { summary } = layer('CronJob', CRONJOB)
    expect(summary).not.toContain('replicas')
    expect(summary).toBe('CronJob w (ns) — Schedule 0 3 * * *, Suspend No, Concurrency Policy Forbid, Active Jobs 1, Next Run 2026-11-07T18:00:00.000Z, Last Schedule 2026-11-06T18:00:00Z')
  })

  it('tells the rows the window shows, by the name of the row', () => {
    expect(layer('CronJob', CRONJOB).data).toMatchObject({
      schedule: '0 3 * * *', suspend: 'No', concurrency_policy: 'Forbid', starting_deadline: '120s',
      successful_jobs_history: '3', failed_jobs_history: '1', time_zone: 'Asia/Seoul',
      next_run: '2026-11-07T18:00:00.000Z', active_jobs: '1',
      last_schedule: '2026-11-06T18:00:00Z', last_successful: '2026-11-05T18:00:00Z',
    })
  })

  it('says the schedule has no zone of its own in the words of the window', () => {
    expect(layer('CronJob', { ...CRONJOB, time_zone: undefined }).data?.time_zone).toBe('the controller zone')
  })

  it('names no next run for a suspended CronJob, which has none', () => {
    const got = layer('CronJob', { ...CRONJOB, suspend: true })
    expect(got.data).toMatchObject({ suspend: 'Yes' })
    expect(got.data?.next_run).toBeUndefined()
    expect(got.summary).toContain('Suspend Yes')
    expect(got.summary).not.toContain('Next Run')
  })

  // the issues' LastRunNotSucceeded (issues.go issuesFromJobs): the last run has not succeeded and none is active
  it('marks a CronJob as the issues do', () => {
    const look = (fields: Record<string, unknown>) => layer('CronJob', { ...CRONJOB, ...fields }).summary.startsWith('⚠️')
    expect(look({ active: 0 })).toBe(true)
    expect(look({ active: 0, last_successful_time: undefined })).toBe(true)
    expect(look({ active: 1 })).toBe(false)
    expect(look({ active: 0, last_successful_time: '2026-11-06T18:00:30Z' })).toBe(false)
    expect(look({ active: 0, last_schedule_time: undefined, last_successful_time: undefined })).toBe(false)
  })

  it('reads the row until the describe answer has come', () => {
    const got = layer('CronJob', undefined, {
      spec: { schedule: '*/5 * * * *', suspend: false, concurrencyPolicy: 'Allow' },
      status: { lastScheduleTime: '2026-11-07T03:55:00Z', active: [{ name: 'a' }, { name: 'b' }] },
    })
    expect(got.data).toMatchObject({ schedule: '*/5 * * * *', concurrency_policy: 'Allow', active_jobs: '2', last_schedule: '2026-11-07T03:55:00Z' })
  })

  it('draws the rows it tells', () => {
    const info = cronJobDrawerInfo(CRONJOB, {}, {})
    const html = renderToStaticMarkup(createElement(WorkloadKindInfo, {
      isJob: false, isCronJob: true, describe: CRONJOB, spec: {}, status: {}, canSuspend: true, canTrigger: true,
      suspendMut: { isPending: false, mutate: () => {} }, setTriggerDialogOpen: () => {},
    }))
    for (const [label, value] of [
      ['Schedule', info.schedule], ['Suspend', info.suspend], ['Concurrency Policy', info.concurrency_policy], ['Starting Deadline', info.starting_deadline],
      ['Successful Jobs History', info.successful_jobs_history], ['Failed Jobs History', info.failed_jobs_history], ['Time Zone', info.time_zone], ['Active Jobs', info.active_jobs],
    ]) {
      expect(html, String(label)).toContain(`>${label}<`)
      expect(html, String(label)).toContain(`>${value}<`)
    }
    // the window's time and the told one are one moment
    expect(html).toContain('Next Run')
    expect(html).toContain(new Date(info.next_run!).getFullYear().toString())
    expect(html).toContain('Last Schedule')
    expect(html).toContain('Last Successful')
  })
})

describe('the Jobs a CronJob window lists', () => {
  const job = (name: string, start: string | undefined, end?: string, status = 'Complete') => ({ name, status, start_time: start, completion_time: end })

  it('tells them newest first, with what the window says of each', () => {
    const got = layer('CronJob', CRONJOB, {
      ownedJobs: [
        job('old', '2026-11-05T18:00:00Z', '2026-11-05T18:01:30Z'),
        job('now', '2026-11-07T03:59:00Z', undefined, 'Running'),
        job('mid', '2026-11-06T18:00:00Z', '2026-11-06T18:00:10Z', 'Failed'),
      ],
    })
    expect(got.data?.owned_jobs).toEqual([
      { name: 'now', status: 'Running', start_time: '2026-11-07T03:59:00Z', duration: '60s' },
      { name: 'mid', status: 'Failed', start_time: '2026-11-06T18:00:00Z', duration: '10s' },
      { name: 'old', status: 'Complete', start_time: '2026-11-05T18:00:00Z', duration: '90s' },
    ])
    expect(got.data?.owned_jobs_total).toBe(3)
  })

  // kubectl's DURATION: the rows of its Jobs table and Recent Runs say one thing of one run
  it('draws a run\'s Duration in the Jobs table as Recent Runs and kubectl do', () => {
    const rows = [
      { ...job('ended', '2026-11-07T03:00:00Z', '2026-11-07T03:02:05Z'), duration_seconds: 125 },
      job('from-the-list', '2026-11-07T02:00:00Z', '2026-11-07T02:00:30Z'),
      job('going', '2026-11-07T03:59:00Z', undefined, 'Running'),
      job('waiting', undefined, undefined, 'Pending'),
    ]
    const html = renderToStaticMarkup(createElement(WorkloadOwnedResources, {
      namespace: 'ns', isCronJob: true, isDaemonSet: false, isDeployment: false, isJob: false, isReplicaSet: false, isStatefulSet: false,
      owned: { ...noPods, podTable: { items: [], total: 0, loading: false }, replicaSets: [], jobs: [], pvcsByPodName: {}, rsEnabled: false, jobsEnabled: false, pvcsEnabled: false } as never,
      describe: undefined, ownedJobs: rows,
    }))
    const durations = html.split('<tbody')[1].split('</tr>').slice(0, 4).map((row) => [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '')).pop())
    expect(durations).toEqual(['2m5s', '30s', '60s', '-'])
    expect(rows.slice(0, 3).map((j) => formatDuration(jobDurationSeconds(j)))).toEqual(durations.slice(0, 3))
  })

  // The window draws no pods of a CronJob, whose runs hold them: the counts its Jobs answered say what they did.
  it('tells the pods of its Jobs from the rows it lists', () => {
    const got = layer('CronJob', CRONJOB, {
      ownedJobs: [
        { ...job('a', '2026-11-07T03:00:00Z', '2026-11-07T03:01:00Z'), active: 0, succeeded: 2, failed: 0 },
        { ...job('b', '2026-11-07T03:30:00Z', undefined, 'Running'), active: 1, succeeded: 0, failed: 3 },
      ],
    })
    expect(got.data?.job_pods).toEqual({ active: 1, succeeded: 2, failed: 3 })
    expect(got.summary).toContain(', Job 2개 (Pod active 1, succeeded 2, failed 3)')
  })

  it('says nothing of pods before it has read any', () => {
    const got = layer('CronJob', CRONJOB)
    expect(got.data).not.toHaveProperty('job_pods')
    expect(got.data?.pods).toBeUndefined()
    expect(got.summary).not.toContain('Pod ')
    expect(layer('StatefulSet', STATEFUL_SET).data?.pods).toBeUndefined()
    expect(layer('StatefulSet', STATEFUL_SET, { owned: { pods: [], podsEnabled: true, podsLoaded: true } }).data?.pods).toEqual([])
  })

  it('keeps the newest of more than it tells, and says how many there are', () => {
    const many = Array.from({ length: 14 }, (_, i) => job(`j${String(i).padStart(2, '0')}`, `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `2026-11-${String(i + 1).padStart(2, '0')}T00:00:05Z`))
    const got = layer('CronJob', CRONJOB, { ownedJobs: many })
    const told = got.data?.owned_jobs as { name: string }[]
    expect(told.map((j) => j.name)).toEqual(['j13', 'j12', 'j11', 'j10', 'j09', 'j08', 'j07', 'j06', 'j05', 'j04'])
    expect(got.data?.owned_jobs_total).toBe(14)
  })

  it('reads the live list the window draws, else the one it asked for', () => {
    const live = [job('live', NOW)]
    const asked = [job('asked', NOW)]
    expect(ownedDisplayJobs({ jobs: live, jobsEnabled: true }, asked).map((j) => j.name)).toEqual(['live'])
    expect(ownedDisplayJobs({ jobs: [], jobsEnabled: true }, asked).map((j) => j.name)).toEqual(['asked'])
    expect(ownedDisplayJobs({ jobs: live, jobsEnabled: false }, asked).map((j) => j.name)).toEqual(['asked'])
    expect(ownedDisplayJobs({ jobs: [], jobsEnabled: false }, undefined)).toEqual([])
    const told = layer('CronJob', CRONJOB, { owned: { ...noPods, jobs: live, jobsEnabled: true }, ownedJobs: asked }).data?.owned_jobs as { name: string }[]
    expect(told.map((j) => j.name)).toEqual(['live'])
  })
})

describe('the replicas a window shows and the floating chat is told', () => {
  it('reads a DaemonSet from its describe answer, which has no replicas', () => {
    expect(workloadReplicaView('DaemonSet', DAEMON_SET, {}, {})).toMatchObject({ desired: 3, current: 3, ready: 2, updated: 3, available: 2 })
    const got = layer('DaemonSet', DAEMON_SET)
    expect(got.summary).toBe('⚠️ DaemonSet w (ns) — replicas 2/3')
    expect(got.data).toMatchObject({ replicas: 3, ready_replicas: 2, current_replicas: 3, updated_replicas: 3, available_replicas: 2, unavailable_replicas: 1, misscheduled_replicas: 1 })
  })

  it('reads a DaemonSet from its row until the describe answer has come', () => {
    const status = { desiredNumberScheduled: 4, currentNumberScheduled: 4, numberReady: 4, updatedNumberScheduled: 4, numberAvailable: 4 }
    expect(workloadReplicaView('DaemonSet', undefined, {}, status)).toEqual({ desired: 4, current: 4, ready: 4, updated: 4, available: 4 })
    expect(layer('DaemonSet', undefined, { status }).summary).toBe('DaemonSet w (ns) — replicas 4/4')
  })

  it('heads each kind with what the window shows', () => {
    expect(layer('Deployment', DEPLOYMENT).summary).toBe('⚠️ Deployment w (ns) — replicas 2/3')
    expect(layer('StatefulSet', STATEFUL_SET).summary).toBe('⚠️ StatefulSet w (ns) — replicas 1/2')
    expect(layer('ReplicaSet', REPLICA_SET).summary).toBe('ReplicaSet w (ns) — replicas 2/2')
  })

  it('tells the Current count, the row the window has', () => {
    expect(layer('Deployment', DEPLOYMENT).data?.current_replicas).toBe(3)
    expect(layer('ReplicaSet', REPLICA_SET).data?.current_replicas).toBe(2)
  })

  it('tells a ReplicaSet no updated count, which the window does not have', () => {
    expect(layer('ReplicaSet', REPLICA_SET).data?.updated_replicas).toBeUndefined()
  })

  it('says it does not know before any answer, not a number', () => {
    expect(layer('Deployment', undefined).summary).toBe('Deployment w (ns) — replicas ?/?')
    const daemonSet = layer('DaemonSet', undefined)
    expect(daemonSet.summary).toBe('DaemonSet w (ns) — replicas ?/?')
    expect(daemonSet.data?.replicas).toBeUndefined()
  })

  it('tells a Job no replicas', () => {
    const { data, summary } = layer('Job', { status: 'Running', completions: 1, parallelism: 1, active: 1, succeeded: 0, failed: 0 })
    expect(summary).toBe('Job w (ns) — Status Running, Completions 1, Parallelism 1, Active 1, Succeeded 0, Failed 0')
    expect(data?.replicas).toBeUndefined()
    expect(data?.ready_replicas).toBeUndefined()
  })
})

describe('the settings a window shows and the floating chat is told', () => {
  it('a Deployment', () => {
    expect(workloadSettingsInfo('Deployment', DEPLOYMENT, {}, { misscheduled: 0, unavailable: 0 })).toEqual({
      revision: '7', paused: 'Yes', min_ready_seconds: '5', progress_deadline: '600s', revision_history_limit: '10',
    })
    expect(layer('Deployment', DEPLOYMENT).data).toMatchObject({
      revision: '7', paused: 'Yes', min_ready_seconds: '5', progress_deadline: '600s', revision_history_limit: '10',
      strategy: { type: 'RollingUpdate', max_unavailable: '25%', max_surge: '1' },
    })
  })

  it('a StatefulSet', () => {
    expect(workloadSettingsInfo('StatefulSet', STATEFUL_SET, {}, { misscheduled: 0, unavailable: 0 })).toEqual({
      service_name: 'db-headless', pod_management_policy: 'OrderedReady', min_ready_seconds: '3', revision_history_limit: '10',
      current_revision: 'db-1', update_revision: 'db-2', collision_count: '0',
    })
    expect(layer('StatefulSet', STATEFUL_SET).data).toMatchObject({
      service_name: 'db-headless', pod_management_policy: 'OrderedReady', current_revision: 'db-1', update_revision: 'db-2', collision_count: '0',
      strategy: { type: 'RollingUpdate', partition: 1 },
    })
  })

  it('a DaemonSet', () => {
    expect(workloadSettingsInfo('DaemonSet', DAEMON_SET, {}, { misscheduled: 1, unavailable: 1 })).toEqual({
      min_ready_seconds: '2', revision_history_limit: '10', collision_count: '0', misscheduled_pods: '1', unavailable_pods: '1',
    })
    expect(layer('DaemonSet', DAEMON_SET).data).toMatchObject({
      min_ready_seconds: '2', revision_history_limit: '10', misscheduled_pods: '1', unavailable_pods: '1',
      strategy: { type: 'RollingUpdate', max_unavailable: '1' },
    })
  })

  it('a ReplicaSet', () => {
    expect(workloadSettingsInfo('ReplicaSet', REPLICA_SET, {}, { misscheduled: 0, unavailable: 0 })).toEqual({
      owner: 'web', revision: '3', min_ready_seconds: '4', fully_labeled_replicas: '2',
    })
    expect(layer('ReplicaSet', REPLICA_SET).data).toMatchObject({ owner: 'web', revision: '3', fully_labeled_replicas: '2' })
  })

  it('a row the answer does not hold is not told', () => {
    expect(workloadSettingsInfo('Deployment', {}, {}, { misscheduled: 0, unavailable: 0 })).toEqual({})
    const data = layer('Deployment', {}).data as Record<string, unknown>
    expect('paused' in data && data.paused !== undefined).toBe(false)
    expect(data.strategy).toBeUndefined()
  })

  it('reads the row for what a StatefulSet has before the describe answer', () => {
    expect(workloadSettingsInfo('StatefulSet', undefined, { serviceName: 's', podManagementPolicy: 'Parallel' }, { misscheduled: 0, unavailable: 0 })).toEqual({
      service_name: 's', pod_management_policy: 'Parallel',
    })
  })

  it('tells the basic rows and what the pods are made from', () => {
    const data = layer('Deployment', DEPLOYMENT, {
      selectorExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }],
      podTemplate: {
        service_account_name: 'web-sa', priority_class_name: 'high', node_selector: { pool: 'gpu' },
        tolerations: [{ key: 'gpu', operator: 'Exists', effect: 'NoSchedule' }],
        securityContext: { runAsUser: 1000, runAsNonRoot: true },
        containers: [{ name: 'app', image: 'web:1', ports: [{ container_port: 80, protocol: 'TCP' }], requests: { cpu: '100m' }, limits: { memory: '1Gi' }, env_count: 3, command: ['start-the-app'] }],
      },
      labels: { app: 'web' },
    }).data
    expect(data).toMatchObject({
      created_at: '2026-01-01T00:00:00Z', uid: 'uid-1', resource_version: '42', generation: 4, observed_generation: 3,
      labels: { app: 'web' },
      selector_expressions: ['tier In a, b'],
      service_account: 'web-sa', priority_class: 'high', node_selector: { pool: 'gpu' },
      tolerations: ['gpu Exists  NoSchedule'],
      pod_security_context: { runAsUser: 1000, runAsNonRoot: true },
      containers: [{ name: 'app', image: 'web:1', ports: ['80 / TCP'], requests: { cpu: '100m' }, limits: { memory: '1Gi' }, env_count: 3 }],
    })
    // a command line can hold a credential: it stays in the window
    expect(JSON.stringify(data)).not.toContain('start-the-app')
  })

  it('tells a StatefulSet its volume claim templates, as the window words them', () => {
    const data = layer('StatefulSet', STATEFUL_SET, {
      volumeClaimTemplates: [{ name: 'data', storage_class_name: 'fast', access_modes: ['ReadWriteOnce'], requests: { storage: '1Gi' } }],
    }).data
    expect(data?.volume_claim_templates).toEqual([{ name: 'data', storage_class: 'fast', access_modes: ['ReadWriteOnce'], requests: { storage: '1Gi' } }])
  })

  it('draws the rows it tells', () => {
    const draw = (describe: Record<string, unknown>, flags: Record<string, boolean>, daemonSetStatus = { misscheduled: 0, unavailable: 0 }) => renderToStaticMarkup(createElement(WorkloadStrategySection, {
      namespace: 'ns', describe, spec: {}, showStrategy: false, strategyType: '-', strategyRolling: undefined, showWorkloadSettings: true,
      showDeploymentSettings: false, showStatefulSetSettings: false, showDaemonSetSettings: false, showReplicaSetSettings: false, daemonSetStatus, ...flags,
    }))
    const cells = (html: string) => html.split(/<[^>]+>/).map((t) => t.trim()).filter(Boolean)
    expect(cells(draw(DEPLOYMENT, { showDeploymentSettings: true }))).toEqual([
      'Workload Settings', 'Revision', '7', 'Paused', 'Yes', 'Min Ready Seconds', '5', 'Progress Deadline', '600s', 'Revision History Limit', '10',
    ])
    expect(cells(draw(STATEFUL_SET, { showStatefulSetSettings: true }))).toEqual([
      'Workload Settings', 'Service Name', 'db-headless', 'Pod Management Policy', 'OrderedReady', 'Min Ready Seconds', '3', 'Revision History Limit', '10',
      'Current Revision', 'db-1', 'Update Revision', 'db-2', 'Collision Count', '0',
    ])
    expect(cells(draw(DAEMON_SET, { showDaemonSetSettings: true }, { misscheduled: 1, unavailable: 1 }))).toEqual([
      'Workload Settings', 'Min Ready Seconds', '2', 'Revision History Limit', '10', 'Collision Count', '0', 'Misscheduled Pods', '1', 'Unavailable Pods', '1',
    ])
    expect(cells(draw(REPLICA_SET, { showReplicaSetSettings: true }))).toEqual([
      'Workload Settings', 'Owner', 'web', 'Revision', '3', 'Min Ready Seconds', '4', 'Fully Labeled Replicas', '2',
    ])
  })
})

describe('the layer stays whole under the budget of a layer', () => {
  it('cuts the long lists and keeps what the window says of the object', () => {
    const pods = Array.from({ length: 30 }, (_, i) => ({ name: `web-${'x'.repeat(40)}-${i}`, status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: `node-${'y'.repeat(30)}` }))
    const events = Array.from({ length: 15 }, (_, i) => ({ type: 'Warning', reason: 'Unhealthy', message: `${i} ${'z'.repeat(300)}`, last_timestamp: NOW }))
    const conditions = Array.from({ length: 8 }, (_, i) => ({ type: `C${i}`, status: 'True', reason: 'r'.repeat(40) }))
    const got = enforceTokenBudget(layer('Deployment', { ...DEPLOYMENT, events, conditions }, { owned: { pods, podsEnabled: true, podsLoaded: true }, labels: { app: 'web' } }))
    expect(got.data?.__truncated__).toBeUndefined()
    expect(got.data).toMatchObject({ revision: '7', paused: 'Yes', strategy: { type: 'RollingUpdate' }, replicas: 3, uid: 'uid-1', labels: { app: 'web' } })
    expect((got.data?.pods as unknown[]).length).toBeGreaterThan(0)
    expect(got.summary).toContain('replicas 2/3')
  })
})
