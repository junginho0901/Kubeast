import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PodPage } from '@/services/api'
import ko from '@/i18n/locales/ko.json'
import { translateDetailLabel, type TranslateFn } from './detailLabel'
import { POD_TABLE_WATCH_MAX, SET_POD_TABLE_WATCH_MAX, podTableNote, podTableReadsPages } from './namespacePodTable'

const matches = (total: number) => ({ items: [], total, stats: { total: 50_000 }, revision: 'r1', source: 'index' } as unknown as PodPage)

describe('the note over a table read a page at a time', () => {
  const instance = i18next.createInstance()
  beforeAll(async () => {
    const detail = (ko as { detail: Record<string, string> }).detail
    await instance.init({
      lng: 'ko', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
      resources: { ko: { translation: ko, detail }, en: { translation: {}, detail: {} } }, interpolation: { escapeValue: false },
    })
  })
  const said = (lng: string, owner: string | undefined, bySelector: boolean) => {
    const note = podTableNote(owner, bySelector)
    return translateDetailLabel(instance.getFixedT(lng) as unknown as TranslateFn, note.text, { ...note.values, seconds: 3 })
  }

  it('names what passed the line: the namespace\'s pods, a selector\'s matches or a workload\'s pods, in English and Korean', () => {
    expect(said('en', undefined, false)).toBe('This namespace has too many pods to follow live, so this table is read again every 3 seconds.')
    expect(said('ko', undefined, false)).toBe('이 Namespace는 Pod가 많아 실시간으로 따라가지 않고 이 표를 3초마다 다시 읽습니다.')
    expect(said('en', undefined, true)).toBe('Too many pods match this selector to follow live, so this table is read again every 3 seconds.')
    expect(said('ko', undefined, true)).toBe('이 셀렉터에 맞는 Pod가 많아 실시간으로 따라가지 않고 이 표를 3초마다 다시 읽습니다.')
    expect(said('en', 'DaemonSet/agent', true)).toBe('This DaemonSet has too many pods to follow live, so this table is read again every 3 seconds.')
    expect(said('ko', 'DaemonSet/agent', true)).toBe('이 DaemonSet의 Pod가 많아 실시간으로 따라가지 않고 이 표를 3초마다 다시 읽습니다.')
  })
})

describe('the line of the tables of a selector\'s or a workload\'s pods', () => {
  it('is 300 pods, below the namespace tables\' 2 000: 301 are read a page at a time, 300 followed live', () => {
    expect(SET_POD_TABLE_WATCH_MAX).toBe(300)
    expect(POD_TABLE_WATCH_MAX).toBe(2000)
    expect(podTableReadsPages({ answered: matches(301) }, true, SET_POD_TABLE_WATCH_MAX)).toBe(true)
    expect(podTableReadsPages({ answered: matches(300) }, true, SET_POD_TABLE_WATCH_MAX)).toBe(false)
    expect(podTableReadsPages({ held: 301 }, true, SET_POD_TABLE_WATCH_MAX)).toBe(true)
    expect(podTableReadsPages({ held: 300, answered: matches(300) }, true, SET_POD_TABLE_WATCH_MAX)).toBe(false)
    expect(podTableReadsPages({ answered: matches(301) }, true)).toBe(false)
  })

  it('is the one the table is given, for the page and for the rows held', () => {
    expect(podTableReadsPages({ answered: matches(30) }, true, 20)).toBe(true)
    expect(podTableReadsPages({ held: 21 }, true, 20)).toBe(true)
    expect(podTableReadsPages({ answered: matches(30) }, true)).toBe(false)
  })
})
