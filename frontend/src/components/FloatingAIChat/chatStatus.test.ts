import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'

import i18n from '@/i18n'
import { chatStatusText } from './chatStatus'

const en = i18n.getFixedT('en') as TFunction
const ko = i18n.getFixedT('ko') as TFunction

describe('floating chat status line', () => {
  it('says the conversation is being made before anything else', () => {
    expect(chatStatusText(en, { starting: true, answering: true, streamStatus: 'completed' })).toBe('Preparing session...')
  })

  it('says an answer is coming while it streams', () => {
    expect(chatStatusText(en, { starting: false, answering: true, streamStatus: 'streaming' })).toBe('Writing the answer...')
  })

  it('says the answer came once its stream completed', () => {
    expect(chatStatusText(en, { starting: false, answering: false, streamStatus: 'completed' })).toBe('The answer is complete.')
  })

  it('is empty while nothing is under way, after a stop or an error too', () => {
    for (const streamStatus of [undefined, 'idle', 'aborted', 'error']) {
      expect(chatStatusText(en, { starting: false, answering: false, streamStatus })).toBe('')
    }
  })

  it('has the Korean text from the catalog', () => {
    expect(chatStatusText(ko, { starting: false, answering: true, streamStatus: 'streaming' })).toBe('답변을 쓰고 있습니다.')
    expect(chatStatusText(ko, { starting: false, answering: false, streamStatus: 'completed' })).toBe('답변이 끝났습니다.')
  })
})
