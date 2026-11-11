import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

// the unit tests run without a DOM: navigator and document are stood in per case
const stand = (clipboard: { writeText: (t: string) => Promise<void> } | undefined, execCommand: () => boolean, inModal = false) => {
  const removed = vi.fn()
  const body = { appendChild: vi.fn(), removeChild: vi.fn(), removed }
  const modal = { appendChild: vi.fn() }
  const button = { focus: vi.fn(), closest: () => (inModal ? modal : null) }
  vi.stubGlobal('navigator', { clipboard })
  vi.stubGlobal('document', {
    body,
    activeElement: button,
    createElement: () => ({ value: '', style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: removed }),
    execCommand: vi.fn(execCommand),
  })
  return Object.assign(body, { modal, button })
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
    expect(body.removed, 'the textarea holding the value is removed').toHaveBeenCalledTimes(1)
    expect(body.button.focus, 'focus goes back to the button').toHaveBeenCalled()
  })

  it('puts the textarea inside the window the button is in, which keeps focus inside itself', async () => {
    const body = stand({ writeText: () => Promise.reject(new Error('NotAllowedError')) }, () => true, true)
    expect(await copyText('kbk_once')).toBe(true)
    expect(body.modal.appendChild).toHaveBeenCalledTimes(1)
    expect(body.appendChild).not.toHaveBeenCalled()
  })

  it('is false when neither copied, so no "Copied" shows, and leaves no textarea behind', async () => {
    let body = stand({ writeText: () => Promise.reject(new Error('NotAllowedError')) }, () => false)
    expect(await copyText('secret')).toBe(false)
    expect(body.removed).toHaveBeenCalledTimes(1)
    body = stand(undefined, () => { throw new Error('no execCommand') })
    expect(await copyText('secret')).toBe(false)
    expect(body.removed, 'removed when execCommand throws too').toHaveBeenCalledTimes(1)
  })
})
