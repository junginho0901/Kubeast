import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { crReadNotice } from './readNotice'

async function trFor(lng: 'en' | 'ko') {
  const inst = i18next.createInstance()
  await inst.init({ lng, resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
  return (key: string, fallback: string, opts?: Record<string, unknown>) => inst.t(key, { defaultValue: fallback, ...opts })
}

describe('the custom resource instances notice', () => {
  it('says nothing when every CRD was listed', async () => {
    const tr = await trFor('en')
    expect(crReadNotice(undefined, undefined, tr)).toEqual([])
    expect(crReadNotice([], [], tr)).toEqual([])
  })

  it('names the refused kinds in the lists\' shared "no permission" words', async () => {
    expect(crReadNotice(['GuardCheck', 'Widget (qa.example.com)', 'Gadget (e2e-b)'], undefined, await trFor('en'))).toEqual([{
      testId: 'cr-instances-forbidden',
      text: 'You do not have permission to view GuardCheck, Widget (qa.example.com), Gadget (e2e-b) in this cluster.',
    }])
    expect(crReadNotice(['GuardCheck'], undefined, await trFor('ko'))[0].text).toBe('GuardCheck: 이 클러스터에서 볼 권한이 없습니다.')
  })

  it('names the kinds whose list failed otherwise, one line per status, the reason of each kind in it', async () => {
    const failed = [
      { kind: 'Thing', code: 500, error: 'conversion webhook failed' },
      { kind: 'Slow', code: 0, error: 'context deadline exceeded' },
      { kind: 'Other', code: 500, error: 'etcdserver: request timed out' },
    ]
    expect(crReadNotice(['GuardCheck'], failed, await trFor('en'))).toEqual([
      { testId: 'cr-instances-forbidden', text: 'You do not have permission to view GuardCheck in this cluster.' },
      { testId: 'cr-instances-load-error', text: 'Could not load Slow (no response from the server): context deadline exceeded', title: 'Slow: context deadline exceeded' },
      { testId: 'cr-instances-load-error', text: 'Could not load Thing, Other (server error 500): Thing: conversion webhook failed; Other: etcdserver: request timed out', title: 'Thing: conversion webhook failed\nOther: etcdserver: request timed out' },
    ])
    expect(crReadNotice(undefined, failed.slice(0, 1), await trFor('ko'))[0].text).toBe('Thing: 불러오지 못했습니다(서버 오류 500): conversion webhook failed')
  })
})
