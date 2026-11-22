import { createContext, useContext } from 'react'
import type { NodeBoxRow } from '@/services/api'
import type { PodDetail, DetailTab } from './types'

// ClusterView 전용 state container — 모든 modal / tab / exec / delete state lift.
//
// `tr` 도 여기서 useCallback 으로 안정화 — 매 render 마다 새 reference 면 자식의
// useEffect dep ([..., tr]) 가 매번 trigger 되어 PodLogsTab 의 WebSocket 이
// 끊임없이 close/재연결되며 받은 로그가 setLogs('') 로 날아가는 회귀가 있었다.
// Provider 안에서 한 번 만들어 자식 전체가 같은 ref 를 받게 한다.
//
// `selectTab` 단일 setter — 기존엔 매 탭 버튼이 5개 boolean 을 false/false/...
// 식으로 일일이 reset 했다. 잊으면 두 탭이 동시에 활성화. select(tab) 으로 통일.

export interface PodContextMenuPosition {
  x: number
  y: number
  pod: NodeBoxRow
}

export interface ClusterViewContextValue {
  // i18n helpers
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
  locale: string
  emptyValue: string

  // namespace + search
  selectedNamespace: string
  setSelectedNamespace: (s: string) => void
  isNamespaceDropdownOpen: boolean
  setIsNamespaceDropdownOpen: (b: boolean) => void
  namespaceDropdownRef: React.RefObject<HTMLDivElement | null>
  searchQuery: string
  setSearchQuery: (s: string) => void
  // the node's own view (a map cell or a box's "show all"), kept in the address as ?node=, ?nodePage= and ?pod= so a
  // link opens it; null is the overview of every node. `pod` (namespace/name) is the pod a search opened it on, which
  // the page follows; a page of null is chosen by the view (the search's first match, else 1). Opening and closing it
  // are history entries (Back returns to every node); turning a page (which drops `pod`) and moving with the pod
  // followed replace the entry.
  nodeView: { node: string; page: number | null; pod: string | null } | null
  openNodeView: (node: string, at?: { page?: number; pod?: string }) => void
  setNodeViewPage: (page: number) => void
  moveNodeView: (at: { page: number; pod?: string | null }) => void
  closeNodeView: () => void

  // pod detail modal
  selectedPod: PodDetail | null
  setSelectedPod: (p: PodDetail | null) => void
  selectedContainer: string
  setSelectedContainer: (s: string) => void
  containerSearchQuery: string
  setContainerSearchQuery: (s: string) => void

  // tab toggles + 통합 selector
  activeTab: DetailTab
  selectTab: (t: DetailTab) => void
  // 호환 위해 boolean snapshot 도 노출 (sub-component 들 점진 마이그레이션 후 제거)
  showLogs: boolean
  showManifest: boolean
  showDescribe: boolean
  showRbac: boolean
  showExec: boolean

  // exec 패널
  execContainer: string
  setExecContainer: (s: string) => void
  execCommand: string
  setExecCommand: (s: string) => void
  isExecContainerDropdownOpen: boolean
  setIsExecContainerDropdownOpen: (b: boolean) => void
  isExecShellDropdownOpen: boolean
  setIsExecShellDropdownOpen: (b: boolean) => void
  execContainerDropdownRef: React.RefObject<HTMLDivElement | null>
  execShellDropdownRef: React.RefObject<HTMLDivElement | null>

  // context-menu + delete modal
  podContextMenu: PodContextMenuPosition | null
  setPodContextMenu: (m: PodContextMenuPosition | null) => void
  deleteTargetPod: NodeBoxRow | null
  deleteForce: boolean
  setDeleteForce: (b: boolean) => void
  deleteError: string | null
  setDeleteError: (s: string | null) => void
  isDeletingPod: boolean
  setIsDeletingPod: (b: boolean) => void
  deletingPods: Set<string>
  setDeletingPods: React.Dispatch<React.SetStateAction<Set<string>>>

  // close handlers (Dashboard 와 동일 패턴 — 모달 close 가 여러 state 한 번에 reset)
  closeDetailModal: () => void
  closeContextMenu: () => void
  openDeleteModal: (pod: NodeBoxRow) => void
  closeDeleteModal: () => void
}

export const ClusterViewContext = createContext<ClusterViewContextValue | null>(null)

export function useClusterView(): ClusterViewContextValue {
  const ctx = useContext(ClusterViewContext)
  if (!ctx) throw new Error('useClusterView must be used within ClusterViewProvider')
  return ctx
}
