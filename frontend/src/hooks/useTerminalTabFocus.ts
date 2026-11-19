import { useCallback, useId, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { isMacPlatform } from '@/hooks/useChatShortcut'
import { tabFocusKeyNames, terminalKeyFilter } from '@/utils/terminalTabFocus'

/**
 * What Tab does in a terminal (the shell's key until the toggle), kept across a reconnect. `attach` gives a new
 * terminal the key filter and points its input at the hint line (`hintId`).
 */
export function useTerminalTabFocus() {
  const [tabMovesFocus, setTabMovesFocus] = useState(false)
  const moves = useRef(false)
  const hintId = useId()
  const attach = useCallback((term: Pick<Terminal, 'attachCustomKeyEventHandler' | 'textarea'>) => {
    const mac = isMacPlatform()
    term.attachCustomKeyEventHandler(terminalKeyFilter(mac, () => moves.current, () => {
      moves.current = !moves.current
      setTabMovesFocus(moves.current)
    }))
    term.textarea?.setAttribute('aria-describedby', hintId)
    term.textarea?.setAttribute('aria-keyshortcuts', tabFocusKeyNames(mac).aria)
  }, [hintId])
  return { tabMovesFocus, attach, hintId }
}
