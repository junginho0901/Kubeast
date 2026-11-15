import { describe, expect, it } from 'vitest'
import { terminalEnd, terminalEndText } from './serverShutdown'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'

const echo = (_key: string, fallback: string) => fallback

describe('why a terminal closed', () => {
  it('reads a replaced server from its close code and reason', () => {
    expect(terminalEnd(1001, 'server_shutdown')).toBe('serverReplaced')
    expect(terminalEndText('serverReplaced', echo)).toContain('server was replaced')
  })

  it('reads a socket that closed with no close frame as a lost connection', () => {
    expect(terminalEnd(1006, '')).toBe('connectionLost')
    expect(terminalEndText('connectionLost', echo)).toContain('connection to the server was lost')
  })

  it('leaves the ends that say why themselves alone', () => {
    expect(terminalEnd(1000, '')).toBeNull() // the shell exited
    expect(terminalEnd(1001, '')).toBeNull() // a browser leaving the page
    expect(terminalEnd(4401, 'session_revoked')).toBeNull() // the session, whose notice the server wrote
    expect(terminalEnd(1008, '')).toBeNull()
  })

  it('has every line in both languages, and the English one is the fallback', () => {
    for (const key of ['terminalReplaced', 'terminalLost', 'reconnect', 'followStopped'] as const) {
      expect((en as any).serverShutdown[key]).toBeTruthy()
      expect((ko as any).serverShutdown[key]).toBeTruthy()
    }
    expect(terminalEndText('serverReplaced', echo)).toBe((en as any).serverShutdown.terminalReplaced)
    expect(terminalEndText('connectionLost', echo)).toBe((en as any).serverShutdown.terminalLost)
  })
})
