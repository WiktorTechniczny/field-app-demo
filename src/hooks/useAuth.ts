import { createContext, useContext } from 'react'
import type { User, Shift } from '../db'

export type LoginFailureReason = 'invalid_credentials'
export type LoginResult = { ok: true } | { ok: false; reason: LoginFailureReason }

export interface AuthState {
    user: User | null
    activeShift: Shift | null
    login: (u: string, p: string) => Promise<LoginResult>
    logout: () => void
    startShift: () => Promise<void>
    endShift: () => Promise<void>
    hasFinishedToday: boolean
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}
