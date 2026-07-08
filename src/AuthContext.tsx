import { useState, useEffect, useCallback, type ReactNode } from 'react'
import type { User, Shift } from './db'
import { supabase } from './supabase'
import { getOfflineSurveys, removeOfflineSurveys, getOfflineGpsLogs, clearOfflineGpsLogs } from './offlineStore'
import { getStartOfDayISO } from './dateUtils'
import { AuthContext, type LoginResult } from './hooks/useAuth'

// 12 hours max shift
const MAX_SHIFT_MS = 12 * 60 * 60 * 1000

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [activeShift, setActiveShift] = useState<Shift | null>(null)
    const [hasFinishedToday, setHasFinishedToday] = useState(false)
    const [ready, setReady] = useState(false)

    // Helper: find last activity time for a shift
    const findLastActivityTime = useCallback(async (shiftId: number, startTime: string) => {
        const [surveyRes, gpsRes] = await Promise.all([
            supabase.from('surveys').select('created_at').eq('shift_id', shiftId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('gps_logs').select('timestamp').eq('shift_id', shiftId).order('timestamp', { ascending: false }).limit(1).maybeSingle(),
        ])
        const lastSurvey = surveyRes.data?.created_at ? new Date(surveyRes.data.created_at).getTime() : 0
        const lastGps = gpsRes.data?.timestamp ? new Date(gpsRes.data.timestamp).getTime() : 0
        const lastActivity = Math.max(lastSurvey, lastGps)
        return lastActivity > 0 ? new Date(lastActivity).toISOString() : new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString()
    }, [])

    const autoCloseStaleShifts = useCallback(async (userId?: number) => {
        let query = supabase.from('shifts').select('*').is('end_time', null)
        if (userId) query = query.eq('user_id', userId)
        
        const { data: allShifts } = await query
        if (!allShifts) return

        const now = Date.now()
        for (const s of allShifts) {
            const elapsed = now - new Date(s.start_time).getTime()
            // Close if > 12h OR if it's from a previous day
            const isPreviousDay = new Date(s.start_time).toLocaleDateString() !== new Date().toLocaleDateString()
            
            if (elapsed > MAX_SHIFT_MS || isPreviousDay) {
                const endTime = await findLastActivityTime(s.id!, s.start_time)
                const { count } = await supabase.from('surveys').select('*', { count: 'exact', head: true }).eq('shift_id', s.id)
                
                await supabase.from('shifts').update({
                    end_time: endTime,
                    total_surveys: count || 0,
                }).eq('id', s.id)

                const storedShiftId = Number(localStorage.getItem('shiftId') || 0)
                if (storedShiftId === s.id) {
                    localStorage.removeItem('shiftId')
                }
                setActiveShift((prev) => (prev?.id === s.id ? null : prev))
            }
        }
    }, [findLastActivityTime])

    // Restore session + auto-close stale shifts on init
    useEffect(() => {
        async function init() {
            // Optional auto-seed users if none exist
            const { count } = await supabase.from('users').select('*', { count: 'exact', head: true })
            if (count === 0) {
                await supabase.from('users').insert([
                    { login: 'admin', password: 'admin123', name: 'Demo Admin', role: 'admin' },
                    { login: 'adam', password: 'demo123', name: 'Adam Nowak', role: 'worker' },
                    { login: 'marta', password: 'demo123', name: 'Marta Zielinska', role: 'worker' },
                ])
            }

            await autoCloseStaleShifts()

            const savedUserId = localStorage.getItem('userId')
            const savedShiftId = localStorage.getItem('shiftId')

            if (savedUserId) {
                const { data: u } = await supabase.from('users').select('*').eq('id', Number(savedUserId)).single()
                if (u) {
                    setUser(u)
                    let restoredShift = false

                    // Try to restore shift from localStorage first
                    if (savedShiftId) {
                        const { data: s } = await supabase.from('shifts').select('*').eq('id', Number(savedShiftId)).single()
                        if (s && !s.end_time) {
                            setActiveShift(s)
                            restoredShift = true
                        } else {
                            localStorage.removeItem('shiftId')
                        }
                    }

                    // If no saved shift was restored, try latest open one from DB
                    if (!restoredShift) {
                        const { data: openShift } = await supabase.from('shifts').select('*').eq('user_id', u.id!).is('end_time', null).order('start_time', { ascending: false }).limit(1).single()
                        if (openShift) {
                            setActiveShift(openShift)
                            localStorage.setItem('shiftId', String(openShift.id))
                        }
                    }
                }
            }
            setReady(true)
        }
        init()
    }, [autoCloseStaleShifts])

    // Check if user finished work today
    useEffect(() => {
        const check = async () => {
            if (!user) { setHasFinishedToday(false); return }
            if (activeShift && !activeShift.end_time) {
                setHasFinishedToday(false)
                return
            }
            const startOfDay = getStartOfDayISO()
            const { data } = await supabase
                .from('shifts')
                .select('id')
                .eq('user_id', user.id!)
                .not('end_time', 'is', null)
                .gte('start_time', startOfDay)
                .limit(1)
            setHasFinishedToday(!!data && data.length > 0)
        }
        check()
        const interval = setInterval(check, 30000)
        return () => clearInterval(interval)
    }, [user, activeShift])

    // Periodic check every 5 min for stale shifts
    useEffect(() => {
        if (!activeShift) return
        const interval = setInterval(async () => {
            const now = new Date()
            const elapsed = now.getTime() - new Date(activeShift.start_time).getTime()
            
            // Auto-close if > 12h or after 23:00
            if (elapsed > MAX_SHIFT_MS || now.getHours() >= 23) {
                const endTime = await findLastActivityTime(activeShift.id!, activeShift.start_time)
                const { count } = await supabase.from('surveys').select('*', { count: 'exact', head: true }).eq('shift_id', activeShift.id)
                
                await supabase.from('shifts').update({
                    end_time: now.getHours() >= 23 ? now.toISOString() : endTime,
                    total_surveys: count || 0,
                }).eq('id', activeShift.id)

                setActiveShift(null)
                localStorage.removeItem('shiftId')
                alert('Twoja zmiana została automatycznie zakończona przez system (limit czasu lub koniec dnia).')
            }
        }, 5 * 60 * 1000)
        return () => clearInterval(interval)
    }, [activeShift, findLastActivityTime])

    // --- BACKGROUND SYNC LOGIC ---
    useEffect(() => {
        const syncOfflineData = async () => {
            if (!navigator.onLine || !user) return

            const pendingSurveys = getOfflineSurveys()
            const pendingGps = getOfflineGpsLogs()

            if (pendingSurveys.length > 0) {
                console.log(`Syncing ${pendingSurveys.length} offline surveys...`)
                const successIds: number[] = []
                for (const s of pendingSurveys) {
                    const surveyData = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'id'))
                    const { error } = await supabase.from('surveys').insert(surveyData)
                    if (!error) successIds.push(s.id!)
                }
                if (successIds.length > 0) removeOfflineSurveys(successIds)
            }

            if (pendingGps.length > 0) {
                console.log(`Syncing ${pendingGps.length} offline GPS logs...`)
                // Removing temporary ids
                const logsToInsert = pendingGps.map(g => 
                    Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'id'))
                )
                const { error } = await supabase.from('gps_logs').insert(logsToInsert)
                if (!error) clearOfflineGpsLogs()
            }
        }

        // Try syncing periodically
        const syncInt = setInterval(syncOfflineData, 15000)
        // Try syncing when navigator fires online event
        window.addEventListener('online', syncOfflineData)

        return () => {
            clearInterval(syncInt)
            window.removeEventListener('online', syncOfflineData)
        }
    }, [user])

    // Cleanup expired survey audio files (retain transcript in DB)
    useEffect(() => {
        if (!user) return

        const cleanupExpiredAudio = async () => {
            if (!navigator.onLine) return
            const { error } = await supabase.rpc('cleanup_expired_survey_audio')
            if (error) {
                console.warn('Audio cleanup error:', error.message)
            }
        }

        void cleanupExpiredAudio()
        const interval = setInterval(cleanupExpiredAudio, 6 * 60 * 60 * 1000)
        window.addEventListener('online', cleanupExpiredAudio)

        return () => {
            clearInterval(interval)
            window.removeEventListener('online', cleanupExpiredAudio)
        }
    }, [user])

    const login = async (username: string, password: string): Promise<LoginResult> => {
        const cleanUser = username.trim()
        const cleanPass = password.trim()
        
        const { data: u } = await supabase.from('users').select('*').ilike('login', cleanUser).single()
        if (u && u.password === cleanPass) {
            setUser(u)
            localStorage.setItem('userId', String(u.id))

            // Restore active shift from DB if exists
            const { data: openShift } = await supabase.from('shifts').select('*').eq('user_id', u.id!).is('end_time', null).order('start_time', { ascending: false }).limit(1).single()
            if (openShift) {
                setActiveShift(openShift)
                localStorage.setItem('shiftId', String(openShift.id))
            }

            return { ok: true }
        }
        return { ok: false, reason: 'invalid_credentials' }
    }

    const logout = () => {
        setUser(null)
        setActiveShift(null)
        setHasFinishedToday(false)
        localStorage.removeItem('userId')
        localStorage.removeItem('shiftId')
    }

    const startShift = async () => {
        if (!user) return

        // Prevent starting a new shift if one was already finished today
        const startOfDay = getStartOfDayISO()
        const { data: todayFinishedShifts } = await supabase
            .from('shifts')
            .select('*')
            .eq('user_id', user.id!)
            .not('end_time', 'is', null)
            .gte('start_time', startOfDay)

        if (todayFinishedShifts && todayFinishedShifts.length > 0) {
            alert('Twoja zmiana na dziś została już zakończona. Nie można rozpocząć nowej pracy w tym samym dniu.')
            return
        }

        // Close any orphaned/unclosed shifts for this user (use last activity time)
        const { data: openShifts } = await supabase.from('shifts').select('*').eq('user_id', user.id!).is('end_time', null)
        if (openShifts && openShifts.length > 0) {
            for (const os of openShifts) {
                const [countRes, endTime] = await Promise.all([
                    supabase.from('surveys').select('*', { count: 'exact', head: true }).eq('shift_id', os.id),
                    findLastActivityTime(os.id!, os.start_time)
                ])
                await supabase.from('shifts').update({
                    end_time: endTime,
                    total_surveys: countRes.count || 0,
                }).eq('id', os.id)
            }
        }

        const shift = {
            user_id: user.id!,
            user_name: user.name,
            start_time: new Date().toISOString(),
            total_surveys: 0,
        }
        const { data: created, error } = await supabase.from('shifts').insert(shift).select().single()
        if (error) { console.error(error); return }

        setActiveShift(created)
        setHasFinishedToday(false)
        localStorage.setItem('shiftId', String(created.id))
    }

    const endShift = async () => {
        if (!activeShift) return
        const { count } = await supabase.from('surveys').select('*', { count: 'exact', head: true }).eq('shift_id', activeShift.id)

        await supabase.from('shifts').update({
            end_time: new Date().toISOString(),
            total_surveys: count || 0,
        }).eq('id', activeShift.id)

        setActiveShift(null)
        setHasFinishedToday(true)
        localStorage.removeItem('shiftId')
    }

    if (!ready) return null

    return (
        <AuthContext.Provider value={{ user, activeShift, login, logout, startShift, endShift, hasFinishedToday }}>
            {children}
        </AuthContext.Provider>
    )
}
