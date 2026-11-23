import { describe, expect, it } from 'vitest'
import { followLimitText, terminalEnd, terminalEndText } from './serverShutdown'
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

  it('reads a session the server could not check as one a new terminal may open, never as a sign-out', () => {
    expect(terminalEnd(1013, 'session_unverified')).toBe('sessionUnchecked')
    expect(terminalEndText('sessionUnchecked', echo)).toBe((en as any).serverShutdown.terminalUnchecked)
    expect(terminalEndText('sessionUnchecked', echo)).not.toMatch(/sign in/i)
    expect((ko as any).serverShutdown.terminalUnchecked).not.toContain('로그인')
    expect(terminalEnd(1013, '')).toBeNull()
  })

  it('reads a terminal refused at its account\'s cap from its close code and reason, as one to reconnect once another closes', () => {
    expect(terminalEnd(4429, 'terminal_limit')).toBe('accountLimit')
    expect(terminalEndText('accountLimit', echo)).toBe((en as any).serverShutdown.terminalLimit)
    expect(terminalEndText('accountLimit', echo)).toContain('Close one, then reconnect')
    expect(terminalEnd(4429, '')).toBeNull()
    expect(terminalEnd(1013, 'terminal_limit')).toBeNull()
  })

  it('reads a terminal refused at the server\'s cap apart from the account\'s, as one to reconnect in a while', () => {
    expect(terminalEnd(4429, 'server_stream_limit')).toBe('serverLimit')
    expect(terminalEndText('serverLimit', echo)).toBe((en as any).serverShutdown.terminalServerLimit)
    expect(terminalEndText('serverLimit', echo)).toContain('for all accounts together')
    expect(terminalEndText('serverLimit', echo)).not.toContain('Close one')
    expect(terminalEnd(1013, 'server_stream_limit')).toBeNull()
  })

  it('says a followed log refused at the server\'s cap apart from the account\'s, from the event\'s data', () => {
    expect(followLimitText(echo, 'server_stream_limit')).toBe((en as any).serverShutdown.followServerLimit)
    expect(followLimitText(echo, 'followed_log_limit')).toBe((en as any).serverShutdown.followLimit)
    expect(followLimitText(echo, undefined)).toBe((en as any).serverShutdown.followLimit)
    const koText = (key: string) => key.split('.').reduce((o: any, k) => o?.[k], ko) as string
    expect(followLimitText(koText, 'server_stream_limit')).toBe((ko as any).serverShutdown.followServerLimit)
    expect(followLimitText(koText, 'server_stream_limit')).toContain('실시간 보기')
  })

  it('says a followed log refused at its account\'s cap in the screen\'s language', () => {
    expect(followLimitText(echo)).toBe((en as any).serverShutdown.followLimit)
    const koText = (key: string) => key.split('.').reduce((o: any, k) => o?.[k], ko) as string
    expect(followLimitText(koText)).toBe((ko as any).serverShutdown.followLimit)
    expect(followLimitText(koText)).toContain('실시간 보기')
  })

  it('leaves the ends that say why themselves alone', () => {
    expect(terminalEnd(1000, '')).toBeNull() // the shell exited
    expect(terminalEnd(1001, '')).toBeNull() // a browser leaving the page
    expect(terminalEnd(4401, 'session_revoked')).toBeNull() // the session, whose notice the server wrote
    expect(terminalEnd(1008, '')).toBeNull()
  })

  it('has every line in both languages, and the English one is the fallback', () => {
    for (const key of ['terminalReplaced', 'terminalLost', 'terminalUnchecked', 'reconnect', 'followStopped', 'terminalLimit', 'followLimit', 'terminalServerLimit', 'followServerLimit'] as const) {
      expect((en as any).serverShutdown[key]).toBeTruthy()
      expect((ko as any).serverShutdown[key]).toBeTruthy()
    }
    expect(terminalEndText('serverReplaced', echo)).toBe((en as any).serverShutdown.terminalReplaced)
    expect(terminalEndText('connectionLost', echo)).toBe((en as any).serverShutdown.terminalLost)
  })
})
