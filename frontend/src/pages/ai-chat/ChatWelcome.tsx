// 빈 세션 (또는 임시 세션) 의 welcome 화면. AIChat.tsx 에서 추출 (Phase 3.2.a).
//
// `messages.length === 0 && (!selectedSessionId || isTempSessionId(...))` 조건은
// 부모가 판정 + conditional render. 이 컴포넌트는 항상 렌더 가능.

import ParticleWaveLoader from '@/components/ParticleWaveLoader'

interface Props {
  emptyTitle: string
  emptySubtitle: string
  questions: string[]
  onSelectQuestion: (q: string) => void
}

export function ChatWelcome({ emptyTitle, emptySubtitle, questions, onSelectQuestion }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-10 sm:px-6 lg:px-10">
      <div className="w-full max-w-4xl flex flex-col items-center">
        <div className="mb-6">
          <ParticleWaveLoader className="w-[clamp(220px,24vh,360px)] h-[clamp(220px,24vh,360px)]" />
        </div>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white mb-2 text-center">
          {emptyTitle}
        </h2>
        <p className="text-slate-400 mb-8 text-center text-sm sm:text-base">
          {emptySubtitle}
        </p>

        <div className="grid grid-cols-2 gap-3 w-full px-8">
          {questions.map((question, idx) => (
            <button
              key={idx}
              onClick={() => onSelectQuestion(question)}
              className="p-4 text-left bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
            >
              {question}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
