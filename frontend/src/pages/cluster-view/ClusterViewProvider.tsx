import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type { PodInfo } from '@/services/api'
import type { PodDetail, DetailTab } from './types'
import { ClusterViewContext, type ClusterViewContextValue, type PodContextMenuPosition } from './ClusterViewContext'
import { useNamespaceParam } from '@/hooks/useNamespaceParam'

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

  const [selectedNamespace, setSelectedNamespace] = useNamespaceParam()
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  // ?node=, ?nodePage= and ?pod= keep the node's own view, so a reload or a link opens it again; other parameters stay.
  // Opening and closing it push a history entry, so Back returns to every node; a page turned replaces the entry.
  const [params, setParams] = useSearchParams()
  const viewNode = params.get('node')
  const viewPage = Number(params.get('nodePage')) || null
  const viewPod = params.get('pod')
  const nodeView = useMemo(() => (viewNode === null ? null : { node: viewNode, page: viewPage, pod: viewPod }), [viewNode, viewPage, viewPod])
  // an address that would not change is not navigated to: no render of every useCluster screen, no Back entry
  const changeParams = useCallback((change: (next: URLSearchParams) => void, replace: boolean) => {
    const next = new URLSearchParams(params)
    change(next)
    if (next.toString() !== params.toString()) setParams(next, replace ? { replace: true } : undefined)
  }, [params, setParams])
  const setView = useCallback((node: string | null, at: { page?: number; pod?: string } = {}) => changeParams((next) => {
    for (const k of ['node', 'nodePage', 'pod']) next.delete(k)
    if (node !== null) next.set('node', node)
    if (node !== null && at.page) next.set('nodePage', String(at.page))
    if (node !== null && at.pod) next.set('pod', at.pod)
  }, false), [changeParams])
  const openNodeView = useCallback((node: string, at?: { page?: number; pod?: string }) => {
    if (node !== viewNode) setView(node, at)
  }, [setView, viewNode])
  const moveNodeView = useCallback((at: { page: number; pod?: string | null }) => changeParams((next) => {
    next.set('nodePage', String(at.page))
    if (at.pod) next.set('pod', at.pod)
    else next.delete('pod')
  }, true), [changeParams])
  const setNodeViewPage = useCallback((page: number) => moveNodeView({ page }), [moveNodeView])
  const closeNodeView = useCallback(() => setView(null), [setView])

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
    nodeView, openNodeView, setNodeViewPage, moveNodeView, closeNodeView,
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
    selectedNamespace, setSelectedNamespace, isNamespaceDropdownOpen, searchQuery,
    nodeView, openNodeView, setNodeViewPage, moveNodeView, closeNodeView,
    selectedPod, selectedContainer, containerSearchQuery,
    activeTab, selectTab,
    showLogs, showManifest, showDescribe, showRbac, showExec,
    execContainer, execCommand, isExecContainerDropdownOpen, isExecShellDropdownOpen,
    podContextMenu, deleteTargetPod, deleteForce, deleteError, isDeletingPod, deletingPods,
    closeDetailModal, closeContextMenu, openDeleteModal, closeDeleteModal,
  ])

  return <ClusterViewContext.Provider value={value}>{children}</ClusterViewContext.Provider>
}
