import { describe, expect, it } from 'vitest'
import { liveSessionEndText } from './liveSessionEnd'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'

const echo = (_key: string, fallback: string) => fallback

describe('what a followed stream says when its session ended', () => {
  it('names the reason the server sent', () => {
    expect(liveSessionEndText(echo, 'session_revoked')).toContain('account or access changed')
    expect(liveSessionEndText(echo, 'session_expired')).toContain('maximum lifetime')
    expect(liveSessionEndText(echo, 'session_unverified')).toContain('could not be verified')
    expect(liveSessionEndText(echo, 'session_signed_out')).toContain('sign-in was signed out')
  })

  it('has every reason in both languages', () => {
    for (const key of ['revoked', 'expired', 'signedOut', 'unverified'] as const) {
      expect((en as any).liveSession[key]).toBeTruthy()
      expect((ko as any).liveSession[key]).toBeTruthy()
    }
  })
})
