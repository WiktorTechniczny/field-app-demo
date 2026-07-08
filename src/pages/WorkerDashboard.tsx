import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { format } from 'date-fns'
import { pl } from 'date-fns/locale'
import { DayPicker } from 'react-day-picker'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../ThemeContext'
import { supabase } from '../supabase'
import type { SalesMeeting, Survey } from '../db'
import { getOfflineSurveys, addOfflineGpsLog } from '../offlineStore'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useRef, useMemo, useCallback } from 'react'
import { QS } from '../questions'
import { distanceMeters } from '../powerPoles'
import { getStartOfDayISO } from '../dateUtils'
import { APPOINTMENT_SLOTS } from '../appointmentSlots'
import WorkerHistory from './WorkerHistory'
import toast from 'react-hot-toast'
import { getSurveyStatus } from '../surveyStatus'
import { buildSalesMeetingRescheduledNote, getSalesMeetingDisplayMeta, getSalesMeetingEffectiveScheduledAt, isSalesMeetingMissed } from '../salesMeetingStatus'
import { mapSalesMeetingsMutationError } from '../salesMeetingsErrors'
import { normalizeSalesMeetingInlineText } from '../salesMeetingText'
import { formatSurveyDateTime, getSurveyTimingMeta } from '../surveyTiming'
import { getSurveyStatusNote, getSurveyStatusNoteLabel } from '../surveyStatusNotes'
import {
    buildMeetingAddressQuery,
    buildMeetingAddressQueries,
    geocodeMeetingAddress,
    getMeetingAddressCacheKey,
    type GeocodedMeetingAddress
} from '../meetingAddressGeocoding'
import SalesSchedulePanel from '../components/SalesSchedulePanel'
import { APP_VERSION } from '../appMeta'
import { mergeSalesMeetingPatch } from '../salesMeetingCollections'
import { buildGoogleMapsDirectionsHref, buildPhoneHref } from '../contactLinks'
import { getSalesMeetingMapLocation, getSalesMeetingEnhancedAddress } from '../salesMeetingLocation'

const card = "bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/50 dark:border-slate-700/80 shadow-lg"
const innerCard = "bg-gray-50 dark:bg-slate-800/60 rounded-xl border border-gray-100/80 dark:border-slate-600/60"
interface Props {
    onNewSurvey: (coords?: { lat: number, lng: number } | null, meeting?: SalesMeeting | null) => void
    pendingMeetingPatch?: SalesMeeting | null
}

