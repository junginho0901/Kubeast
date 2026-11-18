import { describe, expect, it } from 'vitest'
import { compareResults, rememberPrinterStatus, searchWithExpression, toSearchResult } from './searchEngine'

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

describe('an expression the engine cannot search', () => {
  const search = (items: Record<string, unknown>[], query: string) => searchWithExpression(items, query, { current: false })
  const pending = { kind: 'Pod', metadata: { name: 'starting' }, status: { phase: 'Pending' } }
  const restarted = { kind: 'Pod', metadata: { name: 'restarted' }, status: { phase: 'Running', containerStatuses: [{ restartCount: 6 }] } }
  const withData = { kind: 'ConfigMap', metadata: { name: 'conf' }, data: { k: 'v' } }

  it("is unreadable with jsep's words when it cannot be parsed, not 0 results", async () => {
    expect(await search([restarted], 'status.containerStatuses?.some(c => c.restartCount > 5)')).toEqual({
      results: [], timeMs: 0, unreadable: 'Expected comma at character 33',
    })
    expect((await search([pending], 'status.phase ==')).unreadable).toBe('Expected expression after == at character 15')
    // read before the objects: no object to search does not hide it
    expect(await search([], 'status.phase ==')).toEqual({ results: [], timeMs: 0, unreadable: 'Expected expression after == at character 15' })
  })

  it("is unreadable with simple-eval's words when it refuses the form, whatever the objects hold", async () => {
    const twice = await search([withData, pending], '!!data')
    expect(twice.results).toEqual([])
    expect(twice.unreadable).toBe('Unexpected operator')
    expect((await search([withData], 'a; b')).unreadable).toBe('Unexpected node')
  })

  it('asks simple-eval about the form once over no data when there is no object: its refusal only, not a data error', async () => {
    const twice = await search([], '!!data')
    expect(twice).toMatchObject({ results: [], unreadable: 'Unexpected operator' })
    // over no data `data` and `spec` are not defined: an error of the data, as for an object without them
    for (const query of ['data != null', 'spec.x > 1']) {
      const searched = await search([], query)
      expect(searched.results).toEqual([])
      expect(searched.unreadable).toBeUndefined()
    }
  })

  it('leaves out an object whose data the expression cannot read, and searches the others', async () => {
    const searched = await search([pending, restarted], 'status.containerStatuses[0].restartCount > 5')
    expect(searched.unreadable).toBeUndefined()
    expect(searched.results).toEqual([restarted])
    const none = await search([pending], 'metadata.labels.app === "web"')
    expect(none).toMatchObject({ results: [] })
    expect(none.unreadable).toBeUndefined()
  })
})
