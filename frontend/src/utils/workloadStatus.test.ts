import { describe, expect, it } from 'vitest'
import ko from '../i18n/locales/ko.json'
import { workloadStatus, workloadStatusLabel, workloadStatusText, workloadStatusTitle } from './workloadStatus'

const koTr = (key: string, fallback: string) => {
  const v = key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), ko)
  return typeof v === 'string' ? v : fallback
}

describe('workload summary status', () => {
  it('maps the Deployment conditions and the computed states onto one set', () => {
    expect(workloadStatus('Available')).toBe('Healthy')
    expect(workloadStatus('Healthy')).toBe('Healthy')
    for (const s of ['Progressing', 'Degraded', 'Idle', 'Unavailable', 'Failed'] as const) expect(workloadStatus(s)).toBe(s)
    expect(workloadStatus('Complete')).toBeNull()
    expect(workloadStatus(undefined)).toBeNull()
  })

  it('shows the label in the UI language and passes unknown values through', () => {
    expect(workloadStatusLabel(koTr, 'Available')).toBe('정상')
    expect(workloadStatusLabel(koTr, 'Unavailable')).toBe('사용 불가')
    expect(workloadStatusLabel(koTr, 'Progressing')).toBe('진행 중')
    expect(workloadStatusLabel(koTr, 'Complete')).toBe('Complete')
    expect(workloadStatusLabel(koTr, '')).toBe('-')
  })

  it('lets the search box match the server value and the label', () => {
    const text = workloadStatusText(koTr, 'Available')
    expect(text).toContain('available')
    expect(text).toContain('정상')
  })

  it('keeps the server value and the failure reason in the tooltip', () => {
    expect(workloadStatusTitle('Failed', 'ProgressDeadlineExceeded')).toBe('Failed: ProgressDeadlineExceeded')
    expect(workloadStatusTitle('Available')).toBe('Available')
    expect(workloadStatusTitle(undefined)).toBe('')
  })
})
