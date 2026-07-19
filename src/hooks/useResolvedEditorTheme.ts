import { useEffect, useMemo, useState } from 'react'
import { useSettingsStore, type UIThemeSetting } from '../stores/useSettingsStore'

function readSystemDarkMode(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useResolvedEditorTheme(): 'vs' | 'vs-dark' {
  const theme = useSettingsStore((state) => state.theme)
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => readSystemDarkMode())

  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemPrefersDark(mediaQuery.matches)

    update()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update)
      return () => mediaQuery.removeEventListener('change', update)
    }

    mediaQuery.addListener(update)
    return () => mediaQuery.removeListener(update)
  }, [theme])

  return useMemo(() => resolveEditorTheme(theme, systemPrefersDark), [theme, systemPrefersDark])
}

function resolveEditorTheme(theme: UIThemeSetting, systemPrefersDark: boolean): 'vs' | 'vs-dark' {
  if (theme === 'system') {
    return systemPrefersDark ? 'vs-dark' : 'vs'
  }
  // `cursor` is a dark variant (neutral gray), so it maps to Monaco's dark editor.
  // `milk` is a warm off-white variant of `light` — both use Monaco's light editor.
  return theme === 'light' || theme === 'milk' ? 'vs' : 'vs-dark'
}
