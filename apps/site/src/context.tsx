import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { TENSOL_I18N, type TensolDict, type TensolLang } from './i18n.ts';

type TensolCtx = {
  lang: TensolLang;
  setLang: (l: TensolLang) => void;
  t: TensolDict;
};

const Ctx = createContext<TensolCtx | null>(null);
const LANG_KEY = 'tensol.lang';

const readStoredLang = (fallback: TensolLang): TensolLang => {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(LANG_KEY);
    return v === 'en' ? v : fallback;
  } catch {
    return fallback;
  }
};

export const TensolProvider = ({
  children,
  defaultLang = 'en',
}: {
  children: ReactNode;
  defaultLang?: TensolLang;
}) => {
  const [lang, setLangState] = useState<TensolLang>(() => readStoredLang(defaultLang));

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, [lang]);

  const setLang = useCallback((l: TensolLang) => setLangState(l), []);
  const value = useMemo<TensolCtx>(() => ({ lang, setLang, t: TENSOL_I18N[lang] }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useTensol = (): TensolCtx => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTensol outside TensolProvider');
  return ctx;
};
