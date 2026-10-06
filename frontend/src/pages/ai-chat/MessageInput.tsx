// AI Chat 입력 영역 — textarea + Send/Stop 버튼. AIChat.tsx 에서 추출 (Phase 3.2.a).
//
// streaming 중에는 textarea disabled + Stop 버튼 노출. Enter 키 (shift 없이)
// 로 전송, 한글 IME composing 중에는 무시.

import { Send, StopCircle } from 'lucide-react'

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
  return (
    <div className="p-4 border-t border-slate-700 bg-slate-800">
      <div className="flex gap-3">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!isStreaming) onSubmit()
            }
          }}
          placeholder={placeholder}
          disabled={isStreaming}
          rows={1}
          className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-hidden focus:border-primary-500 disabled:opacity-50 resize-none"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="btn bg-red-600 hover:bg-red-700 text-white px-6 flex items-center gap-2"
          >
            <StopCircle className="w-4 h-4" />
            {stopLabel}
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            className="btn btn-primary px-6 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
            {sendLabel}
          </button>
        )}
      </div>
    </div>
  )
}
