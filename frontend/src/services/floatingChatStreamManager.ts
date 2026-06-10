import type { PageContextSnapshot } from '@/components/PageContextProvider'
import { ChatStreamManager } from './chatStreamManager'
import { clusterHeaders } from './clusterRef'

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
  // step 14: scope the floating chat's tool calls to the active cluster.
  extraHeaders: clusterHeaders,
})

export interface FloatingChatExtraBody {
  page_context?: PageContextSnapshot
}
