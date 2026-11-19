import { describe, expect, it } from 'vitest'
import { isTabFocusToggle, tabFocusKeyNames, terminalKeyFilter } from './terminalTabFocus'

// A terminal window: the Close button, then the terminal's input. A key goes to xterm first: its filter says whether
// xterm takes it, and a key xterm takes is sent to the shell and stopped there (xterm's `cancel(e, true)`). A key it
// leaves goes on to the page, where Tab moves the focus (the window keeps it inside, as ModalOverlay does) and Escape
// closes the window.
// `sends` is what xterm writes to the shell for the key.
type Press = { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean; sends: string }

function terminalWindow(mac: boolean) {
  const order = ['close', 'terminal'] as const
  const state = { focus: 'terminal' as (typeof order)[number], open: true, tabMovesFocus: false, toggles: 0, shell: [] as string[] }
  const filter = terminalKeyFilter(mac, () => state.tabMovesFocus, () => { state.tabMovesFocus = !state.tabMovesFocus; state.toggles++ })
  const press = (p: Press) => {
    let prevented = false
    const event = (type: string) => ({
      type, key: p.key, code: p.code, ctrlKey: !!p.ctrlKey, shiftKey: !!p.shiftKey, altKey: false, metaKey: false,
      preventDefault: () => { prevented = true },
    })
    if (state.focus === 'terminal') {
      const taken = filter(event('keydown'))
      filter(event('keypress'))
      filter(event('keyup'))
      if (taken) {
        state.shell.push(p.sends)
        return { prevented: true }
      }
    }
    if (prevented) return { prevented }
    if (p.key === 'Tab') {
      const i = order.indexOf(state.focus)
      state.focus = order[(i + (p.shiftKey ? order.length - 1 : 1)) % order.length]
    } else if (p.key === 'Escape') {
      state.open = false
    }
    return { prevented }
  }
  return { state, press }
}

const TAB = { key: 'Tab', code: 'Tab', sends: '\t' }
const SHIFT_TAB = { key: 'Tab', code: 'Tab', shiftKey: true, sends: '\x1b[Z' }
const ESCAPE = { key: 'Escape', code: 'Escape', sends: '\x1b' }
const CTRL_M = { key: 'm', code: 'KeyM', ctrlKey: true, sends: '\r' }
const CTRL_SHIFT_M = { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, sends: '\r' }

describe('terminal keys (WCAG 2.2 2.1.2)', () => {
  it('sends Tab, Shift+Tab and Escape to the shell, and the focus and the window stay', () => {
    const { state, press } = terminalWindow(false)
    press(TAB)
    press(SHIFT_TAB)
    press(ESCAPE)
    expect(state.shell).toEqual(['\t', '\x1b[Z', '\x1b'])
    expect(state.focus).toBe('terminal')
    expect(state.open).toBe(true)
  })

  it('leaves the terminal with Tab after Ctrl+M, then closes the window with Escape', () => {
    const { state, press } = terminalWindow(false)
    expect(press(CTRL_M).prevented).toBe(true)
    expect(state.tabMovesFocus).toBe(true)
    press(TAB)
    expect(state.focus).toBe('close')
    expect(state.shell).toEqual([])
    press(ESCAPE)
    expect(state.open).toBe(false)
  })

  it('leaves it backwards with Shift+Tab, and Escape inside still goes to the shell', () => {
    const { state, press } = terminalWindow(false)
    press(CTRL_M)
    press(ESCAPE)
    expect(state.shell).toEqual(['\x1b'])
    expect(state.open).toBe(true)
    press(SHIFT_TAB)
    expect(state.focus).toBe('close')
    expect(state.shell).toEqual(['\x1b'])
  })

  it('gives Tab back to the shell when the key is pressed again', () => {
    const { state, press } = terminalWindow(false)
    press(CTRL_M)
    press(CTRL_M)
    expect(state.tabMovesFocus).toBe(false)
    press(TAB)
    expect(state.focus).toBe('terminal')
    expect(state.shell).toEqual(['\t'])
  })

  it('takes Ctrl+Shift+M on a Mac, where Ctrl+M stays the shell’s Enter', () => {
    const { state, press } = terminalWindow(true)
    press(CTRL_M)
    expect(state.shell).toEqual(['\r'])
    expect(state.tabMovesFocus).toBe(false)
    press(CTRL_SHIFT_M)
    expect(state.tabMovesFocus).toBe(true)
    press(TAB)
    expect(state.focus).toBe('close')
  })

  it('switches once for one press, whatever the keypress and keyup of that press', () => {
    const { state, press } = terminalWindow(false)
    press(CTRL_M)
    expect(state.toggles).toBe(1)
    expect(state.shell).toEqual([])
  })

  it('finds the key by its place, so a Korean input source switches too, and no other chord does', () => {
    const base = { type: 'keydown', altKey: false, metaKey: false, preventDefault: () => {} }
    expect(isTabFocusToggle({ ...base, key: 'ㅡ', code: 'KeyM', ctrlKey: true, shiftKey: false }, false)).toBe(true)
    expect(isTabFocusToggle({ ...base, key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }, false)).toBe(false)
    expect(isTabFocusToggle({ ...base, key: 'm', code: 'KeyM', ctrlKey: false, shiftKey: false }, false)).toBe(false)
    expect(isTabFocusToggle({ ...base, key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: false, altKey: true }, false)).toBe(false)
    expect(isTabFocusToggle({ ...base, key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: false, metaKey: true }, false)).toBe(false)
  })

  it('names the key as the hint writes it', () => {
    expect(tabFocusKeyNames(false)).toEqual({ label: 'Ctrl+M', aria: 'Control+M' })
    expect(tabFocusKeyNames(true)).toEqual({ label: 'Ctrl+Shift+M', aria: 'Control+Shift+M' })
  })
})
