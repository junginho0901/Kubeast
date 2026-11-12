import { beforeEach, describe, expect, it } from 'vitest'

import { announceCreated, announceDeleted, clearCreated, createdNoticeNow, createdOf, createdText } from './createdNoticeStore'

describe('announceDeleted', () => {
  beforeEach(() => clearCreated())
  const cm = (name: string) => ({ kind: 'ConfigMap', name, namespace: 'shop' })

  it('takes a deleted object off what the page made and names it as deleted', () => {
    announceCreated('/configuration/configmaps', [cm('a'), cm('b')])
    announceDeleted('/configuration/configmaps', cm('a'))
    expect(createdNoticeNow()).toEqual({ path: '/configuration/configmaps', objects: [cm('b')], deleted: [cm('a')] })
    announceDeleted('/configuration/configmaps', cm('b'))
    expect(createdNoticeNow()).toEqual({ path: '/configuration/configmaps', objects: [], deleted: [cm('a'), cm('b')] })
  })

  it('keeps an object of the same name in another namespace or of another kind, and names a delete once', () => {
    announceCreated('/configuration/configmaps', [cm('a'), { kind: 'ConfigMap', name: 'a', namespace: 'other' }, { kind: 'Secret', name: 'a', namespace: 'shop' }])
    announceDeleted('/configuration/configmaps', cm('a'))
    announceDeleted('/configuration/configmaps', { kind: 'ConfigMap', name: 'a', namespace: 'shop' })
    expect(createdNoticeNow()?.objects).toEqual([{ kind: 'ConfigMap', name: 'a', namespace: 'other' }, { kind: 'Secret', name: 'a', namespace: 'shop' }])
    expect(createdNoticeNow()?.deleted).toEqual([cm('a')])
  })

  it('starts over on another page: what was made elsewhere is not carried', () => {
    announceCreated('/configuration/configmaps', [cm('a')])
    announceDeleted('/cluster-view', { kind: 'Pod', name: 'web-1', namespace: 'shop' })
    expect(createdNoticeNow()).toEqual({ path: '/cluster-view', objects: [], deleted: [{ kind: 'Pod', name: 'web-1', namespace: 'shop' }] })
  })

  it('a cluster object has no namespace, and a create after a delete starts a new notice', () => {
    announceDeleted('/cluster/namespaces', { kind: 'Namespace', name: 'shop', namespace: '' })
    expect(createdNoticeNow()?.deleted).toEqual([{ kind: 'Namespace', name: 'shop', namespace: null }])
    announceCreated('/cluster/namespaces', [{ kind: 'Namespace', name: 'shop', namespace: null }])
    expect(createdNoticeNow()).toEqual({ path: '/cluster/namespaces', objects: [{ kind: 'Namespace', name: 'shop', namespace: null }], deleted: [] })
  })
})

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
