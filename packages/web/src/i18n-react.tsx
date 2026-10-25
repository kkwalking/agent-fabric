import { createContext, useContext, useEffect, useState } from "react";
import {
  applyDocumentLanguage,
  readStoredLanguage,
  storeLanguage,
  translate,
  type Language,
  type MessageKey,
  type Translate,
} from "./i18n";

/**
 * Language state for the whole app.
 *
 * One provider at the root owns the choice; every component that renders text
 * reads it from here. `setLanguage` is applied immediately (no reload, no round
 * trip) and remembered for the next visit.
 */
export interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
}

/** English until a provider mounts: nothing outside the app renders text. */
const defaultValue: LanguageContextValue = {
  language: "en",
  setLanguage: () => {},
  t: (key: MessageKey, vars?: Record<string, string | number>) => translate("en", key, vars),
};

export const LanguageContext = createContext<LanguageContextValue>(defaultValue);

/** The active language and translator. */
export function useI18n(): LanguageContextValue {
  return useContext(LanguageContext);
}

/** Just the translator, for components that render text and nothing else. */
export function useT(): Translate {
  return useContext(LanguageContext).t;
}

/** Owns the language state; mounted once, at the root. */
export function useLanguageState(): LanguageContextValue {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  return {
    language,
    setLanguage: (next: Language) => {
      storeLanguage(next);
      applyDocumentLanguage(next);
      setLanguageState(next);
    },
    t: (key: MessageKey, vars?: Record<string, string | number>) => translate(language, key, vars),
  };
}
