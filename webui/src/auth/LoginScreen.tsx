import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, errorMessage } from '../api/client'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'

const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
]

export function LoginScreen({
  onSubmit,
}: {
  onSubmit: (password: string) => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await onSubmit(password)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(t('auth.tooManyAttempts'))
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-screen-bar">
        <span className="brand">
          <span className="brand-mark">
            <Icon name="candles" size={15} />
          </span>
          FuturesView
        </span>
        <div className="spacer" />
        <ThemeToggle />
        <div className="segmented" role="group" aria-label={t('workspace.language')}>
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`segmented-btn ${i18n.resolvedLanguage === l.code ? 'active' : ''}`}
              aria-pressed={i18n.resolvedLanguage === l.code}
              onClick={() => void i18n.changeLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="auth-screen-main">
        <form className="auth-card" onSubmit={(e) => void handleSubmit(e)}>
          <span className="brand">
            <span className="brand-mark">
              <Icon name="lock" size={15} />
            </span>
            FuturesView
          </span>
          <h1>{t('auth.loginTitle')}</h1>
          <p className="auth-card-hint">{t('auth.loginHint')}</p>
          <div className="field">
            <label htmlFor="auth-login-password">{t('auth.password')}</label>
            <input
              id="auth-login-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={error ? 'invalid' : undefined}
            />
            {error && <p className="field-error">{error}</p>}
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !password}>
            {t('auth.login')}
          </button>
        </form>
      </div>
    </div>
  )
}

export function AuthSplash() {
  const { t } = useTranslation()
  return (
    <div className="auth-screen">
      <div className="auth-screen-main">
        <div className="auth-card">
          <span className="brand">
            <span className="brand-mark">
              <Icon name="candles" size={15} />
            </span>
            FuturesView
          </span>
          <p className="auth-card-hint">{t('common.loading')}</p>
        </div>
      </div>
    </div>
  )
}
