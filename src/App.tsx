import { startTransition, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ToastBar, Toaster } from 'react-hot-toast'
import { useAuth } from './hooks/useAuth'
import AdminPanel from './pages/AdminPanel'
import LoginPage from './pages/LoginPage'
import SurveyForm from './pages/SurveyForm'
import WorkerDashboard from './pages/WorkerDashboard'
import type { SalesMeeting } from './db'
import {
  APP_NAME,
  APP_VERSION,
  ENTRY_SPLASH_STORAGE_KEY,
  PROFILE_META,
  getProfileLabel,
  getProfileSubtitle,
} from './appMeta'

type ToastTone = 'success' | 'error' | 'loading' | 'info'

const getToastTone = (type: string): ToastTone => {
  if (type === 'success' || type === 'error' || type === 'loading') return type
  return 'info'
}

const renderToastIcon = (tone: ToastTone) => {
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
        <path d="M4.75 10.25l3.25 3.25 7.25-7.5" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (tone === 'error') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
        <path d="M10 6.25v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="10" cy="13.85" r="1.05" fill="currentColor" />
        <path d="M9.14 3.62L2.69 14.42a1 1 0 00.86 1.51h12.9a1 1 0 00.86-1.51L10.86 3.62a1 1 0 00-1.72 0z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    )
  }

  if (tone === 'loading') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 animate-spin" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeOpacity="0.24" strokeWidth="2" />
        <path d="M10 3a7 7 0 017 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M10 5.75v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="13.75" r="1.05" fill="currentColor" />
      <circle cx="10" cy="10" r="7.1" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

const isReloadNavigation = (): boolean => {
  const [navigationEntry] = performance.getEntriesByType('navigation')

  if (navigationEntry && 'type' in navigationEntry) {
    return (navigationEntry as PerformanceNavigationTiming).type === 'reload'
  }

  const legacyPerformance = performance as Performance & { navigation?: { type?: number } }
  return legacyPerformance.navigation?.type === 1
}

