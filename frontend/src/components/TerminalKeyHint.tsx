import { useTranslation } from 'react-i18next'
import { isMacPlatform } from '@/hooks/useChatShortcut'
import { tabFocusKeyNames } from '@/utils/terminalTabFocus'

/** The line under a terminal that says what Tab does there and how to leave it by keyboard (WCAG 2.1.2). */
export default function TerminalKeyHint({ id, tabMovesFocus }: { id: string; tabMovesFocus: boolean }) {
  const { t } = useTranslation()
  const key = tabFocusKeyNames(isMacPlatform())
  return (
    <p
      id={id}
      role="status"
      data-testid="terminal-key-hint"
      data-tab-moves-focus={tabMovesFocus ? 'true' : 'false'}
      className="shrink-0 border-t border-hairline px-4 py-1.5 text-xs text-slate-400 [overflow-wrap:anywhere]"
    >
      {tabMovesFocus
        ? t('keyboardHelp.terminalTabMovesFocus', { key: key.label, defaultValue: 'Tab moves the focus out of the terminal. Press {{key}} to send Tab to the shell again.' })
        : t('keyboardHelp.terminalTab', { key: key.label, defaultValue: 'Tab and Esc go to the shell. Press {{key}} to move the focus with Tab instead.' })}
    </p>
  )
}
