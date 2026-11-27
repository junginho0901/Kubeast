// 빈 세션 (또는 임시 세션) 의 welcome 화면. AIChat.tsx 에서 추출 (Phase 3.2.a).
//
// `messages.length === 0 && (!selectedSessionId || isTempSessionId(...))` 조건은
// 부모가 판정 + conditional render. 이 컴포넌트는 항상 렌더 가능.

import { Component } from 'react'
import ParticleWaveLoader from '@/components/ParticleWaveLoader'

function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    if (!context) return false
    context.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

class WelcomeParticles extends Component<Record<string, never>, { available: boolean }> {
  state = { available: hasWebGL2() }

  static getDerivedStateFromError() {
    return { available: false }
  }

  render() {
    if (!this.state.available) {
      return (
        <div className="w-[clamp(220px,24vh,360px)] h-[clamp(220px,24vh,360px)] flex items-center justify-center" aria-hidden="true">
          <img src="/icon.svg" alt="" className="h-16 w-16" />
        </div>
      )
    }
    return <ParticleWaveLoader className="w-[clamp(220px,24vh,360px)] h-[clamp(220px,24vh,360px)]" />
  }
}

interface Props {
  emptyTitle: string
  emptySubtitle: string
  questions: string[]
  onSelectQuestion: (q: string) => void
}

export function ChatWelcome({ emptyTitle, emptySubtitle, questions, onSelectQuestion }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 sm:px-6 lg:px-10">
      <div className="w-full max-w-4xl flex flex-col items-center">
        <div className="mb-4">
          <WelcomeParticles />
        </div>
        <h2 className="text-2xl sm:text-[28px] font-medium text-ink mb-2 text-center">
          {emptyTitle}
        </h2>
        <p className="text-slate-400 mb-6 text-center text-sm sm:text-base">
          {emptySubtitle}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
          {questions.map((question, idx) => (
            <button
              key={idx}
              onClick={() => onSelectQuestion(question)}
              className="px-4 py-3 text-left text-sm bg-slate-800 border border-slate-700 hover:border-slate-500 hover:bg-slate-700/50 text-slate-300 rounded-lg transition-colors"
            >
              {question}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