function spreadOverlappingSurveyMarkers<T extends { lat: number; lng: number }>(
    points: T[],
    radiusMeters = 8,
    minDistanceMeters = 22
): Array<T & { renderLat: number; renderLng: number }> {
    type SpreadPoint = T & { renderLat: number; renderLng: number; baseLat: number; baseLng: number }
    const seededPoints: SpreadPoint[] = points.map((point) => ({
        ...point,
        renderLat: point.lat,
        renderLng: point.lng,
        baseLat: point.lat,
        baseLng: point.lng
    }))

    const grouped = new Map<string, SpreadPoint[]>()
    seededPoints.forEach((point) => {
        const key = `${point.lat.toFixed(6)}|${point.lng.toFixed(6)}`
        const arr = grouped.get(key)
        if (arr) arr.push(point)
        else grouped.set(key, [point])
    })

    grouped.forEach((group) => {
        if (group.length === 1) return

        group.forEach((p, idx) => {
            const angle = (idx / group.length) * 2 * Math.PI
            const dLat = (radiusMeters * Math.sin(angle)) / 111111
            const safeCos = Math.max(0.2, Math.cos((p.lat * Math.PI) / 180))
            const dLng = (radiusMeters * Math.cos(angle)) / (111111 * safeCos)
            p.renderLat = p.lat + dLat
            p.renderLng = p.lng + dLng
        })
    })

    const clampOffset = (point: SpreadPoint, maxOffsetMeters: number) => {
        const safeCos = Math.max(0.2, Math.cos((point.baseLat * Math.PI) / 180))
        const deltaY = (point.renderLat - point.baseLat) * 111111
        const deltaX = (point.renderLng - point.baseLng) * 111111 * safeCos
        const distance = Math.hypot(deltaX, deltaY)
        if (distance <= maxOffsetMeters || distance <= 0.001) return
        const scale = maxOffsetMeters / distance
        point.renderLat = point.baseLat + (deltaY * scale) / 111111
        point.renderLng = point.baseLng + (deltaX * scale) / (111111 * safeCos)
    }

    const maxOffsetMeters = Math.max(radiusMeters * 4, minDistanceMeters * 2.2)
    for (let iteration = 0; iteration < 12; iteration += 1) {
        let moved = false
        for (let i = 0; i < seededPoints.length; i += 1) {
            for (let j = i + 1; j < seededPoints.length; j += 1) {
                const first = seededPoints[i]
                const second = seededPoints[j]
                const avgLat = (first.renderLat + second.renderLat) / 2
                const safeCos = Math.max(0.2, Math.cos((avgLat * Math.PI) / 180))
                let deltaY = (first.renderLat - second.renderLat) * 111111
                let deltaX = (first.renderLng - second.renderLng) * 111111 * safeCos
                let distance = Math.hypot(deltaX, deltaY)

                if (distance >= minDistanceMeters) continue

                moved = true
                if (distance < 0.001) {
                    const angle = (((i + 1) * 37 + (j + 1) * 17) % 360) * (Math.PI / 180)
                    deltaX = Math.cos(angle)
                    deltaY = Math.sin(angle)
                    distance = 1
                } else {
                    deltaX /= distance
                    deltaY /= distance
                }

                const shiftMeters = (minDistanceMeters - distance) / 2 + 0.35
                first.renderLat += (deltaY * shiftMeters) / 111111
                first.renderLng += (deltaX * shiftMeters) / (111111 * safeCos)
                second.renderLat -= (deltaY * shiftMeters) / 111111
                second.renderLng -= (deltaX * shiftMeters) / (111111 * safeCos)
                clampOffset(first, maxOffsetMeters)
                clampOffset(second, maxOffsetMeters)
            }
        }
        if (!moved) break
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return seededPoints.map(({ baseLat: _baseLat, baseLng: _baseLng, ...point }) => point as T & { renderLat: number; renderLng: number })
}

function offsetPointAwayFromTargets(
    point: { lat: number; lng: number },
    targets: Array<{ lat: number; lng: number }>,
    triggerDistanceMeters = 16,
    shiftMeters = 18
): { lat: number; lng: number } {
    const nearby = targets.filter((target) => distanceMeters(point.lat, point.lng, target.lat, target.lng) <= triggerDistanceMeters)
    if (nearby.length === 0) return point

    let vectorLat = 0
    let vectorLng = 0
    nearby.forEach((target) => {
        vectorLat += point.lat - target.lat
        vectorLng += point.lng - target.lng
    })

    const magnitude = Math.hypot(vectorLat, vectorLng)
    const fallbackAngle = ((point.lat + point.lng) * 9973) % (2 * Math.PI)
    const normLat = magnitude > 1e-10 ? vectorLat / magnitude : Math.sin(fallbackAngle)
    const normLng = magnitude > 1e-10 ? vectorLng / magnitude : Math.cos(fallbackAngle)
    const safeCos = Math.max(0.2, Math.cos((point.lat * Math.PI) / 180))

    return {
        lat: point.lat + (shiftMeters * normLat) / 111111,
        lng: point.lng + (shiftMeters * normLng) / (111111 * safeCos)
    }
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

const toTimeLabel = (value: string): string =>
    new Date(value).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

const getTodayDateInput = (): string => {
    const date = new Date()
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const toLocalDate = (value: string): Date => {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

const getScheduledDatePart = (value: string): string => {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
        const yyyy = date.getFullYear()
        const mm = String(date.getMonth() + 1).padStart(2, '0')
        const dd = String(date.getDate()).padStart(2, '0')
        return `${yyyy}-${mm}-${dd}`
    }

    const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
    return match?.[1] || getTodayDateInput()
}

const getScheduledTimePart = (value: string): string => {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
    }

    const match = value.match(/T(\d{2}:\d{2})/)
    return match?.[1] || '10:00'
}

const buildLocalScheduledAt = (datePart: string, timePart: string): Date => {
    const [year, month, day] = datePart.split('-').map(Number)
    const [hours, minutes] = timePart.split(':').map(Number)
    return new Date(year, month - 1, day, hours, minutes, 0, 0)
}

const getMeetingDayKey = (value: string): string =>
    new Date(value).toLocaleDateString('sv-SE')

const getSurveyMeetingId = (survey: Survey): string => {
    const rawMeetingId = Array.isArray(survey.answers?.meeting_id) ? survey.answers.meeting_id[0] : survey.answers?.meeting_id
    return typeof rawMeetingId === 'string' ? rawMeetingId.trim() : ''
}

const getLinkedMeetingForSurvey = (survey: Survey, meetings: SalesMeeting[]): SalesMeeting | null => {
    const surveyMeetingId = getSurveyMeetingId(survey)
    if (surveyMeetingId) {
        const byId = meetings.find((meeting) => String(meeting.id) === surveyMeetingId)
        if (byId) return byId
    }

    if (typeof survey.id === 'number') {
        const byLinkedSurvey = meetings.find((meeting) => meeting.linked_survey_id === survey.id)
        if (byLinkedSurvey) return byLinkedSurvey
    }

    return null
}

const MEETING_MARKER_COLORS: Record<string, string> = {
    planned: '#7c3aed',
    signed: '#16a34a',
    refused: '#dc2626',
    no_cooperation: '#e11d48',
    not_home: '#2563eb',
    follow_up: '#d97706',
    cancelled: '#64748b'
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

function dedupeSurveys(rawSurveys: Survey[]): Survey[] {
    const byKey = new Map<string, Survey>()
    rawSurveys.forEach((survey) => {
        const key = survey.id
            ? `id:${survey.id}`
            : `tmp:${survey.user_id}:${survey.created_at}:${survey.address || ''}:${survey.respondent_name || ''}`

        const existing = byKey.get(key)
        if (!existing || new Date(survey.created_at).getTime() > new Date(existing.created_at).getTime()) {
            byKey.set(key, survey)
        }
    })

    return Array.from(byKey.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export default function WorkerDashboard({ onNewSurvey, pendingMeetingPatch = null }: Props) {
    const { user, activeShift, startShift, endShift, logout, hasFinishedToday } = useAuth()
    const { dark, toggle } = useTheme()
    const userId = user?.id
    const userName = user?.name
    const activeShiftId = activeShift?.id
    const [elapsed, setElapsed] = useState('00:00:00')
    const [todaySurveys, setTodaySurveys] = useState<Survey[]>([])
    const [, setPastSurveys] = useState<Survey[]>([])
    const [viewMode, setViewMode] = useState<'dashboard' | 'history'>('dashboard')
    const [dashboardTab, setDashboardTab] = useState<'overview' | 'stats'>('overview')
    const [isFullscreenMap] = useState(false)
    const workerMapEnabled = false
    const [lastPos, setLastPos] = useState<[number, number] | null>(null) // null until real GPS fix
    const [expandedSurvey, setExpandedSurvey] = useState<string | null>(null)
    const [routeGps, setRouteGps] = useState<{ lat: number; lng: number; time: string }[]>([])
    const [gpsPermission, setGpsPermission] = useState<'prompt' | 'granted' | 'denied'>('prompt')
    const [microphonePermission, setMicrophonePermission] = useState<'prompt' | 'granted' | 'denied' | 'unsupported'>('prompt')
    const [scheduledMeetings, setScheduledMeetings] = useState<SalesMeeting[]>([])
    const [meetingLocations, setMeetingLocations] = useState<Record<string, GeocodedMeetingAddress | null>>({})
    const [, setMeetingMarkersReady] = useState(false)
    const [pendingFocusedMeeting, setPendingFocusedMeeting] = useState<SalesMeeting | null>(null)
    const [rescheduleMeeting, setRescheduleMeeting] = useState<SalesMeeting | null>(null)
    const [rescheduleDate, setRescheduleDate] = useState(getTodayDateInput())
    const [rescheduleTime, setRescheduleTime] = useState('10:00')
    const [reschedulePickerMonth, setReschedulePickerMonth] = useState<Date>(() => toLocalDate(getTodayDateInput()))
    const [rescheduleSaving, setRescheduleSaving] = useState(false)
    const [showEndShiftConfirm, setShowEndShiftConfirm] = useState(false)
    const [endingShift, setEndingShift] = useState(false)

    const mapRef = useRef<HTMLDivElement>(null)
    const mapInst = useRef<L.Map | null>(null)
    const markersLayerRef = useRef<L.LayerGroup | null>(null) // For worker position
    const meetingMarkersLayerRef = useRef<L.LayerGroup | null>(null)
    const routeLayerRef = useRef<L.LayerGroup | null>(null)
    const tileLayerRef = useRef<L.TileLayer | null>(null)
    
    // Stable marker refs to prevent flickering during intervals
    const workerMarkerRef = useRef<L.Marker | null>(null)
    const workerMarkerLabelRef = useRef('')
    const meetingMarkerRefs = useRef(new Map<number, L.Marker>())
    const routePolylineRef = useRef<L.Polyline | null>(null)
    const routeStartMarkerRef = useRef<L.CircleMarker | null>(null)
    const hasCenteredUser = useRef(false)
    const hasCenteredMeetings = useRef(false)
    const lastReflowAtRef = useRef(0)

    const todaySurveysRef = useRef(todaySurveys)
    const scheduledMeetingsRef = useRef(scheduledMeetings)
    const meetingLocationsRef = useRef(meetingLocations)
    const lastPosRef = useRef(lastPos)

    useEffect(() => {
        todaySurveysRef.current = todaySurveys
        scheduledMeetingsRef.current = scheduledMeetings
        meetingLocationsRef.current = meetingLocations
        lastPosRef.current = lastPos
    }, [todaySurveys, scheduledMeetings, meetingLocations, lastPos])

    useEffect(() => {
        if (!rescheduleMeeting) return

        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        return () => {
            document.body.style.overflow = previousOverflow
        }
    }, [rescheduleMeeting])

    const forceMapReflow = useCallback((options?: { burst?: boolean }) => {
        const map = mapInst.current
        if (!map) return
        const now = Date.now()
        if (!options?.burst && now - lastReflowAtRef.current < 450) return
        lastReflowAtRef.current = now

        const resizeOnly = () => {
            map.invalidateSize({ pan: false, debounceMoveend: true })
        }

        resizeOnly()
        requestAnimationFrame(resizeOnly)
        setTimeout(resizeOnly, 140)
        if (options?.burst) {
            setTimeout(() => tileLayerRef.current?.redraw(), 260)
            setTimeout(resizeOnly, 320)
            setTimeout(() => tileLayerRef.current?.redraw(), 620)
        }
    }, [])

    const syncMicrophonePermission = useCallback(async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setMicrophonePermission('unsupported')
            return
        }

        if (!('permissions' in navigator)) {
            setMicrophonePermission((current) => (current === 'granted' ? current : 'prompt'))
            return
        }

        try {
            const nav = navigator as Navigator & {
                permissions: {
                    query: (opts: { name: string }) => Promise<{ state: 'prompt' | 'granted' | 'denied'; onchange: (() => void) | null }>
                }
            }
            const status = await nav.permissions.query({ name: 'microphone' })
            setMicrophonePermission(status.state)
            status.onchange = () => setMicrophonePermission(status.state)
        } catch {
            setMicrophonePermission((current) => (current === 'granted' ? current : 'prompt'))
        }
    }, [])

    const primeMicrophonePermission = useCallback(async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setMicrophonePermission('unsupported')
            return 'unsupported' as const
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            })
            stream.getTracks().forEach((track) => track.stop())
            setMicrophonePermission('granted')
            return 'granted' as const
        } catch (error) {
            const name = error instanceof DOMException ? error.name : ''
            const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError'
            setMicrophonePermission(denied ? 'denied' : 'prompt')
            return denied ? 'denied' as const : 'prompt' as const
        }
    }, [])

    const handleStartShift = useCallback(async () => {
        await startShift()

        if (microphonePermission === 'granted' || microphonePermission === 'unsupported') return

        const micState = await primeMicrophonePermission()
        if (micState === 'denied') {
            toast.error('Mikrofon jest zablokowany. Odblokuj go teraz, żeby później nie przerywać spotkania.')
        }
    }, [microphonePermission, primeMicrophonePermission, startShift])


    // Need to expose function to window for the popup button
    useEffect(() => {
        ;(window as unknown as { __startSurveyAt?: (lat: string, lng: string) => void }).__startSurveyAt = (lat: string, lng: string) => {
            if (mapInst.current) mapInst.current.closePopup()
            if (!activeShift) {
                toast.error("Musisz rozpocząć sesję, aby utworzyć formularz umowy!")
                return
            }
            onNewSurvey({ lat: parseFloat(lat), lng: parseFloat(lng) })
        }

        return () => {
            delete (window as unknown as { __startSurveyAt?: (lat: string, lng: string) => void }).__startSurveyAt
        }
    }, [activeShift, onNewSurvey])

    // Global handler for linking last survey to a pole
    useEffect(() => {
        ;(window as unknown as { __linkLastSurveyToPole?: (latStr: string, lngStr: string) => Promise<void> }).__linkLastSurveyToPole = async (latStr: string, lngStr: string) => {
            if (mapInst.current) mapInst.current.closePopup()
            const surveys = todaySurveysRef.current
            if (!user || surveys.length === 0) {
                toast.error("Nie masz jeszcze żadnych dzisiejszych wpisów, które można przypisać!")
                return;
            }
            if(!confirm("Czy na pewno chcesz zaktualizować lokalizację ostatniego dzisiejszego wpisu i przypiąć ją dokładnie do tego słupa?")) return;

            // Find newest survey
            const sortedSurveys = [...surveys].sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
            const latest = sortedSurveys[0];

            if (!latest.id) {
                toast.error("Twój ostatni wpis czeka na synchronizację offline. Poczekaj aż zapisze się w chmurze, aby móc go zlinkować z mapą.")
                return;
            }

            const lat = parseFloat(latStr)
            const lng = parseFloat(lngStr)

            const linkToast = toast.loading("Przypinanie wpisu do słupa...")

            try {
                const { error } = await supabase.from('surveys').update({
                    latitude: lat,
                    longitude: lng,
                    address: `Punkt: ${lat.toFixed(5)}, ${lng.toFixed(5)}`
                }).eq('id', latest.id);

                if (error) throw error;
                
                toast.success("Sukces! Ostatni wpis został przypięty do tego punktu na stałe.", { id: linkToast })
                
                // Refresh surveys
                const startOfDay = getStartOfDayISO()
                const { data } = await supabase.from('surveys')
                    .select('*')
                    .eq('user_id', user.id)
                    .gte('created_at', startOfDay)
                
                if (data) setTodaySurveys(data)
                
            } catch (err) {
                console.error("Link survey err:", err);
                toast.error("Wystąpił błąd łączenia. Sprawdź internet.", { id: linkToast })
            }
        }
        return () => { delete (window as unknown as { __linkLastSurveyToPole?: (latStr: string, lngStr: string) => Promise<void> }).__linkLastSurveyToPole }
    }, [user, activeShift]);

    useEffect(() => {
        if (!activeShift?.start_time) {
            setElapsed('00:00:00')
            return
        }

        const startMs = Date.parse(activeShift.start_time)
        if (!Number.isFinite(startMs)) {
            console.warn('Invalid shift start_time:', activeShift.start_time)
            setElapsed('00:00:00')
            return
        }

        const updateElapsed = () => {
            const diff = Math.max(0, Date.now() - startMs)
            const h = String(Math.floor(diff / 3600000)).padStart(2, '0')
            const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0')
            const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0')
            setElapsed(`${h}:${m}:${s}`)
        }

        updateElapsed()
        const interval = setInterval(updateElapsed, 1000)
        return () => clearInterval(interval)
    }, [activeShift?.start_time])

    // Request GPS permission early on dashboard mount
    useEffect(() => {
        if (!navigator.geolocation) {
            setGpsPermission('denied')
            return
        }

        const checkPerm = async () => {
            try {
                // Try to get current position to trigger prompt or check status
                navigator.geolocation.getCurrentPosition(
                    () => setGpsPermission('granted'),
                    (err) => {
                        if (err.code === 1) setGpsPermission('denied')
                        else console.warn('GPS Error:', err.message)
                    },
                    { timeout: 5000 }
                )
                
                // Also listen to permission status if supported
                if ('permissions' in navigator) {
                    const nav = navigator as unknown as { permissions: { query: (opts: { name: string }) => Promise<{ state: 'prompt' | 'granted' | 'denied', onchange: (() => void) | null }> } }
                    const status = await nav.permissions.query({ name: 'geolocation' })
                    setGpsPermission(status.state)
                    status.onchange = () => setGpsPermission(status.state)
                }
            } catch (err) {
                console.warn('Permission API not supported or error:', err)
            }
        }
        checkPerm()
    }, [])

    useEffect(() => {
        void syncMicrophonePermission()
    }, [syncMicrophonePermission])

    useEffect(() => {
        if (!userId) { setTodaySurveys([]); setPastSurveys([]); return }
        const load = async () => {
            const startOfDay = getStartOfDayISO()
            const startOfLastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
            const { data } = await supabase.from('surveys')
                .select('*')
                .eq('user_id', userId)
                .gte('created_at', startOfLastMonth)
                
            const off = getOfflineSurveys().filter(s => s.user_id === userId && new Date(s.created_at) >= new Date(startOfDay))
            if (data) {
                 const today = data.filter(s => s.created_at >= startOfDay)
                 const past = data.filter(s => s.created_at < startOfDay)
                 setTodaySurveys(dedupeSurveys([...today, ...off]))
                 setPastSurveys(dedupeSurveys(past))
            } else {
                 setTodaySurveys(dedupeSurveys(off))
                 setPastSurveys([])
            }
        }
        load()
        const interval = setInterval(load, 5000)
        return () => clearInterval(interval)
    }, [userId, activeShiftId])

    // Fetch GPS route for current DAY
    useEffect(() => {
        if (!userId) { setRouteGps([]); return }
        const load = async () => {
            const startOfDay = getStartOfDayISO()
            const { data } = await supabase.from('gps_logs')
                .select('latitude, longitude, timestamp')
                .eq('user_id', userId)
                .gte('timestamp', startOfDay)
                .order('timestamp', { ascending: true })
            if (data) setRouteGps(data.map(g => ({ lat: g.latitude, lng: g.longitude, time: g.timestamp })))
        }
        load()
        const i = setInterval(load, 30000)
        return () => clearInterval(i)
    }, [userId, activeShiftId])

    const distanceKm = useMemo(() => {
        let dist = 0
        for (let i = 1; i < routeGps.length; i++) {
            dist += distanceMeters(routeGps[i - 1].lat, routeGps[i - 1].lng, routeGps[i].lat, routeGps[i].lng)
        }
        return (dist / 1000).toFixed(2)
    }, [routeGps])

    const todayStatusStats = useMemo(() => {
        return todaySurveys.reduce(
            (acc, survey) => {
                const statusKey = getSurveyStatus(survey).key
                acc[statusKey] += 1
                return acc
            },
            { completed: 0, attempted: 0, refused: 0, not_home: 0, no_cooperation: 0 } as Record<
                'completed' | 'attempted' | 'refused' | 'not_home' | 'no_cooperation',
                number
            >
        )
    }, [todaySurveys])
    const todayDocuments = useMemo(
        () => [...todaySurveys].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
        [todaySurveys]
    )
    const todayMeetingsCount = todaySurveys.length
    const todayConversion = todayMeetingsCount > 0 ? Math.round((todayStatusStats.completed / todayMeetingsCount) * 100) : 0
    const effectiveScheduledMeetings = useMemo(
        () =>
            scheduledMeetings.map((meeting) => {
                const effectiveScheduledAt = getSalesMeetingEffectiveScheduledAt(meeting)
                return effectiveScheduledAt === meeting.scheduled_at
                    ? meeting
                    : { ...meeting, scheduled_at: effectiveScheduledAt }
            }),
        [scheduledMeetings]
    )

    const todayMeetingTargets = useMemo(
        () =>
            effectiveScheduledMeetings
                .filter((meeting) => {
                    const scheduledDatePart = getScheduledDatePart(meeting.scheduled_at)

                    return (
                        (meeting.status === 'planned' || meeting.status === 'follow_up') &&
                        !isSalesMeetingMissed(meeting) &&
                        scheduledDatePart === getTodayDateInput()
                    )
                })
                .sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime()),
        [effectiveScheduledMeetings]
    )
    const upcomingMeetingTargets = useMemo(
        () =>
            effectiveScheduledMeetings
                .filter((meeting) => {
                    const scheduledAtMs = Date.parse(meeting.scheduled_at)
                    const startOfTodayMs = Date.parse(getStartOfDayISO())

                    return (
                        (meeting.status === 'planned' || meeting.status === 'follow_up') &&
                        !isSalesMeetingMissed(meeting) &&
                        Number.isFinite(scheduledAtMs) &&
                        Number.isFinite(startOfTodayMs) &&
                        scheduledAtMs >= startOfTodayMs
                    )
                })
                .sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime()),
        [effectiveScheduledMeetings]
    )
    const prioritizedMeetingTargets = todayMeetingTargets.length > 0 ? todayMeetingTargets : upcomingMeetingTargets
    const dashboardTabs = useMemo(
        () => [
            { key: 'overview' as const, label: 'Strona główna', count: null },
            { key: 'stats' as const, label: 'Statystyki', count: null },
        ],
        []
    )

    const handleMeetingsChange = useCallback(
        (nextMeetings: SalesMeeting[]) => {
            setScheduledMeetings(mergeSalesMeetingPatch(nextMeetings, pendingMeetingPatch))
        },
        [pendingMeetingPatch]
    )

    useEffect(() => {
        setScheduledMeetings((prev) => mergeSalesMeetingPatch(prev, pendingMeetingPatch))
    }, [pendingMeetingPatch])

    const isRescheduleSlotUnavailable = useCallback(
        (datePart: string, timePart: string, currentMeetingId?: number | null, now = new Date()): boolean => {
            const scheduledAt = buildLocalScheduledAt(datePart, timePart)
            if (scheduledAt.getTime() <= now.getTime()) return true

            return effectiveScheduledMeetings.some((meeting) => {
                if (!meeting.id || meeting.id === currentMeetingId || meeting.status === 'cancelled') return false
                return (
                    getScheduledDatePart(meeting.scheduled_at) === datePart &&
                    getScheduledTimePart(meeting.scheduled_at) === timePart
                )
            })
        },
        [effectiveScheduledMeetings]
    )

    const getFirstAvailableRescheduleSlot = useCallback(
        (datePart: string, currentMeetingId?: number | null): string | null =>
            APPOINTMENT_SLOTS.find((slot) => !isRescheduleSlotUnavailable(datePart, slot, currentMeetingId)) ?? null,
        [isRescheduleSlotUnavailable]
    )

    const openRescheduleModal = useCallback(
        (meeting: SalesMeeting) => {
            const currentDatePart = getScheduledDatePart(meeting.scheduled_at)
            const currentTimePart = getScheduledTimePart(meeting.scheduled_at)
            const nextTime = isRescheduleSlotUnavailable(currentDatePart, currentTimePart, meeting.id ?? null)
                ? getFirstAvailableRescheduleSlot(currentDatePart, meeting.id ?? null) ?? currentTimePart
                : currentTimePart

            setRescheduleMeeting(meeting)
            setRescheduleDate(currentDatePart)
            setRescheduleTime(nextTime)
            setReschedulePickerMonth(toLocalDate(currentDatePart))
        },
        [getFirstAvailableRescheduleSlot, isRescheduleSlotUnavailable]
    )

    const closeRescheduleModal = useCallback(() => {
        if (rescheduleSaving) return
        setRescheduleMeeting(null)
    }, [rescheduleSaving])

    const handleRescheduleDateChange = useCallback(
        (date?: Date) => {
            if (!date) return
            const today = toLocalDate(getTodayDateInput())
            if (date < today) return

            const year = date.getFullYear()
            const month = String(date.getMonth() + 1).padStart(2, '0')
            const day = String(date.getDate()).padStart(2, '0')
            const nextDatePart = `${year}-${month}-${day}`
            const nextTime = isRescheduleSlotUnavailable(nextDatePart, rescheduleTime, rescheduleMeeting?.id ?? null)
                ? getFirstAvailableRescheduleSlot(nextDatePart, rescheduleMeeting?.id ?? null) ?? rescheduleTime
                : rescheduleTime

            setRescheduleDate(nextDatePart)
            setRescheduleTime(nextTime)
            setReschedulePickerMonth(new Date(date.getFullYear(), date.getMonth(), 1))
        },
        [getFirstAvailableRescheduleSlot, isRescheduleSlotUnavailable, rescheduleMeeting?.id, rescheduleTime]
    )

    const handleRescheduleTimeChange = useCallback(
        (timePart: string) => {
            if (isRescheduleSlotUnavailable(rescheduleDate, timePart, rescheduleMeeting?.id ?? null)) return
            setRescheduleTime(timePart)
        },
        [isRescheduleSlotUnavailable, rescheduleDate, rescheduleMeeting?.id]
    )

    const saveRescheduledMeeting = useCallback(async () => {
        if (!rescheduleMeeting?.id) return

        const meeting = rescheduleMeeting
        const meetingId = meeting.id
        if (!rescheduleDate || !rescheduleTime) {
            toast.error('Wybierz poprawną datę i godzinę nowego terminu.')
            return
        }

        if (isRescheduleSlotUnavailable(rescheduleDate, rescheduleTime, meetingId)) {
            toast.error('Ten termin nie jest już dostępny. Wybierz inną godzinę.')
            return
        }

        const rescheduledAt = buildLocalScheduledAt(rescheduleDate, rescheduleTime)
        if (Number.isNaN(rescheduledAt.getTime())) {
            toast.error('Wybierz poprawną datę i godzinę nowego terminu.')
            return
        }

        if (new Date(meeting.scheduled_at).getTime() === rescheduledAt.getTime()) {
            toast.error('Wybierz inny termin niż obecnie zaplanowany.')
            return
        }

        setRescheduleSaving(true)
        try {
            if (meeting.linked_survey_id) {
                const preferredDate = rescheduledAt.toLocaleDateString('sv-SE')
                const preferredTime = rescheduledAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

                const { error: updateSurveyError } = await supabase
                    .from('surveys')
                    .update({
                        respondent_preferred_date: preferredDate,
                        respondent_preferred_time: preferredTime
                    })
                    .eq('id', meeting.linked_survey_id)

                if (updateSurveyError) throw updateSurveyError
            }

            const nextScheduledAtIso = rescheduledAt.toISOString()
            const statusUpdatedAtIso = new Date().toISOString()
            const updatePayload: Record<string, string | null> = {
                scheduled_at: nextScheduledAtIso,
                status_note: buildSalesMeetingRescheduledNote(meeting.scheduled_at, nextScheduledAtIso, meeting.status_note),
                status_updated_at: statusUpdatedAtIso
            }

            const { error } = await supabase
                .from('sales_meetings')
                .update(updatePayload)
                .eq('id', meetingId)

            if (error) throw error

            const updatedMeeting: SalesMeeting = {
                ...meeting,
                scheduled_at: nextScheduledAtIso,
                status_note: updatePayload.status_note,
                status_updated_at: statusUpdatedAtIso
            }

            setScheduledMeetings((prev) => mergeSalesMeetingPatch(prev, updatedMeeting))
            toast.success('Termin spotkania został przełożony.')
            setRescheduleMeeting(null)
        } catch (error) {
            toast.error(mapSalesMeetingsMutationError(error))
        } finally {
            setRescheduleSaving(false)
        }
    }, [isRescheduleSlotUnavailable, rescheduleDate, rescheduleMeeting, rescheduleTime])

    const nextMeeting = prioritizedMeetingTargets[0] ?? null
    const nextMeetingStatusMeta = nextMeeting ? getSalesMeetingDisplayMeta(nextMeeting) : null
    const nextMeetingPhoneHref = nextMeeting ? buildPhoneHref(nextMeeting.phone) : null
    const nextMeetingDirectionsHref = nextMeeting ? buildGoogleMapsDirectionsHref(nextMeeting.address) : null
    const nextMeetingEnhancedAddress = nextMeeting ? getSalesMeetingEnhancedAddress(nextMeeting) : null
    const nextMeetingLocationLabel = nextMeetingEnhancedAddress?.main ?? ''
    const rescheduleDateValue = useMemo(() => toLocalDate(rescheduleDate), [rescheduleDate])
    const rescheduleTimeOptions = useMemo(
        () => Array.from(new Set([rescheduleTime, ...APPOINTMENT_SLOTS])).sort((left, right) => left.localeCompare(right)),
        [rescheduleTime]
    )
    const unavailableRescheduleSlots = useMemo(
        () =>
            new Set(
                rescheduleTimeOptions.filter((slot) =>
                    isRescheduleSlotUnavailable(rescheduleDate, slot, rescheduleMeeting?.id ?? null)
                )
            ),
        [isRescheduleSlotUnavailable, rescheduleDate, rescheduleMeeting?.id, rescheduleTimeOptions]
    )
    const nextMeetingDayProgress = useMemo(() => {
        if (!nextMeeting) {
            return { total: 0, remaining: 0, completed: 0, progressPercent: 0, currentSequence: 0 }
        }

        const dayKey = getMeetingDayKey(nextMeeting.scheduled_at)
        const dayMeetings = effectiveScheduledMeetings.filter(
            (meeting) => getMeetingDayKey(meeting.scheduled_at) === dayKey && meeting.status !== 'cancelled'
        )
        const remainingMeetings = dayMeetings.filter(
            (meeting) => (meeting.status === 'planned' || meeting.status === 'follow_up') && !isSalesMeetingMissed(meeting)
        )
        const total = dayMeetings.length
        const remaining = remainingMeetings.length
        const completed = Math.max(0, total - remaining)
        const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0
        const currentSequence = total > 0 ? Math.min(total, completed + 1) : 0

        return { total, remaining, completed, progressPercent, currentSequence }
    }, [effectiveScheduledMeetings, nextMeeting])
    const shiftStatsLabel = activeShift ? elapsed : 'Poza zmianą'
    const getMeetingStartAvailability = useCallback(
        (meeting: SalesMeeting): { allowed: boolean; reason: string | null } => {
            if (!activeShift) {
                return { allowed: false, reason: 'Najpierw rozpocznij pracę.' }
            }
            if (gpsPermission !== 'granted') {
                return { allowed: false, reason: 'Aby rozpocząć spotkanie, potrzebujesz aktywnego GPS.' }
            }

            const displayMeta = getSalesMeetingDisplayMeta(meeting)
            if (displayMeta.isMissed) {
                return { allowed: false, reason: 'To spotkanie jest już oznaczone jako nieodbyte.' }
            }

            return { allowed: true, reason: null }
        },
        [activeShift, gpsPermission]
    )
    const nextMeetingStartAvailability = nextMeeting
        ? getMeetingStartAvailability(nextMeeting)
        : { allowed: false, reason: null }
    const canStartMeeting = nextMeetingStartAvailability.allowed

    useEffect(() => {
        if (!activeShift) {
            setShowEndShiftConfirm(false)
            setEndingShift(false)
        }
    }, [activeShift])

    const setMeetingLocationAliases = useCallback((meeting: SalesMeeting, location: GeocodedMeetingAddress | null) => {
        const queries = buildMeetingAddressQueries(meeting)
        if (queries.length === 0) return

        setMeetingLocations((prev) => {
            let changed = false
            const next = { ...prev }

            queries.forEach((query) => {
                const cacheKey = getMeetingAddressCacheKey(query)
                if (!cacheKey) return
                if (next[cacheKey] !== location) {
                    next[cacheKey] = location
                    changed = true
                }
            })

            return changed ? next : prev
        })
    }, [])

    const resolveMeetingLocation = useCallback(
        async (
            meeting: SalesMeeting,
            options?: { force?: boolean; signal?: AbortSignal }
        ): Promise<GeocodedMeetingAddress | null> => {
            const directLocation = getSalesMeetingMapLocation(meeting)
            if (directLocation) return directLocation

            const queries = buildMeetingAddressQueries(meeting)
            if (queries.length === 0) return null

            for (const query of queries) {
                const cacheKey = getMeetingAddressCacheKey(query)
                const cached = meetingLocationsRef.current[cacheKey]
                if (cached) {
                    return cached
                }
            }

            for (const query of queries) {
                const cacheKey = getMeetingAddressCacheKey(query)
                const cached = meetingLocationsRef.current[cacheKey]
                if (cached === null && !options?.force) continue

                const resolved = await geocodeMeetingAddress(query, options?.signal, {
                    force: Boolean(options?.force && cached === null)
                })

                if (resolved) {
                    setMeetingLocationAliases(meeting, resolved)
                    return resolved
                }

                setMeetingLocations((prev) => (cacheKey in prev ? prev : { ...prev, [cacheKey]: null }))
            }

            setMeetingLocationAliases(meeting, null)
            return null
        },
        [setMeetingLocationAliases]
    )

    const ensureMapReady = useCallback(async (): Promise<L.Map | null> => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const map = mapInst.current
            if (map && mapRef.current) {
                forceMapReflow({ burst: true })
                await wait(40)
                return map
            }

            await wait(90)
        }

        return null
    }, [forceMapReflow])

    const focusMeetingOnMap = useCallback(
        async (meeting: SalesMeeting) => {
            const map = await ensureMapReady()
            if (!map) {
                toast.error('Mapa nie jest jeszcze gotowa.')
                return
            }

            const toastId = toast.loading('Lokalizuję spotkanie na mapie...')
            let location: GeocodedMeetingAddress | null = null
            try {
                location = await resolveMeetingLocation(meeting, { force: true })
            } finally {
                toast.dismiss(toastId)
            }

            if (!location) {
                toast.error('Nie udało się zlokalizować adresu spotkania na mapie.')
                return
            }

            window.scrollTo({ top: 0, behavior: 'smooth' })
            forceMapReflow({ burst: true })
            await wait(120)
            map.setView([location.lat, location.lng], 16, { animate: true })

            if (meeting.id) {
                window.setTimeout(() => {
                    meetingMarkerRefs.current.get(meeting.id!)?.openPopup()
                }, 320)
            }
        },
        [ensureMapReady, forceMapReflow, resolveMeetingLocation]
    )

    const openMeetingSurvey = useCallback(
        (meeting: SalesMeeting) => {
            const startAvailability = getMeetingStartAvailability(meeting)
            if (!startAvailability.allowed) {
                toast.error(startAvailability.reason || 'Nie możesz jeszcze rozpocząć tego spotkania.')
                return
            }
            onNewSurvey(null, meeting)
        },
        [getMeetingStartAvailability, onNewSurvey]
    )

    const confirmEndShift = useCallback(async () => {
        if (!activeShift || endingShift) return
        setEndingShift(true)
        try {
            await endShift()
            setShowEndShiftConfirm(false)
        } finally {
            setEndingShift(false)
        }
    }, [activeShift, endShift, endingShift])

    useEffect(() => {
        if (dashboardTab !== 'overview' || !pendingFocusedMeeting) return

        let cancelled = false

        const run = async () => {
            await wait(90)
            if (cancelled) return
            forceMapReflow({ burst: true })
            await wait(140)
            if (cancelled) return
            await focusMeetingOnMap(pendingFocusedMeeting)
            if (!cancelled) setPendingFocusedMeeting(null)
        }

        void run()

        return () => {
            cancelled = true
        }
    }, [dashboardTab, focusMeetingOnMap, forceMapReflow, pendingFocusedMeeting])

    useEffect(() => {
        if (!workerMapEnabled) return
        if (todayMeetingTargets.length === 0) {
            setMeetingMarkersReady(true)
            return
        }

        let cancelled = false
        const controller = new AbortController()

        const run = async () => {
            setMeetingMarkersReady(false)

            const queuedMeetings: SalesMeeting[] = []
            const seenPrimaryKeys = new Set<string>()

            todayMeetingTargets.forEach((meeting) => {
                if (getSalesMeetingMapLocation(meeting)) return
                const primaryQuery = buildMeetingAddressQuery(meeting)
                const cacheKey = getMeetingAddressCacheKey(primaryQuery)
                if (!cacheKey || meetingLocationsRef.current[cacheKey] !== undefined || seenPrimaryKeys.has(cacheKey)) return
                seenPrimaryKeys.add(cacheKey)
                queuedMeetings.push(meeting)
            })

            for (const meeting of queuedMeetings) {
                try {
                    await resolveMeetingLocation(meeting, { signal: controller.signal })
                    if (cancelled) return
                    await wait(350)
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return
                }
            }

            if (!cancelled) setMeetingMarkersReady(true)
        }

        void run()

        return () => {
            cancelled = true
            controller.abort()
        }
    }, [resolveMeetingLocation, todayMeetingTargets, workerMapEnabled])

    useEffect(() => {
        if (!userId || !userName) return
        if (!navigator.geolocation) return
        
        let lastLogTime = 0
        const minLogInterval = 30000 // 30 seconds

        const watchId = navigator.geolocation.watchPosition(
            async (pos) => {
                const lat = pos.coords.latitude
                const lng = pos.coords.longitude
                setLastPos([lat, lng])

                // ONLY log to DB/Offline if shift is active and enough time passed
                const now = Date.now()
                if (activeShiftId && (now - lastLogTime >= minLogInterval)) {
                    lastLogTime = now
                    const logData = {
                        user_id: userId,
                        user_name: userName,
                        shift_id: activeShiftId,
                        latitude: lat,
                        longitude: lng,
                        timestamp: new Date().toISOString()
                    }
                    try {
                        const { error } = await supabase.from('gps_logs').insert(logData)
                        if (error) throw error
                    } catch {
                        addOfflineGpsLog(logData)
                    }
                }
            },
            (err) => console.warn('GPS Update Error:', err.message),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        )
        
        return () => navigator.geolocation.clearWatch(watchId)
    }, [userId, userName, activeShiftId])

    // 1. Map Init — one time, event listeners registered once
    useEffect(() => {
        if (!mapRef.current || !user) return
        
        // If map already exists, just resize it
        if (mapInst.current) {
            setTimeout(() => forceMapReflow(), 100)
            return
        }

        const map = L.map(mapRef.current, { 
            zoomControl: false, 
            attributionControl: false,
            fadeAnimation: false,
            zoomAnimation: false,
            markerZoomAnimation: false
        }).setView(lastPosRef.current || [50.89, 20.70], 16)
        
        tileLayerRef.current = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            keepBuffer: 6,
            updateWhenIdle: true
        })
        tileLayerRef.current.addTo(map)
        mapInst.current = map
        routeLayerRef.current = L.layerGroup().addTo(map)
        markersLayerRef.current = L.layerGroup().addTo(map)
        meetingMarkersLayerRef.current = L.layerGroup().addTo(map)


        // Multiple attempts to invalidate size to handle animations/transitions
        const timer1 = setTimeout(() => {
            forceMapReflow()
        }, 100)
        
        const timer2 = setTimeout(() => {
            forceMapReflow()
        }, 800)

        return () => {
            clearTimeout(timer1)
            clearTimeout(timer2)
        }
    }, [user, forceMapReflow]) // Re-run only when user/map lifecycle changes

    // iOS/Safari sometimes keeps stale map canvas after layout jump to fullscreen.
    useEffect(() => {
        const map = mapInst.current
        if (!map) return

        const center = map.getCenter()
        const zoom = map.getZoom()
        const raf = requestAnimationFrame(() => {
            map.setView(center, zoom, { animate: false })
            forceMapReflow({ burst: true })
        })

        return () => cancelAnimationFrame(raf)
    }, [isFullscreenMap, forceMapReflow])

    useEffect(() => {
        if (dashboardTab !== 'overview' && !isFullscreenMap) return

        const timers = [0, 120, 320, 680].map((delay) =>
            window.setTimeout(() => {
                forceMapReflow({ burst: true })
            }, delay)
        )

        return () => {
            timers.forEach((timer) => window.clearTimeout(timer))
        }
    }, [dashboardTab, forceMapReflow, isFullscreenMap])

    // Keep tiles visible after viewport changes (Safari bars, orientation, app resume).
    useEffect(() => {
        if (!isFullscreenMap) return

        const handleViewportChange = () => forceMapReflow()
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') forceMapReflow()
        }

        window.addEventListener('resize', handleViewportChange)
        window.addEventListener('orientationchange', handleViewportChange)
        window.addEventListener('pageshow', handleViewportChange)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        const vv = window.visualViewport
        vv?.addEventListener('resize', handleViewportChange)

        return () => {
            window.removeEventListener('resize', handleViewportChange)
            window.removeEventListener('orientationchange', handleViewportChange)
            window.removeEventListener('pageshow', handleViewportChange)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            vv?.removeEventListener('resize', handleViewportChange)
        }
    }, [isFullscreenMap, forceMapReflow])

    const meetingsHash = useMemo(
        () =>
            todayMeetingTargets
                .map((meeting) => `${meeting.id || meeting.import_key}-${meeting.status}-${meeting.scheduled_at}`)
                .join(';'),
        [todayMeetingTargets]
    )

    useEffect(() => {
        const map = mapInst.current
        const layer = meetingMarkersLayerRef.current
        if (!map || !layer) return

        layer.clearLayers()
        meetingMarkerRefs.current.clear()

        const mappedMeetings = todayMeetingTargets
            .map((meeting) => {
                const directLocation = getSalesMeetingMapLocation(meeting)
                if (directLocation) {
                    return {
                        meeting,
                        lat: directLocation.lat,
                        lng: directLocation.lng,
                        label: directLocation.label
                    }
                }

                const query = buildMeetingAddressQuery(meeting)
                const cacheKey = getMeetingAddressCacheKey(query)
                const location = meetingLocations[cacheKey]
                if (!location) return null
                return {
                    meeting,
                    lat: location.lat,
                    lng: location.lng,
                    label: location.label
                }
            })
            .filter((item): item is { meeting: SalesMeeting; lat: number; lng: number; label: string } => item !== null)

        const spread = spreadOverlappingSurveyMarkers(mappedMeetings, 14)
        spread.forEach((item) => {
            const statusMeta = getSalesMeetingDisplayMeta(item.meeting)
            const markerColor = MEETING_MARKER_COLORS[item.meeting.status] || MEETING_MARKER_COLORS.planned
            const timeLabel = toTimeLabel(item.meeting.scheduled_at)
            const popupContent = [
                '<strong>Spotkanie</strong>',
                `Klient: ${escapeHtml(item.meeting.client_name || 'Brak')}`,
                `Termin: ${escapeHtml(new Date(item.meeting.scheduled_at).toLocaleString('pl-PL'))}`,
                `Status: ${escapeHtml(statusMeta.label)}`,
                `Lokalizacja: ${escapeHtml(getSalesMeetingEnhancedAddress(item.meeting).main || item.label)}`
            ]
            const enhanced = getSalesMeetingEnhancedAddress(item.meeting)
            if (enhanced.suggestion) {
                popupContent.push(`<em>Sugerowana nawigacja: ${escapeHtml(enhanced.suggestion)}</em>`)
            }

            if (item.meeting.phone) popupContent.push(`Telefon: ${escapeHtml(item.meeting.phone)}`)
            if (item.meeting.lead_source) {
                popupContent.push(`Źródło: ${escapeHtml(normalizeSalesMeetingInlineText(item.meeting.lead_source))}`)
            }
            if (item.meeting.note) {
                popupContent.push(`Komentarz: ${escapeHtml(normalizeSalesMeetingInlineText(item.meeting.note))}`)
            }

            const icon = L.divIcon({
                className: 'meeting-marker',
                html: `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:78px;height:74px;">
                        <div style="min-width:58px;padding:5px 9px;border-radius:999px;background:${markerColor};color:#fff;font-size:11px;font-weight:900;line-height:1;letter-spacing:0.06em;text-align:center;box-shadow:0 12px 28px rgba(15,23,42,0.22);border:2px solid rgba(255,255,255,0.92);">
                            ${escapeHtml(timeLabel)}
                        </div>
                        <div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:9px solid ${markerColor};margin-top:-1px;filter:drop-shadow(0 4px 8px rgba(15,23,42,0.18));"></div>
                        <div style="width:14px;height:14px;border-radius:999px;background:${markerColor};border:3px solid rgba(255,255,255,0.96);margin-top:-2px;box-shadow:0 6px 14px rgba(15,23,42,0.2);"></div>
                    </div>
                `,
                iconSize: [78, 74],
                iconAnchor: [39, 64],
                popupAnchor: [0, -48]
            })

            const marker = L.marker([item.renderLat, item.renderLng], { icon, zIndexOffset: 820 })
                .addTo(layer)
                .bindPopup(popupContent.join('<br/>'))

            if (item.meeting.id) meetingMarkerRefs.current.set(item.meeting.id, marker)
        })

        if (spread.length > 0 && !lastPosRef.current && !hasCenteredMeetings.current) {
            const bounds = L.latLngBounds(spread.map((item) => [item.renderLat, item.renderLng] as [number, number]))
            map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 })
            hasCenteredMeetings.current = true
        }
    }, [meetingLocations, meetingsHash, todayMeetingTargets])

    // 4. Route + position markers (run frequently on GPS updates)
    useEffect(() => {
        if (!mapInst.current || !routeLayerRef.current || !markersLayerRef.current) return
        const occupiedMeetingPoints = todayMeetingTargets
            .map((meeting) => {
                const directLocation = getSalesMeetingMapLocation(meeting)
                if (directLocation) return { lat: directLocation.lat, lng: directLocation.lng }

                const query = buildMeetingAddressQuery(meeting)
                const cacheKey = getMeetingAddressCacheKey(query)
                const location = meetingLocations[cacheKey]
                return location ? { lat: location.lat, lng: location.lng } : null
            })
            .filter((point): point is { lat: number; lng: number } => point !== null)

        // Draw GPS route (Update existing polyline to prevent flashing)
        if (routeGps.length > 1) {
            const latlngs = routeGps.map(g => [g.lat, g.lng] as [number, number])
            if (!routePolylineRef.current) {
                L.polyline(latlngs, { color: '#ffffff', weight: 7, opacity: 0.55, lineCap: 'round' }).addTo(routeLayerRef.current)
                routePolylineRef.current = L.polyline(latlngs, { color: '#f59e0b', weight: 4, opacity: 0.95, lineCap: 'round' }).addTo(routeLayerRef.current)
                routeStartMarkerRef.current = L.circleMarker(latlngs[0], {
                    radius: 6, fillColor: '#22c55e', fillOpacity: 1, color: 'white', weight: 2
                }).addTo(routeLayerRef.current).bindPopup(`Start trasy · ${new Date(routeGps[0].time).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`)
            } else {
                routePolylineRef.current.setLatLngs(latlngs)
            }
        }

        // Draw current position
        if (lastPos) {
            const workerLabel = `${user?.name.split(' ')[0] || 'Ty'} (${todaySurveysRef.current.length})`
            const workerRenderPoint = offsetPointAwayFromTargets(
                { lat: lastPos[0], lng: lastPos[1] },
                occupiedMeetingPoints,
                18,
                20
            )
            const workerIcon = L.divIcon({
                className: 'worker-marker-custom',
                html: `<div style="display: flex; flex-direction: column; align-items: center; justify-content: flex-end; width: 100px; height: 100px; position: relative;">
                         <div style="background: rgba(59, 130, 246, 0.95); padding: 4px 10px; border-radius: 12px; color: white; font-weight: 900; font-size: 11px; white-space: nowrap; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4); text-transform: uppercase; letter-spacing: 0.5px; border: 1.5px solid rgba(255,255,255,0.2); backdrop-filter: blur(4px); margin-bottom: 2px;">
                           ${workerLabel}
                         </div>
                         <div style="width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid rgba(59, 130, 246, 0.95); filter: drop-shadow(0 2px 2px rgba(0,0,0,0.2)); margin-bottom: 2px;"></div>
                         <div style="width: 16px; height: 16px; background: #3b82f6; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.3);"></div>
                       </div>`,
                iconSize: [100, 100],
                iconAnchor: [50, 92] // Pointing exactly to the bottom circle
            })

            if (!workerMarkerRef.current) {
                workerMarkerRef.current = L.marker([workerRenderPoint.lat, workerRenderPoint.lng], { icon: workerIcon, zIndexOffset: 1000 })
                    .addTo(markersLayerRef.current)
                workerMarkerLabelRef.current = workerLabel
            } else {
                workerMarkerRef.current.setLatLng([workerRenderPoint.lat, workerRenderPoint.lng])
                if (workerMarkerLabelRef.current !== workerLabel) {
                    workerMarkerRef.current.setIcon(workerIcon)
                    workerMarkerLabelRef.current = workerLabel
                }
            }

            // Force center on first load or when explicitly needed
            if (!hasCenteredUser.current) {
                mapInst.current.setView(lastPos, 16, { animate: true })
                hasCenteredUser.current = true
            }
        }
    }, [lastPos, routeGps, user?.name, meetingLocations, todayMeetingTargets])

    // Cleanup on unmount
    useEffect(() => {
        const meetingMarkers = meetingMarkerRefs.current
        const t = setTimeout(() => {
            forceMapReflow()
        }, 1000)
        return () => {
            clearTimeout(t)
            if (mapInst.current) {
                mapInst.current.remove()
                mapInst.current = null
                tileLayerRef.current = null
                meetingMarkersLayerRef.current = null
            }
            meetingMarkers.clear()
        }
    }, [forceMapReflow])

    if (viewMode === 'history' && user) {
        return <WorkerHistory user={user} onBack={() => setViewMode('dashboard')} />
    }

    return (
        <div className="animate-in fade-in duration-300">
            <div className={`max-w-lg mx-auto px-4 pt-6 pb-4 ${isFullscreenMap ? 'hidden' : ''}`}>
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-xl font-black dark:text-white">Cześć, {user?.name.split(' ')[0]}! 👋</h1>
                        <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest mt-0.5">Dzisiejsze postępy · <span className="text-violet-500 bg-violet-500/10 px-2 py-0.5 rounded-full font-bold">v{APP_VERSION}</span></p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={() => setViewMode('history')} className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-sm text-lg hover:text-cyan-500 hover:scale-105 active:scale-95 transition-all" title="Historia pracy">📋</button>
                        <button onClick={toggle} className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-sm text-lg hover:scale-105 active:scale-95 transition-all">{dark ? '☀️' : '🌙'}</button>
                        <button onClick={logout} className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-sm text-lg hover:text-red-500 hover:scale-105 active:scale-95 transition-all">⎋</button>
                    </div>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2">
                    {dashboardTabs.map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setDashboardTab(tab.key)}
                            className={`ui-pressable min-w-0 rounded-2xl border px-4 py-2.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                                dashboardTab === tab.key
                                    ? 'border-violet-500 bg-violet-600 text-white shadow-lg shadow-violet-600/20'
                                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                            }`}
                        >
                            <span>{tab.label}</span>
                            {typeof tab.count === 'number' && <span className="ml-2 opacity-80">{tab.count}</span>}
                        </button>
                    ))}
                </div>

                {dashboardTab === 'overview' && (
                    <div className="flex flex-col gap-3">
                        <div className={`${card} p-6 flex flex-col justify-between relative overflow-hidden group`}>
                        <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform">
                            <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>
                        </div>
                        <div>
                            <div className="flex items-center gap-3 mb-6">
                                <div className={`${activeShift ? 'bg-teal-500' : (gpsPermission === 'granted' ? 'bg-teal-500' : 'bg-cyan-500')} text-white rounded-2xl flex items-center justify-center text-xl font-black shadow-lg ${gpsPermission === 'granted' ? 'shadow-teal-500/30' : 'shadow-cyan-500/20'} w-14 h-14 transition-all duration-500`}>
                                    {activeShift ? '✓' : (gpsPermission === 'granted' ? '📍' : '…')}
                                </div>
                                <div>
                                    <h2 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest mb-0.5">Twoja Zmiana</h2>
                                    <p className={`text-[10px] font-black tracking-widest uppercase ${activeShift || gpsPermission === 'granted' ? 'text-teal-500' : 'text-gray-400'}`}>
                                        {activeShift ? 'Praca w toku' : (hasFinishedToday ? 'Praca zakończona' : (gpsPermission === 'granted' ? '📍 GPS AKTYWNY' : 'Oczekiwanie...'))}
                                    </p>
                                </div>
                            </div>

                            {activeShift ? (
                                <div className="space-y-4">
                                    <div className="bg-slate-900 rounded-2xl p-4 border border-slate-800 shadow-inner">
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Czas trwania</span>
                                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                        </div>
                                        <p className="text-3xl font-black text-white font-mono tracking-tighter">{elapsed}</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setShowEndShiftConfirm(true)}
                                        className="ui-pressable w-full bg-red-500 hover:bg-red-600 text-white font-black py-4 rounded-2xl text-xs uppercase tracking-widest transition-all shadow-xl shadow-red-500/20 active:scale-95"
                                    >
                                        Zakończ pracę
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {hasFinishedToday ? (
                                        <div className="bg-teal-500/10 border border-teal-500/20 rounded-2xl p-6 text-center">
                                            <p className="text-[10px] font-black text-teal-600 uppercase mb-2">✅ Praca Zakończona</p>
                                            <p className="text-[9px] text-teal-500/70 font-bold uppercase leading-relaxed">Dziękujemy! Twoje dzisiejsze raporty zostały zabezpieczone. Nową zmianę możesz zacząć jutro.</p>
                                        </div>
                                    ) : (
                                        <>
                                            {gpsPermission === 'denied' ? (
                                                <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 text-center">
                                                    <p className="text-[10px] font-black text-red-600 uppercase mb-2">✕ Brak dostępu do GPS</p>
                                                    <p className="text-[9px] text-red-500/70 font-bold uppercase leading-relaxed">Ustawienia przeglądarki blokują lokalizację. Odblokuj, aby zacząć.</p>
                                                </div>
                                            ) : (
                                                <p className="text-[10px] text-gray-400 font-bold uppercase text-center px-4 leading-relaxed">
                                                    {gpsPermission === 'granted' ? '📍 GPS połączony. Możesz rozpocząć pracę i dokumentację.' : 'System wymaga aktywnego GPS do autoryzacji dokumentacji terenowej.'}
                                                </p>
                                            )}
                                            <button 
                                                onClick={() => void handleStartShift()} 
                                                disabled={gpsPermission !== 'granted' || hasFinishedToday}
                                                className={`w-full font-black py-4 rounded-2xl text-xs uppercase tracking-widest transition-all shadow-xl active:scale-95 ${gpsPermission === 'granted' ? 'bg-cyan-500 hover:bg-cyan-600 text-white shadow-cyan-500/20' : 'bg-gray-100 dark:bg-slate-800 text-gray-400 cursor-not-allowed shadow-none border border-gray-200 dark:border-slate-700'}`}
                                            >
                                                {gpsPermission === 'granted' ? '▶ Rozpocznij pracę' : 'Oczekiwanie na GPS...'}
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    </div>
                )}
            </div>

            {/* Main Interactive Zone */}
            {user ? (
                <div className="max-w-lg mx-auto px-4 pb-10 space-y-4">
                    {/* eslint-disable-next-line no-constant-binary-expression */}
                    {false && !isFullscreenMap && dashboardTab === 'overview' && nextMeeting && (
                    <div className={`${card} p-4 overflow-hidden relative`}>
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-11 h-11 bg-violet-600 text-white rounded-2xl flex items-center justify-center text-lg font-black shadow-lg shadow-violet-600/25 shrink-0">
                                    🎯
                                </div>
                                <div className="min-w-0">
                                    <h2 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest mb-0.5">Najbliższe spotkanie</h2>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-tighter">
                                        {new Date(nextMeeting.scheduled_at).toLocaleDateString('pl-PL', {
                                            day: '2-digit',
                                            month: '2-digit',
                                            year: 'numeric'
                                        })}{' '}
                                        · {toTimeLabel(nextMeeting.scheduled_at)} · {nextMeetingDayProgress.currentSequence} z {nextMeetingDayProgress.total || prioritizedMeetingTargets.length}
                                    </p>
                                </div>
                            </div>
                            {nextMeetingStatusMeta && (
                                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${nextMeetingStatusMeta?.badgeClass ?? ''}`}>
                                    {nextMeetingStatusMeta?.label ?? ''}
                                </span>
                            )}
                        </div>

                        <div className="mt-4 rounded-2xl border border-violet-100 dark:border-violet-500/20 bg-violet-50/70 dark:bg-violet-500/10 p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-lg font-black text-slate-800 dark:text-white truncate">{nextMeeting.client_name}</p>
                                    <p className="mt-1 text-[11px] font-black uppercase tracking-widest text-violet-500">
                                        {new Date(nextMeeting.scheduled_at).toLocaleDateString('pl-PL', {
                                            day: '2-digit',
                                            month: '2-digit',
                                            year: 'numeric'
                                        })}{' '}
                                        · {toTimeLabel(nextMeeting.scheduled_at)}
                                    </p>
                                    {nextMeetingDirectionsHref ? (
                                        <a
                                            href={nextMeetingDirectionsHref ?? undefined}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="mt-3 block text-sm font-semibold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300"
                                        >
                                            📍 {nextMeetingLocationLabel}
                                        </a>
                                    ) : (
                                        <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-100 leading-snug">
                                            📍 {nextMeetingLocationLabel}
                                        </p>
                                    )}
                                    {(() => {
                                        const suggestion = nextMeetingEnhancedAddress?.suggestion
                                        if (!suggestion) return null
                                        return (
                                            <div className="mt-2 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1.5 backdrop-blur-sm">
                                                <p className="text-[9px] font-black uppercase tracking-widest text-cyan-500 mb-0.5">Sugerowana nawigacja</p>
                                                <p className="text-[11px] font-medium text-cyan-700 dark:text-cyan-200 leading-snug">
                                                    {suggestion}
                                                </p>
                                            </div>
                                        )
                                    })()}
                                    {nextMeeting.phone && (
                                        nextMeetingPhoneHref ? (
                                            <a
                                                href={nextMeetingPhoneHref ?? undefined}
                                                className="mt-2 block text-sm font-semibold leading-snug text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300"
                                            >
                                                📞 {nextMeeting.phone}
                                            </a>
                                        ) : (
                                            <p className="mt-2 text-sm font-semibold text-slate-500 dark:text-slate-300 leading-snug">
                                                📞 {nextMeeting.phone}
                                            </p>
                                        )
                                    )}
                                </div>
                                <span className="shrink-0 rounded-full border border-violet-200 bg-white/80 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-violet-600 dark:border-violet-500/20 dark:bg-slate-900/40 dark:text-violet-300">
                                    {nextMeetingDayProgress.currentSequence}/{nextMeetingDayProgress.total || prioritizedMeetingTargets.length}
                                </span>
                            </div>

                            <div className="mt-4">
                                <div className="flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-widest">
                                    <p className="text-violet-500">
                                        Spotkanie {nextMeetingDayProgress.currentSequence} z {nextMeetingDayProgress.total || prioritizedMeetingTargets.length}
                                    </p>
                                    <p className="text-slate-400">
                                        {nextMeetingDayProgress.remaining} pozostało
                                    </p>
                                </div>
                                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-950/60">
                                    <div
                                        className="h-full rounded-full bg-linear-to-r from-violet-500 via-fuchsia-500 to-cyan-400 transition-all duration-500"
                                        style={{ width: `${nextMeetingDayProgress.progressPercent}%` }}
                                    />
                                </div>
                            </div>

                            <div className="mt-4 flex flex-col gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        void openMeetingSurvey(nextMeeting)
                                    }}
                                    disabled={!canStartMeeting}
                                    title={nextMeetingStartAvailability.reason || undefined}
                                    className="ui-pressable w-full rounded-xl border border-violet-400/35 bg-violet-600 px-4 py-3 text-[11px] font-black uppercase tracking-widest text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500 disabled:opacity-40"
                                >
                                    Rozpocznij spotkanie
                                </button>
                                <button
                                    type="button"
                                    onClick={() => openRescheduleModal(nextMeeting)}
                                    className="ui-pressable w-full rounded-xl border border-violet-200 bg-white/90 px-4 py-3 text-[11px] font-black uppercase tracking-widest text-violet-700 shadow-sm hover:bg-white dark:border-violet-500/20 dark:bg-slate-900/40 dark:text-violet-300 dark:hover:bg-slate-900/70"
                                >
                                    Przełóż termin
                                </button>
                            </div>
                        </div>
                    </div>
                    )}

                    {!isFullscreenMap && dashboardTab === 'stats' && (
                    <div className={`${card} p-4 overflow-hidden relative`}>
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-11 h-11 bg-violet-600 text-white rounded-2xl flex items-center justify-center text-lg font-black shadow-lg shadow-violet-600/25">
                                📊
                            </div>
                            <div>
                                <h2 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest mb-0.5">Postęp Dzisiaj</h2>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-tighter">Twoje wyniki · {new Date().toLocaleDateString('pl-PL', { weekday: 'long' })}</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3 mb-3">
                            <div className="relative overflow-hidden rounded-3xl bg-linear-to-br from-violet-600 via-indigo-600 to-sky-600 px-5 py-5 text-white shadow-xl shadow-violet-600/20">
                                <div className="absolute -right-6 -top-8 h-28 w-28 rounded-full bg-white/10 blur-2xl" />
                                <div className="flex flex-col gap-2 min-[430px]:flex-row min-[430px]:items-start min-[430px]:justify-between">
                                    <p className="text-[10px] font-black uppercase tracking-[0.32em] text-white/65">Raporty dnia</p>
                                    <div className="self-start rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/80">
                                        Dzisiejszy wynik
                                    </div>
                                </div>
                                <div className="mt-4 flex items-end gap-3">
                                    <p className="text-6xl font-black leading-none tracking-[-0.08em]">{todayMeetingsCount}</p>
                                    <div className="pb-1">
                                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/70">łącznie</p>
                                        <p className="mt-1 text-[11px] font-bold text-white/85">Wizyty i formularze zapisane dzisiaj</p>
                                    </div>
                                </div>
                                <div className="mt-5 grid grid-cols-1 min-[440px]:grid-cols-2 gap-2">
                                    <div className="rounded-2xl border border-white/15 bg-slate-950/20 px-3 py-3 backdrop-blur-sm">
                                        <p className="text-[9px] font-black uppercase tracking-[0.24em] text-white/65">W kolejce</p>
                                        <p className="mt-2 text-2xl font-black leading-none">{todayMeetingTargets.length}</p>
                                        <p className="mt-1 text-[10px] font-bold text-white/70">aktywnych spotkań</p>
                                    </div>
                                    <div className="rounded-2xl border border-white/15 bg-slate-950/20 px-3 py-3 backdrop-blur-sm">
                                        <p className="text-[9px] font-black uppercase tracking-[0.24em] text-white/65">Czas pracy</p>
                                        <p className="mt-2 text-xl min-[440px]:text-2xl font-black leading-none break-all">{shiftStatsLabel}</p>
                                        <p className="mt-1 text-[10px] font-bold text-white/70">{activeShift ? 'aktywny licznik zmiany' : 'brak aktywnej zmiany'}</p>
                                    </div>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 min-[440px]:grid-cols-2 gap-3">
                                <div className="rounded-3xl border border-emerald-200/70 bg-linear-to-br from-emerald-50 to-white p-4 shadow-sm dark:border-emerald-900/30 dark:from-emerald-950/30 dark:to-slate-900">
                                    <div className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-start min-[400px]:justify-between">
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-[0.26em] text-emerald-500">Skuteczność</p>
                                            <div className="mt-3 flex items-end gap-1">
                                                <p className="text-4xl min-[400px]:text-5xl font-black text-emerald-700 dark:text-emerald-300 leading-none tracking-tighter">{todayConversion}</p>
                                                <span className="pb-1 text-sm font-black text-emerald-400">%</span>
                                            </div>
                                        </div>
                                        <div className="self-start rounded-2xl bg-emerald-500/10 px-3 py-2 text-left min-[400px]:text-right dark:bg-emerald-500/15">
                                            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-emerald-500">Umowy</p>
                                            <p className="mt-1 text-2xl font-black text-emerald-700 dark:text-emerald-300">{todayStatusStats.completed}</p>
                                        </div>
                                    </div>
                                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-950/60">
                                        <div
                                            className="h-full rounded-full bg-linear-to-r from-emerald-400 via-teal-400 to-cyan-400 transition-all duration-700"
                                            style={{ width: `${todayConversion}%` }}
                                        />
                                    </div>
                                    <p className="mt-3 text-[11px] font-bold text-emerald-700/80 dark:text-emerald-200/80">
                                        {todayStatusStats.completed} umów podpisanych z {todayMeetingsCount || 0} zapisanych raportów.
                                    </p>
                                </div>

                                <div className="rounded-3xl border border-indigo-200/70 bg-linear-to-br from-indigo-50 to-white p-4 shadow-sm dark:border-indigo-900/30 dark:from-indigo-950/30 dark:to-slate-900">
                                    <div className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-start min-[400px]:justify-between">
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-[0.26em] text-indigo-500">Trasa GPS</p>
                                            <p className="mt-3 text-4xl min-[400px]:text-5xl font-black text-indigo-700 dark:text-indigo-300 leading-none tracking-tighter">{distanceKm}</p>
                                        </div>
                                        <div className="self-start rounded-2xl bg-indigo-500/10 px-3 py-2 text-left min-[400px]:text-right dark:bg-indigo-500/15">
                                            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-indigo-500">Dojazdy</p>
                                            <p className="mt-1 text-2xl font-black text-indigo-700 dark:text-indigo-300">{routeGps.length > 1 ? routeGps.length - 1 : 0}</p>
                                        </div>
                                    </div>
                                    <p className="mt-3 text-[10px] font-black uppercase tracking-[0.22em] text-indigo-400">kilometry z dzisiejszej zmiany</p>
                                    <p className="mt-3 text-[11px] font-bold text-indigo-700/80 dark:text-indigo-200/80">
                                        Liczone z aktywnej trasy GPS zapisanej w ciągu dnia pracy.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-3xl border border-gray-100 bg-gray-50/70 p-3 dark:border-slate-700/70 dark:bg-slate-800/40">
                            <div className="mb-3 flex flex-col gap-2 px-1 min-[430px]:flex-row min-[430px]:items-center min-[430px]:justify-between">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-[0.28em] text-gray-400">Statusy dnia</p>
                                    <p className="mt-1 text-xs font-bold text-gray-500 dark:text-slate-400">Szybki podział wszystkich wyników z dzisiejszych formularzy.</p>
                                </div>
                                <span className="self-start rounded-full border border-violet-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-violet-600 shadow-sm dark:border-violet-500/20 dark:bg-slate-900/60 dark:text-violet-300">
                                    5 kategorii
                                </span>
                            </div>

                            <div className="grid grid-cols-2 min-[430px]:grid-cols-3 gap-2">
                                <div className="rounded-2xl border border-teal-200/70 bg-white px-3 py-3 shadow-sm dark:border-teal-900/30 dark:bg-slate-900/70">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-teal-500">Umowa podpisana</p>
                                    <p className="mt-3 text-3xl font-black text-teal-600 dark:text-teal-400 leading-none">{todayStatusStats.completed}</p>
                                    <p className="mt-2 text-[10px] font-bold text-teal-600/75 dark:text-teal-300/80">zakończone podpisaniem umowy</p>
                                </div>
                                <div className="rounded-2xl border border-red-200/70 bg-white px-3 py-3 shadow-sm dark:border-red-900/30 dark:bg-slate-900/70">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-red-500">Odmowy klienta</p>
                                    <p className="mt-3 text-3xl font-black text-red-600 dark:text-red-400 leading-none">{todayStatusStats.refused}</p>
                                    <p className="mt-2 text-[10px] font-bold text-red-600/75 dark:text-red-300/80">klient odmówił rozmowy</p>
                                </div>
                                <div className="rounded-2xl border border-cyan-200/70 bg-white px-3 py-3 shadow-sm dark:border-cyan-900/30 dark:bg-slate-900/70">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-cyan-500">Kontakt ponowny</p>
                                    <p className="mt-3 text-3xl font-black text-cyan-600 dark:text-cyan-400 leading-none">{todayStatusStats.attempted}</p>
                                    <p className="mt-2 text-[10px] font-bold text-cyan-600/75 dark:text-cyan-300/80">do kolejnego kontaktu</p>
                                </div>
                                <div className="rounded-2xl border border-rose-200/70 bg-white px-3 py-3 shadow-sm dark:border-rose-900/30 dark:bg-slate-900/70">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-rose-500">INNE</p>
                                    <p className="mt-3 text-3xl font-black text-rose-600 dark:text-rose-400 leading-none">{todayStatusStats.no_cooperation}</p>
                                    <p className="mt-2 text-[10px] font-bold text-rose-600/75 dark:text-rose-300/80">rozmowa zakończona odmową</p>
                                </div>
                                <div className="rounded-2xl border border-blue-200/70 bg-white px-3 py-3 shadow-sm dark:border-blue-900/30 dark:bg-slate-900/70">
                                    <p className="text-[9px] font-black uppercase tracking-[0.22em] text-blue-500">Nie było</p>
                                    <p className="mt-3 text-3xl font-black text-blue-600 dark:text-blue-400 leading-none">{todayStatusStats.not_home}</p>
                                    <p className="mt-2 text-[10px] font-bold text-blue-600/75 dark:text-blue-300/80">brak kontaktu na miejscu</p>
                                </div>
                            </div>
                        </div>
                    </div>
                    )}

                    {!isFullscreenMap && dashboardTab === 'overview' && user && (
                        <SalesSchedulePanel
                            user={user}
                            activeShift={activeShift}
                            lastPos={lastPos}
                            allowManualAdd
                            externalMeetingPatch={pendingMeetingPatch}
                            getStartAvailability={getMeetingStartAvailability}
                            onMeetingsChange={handleMeetingsChange}
                            onStartMeeting={(meeting) => {
                                void openMeetingSurvey(meeting)
                            }}
                        />
                    )}

                    {/* Today's Documentation List - ADVANCED EXPANDABLE STYLE */}
                    {!isFullscreenMap && dashboardTab === 'overview' && (
                        <div className={`${card} p-6`}>
                            <div className="flex items-center justify-between mb-8 pb-4 border-b border-gray-50 dark:border-slate-800/80">
                                <h3 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest">Raporty Dnia</h3>
                                <span className="bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 text-[10px] font-black px-3 py-1 rounded-full border border-violet-200 dark:border-violet-900/50">{todayDocuments.length} WIZYT</span>
                            </div>

                            <div className="space-y-4">
                                {todayDocuments.map((sv, idx) => {
                                    const statusMeta = getSurveyStatus(sv)
                                    const linkedMeeting = getLinkedMeetingForSurvey(sv, scheduledMeetings)
                                    const surveyStatusNote = getSurveyStatusNote(sv, linkedMeeting)
                                    const surveyStatusNoteLabel = getSurveyStatusNoteLabel(sv)
                                    const surveyTiming = getSurveyTimingMeta(sv)
                                    const meetingDuration = surveyTiming.durationLabel

                                    return (
                                    <div key={sv.id || idx} className="group">
                                        <button
                                            onClick={() => setExpandedSurvey(expandedSurvey === (sv.id || idx).toString() ? null : (sv.id || idx).toString())}
                                            className={`w-full ${innerCard} px-4 py-4 sm:px-5 flex flex-col gap-3 hover:bg-white dark:hover:bg-slate-700 transition-all text-left border-l-4 ${statusMeta.borderClass} shadow-sm`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="min-w-0 text-sm font-bold leading-tight whitespace-normal wrap-break-word sm:truncate dark:text-white">
                                                            {sv.respondent_name || 'Mieszkaniec'}
                                                        </p>
                                                        <span className={`inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.14em] ${statusMeta.chipClass}`}>
                                                            {statusMeta.label}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="shrink-0 text-right">
                                                    <p className="text-[11px] font-black text-slate-800 dark:text-slate-200 font-mono">
                                                        {new Date(sv.created_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
                                                    </p>
                                                </div>
                                            </div>

                                            {sv.respondent_phone && (
                                                <p className="text-[10px] font-mono text-gray-400 break-all">
                                                    📞 {sv.respondent_phone}
                                                </p>
                                            )}

                                            <p className="text-[10px] font-bold text-gray-400 leading-snug whitespace-normal wrap-break-word sm:truncate">
                                                📍 {sv.address || 'Brak danych'}
                                            </p>

                                            <div className="flex items-center justify-end">
                                                <span className={`text-[9px] font-black uppercase tracking-widest transition-colors ${expandedSurvey === (sv.id || idx).toString() ? 'text-cyan-500 underline' : 'text-gray-400 group-hover:text-cyan-500'}`}>
                                                    {expandedSurvey === (sv.id || idx).toString() ? 'Zwiń' : 'Detale ▸'}
                                                </span>
                                            </div>
                                        </button>

                                        <AnimatePresence>
                                            {expandedSurvey === (sv.id || idx).toString() && (
                                                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                                    <div className="bg-slate-100 dark:bg-slate-900/60 border-x border-b border-gray-100 dark:border-slate-700/50 rounded-b-2xl px-6 py-6 space-y-6 shadow-inner mx-1 mt-[-4px]">
                                                        <div className="grid grid-cols-1 gap-6 pb-6 border-b border-gray-200 dark:border-slate-800">
                                                            <div>
                                                                <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Respondent & Kontakt</p>
                                                                <p className="text-xs font-bold dark:text-white">{sv.respondent_name || 'Brak'} {sv.respondent_phone ? `· ${sv.respondent_phone}` : ''}</p>
                                                                {surveyStatusNote && (
                                                                    <p className="text-[10px] text-cyan-500 font-black mt-2 flex items-center gap-1">
                                                                        <span>📝</span> {surveyStatusNoteLabel}: {surveyStatusNote}
                                                                    </p>
                                                                )}
                                                                {sv.respondent_preferred_date && sv.status !== 'refused' && sv.status !== 'not_home' && sv.status !== 'no_cooperation' && (
                                                                    <p className="text-[9px] text-cyan-500 font-black mt-2 uppercase flex items-center gap-1">
                                                                        <span>📅</span> {sv.status === 'completed' ? 'Termin wizyty eksperta' : 'Planowany powrót / kontakt'}: {sv.respondent_preferred_date} {sv.respondent_preferred_time}
                                                                    </p>
                                                                )}
                                                                {meetingDuration && (
                                                                    <p className="text-[10px] text-violet-500 font-black mt-2 flex items-center gap-1">
                                                                        <span>⏱</span> Czas spotkania: {meetingDuration}
                                                                    </p>
                                                                )}
                                                            </div>
                                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                                                <div>
                                                                    <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Start wniosku</p>
                                                                    <p className="text-xs font-bold dark:text-white">{formatSurveyDateTime(surveyTiming.startedAt)}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Koniec wniosku</p>
                                                                    <p className="text-xs font-bold dark:text-white">{formatSurveyDateTime(surveyTiming.finishedAt)}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1.5 leading-none">Czas spotkania</p>
                                                                    <p className="text-xs font-bold dark:text-white">{meetingDuration || 'Brak'}</p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-4 leading-none">Dane umowy</p>
                                                            <div className="space-y-3">
                                                                {QS.map((q, qIndex) => {
                                                                    const ans = sv.answers[q.id]
                                                                    if (ans === undefined || ans === null || ans === '') return null
                                                                    return (
                                                                        <div key={q.id} className="flex justify-between items-start py-2 border-b border-gray-200 dark:border-slate-800/60 last:border-0 hover:bg-gray-200 dark:hover:bg-slate-800/40 px-2 rounded-lg transition-colors">
                                                                            <span className="text-[11px] text-gray-600 dark:text-gray-400 pr-4">{qIndex + 1}. {q.text}</span>
                                                                            <span className="text-[11px] font-black dark:text-white text-right shrink-0 max-w-[50%]">{String(ans)}</span>
                                                                        </div>
                                                                    )
                                                                })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                    )})
                                }
                                {todayDocuments.length === 0 && (
                                    <div className="text-center py-16 border-2 border-dashed border-gray-50 dark:border-slate-800 rounded-3xl">
                                        <div className="w-12 h-12 bg-gray-50 dark:bg-slate-800/50 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <span className="text-xl opacity-20">📝</span>
                                        </div>
                                        <p className="text-[10px] font-black text-gray-300 dark:text-gray-600 uppercase tracking-widest">Brak dzisiejszej dokumentacji</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <div className={`max-w-lg mx-auto px-4 pb-12`}>
                    <div className={`${card} p-12 text-center`}>
                        <div className="w-24 h-24 bg-gray-50 dark:bg-slate-900/50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <span className="text-5xl opacity-20 grayscale">📋</span>
                        </div>
                        <h3 className="text-sm font-black text-gray-800 dark:text-white uppercase tracking-widest mb-3">Panel pracownika jest chwilowo niedostępny</h3>
                        <p className="text-xs text-gray-400 font-bold uppercase tracking-tight leading-relaxed max-w-[240px] mx-auto">Odśwież widok albo zaloguj się ponownie, aby pobrać dzisiejszy grafik i dokumentację.</p>
                    </div>
                </div>
            )}

            <AnimatePresence>
                {rescheduleMeeting && (
                    <div className="fixed inset-0 z-110 flex items-end sm:items-center justify-center p-4">
                        <motion.button
                            type="button"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={closeRescheduleModal}
                            className="ui-modal-backdrop absolute inset-0 bg-slate-950/55 backdrop-blur-sm dark:bg-slate-950/75"
                            aria-label="Zamknij przełożenie terminu"
                        />
                        <motion.div
                            initial={{ opacity: 0, y: 16, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 16, scale: 0.96 }}
                            transition={{ duration: 0.2 }}
                            className="ui-modal-panel relative w-full max-w-xl max-h-[90vh] overflow-y-auto overscroll-contain rounded-3xl border border-violet-200 bg-white/95 p-5 text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.18)] dark:border-violet-500/20 dark:bg-slate-900/95 dark:text-white dark:shadow-2xl dark:shadow-black/40"
                            style={{ WebkitOverflowScrolling: 'touch' }}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-500">Przełożenie spotkania</p>
                                    <h3 className="mt-2 text-lg font-black text-slate-900 dark:text-white">{rescheduleMeeting.client_name}</h3>
                                    <p className="mt-1 text-sm font-semibold text-slate-500 dark:text-slate-300">{getSalesMeetingEnhancedAddress(rescheduleMeeting).main}</p>
                                    {getSalesMeetingEnhancedAddress(rescheduleMeeting).suggestion && (
                                        <p className="mt-1 text-[11px] font-bold text-violet-600 dark:text-violet-400 uppercase tracking-tight">
                                            Sugerowana nawigacja: {getSalesMeetingEnhancedAddress(rescheduleMeeting).suggestion}
                                        </p>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={closeRescheduleModal}
                                    disabled={rescheduleSaving}
                                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                >
                                    Zamknij
                                </button>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                                <div className="rounded-2xl border border-violet-200/70 bg-violet-50/80 px-4 py-3 dark:border-violet-500/20 dark:bg-violet-500/10">
                                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-500 dark:text-violet-300">Obecny termin</p>
                                    <p className="mt-2 text-sm font-black text-violet-700 dark:text-violet-100">{new Date(rescheduleMeeting.scheduled_at).toLocaleString('pl-PL')}</p>
                                </div>
                                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-950/60">
                                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Nowy termin</p>
                                    <p className="mt-2 text-sm font-black text-slate-800 dark:text-white">{format(rescheduleDateValue, 'dd MMMM yyyy', { locale: pl })}</p>
                                    <p className="mt-1 text-base font-black text-violet-600 dark:text-violet-300">{rescheduleTime}</p>
                                </div>
                            </div>

                            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                                <div className="rounded-3xl border border-violet-100 bg-white p-3 shadow-sm dark:border-violet-500/15 dark:bg-slate-950/55">
                                    <DayPicker
                                        mode="single"
                                        month={reschedulePickerMonth}
                                        onMonthChange={setReschedulePickerMonth}
                                        selected={rescheduleDateValue}
                                        onSelect={handleRescheduleDateChange}
                                        disabled={{ before: toLocalDate(getTodayDateInput()) }}
                                        locale={pl}
                                        showOutsideDays
                                        className="reschedule-day-picker mx-auto"
                                    />
                                </div>
                                <div className="rounded-3xl border border-slate-200 bg-slate-50/90 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-950/60">
                                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Dostępne godziny</p>
                                    <div className="mt-3 grid grid-cols-2 gap-2">
                                        {rescheduleTimeOptions.map((slot) => {
                                            const disabled = unavailableRescheduleSlots.has(slot)
                                            const selected = rescheduleTime === slot

                                            return (
                                                <button
                                                    key={slot}
                                                    type="button"
                                                    onClick={() => handleRescheduleTimeChange(slot)}
                                                    disabled={disabled}
                                                    className={`rounded-2xl border px-3 py-3 text-sm font-black transition-all ${
                                                        selected
                                                            ? 'border-violet-500 bg-violet-500 text-white shadow-lg shadow-violet-500/20'
                                                            : disabled
                                                                ? 'border-slate-200 bg-slate-100 text-slate-300 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-600'
                                                                : 'border-slate-200 bg-white text-slate-700 hover:border-violet-300 hover:text-violet-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-violet-400/40 dark:hover:text-violet-300'
                                                    }`}
                                                >
                                                    {slot}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                                <button
                                    type="button"
                                    disabled={rescheduleSaving}
                                    onClick={closeRescheduleModal}
                                    className="ui-pressable rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[11px] font-black uppercase tracking-widest text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                >
                                    Anuluj
                                </button>
                                <button
                                    type="button"
                                    disabled={rescheduleSaving}
                                    onClick={() => {
                                        void saveRescheduledMeeting()
                                    }}
                                    className="ui-pressable rounded-2xl border border-violet-400/30 bg-violet-600 px-4 py-3 text-[11px] font-black uppercase tracking-widest text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500 disabled:opacity-40"
                                >
                                    {rescheduleSaving ? 'Zapisywanie...' : 'Zapisz nowy termin'}
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showEndShiftConfirm && activeShift && (
                    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                        <motion.button
                            type="button"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => {
                                if (!endingShift) setShowEndShiftConfirm(false)
                            }}
                            className="ui-modal-backdrop absolute inset-0 bg-slate-950/45 backdrop-blur-sm dark:bg-slate-950/70"
                            aria-label="Zamknij potwierdzenie zakończenia pracy"
                        />
                        <motion.div
                            initial={{ opacity: 0, y: 16, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 16, scale: 0.96 }}
                            transition={{ duration: 0.2 }}
                            className="ui-modal-panel relative w-full max-w-md rounded-3xl border border-slate-200 bg-white/95 p-6 text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.18)] dark:border-slate-700/70 dark:bg-slate-900/95 dark:text-white dark:shadow-2xl dark:shadow-black/40"
                        >
                            <div className="flex items-start gap-4">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-2xl text-red-500 shadow-lg shadow-red-100 dark:bg-red-500/15 dark:text-red-400 dark:shadow-red-950/20">
                                    ⏻
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black uppercase tracking-[0.28em] text-red-500 dark:text-red-300">Zakończenie zmiany</p>
                                    <h3 className="mt-2 text-lg font-black text-slate-900 dark:text-white">Zakończyć pracę na dziś?</h3>
                                    <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-600 dark:text-slate-300">
                                        Po zakończeniu dzisiejszej zmiany nie będzie można uruchomić kolejnej pracy w tym samym dniu.
                                    </p>
                                </div>
                            </div>

                            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700/70 dark:bg-slate-950/60">
                                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Aktywna sesja</p>
                                <p className="mt-2 text-sm font-bold text-slate-900 dark:text-white">Czas trwania: {elapsed}</p>
                                <p className="mt-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                    Umowy i spotkania będą dostępne dopiero po rozpoczęciu nowej zmiany jutro.
                                </p>
                            </div>

                            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
                                <button
                                    type="button"
                                    disabled={endingShift}
                                    onClick={() => setShowEndShiftConfirm(false)}
                                    className="ui-pressable rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[11px] font-black uppercase tracking-widest text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                >
                                    Wróć
                                </button>
                                <button
                                    type="button"
                                    disabled={endingShift}
                                    onClick={() => {
                                        void confirmEndShift()
                                    }}
                                    className="ui-pressable rounded-2xl border border-red-400/30 bg-red-500 px-4 py-3 text-[11px] font-black uppercase tracking-widest text-white shadow-lg shadow-red-500/20 hover:bg-red-400 disabled:opacity-40"
                                >
                                    {endingShift ? 'Kończenie...' : 'Tak, zakończ'}
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    )
}
