import { describe, expect, it } from 'vitest'
import { formatBytes, highlightParts, rangeOptions } from './logSearch'

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
