import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import ko from '@/i18n/locales/ko.json'
import { formatDuration } from './accessRequestFormat'

const koT = ((key: string, opts: Record<string, unknown>) => {
  const v = key.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], ko) as string
  return v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts[k]))
}) as unknown as TFunction

describe('formatDuration', () => {
  it('reads in the UI language', () => {
    expect([30, 60, 90, 480].map((m) => formatDuration(m, koT))).toEqual(['30분', '1시간', '1시간 30분', '8시간'])
    expect([30, 60, 90].map((m) => formatDuration(m))).toEqual(['30 min', '1 h', '1 h 30 min'])
  })
})
