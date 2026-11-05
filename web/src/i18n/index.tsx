import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readUiLocale, statusLabel, translate, writeUiLocale, type UiLocale } from "./messages.ts";

let active: UiLocale = "vi";
/** Read by non-hook helpers (date formatting) during render. The provider updates this before children render. */
export function uiLocale(): UiLocale {
  return active;
}

type Ctx = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  status: (code: string) => string;
};

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(() => {
    try {
      return readUiLocale((k) => localStorage.getItem(k));
    } catch {
      return "vi";
    }
  });
  active = locale;
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      writeUiLocale((k, v) => localStorage.setItem(k, v), locale);
    } catch {}
  }, [locale]);
  const value = useMemo<Ctx>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (key, params) => translate(locale, key, params),
      status: (code) => statusLabel(locale, code),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
