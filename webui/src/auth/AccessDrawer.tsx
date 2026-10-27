import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTH_STATUS_KEY, authApi } from '../api/auth'
import { errorMessage } from '../api/client'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Drawer } from '../components/Drawer'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import './auth.css'

const MIN = 8

export function AccessDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: authApi.status,
    enabled: open,
  })
  const passwordSet = data?.password_set ?? false

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [clearOpen, setClearOpen] = useState(false)

  function resetForm() {
    setCurrent('')
    setNext('')
    setConfirm('')
    setFormError(null)
    setClearOpen(false)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  const update = useMutation({
    mutationFn: authApi.updatePassword,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
      resetForm()
      toast.push({
        kind: 'success',
        title: result.password_set ? t('auth.passwordSaved') : t('auth.passwordCleared'),
      })
    },
    onError: (err: unknown) => {
      setFormError(errorMessage(err))
    },
  })

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
    },
    onError: (err: unknown) => {
      toast.push({ kind: 'error', title: errorMessage(err) })
    },
  })

  function localError(): string | null {
    if (next && next.length < MIN) return t('auth.passwordTooShort', { min: MIN })
    if (next && next !== confirm) return t('auth.passwordMismatch')
    return null
  }

  function handleSave(e: FormEvent) {
    e.preventDefault()
    const local = localError()
    if (local) {
      setFormError(local)
      return
    }
    if (!next) {
      setFormError(t('auth.passwordTooShort', { min: MIN }))
      return
    }
    setFormError(null)
    update.mutate({ current: passwordSet ? current : undefined, password: next })
  }

  function handleClear() {
    if (passwordSet && !current) {
      setFormError(t('auth.currentRequired'))
      setClearOpen(false)
      return
    }
    setClearOpen(false)
    update.mutate({ current: passwordSet ? current : undefined, password: null })
  }

  return (
    <>
      <Drawer open={open} onClose={handleClose} title={t('auth.access')}>
        <div className="hint-banner">
          <Icon name="info" />
          <span>{t('auth.accessHint')}</span>
        </div>

        <div className="auth-status-row">
          <Icon name={passwordSet ? 'lock' : 'unlock'} />
          <span>
            <strong>{passwordSet ? t('auth.lockedStatus') : t('auth.openStatus')}</strong>
            {' — '}
            {passwordSet ? t('auth.lockedStatusHint') : t('auth.openStatusHint')}
          </span>
        </div>

        <form onSubmit={handleSave}>
          <div className="auth-section">
            <h4>{passwordSet ? t('auth.changePassword') : t('auth.setPassword')}</h4>
            {passwordSet && (
              <div className="field">
                <label htmlFor="auth-current">{t('auth.currentPassword')}</label>
                <input
                  id="auth-current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-new">{t('auth.newPassword')}</label>
              <input
                id="auth-new"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <p className="field-hint">{t('auth.passwordTooShort', { min: MIN })}</p>
            </div>
            <div className="field">
              <label htmlFor="auth-confirm">{t('auth.confirmPassword')}</label>
              <input
                id="auth-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {formError && <p className="field-error">{formError}</p>}
            </div>
            <button className="btn btn-primary" type="submit" disabled={update.isPending || !next}>
              {passwordSet ? t('auth.changePassword') : t('auth.setPassword')}
            </button>
          </div>
        </form>

        {passwordSet && (
          <div className="auth-section">
            <h4>{t('auth.clearPassword')}</h4>
            <p className="field-hint">{t('auth.clearPasswordHint')}</p>
            <p className="field-hint">{t('auth.forgotHint')}</p>
            <div className="toolbar">
              <button
                className="btn btn-danger"
                type="button"
                disabled={update.isPending}
                onClick={() => setClearOpen(true)}
              >
                {t('auth.clearPassword')}
              </button>
              <button
                className="btn"
                type="button"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                {t('auth.logout')}
              </button>
            </div>
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={clearOpen}
        title={t('auth.clearPassword')}
        body={t('auth.clearPasswordConfirm')}
        confirmLabel={t('auth.clearPassword')}
        onCancel={() => setClearOpen(false)}
        onConfirm={handleClear}
      />
    </>
  )
}
