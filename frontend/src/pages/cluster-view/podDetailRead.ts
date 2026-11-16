import { useEffect } from 'react'
import { pickMainContainer, podToDetail, type DetailTab, type PodDetail } from './types'

// A pod's window opened from a Cluster View box's row has no containers to show: the box's read gives only what the box
// draws (k8s-service nodeBoxPod) until a live frame brings the pod's full row. As an object's details open in Freelens
// (the store's object, else a read of it) and in Rancher (`find`: the store's, else a GET), a row with its containers
// opens at once and one without reads the pod — its describe, the Describe tab's own read under the same key — before
// Summary, Logs and Exec show it and Logs or Exec choose a container.

/** The pod's describe as the window holds it: the answer and the error with when each came (react-query's state). */
export interface PodRead {
  data: any
  dataAt: number
  error: unknown
  errorAt: number
}

/** The window reads the pod: it was opened from a row without containers. */
export const readsPod = (pod: PodDetail | null): pod is PodDetail => !!pod && !pod.containersKnown

export type PodReadShown = 'none' | 'reading' | { error: unknown }

/** What the window shows of the pod's read: nothing to wait for, the read on its way, or its failure since it opened. */
export function podReadState(pod: PodDetail | null, read: PodRead): PodReadShown {
  if (!readsPod(pod)) return 'none'
  if (read.error && read.errorAt >= (pod.openedAt ?? 0) && read.errorAt >= read.dataAt) return { error: read.error }
  return 'reading'
}

export interface DetailChoice {
  activeTab: DetailTab
  selectedContainer: string
  execContainer: string
}

/**
 * The window once the pod's read has answered after it opened: the pod with its containers, and the container Logs or
 * Exec opens on when it is the tab shown and none is chosen yet. null until then.
 */
export function filledDetail(pod: PodDetail, read: PodRead, choice: DetailChoice): { pod: PodDetail; container?: string; execContainer?: string } | null {
  const answer = read.data
  if (!answer || answer.name !== pod.name || answer.namespace !== pod.namespace || read.dataAt < (pod.openedAt ?? 0)) return null
  const filled: PodDetail = { ...podToDetail(answer), containersKnown: true }
  return {
    pod: filled,
    container: choice.activeTab === 'logs' && !choice.selectedContainer ? pickMainContainer(filled) : undefined,
    execContainer: choice.activeTab === 'exec' && !choice.execContainer ? (filled.containers[0]?.name ?? '') : undefined,
  }
}

/**
 * openPodWindow opens a box card's pod on Logs (a click) or Exec (the menu): a full row chooses the container at once,
 * a box's row leaves it to the pod's read (usePodDetailRead).
 */
export function openPodWindow(pod: any, tab: 'logs' | 'exec', view: {
  setSelectedPod: (p: PodDetail) => void
  setSelectedContainer: (c: string) => void
  setContainerSearchQuery: (q: string) => void
  setExecContainer: (c: string) => void
  selectTab: (t: DetailTab) => void
}) {
  const detail = podToDetail(pod)
  view.setSelectedPod(detail)
  if (tab === 'logs') {
    view.setSelectedContainer(pickMainContainer(detail))
    view.setContainerSearchQuery('')
  } else {
    view.setExecContainer(detail.containers[0]?.name ?? '')
  }
  view.selectTab(tab)
}

/** usePodDetailRead fills the window opened from a row without containers once the pod's read answers. */
export function usePodDetailRead(o: {
  selectedPod: PodDetail | null
  read: PodRead
  choice: DetailChoice
  setSelectedPod: (p: PodDetail) => void
  setSelectedContainer: (c: string) => void
  setExecContainer: (c: string) => void
}) {
  const { selectedPod, read, choice, setSelectedPod, setSelectedContainer, setExecContainer } = o
  const { data, dataAt, error, errorAt } = read
  const { activeTab, selectedContainer, execContainer } = choice
  useEffect(() => {
    if (!readsPod(selectedPod)) return
    const filled = filledDetail(selectedPod, { data, dataAt, error, errorAt }, { activeTab, selectedContainer, execContainer })
    if (!filled) return
    setSelectedPod(filled.pod)
    if (filled.container !== undefined) setSelectedContainer(filled.container)
    if (filled.execContainer !== undefined) setExecContainer(filled.execContainer)
  }, [selectedPod, data, dataAt, error, errorAt, activeTab, selectedContainer, execContainer, setSelectedPod, setSelectedContainer, setExecContainer])
}
