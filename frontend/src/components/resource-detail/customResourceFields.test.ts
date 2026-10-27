import { describe, expect, it } from 'vitest'
import { JSONPath } from 'jsonpath-plus'
import { printerColumnObject } from './customResourceFields'

describe('printerColumnObject', () => {
  it('reads printer columns that point outside spec and status (a PolicyReport)', () => {
    const obj = printerColumnObject({
      name: 'r1',
      fields: { scope: { kind: 'Pod', name: 'web' }, summary: { pass: 1, fail: 1 } },
      spec: {},
    })
    const read = (path: string) => JSONPath({ path: '$' + path, json: obj, wrap: false })
    expect(read('.scope.kind')).toBe('Pod')
    expect(read('.summary.fail')).toBe(1)
    expect(read('.metadata.name')).toBe('r1')
  })

  it('keeps metadata, spec and status from the describe answer over a field of the same name', () => {
    const obj = printerColumnObject({ name: 'r1', fields: { metadata: { name: 'other' }, spec: 'x' }, spec: { a: 1 } })
    expect(obj.metadata).toMatchObject({ name: 'r1' })
    expect(obj.spec).toEqual({ a: 1 })
  })
})
