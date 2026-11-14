import { describe, expect, it } from 'vitest'

import type { Investigation, InvestigationResult } from '@/services/api/investigations'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { CHAT_REPORT_WITH_RESULT, callLabel, notClosedText, orderedHypotheses, reportLayer, resultForChat, resultNotes, stateBadge, stateText } from './investigationResult'

const tr = (_key: string, fallback: string, opts?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''))

const RESULT: InvestigationResult = {
  version: 1,
  status: 'ok',
  no_fault: false,
  causes: [{ resource: 'Deployment/apps/web', kind: 'rollout', started_at: '2026-10-13T11:41:00Z', evidence: [{ call: 1, tool: 'timeline' }] }],
  path: ['Deployment/apps/web', 'Pod/apps/web-1', 'Service/apps/web'],
  ruled_out: ['Node/kind-worker'],
  hypotheses: [
    { id: 'h1', statement: 'The node ran out of memory', resource: 'Node/kind-worker', state: 'ruled_out', for: [], against: [{ call: 3, tool: 'k8s_describe_resource' }], closed: true },
    { id: 'h2', statement: 'Image web:1.5 crashes on start', resource: 'Deployment/apps/web', state: 'cause', for: [{ call: 1, tool: 'timeline' }, { call: 2, tool: 'k8s_get_pod_logs' }], against: [], closed: true },
    { id: 'h3', statement: 'The database is down', resource: 'StatefulSet/apps/db', state: 'open', for: [], against: [], closed: false, problems: [{ reason: 'open' }, { reason: 'bad_calls', calls: ['9'] }] },
    { id: 'h4', statement: 'Traces show the slow span', resource: '', state: 'blocked', for: [{ call: 4, tool: 'traces_search', failed: true }], against: [], blocked: 'traces_search is not offered', closed: true },
  ],
  asked_again: false,
}

const BASE: Investigation = {
  id: 'inv-1', cluster: 'self', fingerprint: 'fp', alertname: 'KubePodCrashLooping', severity: 'critical', namespace: 'apps', status: 'done',
  skip_reason: '', received_at: '2026-10-13T12:00:00Z', started_at: null, finished_at: null, repeat_count: 1, last_seen_at: '2026-10-13T12:00:00Z',
  model: 'm', total_tokens: 10, iterations: 3, tool_call_count: 1, duration_ms: 1000, labels: { alertname: 'KubePodCrashLooping' },
  annotations: {}, starts_at: null, generator_url: '', alertmanager_url: '', provider: 'ollama', prompt_tokens: 5, completion_tokens: 5,
  tool_calls: [{ tool: 'timeline', args: { view: 'changes' }, step: 0, result_chars: 10 }], report: 'r'.repeat(5000), error: '',
}

const investigation = (extra: Partial<Investigation> = {}): Investigation => ({ ...BASE, ...extra })

describe('an investigation result', () => {
  it('lists the hypotheses causes first and ruled out last, in the model order within a state', () => {
    expect(orderedHypotheses(RESULT).map((h) => h.id)).toEqual(['h2', 'h3', 'h4', 'h1'])
  })

  it('names each call by its number in the tool calls and its tool', () => {
    expect(callLabel({ call: 3, tool: 'prometheus_query' })).toBe('#3 prometheus_query')
  })

  it('gives every state a badge and a catalog entry in both languages', () => {
    for (const state of ['cause', 'symptom', 'open', 'blocked', 'ruled_out'] as const) {
      expect(stateBadge[state]).toMatch(/^badge badge-/)
      expect((en.investigations.result.state as Record<string, string>)[state]).toBe(stateText(state, tr))
      expect((ko.investigations.result.state as Record<string, string>)[state]).toBeTruthy()
    }
  })

  it('says why a hypothesis is not closed', () => {
    expect(notClosedText(RESULT.hypotheses[2], tr)).toBe('Not closed: no state of the four; 9 name no call of this investigation')
    expect(notClosedText({ ...RESULT.hypotheses[1], closed: false, problems: [{ reason: 'no_evidence', side: 'against' }] }, tr))
      .toBe('Not closed: no call that answered speaks against it')
  })

  it('says when the block could not be read and when the model was asked again', () => {
    expect(resultNotes(RESULT, tr)).toEqual([])
    expect(resultNotes({ ...RESULT, status: 'missing', asked_again: true }, tr)).toEqual([
      en.investigations.result.missing, en.investigations.result.askedAgain,
    ])
    expect(resultNotes({ ...RESULT, asked_again: true, ask_failed: true }, tr)).toEqual([en.investigations.result.askFailed])
  })
})

describe("the report window's layer for the floating chat", () => {
  it('is what it was without a result', () => {
    const layer = reportLayer(investigation())
    expect(Object.keys(layer.data ?? {})).toEqual([
      'alertname', 'cluster', 'namespace', 'severity', 'status', 'labels', 'received_at', 'model', 'iterations', 'tool_calls', 'error',
      'skip_reason', 'report',
    ])
    expect(layer.source).toBe('InvestigationModal')
    expect((layer.data?.report as string).length).toBe(4096)
    expect(JSON.stringify(layer)).not.toContain('"result"')
  })

  it('carries the result with each call by number and tool, and a shorter report', () => {
    const layer = reportLayer(investigation({ result: RESULT }))
    const result = layer.data?.result as ReturnType<typeof resultForChat>
    expect(result).toEqual(resultForChat(RESULT))
    expect(result.causes).toEqual([{ resource: 'Deployment/apps/web', kind: 'rollout', started_at: '2026-10-13T11:41:00Z', evidence: ['#1 timeline'] }])
    const hypotheses = result.hypotheses as Record<string, unknown>[]
    expect(hypotheses.map((h) => h.state)).toEqual(['cause', 'open', 'blocked', 'ruled_out'])
    expect(hypotheses[0].for).toEqual(['#1 timeline', '#2 k8s_get_pod_logs'])
    expect(hypotheses[1].not_closed).toEqual(['open', 'bad_calls'])
    expect(hypotheses[2].blocked).toBe('traces_search is not offered')
    expect((layer.data?.report as string).length).toBe(CHAT_REPORT_WITH_RESULT)
  })

  it('stays within the 8 KB layer budget with a full result', () => {
    const long = 'x'.repeat(300)
    const full: InvestigationResult = {
      ...RESULT,
      causes: Array.from({ length: 10 }, () => ({ ...RESULT.causes[0], resource: `Deployment/apps/${'w'.repeat(60)}` })),
      path: Array.from({ length: 12 }, (_v, i) => `Pod/apps/p-${i}`),
      ruled_out: Array.from({ length: 6 }, (_v, i) => `Node/n-${i}`),
      hypotheses: Array.from({ length: 12 }, (_v, i) => ({ ...RESULT.hypotheses[1], id: `h${i}`, statement: long, resource: 'Deployment/apps/web' })),
    }
    const data = reportLayer(investigation({ result: full })).data
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(8192)
  })
})
