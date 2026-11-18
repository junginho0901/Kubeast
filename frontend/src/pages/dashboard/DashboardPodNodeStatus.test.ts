import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { DashboardPodNodeStatus } from './DashboardPodNodeStatus'

// While the Dashboard's summary read is failed the cards show "—", and TanStack Query keeps the last answer beside the
// error: the Pod status chart shows the same "—" with the failure in place of that answer's bars.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const kept = [{ name: 'Running', value: 40 }, { name: 'Pending', value: 2 }]
const failed = { response: { status: 500, data: { detail: 'listing namespaces timed out' } }, message: 'Request failed with status code 500' }
const refused = { response: { status: 403, data: { detail: 'namespaces is forbidden: User "kubeast:user:7" cannot list resource "namespaces"' } }, message: 'Request failed with status code 403' }

function chart(podStatusFailure: unknown, lng = 'en', podStatusData = kept) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(DashboardPodNodeStatus, {
      podStatusData, nodeStatusChartData: [], podStatusFailure, onPodStatusClick: () => {}, onNodeStatusClick: () => {},
    })))
}

describe('the Dashboard Pod status chart while the summary read is failed', () => {
  it('a failed re-read shows "—" and the status with the server\'s reason, not the kept bars', () => {
    const html = chart(failed)
    expect(html).toContain('data-testid="pod-status-read-failed"')
    expect(html).toContain('—')
    expect(html).toContain('Could not load Pod status (server error 500): listing namespaces timed out')
    expect(html).not.toContain('Running: 40')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('Click to view pods in each status')
  })

  it('a refused read says no permission, with the cluster\'s reason under it', () => {
    const html = chart(refused)
    expect(html).toContain('You do not have permission to view Pod status in this cluster.')
    expect(html).toContain('namespaces is forbidden: User &quot;kubeast:user:7&quot; cannot list resource &quot;namespaces&quot;')
    expect(html).not.toContain('<svg')
  })

  it('a read with no answer says so, also when there was no answer before', () => {
    const html = chart({ message: 'Network Error' }, 'en', [])
    expect(html).toContain('Could not load Pod status (no response from the server): Network Error')
  })

  it('says it in Korean on a Korean screen', () => {
    expect(chart(failed, 'ko')).toContain('Pod 상태: 불러오지 못했습니다(서버 오류 500): listing namespaces timed out')
    expect(chart(refused, 'ko')).toContain('Pod 상태: 이 클러스터에서 볼 권한이 없습니다.')
  })

  it('draws the bars of a read that answered', () => {
    const html = chart(null)
    expect(html).toContain('Running: 40')
    expect(html).not.toContain('data-testid="pod-status-read-failed"')
  })
})
