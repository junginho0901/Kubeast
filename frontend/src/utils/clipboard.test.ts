import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

// the unit tests run without a DOM: navigator and document are stood in per case
const stand = (clipboard: { writeText: (t: string) => Promise<void> } | undefined, execCommand: () => boolean) => {
  const body = { appendChild: vi.fn(), removeChild: vi.fn() }
  vi.stubGlobal('navigator', { clipboard })
  vi.stubGlobal('document', {
    body,
    createElement: () => ({ value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() }),
    execCommand: vi.fn(execCommand),
  })
  return body
}

describe('copying text', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is done by the Clipboard API when it takes it', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stand({ writeText }, () => { throw new Error('not reached') })
    expect(await copyText('kbk_x')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('kbk_x')
  })

  it('falls back to execCommand when the Clipboard API refuses (a page over http)', async () => {
    const body = stand({ writeText: () => Promise.reject(new Error('NotAllowedError')) }, () => true)
    expect(await copyText('secret')).toBe(true)
    expect(body.appendChild).toHaveBeenCalledTimes(1)
    expect(body.removeChild).toHaveBeenCalledTimes(1)
  })

  it('is false when neither copied, so no "Copied" shows', async () => {
    stand({ writeText: () => Promise.reject(new Error('NotAllowedError')) }, () => false)
    expect(await copyText('secret')).toBe(false)
    stand(undefined, () => { throw new Error('no execCommand') })
    expect(await copyText('secret')).toBe(false)
  })
})
