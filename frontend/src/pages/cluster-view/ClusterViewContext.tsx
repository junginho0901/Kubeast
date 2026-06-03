import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PodInfo } from '@/services/api'
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

interface PodContextMenuPosition {
  x: number
  y: number
  pod: PodInfo
}

interface ClusterViewContextValue {
  // i18n helpers
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
  locale: string
  na: string
  emptyValue: string

  // namespace + search
  selectedNamespace: string
  setSelectedNamespace: (s: string) => void
  isNamespaceDropdownOpen: boolean
  setIsNamespaceDropdownOpen: (b: boolean) => void
  namespaceDropdownRef: React.RefObject<HTMLDivElement>
  searchQuery: string
  setSearchQuery: (s: string) => void

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
  execContainerDropdownRef: React.RefObject<HTMLDivElement>
  execShellDropdownRef: React.RefObject<HTMLDivElement>

  // context-menu + delete modal
  podContextMenu: PodContextMenuPosition | null
  setPodContextMenu: (m: PodContextMenuPosition | null) => void
  deleteTargetPod: PodInfo | null
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
  openDeleteModal: (pod: PodInfo) => void
  closeDeleteModal: () => void
}

const ClusterViewContext = createContext<ClusterViewContextValue | null>(null)

export function ClusterViewProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation()
  const tr = useCallback(
    (key: string, fallback: string, options?: Record<string, any>) =>
      t(key, { defaultValue: fallback, ...options }),
    [t],
  )
  const locale = i18n.language === 'ko' ? 'ko-KR' : 'en-US'
  const na = tr('common.notAvailable', 'N/A')
  const emptyValue = tr('common.empty', '-')

  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')

  const [selectedPod, setSelectedPod] = useState<PodDetail | null>(null)
  const [selectedContainer, setSelectedContainer] = useState<string>('')
  const [containerSearchQuery, setContainerSearchQuery] = useState<string>('')

  const [activeTab, setActiveTab] = useState<DetailTab>('summary')

  const [execContainer, setExecContainer] = useState<string>('')
  const [execCommand, setExecCommand] = useState<string>('/bin/sh')
  const [isExecContainerDropdownOpen, setIsExecContainerDropdownOpen] = useState(false)
  const [isExecShellDropdownOpen, setIsExecShellDropdownOpen] = useState(false)
  const execContainerDropdownRef = useRef<HTMLDivElement>(null)
  const execShellDropdownRef = useRef<HTMLDivElement>(null)

  const [podContextMenu, setPodContextMenu] = useState<PodContextMenuPosition | null>(null)
  const [deleteTargetPod, setDeleteTargetPod] = useState<PodInfo | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeletingPod, setIsDeletingPod] = useState(false)
  const [deletingPods, setDeletingPods] = useState<Set<string>>(new Set())

  const selectTab = useCallback((t: DetailTab) => setActiveTab(t), [])

  const closeContextMenu = useCallback(() => setPodContextMenu(null), [])

  const openDeleteModal = useCallback((pod: PodInfo) => {
    setDeleteTargetPod(pod)
    setDeleteForce(false)
    setDeleteError(null)
  }, [])

  const closeDeleteModal = useCallback(() => {
    setDeleteTargetPod(null)
    setDeleteForce(false)
    setDeleteError(null)
    setIsDeletingPod(false)
  }, [])

  const closeDetailModal = useCallback(() => {
    setSelectedPod(null)
    setActiveTab('summary')
  }, [])

  // boolean snapshot 들 — derive 한 번만 + memo X (cheap)
  const showLogs = activeTab === 'logs'
  const showManifest = activeTab === 'manifest'
  const showDescribe = activeTab === 'describe'
  const showRbac = activeTab === 'rbac'
  const showExec = activeTab === 'exec'

  const value = useMemo<ClusterViewContextValue>(() => ({
    tr, locale, na, emptyValue,
    selectedNamespace, setSelectedNamespace,
    isNamespaceDropdownOpen, setIsNamespaceDropdownOpen,
    namespaceDropdownRef,
    searchQuery, setSearchQuery,
    selectedPod, setSelectedPod,
    selectedContainer, setSelectedContainer,
    containerSearchQuery, setContainerSearchQuery,
    activeTab, selectTab,
    showLogs, showManifest, showDescribe, showRbac, showExec,
    execContainer, setExecContainer,
    execCommand, setExecCommand,
    isExecContainerDropdownOpen, setIsExecContainerDropdownOpen,
    isExecShellDropdownOpen, setIsExecShellDropdownOpen,
    execContainerDropdownRef, execShellDropdownRef,
    podContextMenu, setPodContextMenu,
    deleteTargetPod,
    deleteForce, setDeleteForce,
    deleteError, setDeleteError,
    isDeletingPod, setIsDeletingPod,
    deletingPods, setDeletingPods,
    closeDetailModal, closeContextMenu, openDeleteModal, closeDeleteModal,
  }), [
    tr, locale, na, emptyValue,
    selectedNamespace, isNamespaceDropdownOpen, searchQuery,
    selectedPod, selectedContainer, containerSearchQuery,
    activeTab, selectTab,
    showLogs, showManifest, showDescribe, showRbac, showExec,
    execContainer, execCommand, isExecContainerDropdownOpen, isExecShellDropdownOpen,
    podContextMenu, deleteTargetPod, deleteForce, deleteError, isDeletingPod, deletingPods,
    closeDetailModal, closeContextMenu, openDeleteModal, closeDeleteModal,
  ])

  return <ClusterViewContext.Provider value={value}>{children}</ClusterViewContext.Provider>
}

export function useClusterView(): ClusterViewContextValue {
  const ctx = useContext(ClusterViewContext)
  if (!ctx) throw new Error('useClusterView must be used within ClusterViewProvider')
  return ctx
}
