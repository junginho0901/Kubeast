import i18next from 'i18next'

// The screen's language for requests whose text the server writes (the optimization table and answer, the
// terminal recording notice): "ko" or "en".
export function uiLang(): 'ko' | 'en' {
  return (i18next.resolvedLanguage || i18next.language || 'en').startsWith('ko') ? 'ko' : 'en'
}
