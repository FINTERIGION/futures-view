import { api } from './client'

export interface AuthStatus {
  password_set: boolean
  authenticated: boolean
}

export const AUTH_STATUS_KEY = ['auth', 'status'] as const

export const authApi = {
  status: () => api.get<AuthStatus>('/auth/status'),
  login: (password: string) => api.post<{ ok: boolean }>('/auth/login', { password }),
  logout: () => api.post<{ ok: boolean }>('/auth/logout'),
  /** `password` null or omitted clears the stored password. */
  updatePassword: (body: { current?: string; password?: string | null }) =>
    api.put<{ password_set: boolean }>('/auth/password', body),
}
