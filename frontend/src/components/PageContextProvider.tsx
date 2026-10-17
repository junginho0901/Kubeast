import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { resolveRouteMeta } from '@/utils/aiContext/routeMatcher'
import { isPrivateScreen } from '@/utils/aiContext/privateScreens'
import { PageContextCtx, type PageContextSnapshot, type PageContextValue, type VisibleDataLayer } from './PageContext'

export function PageContextProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { t, i18n } = useTranslation()
  // pageTitle 을 현재 언어로 변환 (titleKey 가 있으면 i18n, 없으면 fallback 그대로).
  // i18n.language 변경 시 다시 계산되도록 deps 에 포함.
  const meta = useMemo(() => {
    const raw = resolveRouteMeta(location.pathname)
    const pageTitle = raw.titleKey
      ? t(raw.titleKey, { defaultValue: raw.pageTitle })
      : raw.pageTitle
    return { ...raw, pageTitle }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, t, i18n.language])

  // Map<layerId, VisibleDataLayer>
  const layersRef = useRef<Map<string, VisibleDataLayer>>(new Map())
  const contextChangedRef = useRef<boolean>(false)

  // 경로 변경 시 contextChanged 플래그 set. 레이어는 각 화면이 언마운트 때 지운다 — 여기서 비우면
  // 같은 커밋에서 먼저 등록된 새 화면과 열려 있는 드로어의 레이어까지 사라진다.
  useEffect(() => {
    contextChangedRef.current = true
  }, [location.pathname])

  const registerLayer = useCallback((id: string, layer: VisibleDataLayer) => {
    layersRef.current.set(id, layer)
  }, [])

  const unregisterLayer = useCallback((id: string) => {
    layersRef.current.delete(id)
  }, [])

  const getSnapshot = useCallback((): PageContextSnapshot => {
    // nothing from a private screen, whatever window on it registered a layer
    const all = isPrivateScreen(meta.path) ? [] : Array.from(layersRef.current.values())
    const base = all.find((l) => l.source === 'base')
    const overlays = all.filter((l) => l.source !== 'base')
    return {
      ...meta,
      snapshotAt: new Date().toISOString(),
      contextChanged: contextChangedRef.current,
      base,
      overlays,
    }
  }, [meta])

  const consumeContextChanged = useCallback(() => {
    const was = contextChangedRef.current
    contextChangedRef.current = false
    return was
  }, [])

  const value = useMemo<PageContextValue>(
    () => ({
      ...meta,
      registerLayer,
      unregisterLayer,
      getSnapshot,
      consumeContextChanged,
    }),
    [meta, registerLayer, unregisterLayer, getSnapshot, consumeContextChanged],
  )

  return (
    <PageContextCtx.Provider value={value}>{children}</PageContextCtx.Provider>
  )
}
