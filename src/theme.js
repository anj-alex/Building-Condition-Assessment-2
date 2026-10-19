const THEME_KEY = 'app-theme'
const THEME_PREFERENCES = ['light', 'dark', 'system']

function getThemePreference() {
  const raw = localStorage.getItem(THEME_KEY)
  if (THEME_PREFERENCES.includes(raw)) return raw
  return 'system'
}

function resolveTheme(preference = getThemePreference()) {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyResolvedTheme(resolved) {
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

function setThemePreference(preference) {
  const next = THEME_PREFERENCES.includes(preference) ? preference : 'system'
  localStorage.setItem(THEME_KEY, next)
  applyResolvedTheme(resolveTheme(next))
  return next
}

function applyStoredTheme() {
  applyResolvedTheme(resolveTheme(getThemePreference()))
}

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)')
systemThemeQuery.addEventListener('change', () => {
  if (getThemePreference() === 'system') {
    applyResolvedTheme(resolveTheme('system'))
  }
})

applyStoredTheme()
