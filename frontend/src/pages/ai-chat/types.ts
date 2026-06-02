// AIChat 의 메시지 모델.
// - id: DB 저장된 메시지면 PK, 임시(스트리밍 중) 메시지면 undefined
// - isTemporary: 스트리밍 중 표시되는 휘발성 말풍선
// - toolCalls: assistant 메시지의 tool 호출 결과 (DB tool_calls 컬럼 그대로)
// - streamingPhase: 임시 assistant 메시지의 스트리밍 단계 (waiting/tools/answer)

export interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
  isTemporary?: boolean
  toolCalls?: any[]
  streamingPhase?: 'waiting' | 'tools' | 'answer'
}
