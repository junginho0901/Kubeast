import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PodInfo } from '@/services/api'
import type { PodDetail, DetailTab } from './types'
import { ClusterViewContext, type ClusterViewContextValue, type PodContextMenuPosition } from './ClusterViewContext'

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
