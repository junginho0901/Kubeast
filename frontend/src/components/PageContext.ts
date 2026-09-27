import { createContext, useContext } from 'react'
import type { RouteContextMeta } from '@/utils/aiContext/routeMatcher'

/**
 * 화면의 한 레이어 (베이스 페이지 또는 오버레이 = 모달/드로어).
 *
 * 각 페이지/컴포넌트가 `useAIContext` 로 등록하면 같은 `id` 에 대해 최신값만
 * 유지된다. 플로팅 AI 위젯이 질문 전송 시점에 `getSnapshot()` 으로 전체
 * 레이어를 수집해 백엔드에 보낸다.
 */
export interface VisibleDataLayer {
  source: string // "base" | "ResourceDetailDrawer" | ...
  summary: string // 한 줄 요약 (LLM 이 먼저 읽음)
  data?: Record<string, unknown> // 집계/top N/차트 통계 등
}

export interface PageContextSnapshot {
  pageType: string
  pageTitle: string
  path: string
  resourceKind?: string
  namespace?: string
  resourceName?: string
  cluster?: string
  snapshotAt: string
  contextChanged: boolean
  base?: VisibleDataLayer
  overlays: VisibleDataLayer[]
}

export interface PageContextValue extends RouteContextMeta {
  registerLayer: (id: string, layer: VisibleDataLayer) => void
  unregisterLayer: (id: string) => void
  getSnapshot: () => PageContextSnapshot
  consumeContextChanged: () => boolean
}

export const PageContextCtx = createContext<PageContextValue | null>(null)

export function usePageContext(): PageContextValue {
  const ctx = useContext(PageContextCtx)
  if (!ctx) {
    throw new Error('usePageContext must be used within <PageContextProvider>')
  }
  return ctx
}
