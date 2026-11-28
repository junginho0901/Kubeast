import { describe, expect, it } from 'vitest'
import i18n from './index'
import en from './locales/en.json'
import ko from './locales/ko.json'

describe('plural forms', () => {
  it('picks the English singular for one, the plain entry otherwise, and the one Korean entry for both', () => {
    const tEn = i18n.getFixedT('en')
    const tKo = i18n.getFixedT('ko')
    expect(tEn('netpolCheck.isolatedBy', { n: 1, count: 1 })).toBe('Isolated by 1 policy: only what its rules allow.')
    expect(tEn('netpolCheck.isolatedBy', { n: 2, count: 2 })).toBe('Isolated by 2 policies: only what their rules allow.')
    expect(tEn('resourceGraph.traffic.lineCount', { n: 1, count: 1 })).toBe('1 traffic line')
    expect(tKo('netpolCheck.isolatedBy', { n: 1, count: 1 })).toBe('정책 1개로 격리됨: 이 규칙들이 허용하는 연결만 됩니다.')
  })

  it('says one permission selected in Create Role, and the count otherwise', () => {
    const tEn = i18n.getFixedT('en')
    expect(tEn('adminRoles.selectedCount', { count: 1 })).toBe('1 permission selected')
    expect(tEn('adminRoles.selectedCount', { count: 0 })).toBe('0 permissions selected')
    expect(tEn('adminRoles.selectedCount', { count: 2 })).toBe('2 permissions selected')
    expect(i18n.getFixedT('ko')('adminRoles.selectedCount', { count: 1 })).toBe(ko.adminRoles.selectedCount.replace('{{count}}', '1'))
  })

  it('says one item for a Cluster View search that matched one pod, and items otherwise', () => {
    const tEn = i18n.getFixedT('en')
    expect(tEn('clusterView.countSuffix', { count: 1 })).toBe('item')
    expect(tEn('clusterView.countSuffix', { count: 0 })).toBe('items')
    expect(tEn('clusterView.countSuffix', { count: 2 })).toBe('items')
    expect(i18n.getFixedT('ko')('clusterView.countSuffix', { count: 1 })).toBe(ko.clusterView.countSuffix)
  })

  it('keeps the plain entry next to every singular one', () => {
    const missing: string[] = []
    const walk = (o: unknown, path: string) => {
      if (!o || typeof o !== 'object') return
      for (const [k, v] of Object.entries(o)) {
        if (k.endsWith('_one') && !(k.slice(0, -4) in (o as Record<string, unknown>))) missing.push(`${path}${k}`)
        walk(v, `${path}${k}.`)
      }
    }
    walk(en, '')
    expect(missing).toEqual([])
  })
})
