import { useState, useEffect } from 'react'

/**
 * Dark/light mode toggle.
 * Persists to localStorage. Applies 'dark' class to <html> for Tailwind darkMode:'class'.
 * Default: dark (matches existing site design).
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('theme')
    return stored || 'dark'
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
      root.classList.remove('light')
    } else {
      root.classList.remove('dark')
      root.classList.add('light')
    }
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  return { theme, toggle, isDark: theme === 'dark' }
}
