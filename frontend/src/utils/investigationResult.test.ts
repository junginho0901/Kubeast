import { describe, expect, it } from 'vitest'

import type { Investigation, InvestigationResult, InvestigationVerdict } from '@/services/api/investigations'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { CHAT_NOTES, CHAT_REPORT_WITH_RESULT, callLabel, checkText, cutText, ledgerOn, notClosedText, notLookedAtText, notVerifiedText, orderedHypotheses, outcomeBadge, outcomeText, outcomeWhyText, reportForChat, reportLayer, resultForChat, resultNotes, sourceText, stateBadge, stateText } from './investigationResult'

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

const VERDICT: InvestigationVerdict = {
  outcome: 'cannot_tell',
  said: 'cause_found',
  why: ['no_symptom'],
  symptom: { resource: 'Deployment/apps/web', evidence: [] },
  looked_at: [{ source: 'objects', calls: [{ call: 1, tool: 'k8s_get_resources' }] }],
  checked_normal: [{ check: 'restarts', call: 2, tool: 'anomaly_rank', namespace: 'apps', since: '2026-10-13T11:35:00Z', until: '2026-10-13T12:00:00Z' }],
  not_looked_at: [
    { source: 'traces', reason: 'not_offered' },
    { check: 'trace_errors', reason: 'not_run', detail: 'no trace store', call: 2, tool: 'anomaly_rank', namespace: 'apps' },
    { call: 3, tool: 'loki_query', reason: 'failed', detail: 'forbidden' },
  ],
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
    expect(notClosedText({ ...RESULT.hypotheses[1], closed: false, problems: [{ reason: 'not_verified' }] }, tr))
      .toBe(`Not closed: ${en.investigations.result.problem.not_verified}`)
    expect(ko.investigations.result.problem.not_verified).toBeTruthy()
  })

  it('says when the block could not be read and when the model was asked again', () => {
    expect(resultNotes(RESULT, tr)).toEqual([])
    expect(resultNotes({ ...RESULT, status: 'missing', asked_again: true }, tr)).toEqual([
      en.investigations.result.missing, en.investigations.result.askedAgain,
    ])
    expect(resultNotes({ ...RESULT, asked_again: true, ask_failed: true }, tr)).toEqual([en.investigations.result.askFailed])
    expect(resultNotes({ ...RESULT, status: 'cut', asked_again: true }, tr)).toEqual([
      en.investigations.result.cut, en.investigations.result.askedAgain,
    ])
  })

  it('says why a cause is not verified, and reads the ledger as on for a row without checks', () => {
    expect(notVerifiedText({ ...RESULT.causes[0], verified: false, reason: 'name_missing' }, tr))
      .toBe('Not verified: its name does not appear in what the calls returned')
    expect(notVerifiedText({ ...RESULT.causes[0], verified: false }, tr)).toBe('Not verified')
    // [1, 999]: call 1 is drawn beside the mark, so the reason says one call given is not a call that answered
    expect(notVerifiedText({ ...RESULT.causes[0], raw_evidence: [1, 999], verified: false, reason: 'bad_calls' }, tr))
      .toBe('Not verified: a call given is not a call of this investigation that answered')
    expect(en.investigations.result.unverified.bad_calls).toBe('a call given is not a call of this investigation that answered')
    for (const reason of ['no_evidence', 'bad_calls', 'name_missing', 'after_alert']) {
      expect((en.investigations.result.unverified as Record<string, string>)[reason]).toBeTruthy()
      expect((ko.investigations.result.unverified as Record<string, string>)[reason]).toBeTruthy()
    }
    expect(ledgerOn(RESULT)).toBe(true)
    expect(ledgerOn({ ...RESULT, checks: { evidence: true, ledger: false } })).toBe(false)
  })

  it('says how many of how many a list the server cut shows, and nothing for one that fits', () => {
    expect(cutText({ given: 11, kept: 10 }, tr)).toBe('Showing the first 10 of 11: the server did not keep the rest.')
    expect(cutText(undefined, tr)).toBe('')
    expect(en.investigations.result.partial).toBe('Showing the first {{shown}} of {{total}}: the server did not keep the rest.')
    expect(ko.investigations.result.partial).toBe('{{total}}개 중 앞의 {{shown}}개를 보여 줍니다. 나머지는 서버가 저장하지 않았습니다.')
  })
})

