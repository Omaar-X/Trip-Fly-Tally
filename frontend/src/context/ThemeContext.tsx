import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { storage } from '../api/client';

interface ThemeCtx { dark: boolean; toggle: () => void; }
const Ctx = createContext<ThemeCtx>(null as never);
export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() =>
    storage.get('tf_theme') === 'dark' ||
    (!storage.get('tf_theme') && window.matchMedia('(prefers-color-scheme: dark)').matches));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    storage.set('tf_theme', dark ? 'dark' : 'light');
  }, [dark]);

  return <Ctx.Provider value={{ dark, toggle: () => setDark(d => !d) }}>{children}</Ctx.Provider>;
}
