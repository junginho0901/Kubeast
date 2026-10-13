import { describe, expect, it } from 'vitest'
import { formatMoney, formatPercent } from './money'

describe('formatMoney', () => {
  it('shows more decimals the smaller the amount', () => {
    expect(formatMoney(1234.5)).toBe('$1,235')
    expect(formatMoney(12.345)).toBe('$12.35')
    expect(formatMoney(0.5)).toBe('$0.5000')
    expect(formatMoney(0.00051)).toBe('$0.000510')
    expect(formatMoney(0)).toBe('$0')
  })
  it('takes the currency and says "-" for no number', () => {
    expect(formatMoney(3, 'EUR')).toBe('€3.00')
    expect(formatMoney(undefined)).toBe('-')
    expect(formatMoney(Number.NaN)).toBe('-')
  })
})

describe('formatPercent', () => {
  it('rounds a share to a whole percent', () => {
    expect(formatPercent(0.13666)).toBe('14%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(undefined)).toBe('-')
  })
})