function App() {
  const { user } = useAuth()
  const [view, setView] = useState<'dashboard' | 'survey'>(() => {
    try {
      const saved = localStorage.getItem('HandlowcyApp.activeView')
      if (saved) return JSON.parse(saved).view || 'dashboard'
    } catch {
      // ignore
    }
    return 'dashboard'
  })
  const [surveyCoords, setSurveyCoords] = useState<{ lat: number; lng: number } | null>(() => {
    try {
      const saved = localStorage.getItem('HandlowcyApp.activeView')
      if (saved) return JSON.parse(saved).surveyCoords || null
    } catch {
      // ignore
    }
    return null
  })
  const [activeMeeting, setActiveMeeting] = useState<SalesMeeting | null>(() => {
    try {
      const saved = localStorage.getItem('HandlowcyApp.activeView')
      if (saved) return JSON.parse(saved).activeMeeting || null
    } catch {
      // ignore
    }
    return null
  })
  const [activeMeetingStartedAt, setActiveMeetingStartedAt] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem('HandlowcyApp.activeView')
      if (saved) return JSON.parse(saved).activeMeetingStartedAt || null
    } catch {
      // ignore
    }
    return null
  })

  useEffect(() => {
    if (user && user.role !== 'admin') {
      localStorage.setItem('HandlowcyApp.activeView', JSON.stringify({ view, surveyCoords, activeMeeting, activeMeetingStartedAt }))
    } else if (!user) {
      localStorage.removeItem('HandlowcyApp.activeView')
    }
  }, [view, surveyCoords, activeMeeting, activeMeetingStartedAt, user])

  const [workerMeetingPatch, setWorkerMeetingPatch] = useState<SalesMeeting | null>(null)
  const [toastPosition, setToastPosition] = useState<'top-center' | 'bottom-center'>('bottom-center')
  const [showEntrySplash, setShowEntrySplash] = useState(false)
  const [entryRole, setEntryRole] = useState<'worker' | 'admin' | null>(null)
  const previousUserIdRef = useRef<number | null>(null)
  const splashHideTimerRef = useRef<number | null>(null)

  const clearEntrySplashTimer = () => {
    if (splashHideTimerRef.current !== null) {
      window.clearTimeout(splashHideTimerRef.current)
      splashHideTimerRef.current = null
    }
  }

  const beginEntrySplash = () => {
    clearEntrySplashTimer()
    setEntryRole(null)
    setShowEntrySplash(true)
  }

  const cancelEntrySplash = () => {
    clearEntrySplashTimer()
    setShowEntrySplash(false)
    setEntryRole(null)
  }

  useEffect(() => {
    return () => clearEntrySplashTimer()
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const syncPosition = () => setToastPosition(media.matches ? 'top-center' : 'bottom-center')

    syncPosition()
    media.addEventListener('change', syncPosition)
    return () => media.removeEventListener('change', syncPosition)
  }, [])

  useEffect(() => {
    if (isReloadNavigation()) {
      sessionStorage.removeItem(ENTRY_SPLASH_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    const previousUserId = previousUserIdRef.current
    const nextUserId = user?.id ?? null

    if (!nextUserId) {
      clearEntrySplashTimer()
      startTransition(() => {
        setShowEntrySplash(false)
        setEntryRole(null)
        setWorkerMeetingPatch(null)
      })
      previousUserIdRef.current = null
      return
    }

    previousUserIdRef.current = nextUserId
    if (previousUserId !== nextUserId) {
      startTransition(() => {
        setWorkerMeetingPatch(null)
      })
    }
    if (previousUserId === nextUserId || !user) return

    const shouldShowEntrySplash =
      sessionStorage.getItem(ENTRY_SPLASH_STORAGE_KEY) === '1' || showEntrySplash

    sessionStorage.removeItem(ENTRY_SPLASH_STORAGE_KEY)
    if (!shouldShowEntrySplash) return

    clearEntrySplashTimer()
    startTransition(() => {
      setEntryRole(user.role)
      setShowEntrySplash(true)
    })
    splashHideTimerRef.current = window.setTimeout(() => {
      setShowEntrySplash(false)
      setEntryRole(null)
    }, 1200)
  }, [showEntrySplash, user])

  const renderContent = () => {
    if (!user) {
      return (
        <LoginPage
          key="login"
          onLoginTransitionStart={beginEntrySplash}
          onLoginTransitionCancel={cancelEntrySplash}
        />
      )
    }

    if (user.role === 'admin') return <AdminPanel key="admin" />

    if (view === 'survey') {
      return (
        <SurveyForm
          key="survey"
          initialCoords={surveyCoords}
          linkedMeeting={activeMeeting}
          meetingStartedAt={activeMeetingStartedAt}
          onMeetingSaved={(meeting) => {
            setWorkerMeetingPatch(meeting)
          }}
          onBack={() => {
            setView('dashboard')
            setSurveyCoords(null)
            setActiveMeeting(null)
            setActiveMeetingStartedAt(null)
          }}
        />
      )
    }

    return (
      <WorkerDashboard
        key="dashboard"
        pendingMeetingPatch={workerMeetingPatch}
        onNewSurvey={(coords?: { lat: number; lng: number } | null, meeting?: SalesMeeting | null) => {
          setSurveyCoords(coords || null)
          setActiveMeeting(meeting || null)
          setActiveMeetingStartedAt(meeting ? new Date().toISOString() : null)
          setView('survey')
        }}
      />
    )
  }

  const contentKey = !user ? 'login' : user.role === 'admin' ? 'admin' : view
  const splashSubtitle = entryRole
    ? `${getProfileLabel(entryRole)} \u2022 ${getProfileSubtitle(entryRole)}`
    : 'Trwa logowanie i przygotowanie panelu'

  return (
    <div className="min-h-dvh bg-linear-to-br from-cyan-100 via-sky-100 to-white font-sans text-gray-900 transition-colors duration-300 dark:from-slate-900 dark:via-cyan-950 dark:to-slate-900 dark:text-gray-100">
      <div className="w-full">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={contentKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="w-full"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>

        <Toaster
          position={toastPosition}
          gutter={12}
          containerStyle={{
            top: toastPosition === 'top-center' ? 14 : undefined,
            bottom: toastPosition === 'bottom-center' ? 18 : undefined,
            left: 12,
            right: 12,
          }}
          toastOptions={{
            duration: 3600,
            className: 'ui-toast-shell',
            style: {
              borderRadius: '20px',
              background: 'transparent',
              color: 'inherit',
              border: '0',
              boxShadow: 'none',
              maxWidth: 'min(92vw, 420px)',
              padding: '0',
            },
          }}
        >
          {(t) => (
            <ToastBar
              toast={t}
              style={{
                ...t.style,
                background: 'transparent',
                boxShadow: 'none',
                padding: 0,
                transform: t.visible
                  ? 'translateY(0) scale(1)'
                  : toastPosition === 'top-center'
                    ? 'translateY(-12px) scale(0.96)'
                    : 'translateY(12px) scale(0.96)',
                opacity: t.visible ? 1 : 0,
                transition:
                  'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, box-shadow 220ms ease',
              }}
            >
              {({ message }) => {
                const tone = getToastTone(t.type)

                return (
                  <div className="ui-toast-card" data-tone={tone}>
                    <div className="ui-toast-icon" data-tone={tone}>{renderToastIcon(tone)}</div>
                    <div className="ui-toast-message">{message}</div>
                  </div>
                )
              }}
            </ToastBar>
          )}
        </Toaster>

        <AnimatePresence>
          {showEntrySplash && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-12000 flex items-center justify-center bg-white/78 px-6 backdrop-blur-xl dark:bg-slate-950/84"
            >
              <motion.div
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.99 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="relative w-full max-w-sm overflow-hidden rounded-[30px] border border-slate-200/80 bg-[linear-gradient(160deg,rgba(255,255,255,0.98),rgba(240,249,255,0.97))] p-7 text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.18)] dark:border-white/10 dark:bg-[linear-gradient(160deg,rgba(2,6,23,0.98),rgba(6,24,44,0.98))] dark:text-white dark:shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
              >
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div
                    className={`flex h-16 w-16 items-center justify-center rounded-[22px] bg-slate-100/90 text-3xl dark:bg-white/8 ${
                      entryRole ? PROFILE_META[entryRole].accentClass : 'text-cyan-300'
                    }`}
                  >
                    {entryRole ? (
                      PROFILE_META[entryRole].icon
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8 text-slate-900 dark:text-white">
                        <path d="M12 20V9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                        <circle cx="12" cy="7" r="4" fill="#ff6130" stroke="#111827" strokeWidth="1.8" />
                        <path d="M10.8 20h2.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                      </svg>
                    )}
                  </div>
                  <div className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                    v{APP_VERSION}
                  </div>
                </div>

                <p className="mb-2 text-[10px] font-black uppercase tracking-[0.26em] text-cyan-700/70 dark:text-cyan-200/70">
                  Uruchamianie aplikacji
                </p>
                <h2 className="text-3xl font-black tracking-tight">{APP_NAME}</h2>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-300">{splashSubtitle}</p>

                <div className="mt-6 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/8">
                  <motion.div
                    initial={{ width: '14%' }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 1.05, ease: 'easeInOut' }}
                    className="h-2 rounded-full bg-linear-to-r from-cyan-400 via-sky-500 to-indigo-500"
                  />
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default App
