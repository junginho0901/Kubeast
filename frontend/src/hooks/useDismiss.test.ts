import { describe, expect, it, vi } from 'vitest'
import { dismissHandlers } from './useDismiss'

// Codex QA Q10: the Namespace and Fit lists stayed open on Escape.
describe('dismissHandlers', () => {
  const inside = { node: {} as Node }
  const box = { contains: (n: Node | null) => n === inside.node }

  it('Escape closes the list and goes no further', () => {
    const close = vi.fn()
    const stopPropagation = vi.fn()
    dismissHandlers(() => box, close).onKey({ key: 'Escape', isComposing: false, stopPropagation })
    expect(close).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('another key, or Escape while an input method composes, leaves it open and passes on', () => {
    const close = vi.fn()
    const stopPropagation = vi.fn()
    const { onKey } = dismissHandlers(() => box, close)
    onKey({ key: 'Enter', isComposing: false, stopPropagation })
    onKey({ key: 'Escape', isComposing: true, stopPropagation })
    expect(close).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('a press outside closes it, a press inside does not', () => {
    const close = vi.fn()
    const { onPress } = dismissHandlers(() => box, close)
    onPress({ target: inside.node as EventTarget })
    expect(close).not.toHaveBeenCalled()
    onPress({ target: {} as EventTarget })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a list no longer on the page is not closed by a press', () => {
    const close = vi.fn()
    dismissHandlers(() => null, close).onPress({ target: {} as EventTarget })
    expect(close).not.toHaveBeenCalled()
  })
})
