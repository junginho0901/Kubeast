import { useCallback } from 'react'
import { api } from '@/services/api'
import { useClusterView } from '../ClusterViewContext'

// Pod 삭제 — UI 상태 (deletingPods Set) 와 함께 처리.
// 성공: 모달 close + (현재 detail 가 같은 Pod 이면) detail 도 close.
// 실패: Set 에서 키 제거 + error 메시지 표시.

export function usePodDelete() {
  const {
    deleteTargetPod,
    isDeletingPod,
    deleteForce,
    setIsDeletingPod,
    setDeleteError,
    setDeletingPods,
    selectedPod,
    closeDetailModal,
    closeDeleteModal,
  } = useClusterView()

  const handleDeletePod = useCallback(async () => {
    if (!deleteTargetPod || isDeletingPod) return
    setIsDeletingPod(true)
    setDeleteError(null)
    const target = deleteTargetPod
    const podKey = `${target.namespace}/${target.name}`
    setDeletingPods((prev) => new Set(prev).add(podKey))
    try {
      await api.deletePod(target.namespace, target.name, deleteForce)
      if (selectedPod?.name === target.name && selectedPod?.namespace === target.namespace) {
        closeDetailModal()
      }
      closeDeleteModal()
    } catch (error: any) {
      setDeletingPods((prev) => {
        const next = new Set(prev)
        next.delete(podKey)
        return next
      })
      setDeleteError(error?.response?.data?.detail || error?.message || '삭제에 실패했습니다.')
    } finally {
      setIsDeletingPod(false)
    }
  }, [deleteTargetPod, isDeletingPod, deleteForce, selectedPod, setIsDeletingPod, setDeleteError, setDeletingPods, closeDetailModal, closeDeleteModal])

  return { handleDeletePod }
}
