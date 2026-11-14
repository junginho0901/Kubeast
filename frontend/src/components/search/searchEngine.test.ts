import { describe, expect, it } from 'vitest'
import { answerFor, compareResults, rememberPrinterStatus, toSearchResult, type SearchAnswer } from './searchEngine'

const NOW = Date.now()
const made = (name: string, agoMs?: number) =>
  toSearchResult({
    kind: 'Pod',
    metadata: { name, namespace: 'default', ...(agoMs === undefined ? {} : { creationTimestamp: new Date(NOW - agoMs).toISOString() }) },
  })

describe('compareResults', () => {
  it('orders Age by creation time, the youngest first and an object without one last', () => {
    const rows = [made('ten-days', 10 * 86_400_000), made('none'), made('thirty-min', 30 * 60_000), made('nine-hours', 9 * 3_600_000)]
    expect(rows.map((r) => r.age)).toEqual(['10d', '-', '30m', '9h'])
    const asc = [...rows].sort((a, b) => compareResults(a, b, 'age'))
    expect(asc.map((r) => r.name)).toEqual(['thirty-min', 'nine-hours', 'ten-days', 'none'])
    const desc = [...rows].sort((a, b) => -compareResults(a, b, 'age'))
    expect(desc.map((r) => r.name)).toEqual(['none', 'ten-days', 'nine-hours', 'thirty-min'])
  })

  it('orders the other columns as text', () => {
    const rows = [made('web-2'), made('api'), made('web-10')]
    expect([...rows].sort((a, b) => compareResults(a, b, 'name')).map((r) => r.name)).toEqual(['api', 'web-10', 'web-2'])
  })
})

describe('the Status column', () => {
  const pod = () => ({ kind: 'Pod', metadata: { name: 'crash', namespace: 'default' }, status: { phase: 'Running' } })

  it("shows kubectl's STATUS the server sent for the object, not its phase", () => {
    const item = pod()
    rememberPrinterStatus(item, 'CrashLoopBackOff')
    expect(toSearchResult(item).status).toBe('CrashLoopBackOff')
  })

  it('shows an empty STATUS cell as -', () => {
    const item = pod()
    rememberPrinterStatus(item, '')
    expect(toSearchResult(item).status).toBe('-')
  })

  it('reads the phase or the Ready condition where the kind prints no STATUS', () => {
    expect(toSearchResult(pod()).status).toBe('Running')
    const deploy = { kind: 'Deployment', metadata: { name: 'web' }, status: { conditions: [{ type: 'Available', status: 'False' }] } }
    expect(toSearchResult(deploy).status).toBe('NotReady')
  })
})

// Advanced Search drew the table behind a deferred value: in the render a search ended, the results of the expression
// or namespace before it showed with the new one's count until the deferred render caught up. An answer now carries
// what it searched and is drawn only for the expression and items on screen.
describe('answerFor', () => {
  const pods = [{ kind: 'Pod', metadata: { name: 'web-0', namespace: 'shop' } }]
  const otherNamespace = [{ kind: 'Pod', metadata: { name: 'job-0', namespace: 'batch' } }]
  const answer: SearchAnswer = { query: "status == 'Running'", items: pods, results: [toSearchResult(pods[0])], timeMs: 3 }

  it('is the answer for its own expression and items', () => {
    expect(answerFor(answer, "status == 'Running'", pods)).toBe(answer)
  })

  it('is none for another expression, other items (another namespace or set of types) or before any answer', () => {
    expect(answerFor(answer, "status == 'Pending'", pods)).toBeNull()
    expect(answerFor(answer, "status == 'Running'", otherNamespace)).toBeNull()
    // the same objects read again are other items: their answer is searched again
    expect(answerFor(answer, "status == 'Running'", [...pods])).toBeNull()
    expect(answerFor(null, "status == 'Running'", pods)).toBeNull()
  })
})
