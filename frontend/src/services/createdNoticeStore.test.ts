import { describe, expect, it } from 'vitest'

import { createdOf, createdText } from './createdNoticeStore'

describe('createdOf', () => {
  it('reads the objects of a create answer and of a refusal that names what was made before it stopped', () => {
    const made = [
      { api_version: 'v1', kind: 'ConfigMap', name: 'first', namespace: 'shop', message: 'ConfigMap first created' },
      { api_version: 'v1', kind: 'Namespace', name: 'shop', namespace: '', message: 'Namespace shop created' },
    ]
    expect(createdOf(made)).toEqual([
      { kind: 'ConfigMap', name: 'first', namespace: 'shop' },
      { kind: 'Namespace', name: 'shop', namespace: null },
    ])
    expect(createdOf({ detail: 'create Service web: already exists', created: made.slice(0, 1) })).toEqual([{ kind: 'ConfigMap', name: 'first', namespace: 'shop' }])
  })

  it('reads nothing from a refusal that made nothing, or from what is not a list of objects', () => {
    expect(createdOf({ detail: 'create ConfigMap first: already exists' })).toEqual([])
    expect(createdOf(null)).toEqual([])
    expect(createdOf('created')).toEqual([])
    expect(createdOf([{ kind: 'ConfigMap' }, null, { name: 'x' }])).toEqual([])
  })
})

describe('createdText', () => {
  it('names an object as kubectl does, with its namespace when it has one', () => {
    expect(createdText({ kind: 'Deployment', name: 'web', namespace: 'shop' })).toBe('Deployment/web (shop)')
    expect(createdText({ kind: 'ClusterRole', name: 'reader', namespace: null })).toBe('ClusterRole/reader')
  })
})
