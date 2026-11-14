import { describe, expect, it, vi } from 'vitest'
import { chatShortcutKeydown, chatShortcutNames, isMacPlatform, listenForChatShortcut } from './useChatShortcut'
import hookSrc from './useChatShortcut.ts?raw'

type Press = { code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; repeat?: boolean; defaultPrevented?: boolean }

// a keydown as the browser sends it to window; preventDefault marks it as a cancelable Event does
function key(over: Press = {}) {
  const e = { code: 'Slash', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, ...over,
    preventDefault: vi.fn(() => { e.defaultPrevented = true }) }
  return e
}
const mac = (over: Press = {}) => key({ metaKey: true, ...over })
const pc = (over: Press = {}) => key({ ctrlKey: true, ...over })

// the chat as FloatingAIChat drives it: the shortcut opens it when closed and closes it when open
function chat(platformIsMac: boolean, shown = () => true) {
  const state = { open: false, toggles: 0 }
  const press = chatShortcutKeydown(platformIsMac, shown, () => { state.open = !state.open; state.toggles++ })
  return { state, press }
}

describe('the floating chat shortcut', () => {
  it('⌘/ on a Mac opens the chat and the same key closes it, each press kept from the browser', () => {
    const { state, press } = chat(true)
    const first = mac()
    press(first)
    expect(state.open).toBe(true)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    const second = mac()
    press(second)
    expect(state.open).toBe(false)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+/ elsewhere opens and closes it', () => {
    const { state, press } = chat(false)
    press(pc())
    expect(state.open).toBe(true)
    press(pc())
    expect(state.open).toBe(false)
  })

  it('is matched by the key’s place (code Slash), whatever character the input source gives it; the numpad / is another key', () => {
    const { state, press } = chat(true)
    press(Object.assign(mac(), { key: 'ㅗ' }))
    expect(state.toggles).toBe(1)
    const numpad = mac({ code: 'NumpadDivide' })
    press(numpad)
    expect(state.toggles).toBe(1)
    expect(numpad.preventDefault).not.toHaveBeenCalled()
  })

  it('does nothing while an input method composes', () => {
    const { state, press } = chat(true)
    const composing = mac({ isComposing: true })
    press(composing)
    expect(state.toggles).toBe(0)
    expect(composing.preventDefault).not.toHaveBeenCalled()
  })

  it('does nothing and leaves the key alone where the chat is not shown (AI off, the AI Chat page)', () => {
    let shown = false
    const { state, press } = chat(true, () => shown)
    const off = mac()
    press(off)
    expect(state.toggles).toBe(0)
    expect(off.preventDefault).not.toHaveBeenCalled()
    shown = true
    press(mac())
    expect(state.toggles).toBe(1)
  })

  it("does nothing with the other platform's modifier, both, or Shift or Alt added", () => {
    const onMac = chat(true)
    const onPc = chat(false)
    const presses = [
      [onMac, pc()], [onMac, mac({ ctrlKey: true })], [onMac, mac({ shiftKey: true })], [onMac, mac({ altKey: true })], [onMac, key()],
      [onPc, mac()], [onPc, pc({ metaKey: true })], [onPc, pc({ shiftKey: true })], [onPc, pc({ altKey: true })], [onPc, key()],
    ] as const
    for (const [c, e] of presses) {
      c.press(e)
      expect(e.preventDefault, JSON.stringify(e)).not.toHaveBeenCalled()
    }
    expect([onMac.state.toggles, onPc.state.toggles]).toEqual([0, 0])
  })

  it('leaves a key an editor already took (Monaco toggles a comment with it) and toggles once for a held key', () => {
    const { state, press } = chat(true)
    const taken = mac({ defaultPrevented: true })
    press(taken)
    expect(state.toggles).toBe(0)
    expect(taken.preventDefault).not.toHaveBeenCalled()
    press(mac())
    const held = mac({ repeat: true })
    press(held)
    expect(state.toggles).toBe(1)
    expect(held.preventDefault, 'a held key still does not reach the browser').toHaveBeenCalledTimes(1)
  })

  it('listens with one listener and stops when its caller leaves the page', () => {
    const target = new EventTarget()
    const add = vi.spyOn(target, 'addEventListener')
    const remove = vi.spyOn(target, 'removeEventListener')
    const toggle = vi.fn()
    const stop = listenForChatShortcut(target, true, () => true, toggle)
    const dispatch = () => {
      const e = new Event('keydown', { cancelable: true })
      Object.assign(e, { code: 'Slash', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false })
      target.dispatchEvent(e)
      return e
    }
    expect(dispatch().defaultPrevented).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(1)
    stop()
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1])
    expect(dispatch().defaultPrevented).toBe(false)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('adds its listener once for the life of the component: the effect has no dependencies, a re-render only updates what it reads', () => {
    const hook = hookSrc.slice(hookSrc.indexOf('export function useChatShortcut'))
    expect(hook).toMatch(/useEffect\(\(\) => listenForChatShortcut\(window, [^\n]*\), \[\]\)/)
  })
})

describe('which modifier a platform uses', () => {
  it('reads a Mac, an iPad and an iPhone as ⌘ and the others as Ctrl, the client hints first', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'iPad' })).toBe(true)
    expect(isMacPlatform({ platform: 'iPhone' })).toBe(true)
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false)
    expect(isMacPlatform({})).toBe(false)
  })

  it('names the shortcut for the tooltip and aria-keyshortcuts', () => {
    expect(chatShortcutNames(true)).toEqual({ label: '⌘/', aria: 'Meta+Slash' })
    expect(chatShortcutNames(false)).toEqual({ label: 'Ctrl+/', aria: 'Control+Slash' })
  })
})
