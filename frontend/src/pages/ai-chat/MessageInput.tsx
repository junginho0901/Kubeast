// AI Chat 입력 영역 — textarea + Send/Stop 버튼. AIChat.tsx 에서 추출 (Phase 3.2.a).
//
// streaming 중에는 textarea disabled + Stop 버튼 노출. Enter 키 (shift 없이)
// 로 전송, Shift+Enter 줄바꿈(IME 조합 중에도 — useChatTextareaKeys). 줄이 늘면 240px 까지 커진다.

import { useRef } from 'react'
import { Send, StopCircle } from 'lucide-react'
import { useAutoGrowTextarea, useChatTextareaKeys } from '@/hooks/useChatTextarea'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  isStreaming: boolean
  placeholder: string
  sendLabel: string
  stopLabel: string
}

export function MessageInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  placeholder,
  sendLabel,
  stopLabel,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrowTextarea(ref, value, 240)
  const keys = useChatTextareaKeys(ref, onChange, () => {
    if (!isStreaming) onSubmit()
  })
  return (
    <div className="p-4 border-t border-slate-700 bg-slate-800">
      <div className="flex items-end gap-3">
        <textarea
          ref={ref}
          data-testid="chat-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keys.onKeyDown}
          onCompositionEnd={keys.onCompositionEnd}
          placeholder={placeholder}
          disabled={isStreaming}
          rows={1}
          className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-hidden focus:border-primary-500 disabled:opacity-50 resize-none"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="btn bg-red-600 hover:bg-red-700 text-white px-6 h-[50px] flex items-center gap-2"
          >
            <StopCircle className="w-4 h-4" />
            {stopLabel}
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            className="btn btn-primary px-6 h-[50px] flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
            {sendLabel}
          </button>
        )}
      </div>
    </div>
  )
}
