import type { PageContextSnapshot } from '@/components/PageContextProvider'
import { ChatStreamManager } from './chatStreamManager'

/**
 * 플로팅 AI 위젯 전용 스트림 매니저.
 *
 * 기존 싱글톤 `chatStreamManager` 와 별도 인스턴스 — 상태(assistantContent,
 * abortController 등)가 분리되어 AIChat 페이지와 플로팅이 동시에 스트리밍 가능.
 *
 * 엔드포인트: `POST /api/v1/ai/sessions/{id}/floating-chat` (JSON body)
 */
export const floatingChatStreamManager = new ChatStreamManager({
  endpoint: '/api/v1/ai/sessions/{sessionId}/floating-chat',
  bodyJson: true,
  // 멀티클러스터 PR 에서 `X-Cluster-Name` 헤더 주입. 현재는 빈 객체.
  extraHeaders: () => ({}),
})

export interface FloatingChatExtraBody {
  page_context?: PageContextSnapshot
}
