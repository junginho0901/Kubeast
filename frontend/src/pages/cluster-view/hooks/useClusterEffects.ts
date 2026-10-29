import { useEffect } from 'react'
import { useClusterView } from '../ClusterViewContext'

// ClusterView 의 5 useEffect 묶음:
// 1) ESC → 메뉴 → delete 모달 → detail 모달 순서로 close
// 2) context-menu 가 떠 있을 때 resize/scroll 발생하면 close
// 3) namespace dropdown 외부 클릭 close
// 4) exec container/shell dropdown 외부 클릭 close
// (deletingPods 재조정은 노드 상자마다 — PodNodeGrid NodeBox: 그 노드 목록에서 사라진 pod 의 키 제거)

export function useClusterEffects() {
  const {
    podContextMenu, setPodContextMenu,
    deleteTargetPod, closeDeleteModal,
    selectedPod, closeDetailModal,
    isNamespaceDropdownOpen, setIsNamespaceDropdownOpen,
    namespaceDropdownRef,
    isExecContainerDropdownOpen, setIsExecContainerDropdownOpen,
    isExecShellDropdownOpen, setIsExecShellDropdownOpen,
    execContainerDropdownRef, execShellDropdownRef,
  } = useClusterView()

  // 1) ESC 키 — 메뉴 → 삭제 모달 → 상세 모달 순으로 닫는다.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (podContextMenu) setPodContextMenu(null)
      else if (deleteTargetPod) closeDeleteModal()
      else if (selectedPod) closeDetailModal()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [selectedPod, podContextMenu, deleteTargetPod, setPodContextMenu, closeDeleteModal, closeDetailModal])

  // 2) context-menu 가 떠 있을 때 화면 변경되면 자동 close (좌표가 stale 됨)
  useEffect(() => {
    if (!podContextMenu) return
    const handleClose = () => setPodContextMenu(null)
    window.addEventListener('resize', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [podContextMenu, setPodContextMenu])

  // 3) namespace dropdown 외부 클릭 close
  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        namespaceDropdownRef.current &&
        !namespaceDropdownRef.current.contains(event.target as Node)
      ) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNamespaceDropdownOpen, namespaceDropdownRef, setIsNamespaceDropdownOpen])

  // 4) exec container/shell dropdown 외부 클릭 close
  useEffect(() => {
    if (!isExecContainerDropdownOpen && !isExecShellDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (execContainerDropdownRef.current && !execContainerDropdownRef.current.contains(event.target as Node)) {
        setIsExecContainerDropdownOpen(false)
      }
      if (execShellDropdownRef.current && !execShellDropdownRef.current.contains(event.target as Node)) {
        setIsExecShellDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isExecContainerDropdownOpen, isExecShellDropdownOpen, execContainerDropdownRef, execShellDropdownRef, setIsExecContainerDropdownOpen, setIsExecShellDropdownOpen])
}
