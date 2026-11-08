import { createContext } from 'react'
import type { QueryKey } from '@tanstack/react-query'

// The drawer's read of its object for the floating chat: the view that watches the object reads it when it changes, and says whether the watch answers.
export const DrawerObjectReadContext = createContext<{ key: QueryKey; setWatchAnswers: (answers: boolean) => void } | null>(null)
