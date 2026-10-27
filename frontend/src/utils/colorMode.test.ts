import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLOR_MODE_KEY, getColorMode, setColorMode } from './colorMode'

let store: Map<string, string>
let dataset: Record<string, string>

beforeEach(() => {
  store = new Map()
  dataset = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('document', { documentElement: { dataset } })
})

afterEach(() => vi.unstubAllGlobals())

describe('color mode', () => {
  it('is default with nothing stored or an unknown value', () => {
    expect(getColorMode()).toBe('default')
    store.set(COLOR_MODE_KEY, 'sepia')
    expect(getColorMode()).toBe('default')
  })

  it('keeps dark in the browser and puts it on <html>', () => {
    setColorMode('dark')
    expect(store.get(COLOR_MODE_KEY)).toBe('dark')
    expect(dataset.colorMode).toBe('dark')
    expect(getColorMode()).toBe('dark')
  })

  it('default removes the stored value and the attribute', () => {
    setColorMode('dark')
    setColorMode('default')
    expect(store.has(COLOR_MODE_KEY)).toBe(false)
    expect('colorMode' in dataset).toBe(false)
    expect(getColorMode()).toBe('default')
  })

  it('still changes the page when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    setColorMode('dark')
    expect(dataset.colorMode).toBe('dark')
    expect(getColorMode()).toBe('default')
  })
})
