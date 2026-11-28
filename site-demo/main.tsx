// The project site's demo: eight screens of the released console (v0.8.0, imported unchanged from its source) on
// sample data answered in the page. ./sample/install goes first so no console module runs before the stand-ins.
import './sample/install'
import React, { lazy, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { clearCreated } from '@/services/createdNoticeStore'
import { queryDefaults } from '@/services/queryDefaults'
import { ClusterProvider } from '@/contexts/ClusterProvider'
import { PageContextProvider } from '@/components/PageContextProvider'
import ConfirmProvider from '@/components/ConfirmProvider'
import { ResourceDetailProvider } from '@/components/ResourceDetailProvider'
import ResourceDetailDrawer from '@/components/ResourceDetailDrawer'
import RequireAuth from '@/components/RequireAuth'
import ClusterGate from '@/components/ClusterGate'
import i18n from '@/i18n'
import { advance, podLogText } from './sample/cluster'
import { setLang } from './sample/notice'
import './demo.css'

const Pods = lazy(() => import('@/pages/workloads/Pods'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const ClusterView = lazy(() => import('@/pages/ClusterView'))
const Monitoring = lazy(() => import('@/pages/Monitoring'))
const Cost = lazy(() => import('@/pages/Cost'))
const Releases = lazy(() => import('@/pages/helm/Releases'))
const ReleaseDetail = lazy(() => import('@/pages/helm/ReleaseDetail'))
const AdminAudit = lazy(() => import('@/pages/AdminAudit'))
const AIChat = lazy(() => import('@/pages/AIChat'))

const client = new QueryClient({ defaultOptions: { queries: queryDefaults } })
const samplePod = '/workloads/pods?cluster=default&detail=Pod/commerce/checkout-api-7b9bc96fc8-8vn4z'

// Live logs in the Pod window. v0.8.0's Pod window reads a Pod's logs once per Load or Refresh (the console's followed
// log is Cluster View's, which streams them); in the demo the lines written since are put into that read every 0.5–2 s
// while the window shows them, and nothing is read once it closes. false keeps the console's own behaviour.
const LIVE_DRAWER_LOGS = false
function followDrawerLogs(queries: QueryClient) {
  const cache = queries.getQueryCache()
  let timer = 0
  const shown = () => cache.findAll({ queryKey: ['pod-logs'] }).filter((q) => q.getObserversCount() > 0 && typeof q.state.data === 'string')
  const tick = () => {
    const open = shown()
    if (!open.length) { timer = 0; return }
    timer = window.setTimeout(tick, 500 + Math.random() * 1500)
    advance()
    for (const q of open) {
      const [, namespace, name, container, lines] = q.queryKey as [string, string, string, string | undefined, number]
      const text = podLogText(namespace, name, container || undefined, Number(lines) || 100)
      if (text !== null && text !== q.state.data) queries.setQueryData(q.queryKey, text)
    }
  }
  cache.subscribe((event) => {
    if (timer || event.query.queryKey[0] !== 'pod-logs' || (event.type !== 'observerAdded' && event.type !== 'updated')) return
    if (shown().length) timer = window.setTimeout(tick, 1000)
  })
}
if (LIVE_DRAWER_LOGS) followDrawerLogs(client)

// What the sample layer writes in the screen's language: its notices, and the badge where the model's name would be.
i18n.on('languageChanged', (lang) => {
  setLang(lang)
  void client.invalidateQueries({ queryKey: ['ai-config'] })
})
// The site sends ?phone=1 for its narrow layout: the AI Chat screen there leaves out its conversation list.
document.documentElement.classList.toggle('tour-phone', new URLSearchParams(location.search).get('phone') === '1')

function Tour() {
  const location = useLocation()
  const ko = useTranslation().i18n.language.startsWith('ko')
  // The line naming what a page made or deleted goes when another opens: the console tells pages apart by the address's
  // path, which is the same for every page here.
  useEffect(() => clearCreated, [location.pathname])
  useEffect(() => {
    const lang = new URLSearchParams(location.search).get('lang')
    if (lang === 'ko' || lang === 'en') {
      setLang(lang)
      void i18n.changeLanguage(lang)
    }
  }, [location.search])
  return (
    <ResourceDetailProvider>
      <ResourceDetailDrawer />
      {window.parent === window && (
        <nav className="tour-nav" aria-label="Demo features">
          <Link to="/overview?cluster=default">Overview</Link>
          <Link to="/cluster-view?cluster=default">Cluster View</Link>
          <Link to="/workloads/pods?cluster=default">Pods</Link>
          <Link to={samplePod}>{ko ? '상세·로그' : 'Details & logs'}</Link>
          <Link to="/ai-chat?cluster=default">AI Chat</Link>
        </nav>
      )}
      <main className={location.pathname === '/ai-chat' ? 'tour-chat' : 'tour-resources'}>
        <Suspense fallback={<div className="tour-loading">{ko ? '화면을 불러옵니다.' : 'Loading…'}</div>}>
          <Routes>
            <Route path="/overview" element={<Dashboard />} />
            <Route path="/cluster-view" element={<ClusterView />} />
            <Route path="/monitoring" element={<Monitoring />} />
            <Route path="/cost" element={<Cost />} />
            <Route path="/helm/releases" element={<Releases />} />
            <Route path="/helm/releases/:namespace/:name" element={<ReleaseDetail />} />
            <Route path="/workloads/pods" element={<Pods />} />
            <Route path="/admin/audit" element={<AdminAudit />} />
            <Route path="/ai-chat" element={<AIChat />} />
            <Route path="*" element={<Navigate to="/overview?cluster=default" replace />} />
          </Routes>
        </Suspense>
      </main>
    </ResourceDetailProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <HashRouter>
        <PageContextProvider>
          <ConfirmProvider>
            <ClusterProvider>
              <RequireAuth>
                <ClusterGate fallback={<div className="tour-loading">Loading…</div>}>
                  <Tour />
                </ClusterGate>
              </RequireAuth>
            </ClusterProvider>
          </ConfirmProvider>
        </PageContextProvider>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
