import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConditionsTable } from './DetailCommon'

const html = (conditions: unknown[]) => renderToStaticMarkup(createElement(ConditionsTable, { conditions: conditions as any[] }))
const head = (out: string) => [...(out.split('</thead>')[0] ?? '').matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])
const cells = (out: string) => [...(out.split('<tbody')[1] ?? '').matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)]
  .map((row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]+>/g, '')))

describe('ConditionsTable', () => {
  it('says which generation each condition was written for, under either name the answers use', () => {
    const out = html([
      { type: 'Accepted', status: 'True', reason: 'Ok', message: 'fine', observedGeneration: 7 },
      { type: 'Programmed', status: 'False', reason: 'Wait', message: 'not yet', observed_generation: 6 },
      { type: 'Resolved', status: 'True', reason: 'Ok', message: 'no generation here' },
    ])
    expect(head(out)).toEqual(['Type', 'Status', 'Reason', 'Message', 'Observed Generation', 'Last Transition'])
    expect(cells(out).map((row) => row[4])).toEqual(['7', '6', '-'])
  })

  it('keeps the five columns for conditions of a kind that has no such field', () => {
    const out = html([{ type: 'Available', status: 'True', reason: 'Ok', message: 'fine' }])
    expect(head(out)).toEqual(['Type', 'Status', 'Reason', 'Message', 'Last Transition'])
    expect(cells(out)[0]).toHaveLength(5)
  })

  it('shows a generation of 0 as a value, not as an empty cell', () => {
    const out = html([{ type: 'Accepted', status: 'True', observedGeneration: 0 }])
    expect(head(out)).toContain('Observed Generation')
    expect(cells(out)[0][4]).toBe('0')
  })
})
