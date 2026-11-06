import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddresses, formatBackends, formatHosts, formatRules, ingressToRawJson } from '@/pages/network/ingresses/ingressHelpers'
import { applyIngressWatchEvent, normalizeWatchIngressObject } from '@/pages/network/ingresses/ingressWatchNormalize'
import { errorText, statusLabel, volumeAttachmentToRawJson } from '@/pages/storage/volumeattachments/volumeAttachmentHelpers'
import { applyVolumeAttachmentWatchEvent, normalizeWatchVolumeAttachmentObject } from '@/pages/storage/volumeattachments/volumeAttachmentWatchNormalize'
import { cronJobToWorkloadRawJson, nextRunOf } from '@/pages/workloads/cronjobs/cronJobHelpers'
import { applyCronJobWatchEvent, normalizeWatchCronJobObject } from '@/pages/workloads/cronjobs/cronJobWatchNormalize'
import cases from './watchRows.cases.json'

type Page = {
  apply: (prev: any[], event: { type?: string; object?: any }) => any[]
  normalize: (obj: any) => any
  // what the list page reads off a row, in the terms the server's case writes by hand
  shows: (row: any) => Record<string, unknown>
  // what else the page derives from the row: the drawer's object and, for a CronJob, the next run
  derives: (row: any) => unknown
}

const pages: Record<string, Page> = {
  ingresses: {
    apply: applyIngressWatchEvent,
    normalize: normalizeWatchIngressObject,
    shows: (row) => ({
      class: row.class || '-',
      hosts: formatHosts(row),
      backends: formatBackends(row),
      addresses: formatAddresses(row),
      rules: formatRules(row),
      tls: (row.tls || []).length,
    }),
    derives: ingressToRawJson,
  },
  volumeattachments: {
    apply: applyVolumeAttachmentWatchEvent,
    normalize: normalizeWatchVolumeAttachmentObject,
    shows: (row) => ({ attached: row.attached, status: statusLabel(row), error: errorText(row) }),
    derives: volumeAttachmentToRawJson,
  },
  cronjobs: {
    apply: applyCronJobWatchEvent,
    normalize: normalizeWatchCronJobObject,
    shows: (row) => ({
      schedule: row.schedule,
      suspend: row.suspend,
      active: row.active,
      concurrency_policy: row.concurrency_policy ?? null,
      last_schedule_time: row.last_schedule_time ?? null,
      last_successful_time: row.last_successful_time ?? null,
      time_zone: row.time_zone ?? null,
      containers: (row.containers || []).join(', ') || '-',
      images: (row.images || []).join(', ') || '-',
    }),
    derives: (row) => ({ next_run: nextRunOf(row)?.toISOString() ?? null, raw: cronJobToWorkloadRawJson(row) }),
  },
}

// k8s-service's TestWatchRowCasesFixture writes these: one object through the real list code and the real live update
// code, and what the page should show.
describe('a live update leaves a row as the list API gives it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the server wrote cases for every list these tests name', () => {
    expect(new Set(cases.map((c) => c.resource))).toEqual(new Set(Object.keys(pages)))
    expect(cases.length).toBeGreaterThanOrEqual(11)
  })

  for (const c of cases) {
    it(c.name, () => {
      const page = pages[c.resource]
      const [row] = page.apply([c.before], { type: 'MODIFIED', object: c.event })
      expect(page.shows(row)).toEqual(c.shows)
      expect(page.shows(c.after)).toEqual(c.shows)
      expect(page.derives(row)).toEqual(page.derives(c.after))
      expect(row).toEqual(page.normalize(c.after))
    })
  }
})

describe('a row the server could not convert comes with its object nested', () => {
  it('a VolumeAttachment reads its state from status, not from the top of the row', () => {
    const nested = {
      name: 'disk-a',
      kind: 'VolumeAttachment',
      created_at: '2026-11-01T00:00:00Z',
      spec: { attacher: 'csi.example.test', nodeName: 'node-a', source: { persistentVolumeName: 'pv-a' } },
      status: { attached: true },
    }
    const prior = { name: 'disk-a', attached: false, attach_error: { message: 'attach failed' } }
    const [row] = applyVolumeAttachmentWatchEvent([prior], { type: 'MODIFIED', object: nested })
    expect(row).toEqual({
      name: 'disk-a',
      attacher: 'csi.example.test',
      node_name: 'node-a',
      persistent_volume_name: 'pv-a',
      attached: true,
      attach_error: null,
      detach_error: null,
      created_at: '2026-11-01T00:00:00Z',
    })
    expect(statusLabel(row)).toBe('Attached')
  })

  it('an Ingress keeps its name and namespace, so the row updates and a deleted one goes', () => {
    const nested = {
      name: 'web',
      namespace: 'demo',
      kind: 'Ingress',
      labels: { team: 'a' },
      created_at: '2026-11-01T00:00:00Z',
      spec: { rules: [{ host: 'example.test' }] },
      status: {},
    }
    const prior = { name: 'web', namespace: 'demo', hosts: ['old.example.test'], backends: [] }
    const [row] = applyIngressWatchEvent([prior], { type: 'MODIFIED', object: nested })
    expect(formatHosts(row)).toBe('example.test')
    expect(row.labels).toEqual({ team: 'a' })
    expect(row.created_at).toBe('2026-11-01T00:00:00Z')
    expect(applyIngressWatchEvent([prior], { type: 'DELETED', object: nested })).toEqual([])
  })
})
