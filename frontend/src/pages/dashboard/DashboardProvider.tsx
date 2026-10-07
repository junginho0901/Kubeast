import { useState, type ReactNode } from 'react'
import type { ResourceType } from './types'
import { DashboardContext, type DashboardContextValue } from './DashboardContext'

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  const [modalSearchQuery, setModalSearchQuery] = useState<string>('')
  const [selectedPodStatus, setSelectedPodStatus] = useState<string | null>(null)
  const [selectedNodeStatus, setSelectedNodeStatus] = useState<string | null>(null)

  const [isIssuesModalOpen, setIsIssuesModalOpen] = useState(false)
  const [issuesSearchQuery, setIssuesSearchQuery] = useState<string>('')
  const [includeRestartHistory, setIncludeRestartHistory] = useState(false)
  const [issuesWindowMinutes, setIssuesWindowMinutes] = useState<number | null>(null)

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
    setIssuesWindowMinutes(null)
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
    issuesWindowMinutes,
    setIssuesWindowMinutes,
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
