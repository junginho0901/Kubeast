import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ResourceType } from './types'

// Dashboard 전용 modal / filter state container.
//
// Dashboard.tsx 는 root state 11개 + 3개 hook 결과로 1100+ 줄. 1차 분할
// (sub-file 13개) 이후 모달 4개가 여전히 root state 를 통해 props drilling
// (각 모달 10~15 props). Context 로 lift 해서 모달들이 직접 useDashboard()
// 로 접근, Dashboard.tsx 는 모달 mount 만.
//
// 이번 단계는 modal/filter state 만 포함 (작은 lift). useDashboardQueries /
// useOptimizationStream / useDashboardRefresh 결과 + aiSnapshot 등은 다음
// 단계에서 추가.

interface DashboardContextValue {
  // 리소스 모달 (Stats Grid 카드 클릭 시)
  selectedResourceType: ResourceType | null
  setSelectedResourceType: (t: ResourceType | null) => void
  modalSearchQuery: string
  setModalSearchQuery: (q: string) => void
  selectedPodStatus: string | null
  setSelectedPodStatus: (s: string | null) => void
  selectedNodeStatus: string | null
  setSelectedNodeStatus: (s: string | null) => void
  closeResourceModal: () => void  // ResourceModal onClose — selectedType + filter 동시 reset

  // Issues 모달
  isIssuesModalOpen: boolean
  setIsIssuesModalOpen: (b: boolean) => void
  issuesSearchQuery: string
  setIssuesSearchQuery: (q: string) => void
  includeRestartHistory: boolean
  setIncludeRestartHistory: (b: boolean) => void
  closeIssuesModal: () => void

  // Storage 모달
  isStorageModalOpen: boolean
  setIsStorageModalOpen: (b: boolean) => void
  storageActiveTab: 'pvcs' | 'pvs' | 'topology'
  setStorageActiveTab: (t: 'pvcs' | 'pvs' | 'topology') => void
  storageSearchQuery: string
  setStorageSearchQuery: (q: string) => void
  storageNamespaceFilter: string
  setStorageNamespaceFilter: (n: string) => void
  isStorageNamespaceDropdownOpen: boolean
  setIsStorageNamespaceDropdownOpen: (b: boolean) => void
  closeStorageModal: () => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  const [modalSearchQuery, setModalSearchQuery] = useState<string>('')
  const [selectedPodStatus, setSelectedPodStatus] = useState<string | null>(null)
  const [selectedNodeStatus, setSelectedNodeStatus] = useState<string | null>(null)

  const [isIssuesModalOpen, setIsIssuesModalOpen] = useState(false)
  const [issuesSearchQuery, setIssuesSearchQuery] = useState<string>('')
  const [includeRestartHistory, setIncludeRestartHistory] = useState(false)

  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false)
  const [storageActiveTab, setStorageActiveTab] = useState<'pvcs' | 'pvs' | 'topology'>('pvcs')
  const [storageSearchQuery, setStorageSearchQuery] = useState<string>('')
  const [storageNamespaceFilter, setStorageNamespaceFilter] = useState<string>('all')
  const [isStorageNamespaceDropdownOpen, setIsStorageNamespaceDropdownOpen] = useState(false)

  const closeResourceModal = () => {
    setSelectedResourceType(null)
    setSelectedPodStatus(null)
    setSelectedNodeStatus(null)
    setModalSearchQuery('')
  }
  const closeIssuesModal = () => {
    setIsIssuesModalOpen(false)
    setIssuesSearchQuery('')
    setIncludeRestartHistory(false)
  }
  const closeStorageModal = () => {
    setIsStorageModalOpen(false)
    setStorageSearchQuery('')
    setStorageNamespaceFilter('all')
    setIsStorageNamespaceDropdownOpen(false)
  }

  const value: DashboardContextValue = {
    selectedResourceType,
    setSelectedResourceType,
    modalSearchQuery,
    setModalSearchQuery,
    selectedPodStatus,
    setSelectedPodStatus,
    selectedNodeStatus,
    setSelectedNodeStatus,
    closeResourceModal,
    isIssuesModalOpen,
    setIsIssuesModalOpen,
    issuesSearchQuery,
    setIssuesSearchQuery,
    includeRestartHistory,
    setIncludeRestartHistory,
    closeIssuesModal,
    isStorageModalOpen,
    setIsStorageModalOpen,
    storageActiveTab,
    setStorageActiveTab,
    storageSearchQuery,
    setStorageSearchQuery,
    storageNamespaceFilter,
    setStorageNamespaceFilter,
    isStorageNamespaceDropdownOpen,
    setIsStorageNamespaceDropdownOpen,
    closeStorageModal,
  }

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider')
  return ctx
}
