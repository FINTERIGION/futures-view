import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTH_STATUS_KEY, authApi } from '../api/auth'
import { setUnauthorizedHandler } from '../api/client'
import { AuthSplash, LoginScreen } from './LoginScreen'
import './auth.css'

/**
 * Gate the workspace behind the optional access password.
 *
 * Status is a shared react-query key so the access drawer and this gate
 * see the same row: setting a password, signing in, or signing out
 * invalidates it and the next paint follows. A 401 anywhere else (an
 * expired cookie mid-session) flips the cached row to "not authenticated"
 * and drops the rest of the query cache, which is what swaps the
 * workspace for the login screen without a reload.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: authApi.status,
    staleTime: 10_000,
  })

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        password_set: true,
        authenticated: false,
      })
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'auth',
      })
    })
    return () => setUnauthorizedHandler(null)
  }, [queryClient])

  if (isPending) return <AuthSplash />

  if (isError || !data) {
    return (
      <div className="auth-screen">
        <div className="auth-screen-main">
          <div className="auth-card">
            <h1>{t('auth.unreachableTitle')}</h1>
            <p className="auth-card-hint">{t('auth.unreachableHint')}</p>
            <button className="btn btn-primary btn-block" type="button" onClick={() => void refetch()}>
              {t('auth.retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (data.password_set && !data.authenticated) {
    return (
      <LoginScreen
        onSubmit={async (password) => {
          await authApi.login(password)
          await queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY })
        }}
      />
    )
  }

  return children
}
