import { describe, expect, it } from 'vitest'
import { formatBytes, highlightParts, keepsLines, logSearchRead, rangeOptions } from './logSearch'

describe('highlightParts', () => {
  it('marks a literal, case-sensitively unless asked', () => {
    expect(highlightParts('ERROR a.b error', 'error', false, false)).toEqual([
      { text: 'ERROR a.b ', match: false },
      { text: 'error', match: true },
    ])
    expect(highlightParts('ERROR a.b error', 'error', false, true).filter((p) => p.match).map((p) => p.text)).toEqual(['ERROR', 'error'])
    // the dot is a literal, not "any character"
    expect(highlightParts('axb a.b', 'a.b', false, false).filter((p) => p.match).map((p) => p.text)).toEqual(['a.b'])
  })

  it('marks regular expression matches', () => {
    expect(highlightParts('took 120ms then 7ms', '\\d+ms', true, false).filter((p) => p.match).map((p) => p.text)).toEqual(['120ms', '7ms'])
  })

  it('leaves the line whole without a query, with a pattern JavaScript cannot compile, or one that matches empty', () => {
    expect(highlightParts('x', '', false, false)).toEqual([{ text: 'x', match: false }])
    expect(highlightParts('x(', '(', true, false)).toEqual([{ text: 'x(', match: false }])
    expect(highlightParts('abc', 'z*', true, false)).toEqual([{ text: 'abc', match: false }])
  })

  it('keeps every character of the line', () => {
    const line = 'GET /api 500 in 30ms (error: upstream)'
    expect(highlightParts(line, 'error|500', true, true).map((p) => p.text).join('')).toBe(line)
  })
})

describe('rangeOptions and formatBytes', () => {
  it('offers presets up to the maximum', () => {
    expect(rangeOptions(1440)).toEqual([15, 60, 360, 1440])
    expect(rangeOptions(60)).toEqual([15, 60])
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

// A new search showed the lines of the search, pod or container before it until its answer came, highlighted with
// the new text: another read now starts from none; Load older and the same search again keep them.
describe('the lines a running search keeps', () => {
  const place = { cluster: 'self', namespace: 'shop', pod: 'web-0', container: 'app' }
  const filter = { q: 'error', regex: false, ignoreCase: true, minutes: 60 }
  const shown = logSearchRead(place, filter)

  it('keeps them for Load older and for the same search pressed again', () => {
    expect(keepsLines(shown, shown, true)).toBe(true)
    expect(keepsLines(shown, logSearchRead({ ...place }, { ...filter }), false)).toBe(true)
  })

  it('drops them for another text, match, case, range, LogQL, pod, container, workload or cluster', () => {
    const others = [
      logSearchRead(place, { ...filter, q: 'warn' }),
      logSearchRead(place, { ...filter, regex: true }),
      logSearchRead(place, { ...filter, ignoreCase: false }),
      logSearchRead(place, { ...filter, minutes: 15 }),
      logSearchRead(place, { ...filter, q: '', logql: '{} |= "error"' }),
      logSearchRead({ ...place, pod: 'web-1' }, filter),
      logSearchRead({ ...place, container: 'sidecar' }, filter),
      logSearchRead({ cluster: 'self', namespace: 'shop', kind: 'Deployment', name: 'web' }, filter),
      logSearchRead({ ...place, cluster: 'default' }, filter),
    ]
    for (const read of others) expect(keepsLines(shown, read, false), read).toBe(false)
    expect(new Set(others).size, 'each read its own').toBe(others.length)
  })

  it('has nothing to keep before the first answer', () => {
    expect(keepsLines(null, shown, false)).toBe(false)
  })
})
