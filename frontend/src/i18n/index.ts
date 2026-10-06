import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ko from './locales/ko.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // `detail` = the drawer label catalog (ko.json's detail block) as its own
    // namespace: keys are English labels that may hold "." or ":"
    // (components/resource-detail/detailLabel.ts).
    resources: {
      en: { translation: en, detail: {} },
      ko: { translation: ko, detail: ko.detail },
    },
    ns: ['translation', 'detail'],
    defaultNS: 'translation',
    // No fixed `lng`: it would override the detector, so the language chosen
    // in Settings (cached in localStorage) and the browser language were both
    // ignored on the next load and the UI always came back in English.
    fallbackLng: 'en',
    supportedLngs: ['en', 'ko'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

export default i18n