describe('the outcome of an investigation', () => {
  it('gives each outcome, reason and source its words in both catalogs', () => {
    for (const outcome of ['cause_found', 'no_fault', 'cannot_tell'] as const) {
      expect(outcomeBadge[outcome]).toMatch(/^badge badge-/)
      expect(en.investigations.result.outcome[outcome]).toBe(outcomeText(outcome, tr))
      expect(ko.investigations.result.outcome[outcome]).toBeTruthy()
    }
    for (const why of Object.keys(en.investigations.result.outcomeWhy)) {
      expect(outcomeWhyText({ ...VERDICT, said: null, why: [why] }, tr))
        .toBe(`Kept by the server: ${(en.investigations.result.outcomeWhy as Record<string, string>)[why]}.`)
      expect((ko.investigations.result.outcomeWhy as Record<string, string>)[why]).toBeTruthy()
    }
    for (const source of Object.keys(en.investigations.result.source)) {
      expect((en.investigations.result.source as Record<string, string>)[source]).toBe(sourceText(source, tr))
      expect((ko.investigations.result.source as Record<string, string>)[source]).toBeTruthy()
    }
    expect(Object.keys(ko.investigations.result.notLooked)).toEqual(Object.keys(en.investigations.result.notLooked))
  })

  it('says why the server keeps another outcome than the report, and nothing when it keeps it', () => {
    expect(outcomeWhyText(VERDICT, tr)).toBe('Kept by the server. The report says "Cause found", but no call is given that shows the alert\'s symptom.')
    expect(outcomeWhyText({ ...VERDICT, outcome: 'cause_found', why: [] }, tr)).toBe('')
  })

  it('names what was not looked at by its source, its check or its call', () => {
    expect(VERDICT.not_looked_at.map((n) => notLookedAtText(n, tr))).toEqual([
      'Traces: the cluster offers no tool for it',
      'trace_errors (apps): the check did not run (no trace store)',
      '#3 loki_query: the call failed or was refused (forbidden)',
    ])
    expect(checkText({ check: 'restarts', namespace: 'apps', workload: 'Deployment/web' })).toBe('restarts (apps, Deployment/web)')
  })

  it('reaches the floating chat with the server lists, and a result without one is as it was', () => {
    const told = resultForChat({ ...RESULT, verdict: VERDICT })
    expect(told.outcome).toBe('cannot_tell')
    expect(told.outcome_said).toBe('cause_found')
    expect(told.checked_normal).toEqual(['restarts (apps) #2 anomaly_rank'])
    expect(told.not_looked_at).toEqual(['traces: not_offered', 'trace_errors (apps): not_run', '#3 loki_query: failed'])
    expect('outcome' in resultForChat(RESULT)).toBe(false)
    expect(Object.keys(resultForChat(RESULT))).toEqual(['status', 'no_fault', 'asked_again', 'causes', 'path', 'ruled_out', 'hypotheses'])
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

  it('tells a cause the calls do not show as not verified, and no hypotheses without the ledger', () => {
    const result: InvestigationResult = {
      ...RESULT,
      causes: [{ ...RESULT.causes[0], verified: false, reason: 'name_missing' }, { ...RESULT.causes[0], resource: 'Pod/apps/web-1', verified: true }],
      hypotheses: [],
      checks: { evidence: true, ledger: false },
    }
    const told = resultForChat(result)
    expect(told.causes).toEqual([
      { resource: 'Deployment/apps/web', kind: 'rollout', started_at: '2026-10-13T11:41:00Z', evidence: ['#1 timeline'], verified: false, not_verified: 'name_missing' },
      { resource: 'Pod/apps/web-1', kind: 'rollout', started_at: '2026-10-13T11:41:00Z', evidence: ['#1 timeline'], verified: true },
    ])
    expect('hypotheses' in told).toBe(false)
    expect('hypotheses' in resultForChat(RESULT)).toBe(true)
  })

  it('tells the floating chat which lists the server cut and how many were given', () => {
    const cut = { causes: { given: 11, kept: 10 }, path: { given: 14, kept: 12 } }
    const told = resultForChat({ ...RESULT, causes: [{ ...RESULT.causes[0], cut: { evidence: { given: 25, kept: 20 } } }], cut })
    expect(told.cut).toEqual(cut)
    expect((told.causes as Record<string, unknown>[])[0].cut).toEqual({ evidence: { given: 25, kept: 20 } })
    expect('cut' in resultForChat(RESULT)).toBe(false)
    expect('cut' in (resultForChat(RESULT).causes as Record<string, unknown>[])[0]).toBe(false)
    const side = { for: { given: 21, kept: 20 } }
    const hypotheses = resultForChat({ ...RESULT, hypotheses: [{ ...RESULT.hypotheses[1], cut: side }] }).hypotheses as Record<string, unknown>[]
    expect(hypotheses[0].cut).toEqual(side)
    expect((resultForChat(RESULT).hypotheses as Record<string, unknown>[]).some((h) => 'cut' in h)).toBe(false)
  })

  it("keeps the server's notes under a report it cuts", () => {
    const note = '\n\n---\n\nNot verified by the server: no tool result of this investigation shows the causes below, so read them as hypotheses.\n- StatefulSet/apps/db: db does not appear in what calls 1 returned'
    const report = `## Summary\n${'r'.repeat(3000)}\n\n---\n\nthe model's own rule\n${'s'.repeat(2000)}${note}`
    const layer = reportLayer(investigation({ report, result: RESULT }))
    const told = layer.data?.report as string
    expect(told.length).toBe(CHAT_REPORT_WITH_RESULT)
    expect(told.startsWith('## Summary\nrrr')).toBe(true)
    expect(told.endsWith(note)).toBe(true)
    expect(told).not.toContain("the model's own rule")  // the rule of the report itself is too far from the end
    expect(reportForChat('short', CHAT_REPORT_WITH_RESULT)).toBe('short')
    const noNotes = 'x'.repeat(5000)
    expect(reportForChat(noNotes, CHAT_REPORT_WITH_RESULT)).toBe(noNotes.slice(0, CHAT_REPORT_WITH_RESULT))
    const longNotes = `${'x'.repeat(3000)}\n\n---\n\n${'n'.repeat(CHAT_NOTES)}`  // notes past the room: the start only
    expect(reportForChat(longNotes, CHAT_REPORT_WITH_RESULT)).toBe(longNotes.slice(0, CHAT_REPORT_WITH_RESULT))
  })

  it('stays within the 8 KB layer budget with names at the server cap, leaving the hypotheses out first', () => {
    const name = (i: number) => `Deployment/apps/${'w'.repeat(280)}-${i}`
    const calls = [{ call: 1, tool: 'timeline' }, { call: 2, tool: 'k8s_get_pod_logs' }, { call: 3, tool: 'k8s_get_events' }]
    const huge: InvestigationResult = {
      ...RESULT,
      causes: Array.from({ length: 10 }, (_v, i) => ({ ...RESULT.causes[0], resource: name(i), evidence: calls, verified: false, reason: 'name_missing' as const })),
      path: Array.from({ length: 12 }, (_v, i) => name(i)),
      ruled_out: Array.from({ length: 20 }, (_v, i) => name(i)),
      hypotheses: Array.from({ length: 12 }, (_v, i) => ({ ...RESULT.hypotheses[1], id: `h${i}`, statement: 'x'.repeat(300), resource: name(i), for: calls })),
    }
    const data = reportLayer(investigation({ result: huge, report: 'r'.repeat(5000) })).data
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(8192)
    const told = data?.result as Record<string, unknown>
    expect(told.hypotheses).toBeUndefined()
    expect(told.hypotheses_left_out).toBe(12)
    const causes = told.causes as { resource: string }[]
    expect(causes.length).toBe(10)
    expect(causes.every((c) => c.resource.length <= 120)).toBe(true)
    expect((data?.report as string).length).toBe(CHAT_REPORT_WITH_RESULT)
    // a result that fits leaves nothing out
    expect(JSON.stringify(reportLayer(investigation({ result: RESULT })).data)).not.toContain('_left_out')
  })

  it("gives up the hypotheses, then the calls' arguments, before the causes when 24 calls fill the layer", () => {
    const query = (i: number) => `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="apps", pod=~"web-.*"}[5m])) # ${i} ${'x'.repeat(120)}`
    const calls = Array.from({ length: 24 }, (_v, i) => ({ tool: 'prometheus_query', args: { query: query(i) }, step: 1, result_chars: 900 }))
    const data = reportLayer(investigation({ result: RESULT, tool_calls: calls, report: 'r'.repeat(5000) })).data
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(8192)
    const told = data?.result as Record<string, unknown>
    expect(told.hypotheses_left_out).toBe(4)
    expect((told.causes as unknown[]).length).toBe(1)
    const shown = data?.tool_calls as Record<string, unknown>[]
    expect(shown.length).toBe(24)
    expect(shown.every((c) => !('args' in c) && c.tool === 'prometheus_query')).toBe(true)
    expect(data?.tool_args_left_out).toBe(true)
  })

  it('stays within the 8 KB layer budget with a full result', () => {
    const long = 'x'.repeat(300)
    const full: InvestigationResult = {
      ...RESULT,
      causes: Array.from({ length: 10 }, () => ({ ...RESULT.causes[0], resource: `Deployment/apps/${'w'.repeat(60)}`, verified: false, reason: 'after_alert' as const })),
      path: Array.from({ length: 12 }, (_v, i) => `Pod/apps/p-${i}`),
      ruled_out: Array.from({ length: 6 }, (_v, i) => `Node/n-${i}`),
      hypotheses: Array.from({ length: 12 }, (_v, i) => ({ ...RESULT.hypotheses[1], id: `h${i}`, statement: long, resource: 'Deployment/apps/web' })),
    }
    const notes = `\n\n---\n\n${'n'.repeat(CHAT_NOTES - 7)}`
    const data = reportLayer(investigation({ result: full, report: 'r'.repeat(5000) + notes })).data
    expect((data?.report as string).endsWith(notes)).toBe(true)
    expect(new Blob([JSON.stringify(data)]).size).toBeLessThanOrEqual(8192)
  })
})
