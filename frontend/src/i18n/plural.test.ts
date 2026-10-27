import { describe, expect, it } from 'vitest'
import i18n from './index'
import en from './locales/en.json'

describe('plural forms', () => {
  it('picks the English singular for one, the plain entry otherwise, and the one Korean entry for both', () => {
    const tEn = i18n.getFixedT('en')
    const tKo = i18n.getFixedT('ko')
    expect(tEn('netpolCheck.isolatedBy', { n: 1, count: 1 })).toBe('Isolated by 1 policy: only what its rules allow.')
    expect(tEn('netpolCheck.isolatedBy', { n: 2, count: 2 })).toBe('Isolated by 2 policies: only what their rules allow.')
    expect(tEn('resourceGraph.traffic.lineCount', { n: 1, count: 1 })).toBe('1 traffic line')
    expect(tKo('netpolCheck.isolatedBy', { n: 1, count: 1 })).toBe('정책 1개로 격리됨: 이 규칙들이 허용하는 연결만 됩니다.')
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
