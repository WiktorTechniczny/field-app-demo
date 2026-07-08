import { useState } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '../hooks/useAuth'
import { APP_NAME, APP_VERSION, ENTRY_SPLASH_STORAGE_KEY } from '../appMeta'

type LoginPageProps = {
  onLoginTransitionStart?: () => void
  onLoginTransitionCancel?: () => void
}

export default function LoginPage({ onLoginTransitionStart, onLoginTransitionCancel }: LoginPageProps) {
  const { login } = useAuth()
  const [username, setUsername] = useState(() => localStorage.getItem('rememberUser') || '')
  const [password, setPassword] = useState(() => localStorage.getItem('rememberPass') || '')
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem('rememberUser'))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    localStorage.removeItem('preferredProfile')
    sessionStorage.setItem(ENTRY_SPLASH_STORAGE_KEY, '1')
    onLoginTransitionStart?.()

    const result = await login(username.trim(), password.trim())

    setLoading(false)

    if (!result.ok) {
      sessionStorage.removeItem(ENTRY_SPLASH_STORAGE_KEY)
      onLoginTransitionCancel?.()
      setError('Nieprawid\u0142owy login lub has\u0142o.')
      return
    }

    if (rememberMe) {
      localStorage.setItem('rememberUser', username)
      localStorage.setItem('rememberPass', password)
    } else {
      localStorage.removeItem('rememberUser')
      localStorage.removeItem('rememberPass')
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.22),_transparent_32%),linear-gradient(135deg,_rgba(8,47,73,0.96),_rgba(15,23,42,0.98))]" />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.03)_24%,transparent_46%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-md items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="w-full"
        >
          <form
            onSubmit={handleSubmit}
            className="rounded-[30px] border border-white/10 bg-slate-950/78 p-6 text-white shadow-[0_28px_70px_rgba(8,15,40,0.45)] backdrop-blur-xl"
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <motion.div
                initial={{ rotate: -8, scale: 0.92 }}
                animate={{ rotate: 0, scale: 1 }}
                transition={{ delay: 0.08, duration: 0.3 }}
                className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-gradient-to-br from-cyan-400 via-sky-500 to-indigo-600 text-white shadow-lg shadow-cyan-500/30"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8">
                  <path d="M12 20V9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  <circle cx="12" cy="7" r="4" fill="#ff6130" stroke="#111827" strokeWidth="1.8" />
                  <path d="M10.8 20h2.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </motion.div>
              <div className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.26em] text-cyan-200">
                v{APP_VERSION}
              </div>
            </div>

            <div className="mb-6">
              <p className="mb-2 text-[10px] font-black uppercase tracking-[0.28em] text-cyan-200/70">
                Logowanie do aplikacji
              </p>
              <h1 className="text-3xl font-black tracking-tight">{APP_NAME}</h1>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.22em] text-slate-400/90">
                  Login
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Wpisz login"
                  autoComplete="username"
                  className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.22em] text-slate-400/90">
                  {'Has\u0142o'}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={'Wpisz has\u0142o'}
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20"
                />
              </div>

              <div className="flex items-center px-1 py-1">
                <input
                  id="remember-login"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-cyan-500 focus:ring-cyan-500"
                />
                <label htmlFor="remember-login" className="ml-3 cursor-pointer text-sm text-slate-200">
                  {'Pami\u0119taj dane logowania'}
                </label>
              </div>
            </div>

            {error && (
              <p className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim() || !password.trim()}
              className="ui-pressable mt-5 flex w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-sky-600 px-4 py-3.5 text-sm font-black uppercase tracking-[0.18em] text-white shadow-lg shadow-cyan-500/25 transition-all hover:from-cyan-400 hover:to-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Logowanie...' : 'Zaloguj si\u0119'}
            </button>
          </form>
        </motion.div>
      </div>
    </div>
  )
}
