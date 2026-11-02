import { describe, expect, it } from 'vitest'
import { formatAge } from '@/utils/time'
import { printerCellText } from './printerCells'

describe('printer cells', () => {
  it('reads a cell as the API server printed it: a date as its age, a boolean as Yes/No, numbers and text as given', () => {
    const at = new Date(Date.now() - 3 * 60_000).toISOString()
    expect(printerCellText({ name: 'Seen', type: 'date', value: at }, 'Yes', 'No')).toBe(formatAge(at))
    expect(printerCellText({ name: 'Enabled', type: 'boolean', value: false }, 'Yes', 'No')).toBe('No')
    expect(printerCellText({ name: 'Replicas', type: 'integer', value: 0 }, 'Yes', 'No')).toBe('0')
    expect(printerCellText({ name: 'Tags', type: 'string', value: '["a","b"]' }, 'Yes', 'No')).toBe('["a","b"]')
  })

  it('an empty or missing cell reads "-"', () => {
    expect(printerCellText(undefined, 'Yes', 'No')).toBe('-')
    expect(printerCellText({ name: 'Ready', type: 'string', value: null }, 'Yes', 'No')).toBe('-')
    expect(printerCellText({ name: 'Ready', type: 'string', value: '' }, 'Yes', 'No')).toBe('-')
  })
})
