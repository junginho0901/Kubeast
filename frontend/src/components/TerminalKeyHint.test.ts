import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import TerminalKeyHint from './TerminalKeyHint'
import podExecSrc from './PodExecTerminal.tsx?raw'
import nodeShellSrc from './NodeShellTerminal.tsx?raw'
import podExecPanelSrc from '@/pages/cluster-view/PodExecPanel.tsx?raw'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
afterEach(() => vi.unstubAllGlobals())

function hint(platform: string, tabMovesFocus: boolean, lng = 'en') {
  vi.stubGlobal('navigator', { platform })
  void i18n.changeLanguage(lng)
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(TerminalKeyHint, { id: 'h', tabMovesFocus })))
  return { text: html.replace(/<[^>]+>/g, ''), role: /role="([^"]*)"/.exec(html)?.[1] }
}

describe('the line under a terminal says how to leave it by keyboard', () => {
  it('names Ctrl+M off a Mac and Ctrl+Shift+M on one, in English and Korean', () => {
    expect(hint('Win32', false).text).toBe('Tab and Esc go to the shell. Press Ctrl+M to move the focus with Tab instead.')
    expect(hint('MacIntel', false).text).toBe('Tab and Esc go to the shell. Press Ctrl+Shift+M to move the focus with Tab instead.')
    expect(hint('Linux x86_64', false, 'ko').text).toBe('Tab과 Esc는 셸로 갑니다. Tab으로 초점을 옮기려면 Ctrl+M을 누르세요.')
  })

  it('says what Tab does after the switch, as a status a screen reader reads out', () => {
    expect(hint('Win32', true)).toEqual({ text: 'Tab moves the focus out of the terminal. Press Ctrl+M to send Tab to the shell again.', role: 'status' })
    expect(hint('MacIntel', true, 'ko').text).toBe('Tab이 초점을 터미널 밖으로 옮깁니다. Tab을 다시 셸로 보내려면 Ctrl+Shift+M을 누르세요.')
  })

  // The node shell and the pod exec are two components; Cluster View's Exec tab is the pod exec one.
  it('is under both terminals, each giving its xterm the same key filter', () => {
    for (const src of [podExecSrc, nodeShellSrc]) {
      expect(src).toContain('useTerminalTabFocus()')
      expect(src).toMatch(/term\.open\(containerRef\.current\)[\s\S]*?\n {4}attach\(term\)/)
      expect(src).toContain('<TerminalKeyHint id={hintId} tabMovesFocus={tabMovesFocus} />')
    }
    expect(podExecPanelSrc).toContain('<PodExecTerminal')
  })
})
