import { describe, expect, it } from 'vitest'
import { crdVersionsText, servedVersions } from './crdVersions'

describe('CRD versions', () => {
  it('lists the served versions, sorted, a version not served left out — kubectl VERSIONS', () => {
    expect(servedVersions([
      { name: 'v1beta1', served: true, storage: false },
      { name: 'v1alpha2', served: false, storage: false },
      { name: 'v1', served: true, storage: true },
    ])).toEqual(['v1', 'v1beta1'])
    expect(servedVersions(undefined)).toEqual([])
  })

  it('marks the storage version in the cell', () => {
    expect(crdVersionsText({ version: 'v1', served_versions: ['v1', 'v1beta1'] })).toBe('v1 (storage), v1beta1')
    expect(crdVersionsText({ version: 'v1beta1', served_versions: ['v1', 'v1beta1'] })).toBe('v1, v1beta1 (storage)')
    // a storage version the API does not serve is not listed, as kubectl leaves it out
    expect(crdVersionsText({ version: 'v1alpha1', served_versions: ['v1'] })).toBe('v1')
    expect(crdVersionsText({ version: 'v1' })).toBe('v1 (storage)')
  })
})
