import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadNodeShellSettings } from './nodeShellSettings'

function withStored(value: unknown) {
  const store = new Map<string, string>()
  if (value !== undefined) store.set('nodeShellSettings', JSON.stringify(value))
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null })
}

afterEach(() => vi.unstubAllGlobals())

describe('loadNodeShellSettings', () => {
  it('leaves the image to the server by default', () => {
    withStored(undefined)
    expect(loadNodeShellSettings().linuxImage).toBe('')
  })

  // The old built-in default would be refused once the server's allow list
  // moves to a pinned version.
  it('reads the old built-in default as the server default', () => {
    withStored({ isEnabled: true, namespace: 'default', linuxImage: 'docker.io/library/busybox:latest' })
    expect(loadNodeShellSettings().linuxImage).toBe('')
  })

  it('keeps an image the user chose', () => {
    withStored({ linuxImage: 'registry.internal/debug:1' })
    expect(loadNodeShellSettings().linuxImage).toBe('registry.internal/debug:1')
  })
})
